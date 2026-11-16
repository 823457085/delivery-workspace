/** 日常 Chrome 连接：只读取其公开调试入口，不启动独立配置或读取认证数据。 */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { CHROME_REMOTE_DEBUGGING_SETTINGS_URL, type BrowserConnectionStatus } from '../shared/browser-connection.js';
import { createChromeCdpRelay } from './chrome-cdp-relay.js';

const exec = promisify(execFile);
const preferencesPath = (root: string) => path.join(root, '.local', 'data', 'agent-browser', 'connection-preferences.json');
type BrowserSocket = EventTarget & { readonly readyState: number; send(data: string): void; close(): void };

export interface BrowserConnectionOptions {
  rootDirectory: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  debugPortFile?: string;
  toolAvailable?: () => Promise<boolean>;
  chromeAvailable?: () => Promise<boolean>;
  openChromeSettings?: () => Promise<void>;
  createSocket?: (endpoint: string) => BrowserSocket;
  timeoutMs?: number;
  now?: () => Date;
}

export async function isChromeReuseEnabled(rootDirectory: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    let directory = await fs.realpath(rootDirectory);
    for (const segment of ['.local', 'data', 'agent-browser']) {
      directory = path.join(directory, segment);
      const entry = await fs.lstat(directory);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('浏览器配置目录不可用');
    }
    const file = preferencesPath(rootDirectory);
    const entry = await fs.lstat(file);
    if (entry.isFile() && !entry.isSymbolicLink() && entry.size <= 4096) {
      const preference: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
      if (preference && typeof preference === 'object' && 'enabled' in preference && typeof preference.enabled === 'boolean') return preference.enabled;
    }
  } catch { /* 未配置时沿用当前安装的环境开关。 */ }
  return env.DELIVERY_AGENT_BROWSER_REUSE_CHROME === '1';
}

async function available(candidates: string[]) {
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      await fs.access(candidate, constants.X_OK);
      if ((await fs.stat(candidate)).isFile()) return true;
    } catch { /* 继续检查明确允许的安装位置。 */ }
  }
  return false;
}

async function readEndpoint(file: string) {
  try {
    const entry = await fs.lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 512) return undefined;
    const match = /^(\d{1,5})\r?\n(\/devtools\/browser\/[\da-f-]{36})$/i.exec((await fs.readFile(file, 'utf8')).trim());
    if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) return undefined;
    return `ws://127.0.0.1:${Number(match[1])}${match[2]}`;
  } catch { return undefined; }
}

async function enableReuse(rootDirectory: string, checkedAt: string) {
  const root = await fs.realpath(rootDirectory);
  let directory = root;
  for (const segment of ['.local', 'data', 'agent-browser']) {
    directory = path.join(directory, segment);
    await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    const entry = await fs.lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('浏览器配置目录不可用');
    await fs.chmod(directory, 0o700);
  }
  const file = preferencesPath(root);
  try {
    const entry = await fs.lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('浏览器连接配置不可用');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify({ enabled: true, updatedAt: checkedAt }) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

export function createBrowserConnection(options: BrowserConnectionOptions) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const home = options.homeDirectory || os.homedir();
  const file = options.debugPortFile || path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'DevToolsActivePort');
  const now = options.now || (() => new Date());
  const toolAvailable = options.toolAvailable || (() => available(env.DELIVERY_AGENT_BROWSER_BIN ? [env.DELIVERY_AGENT_BROWSER_BIN] : [
    '/opt/homebrew/bin/agent-browser', '/usr/local/bin/agent-browser',
    ...String(env.PATH || '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, 'agent-browser')),
  ]));
  const chromeAvailable = options.chromeAvailable || (() => available(env.DELIVERY_AGENT_BROWSER_CHROME_BIN ? [env.DELIVERY_AGENT_BROWSER_CHROME_BIN] : [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  ]));
  const createSocket = options.createSocket || (endpoint => new WebSocket(endpoint));
  const openChromeSettings = options.openChromeSettings || (async () => {
    await exec('open', ['-a', 'Google Chrome', CHROME_REMOTE_DEBUGGING_SETTINGS_URL], { timeout: 10_000 });
  });
  let socket: BrowserSocket | undefined;
  let relay: ReturnType<typeof createChromeCdpRelay> | undefined;
  let endpoint: string | undefined;
  let generation = 0;
  let disconnectGeneration = 0;
  let verified = false;
  let phase: BrowserConnectionStatus['phase'] = 'setup_required';
  let message = '';
  let browserVersion: string | undefined;
  let lastVerifiedAt: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeListeners: (() => void) | undefined;
  let connectPromise: Promise<BrowserConnectionStatus> | undefined;

  const stopTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const closeProbe = (invalidate = true) => {
    if (invalidate) generation++;
    stopTimer();
    removeListeners?.(); removeListeners = undefined;
    relay?.close(); relay = undefined;
    const ownSocket = socket;
    socket = undefined; endpoint = undefined; verified = false;
    if (ownSocket && ownSocket.readyState < 2) { try { ownSocket.close(); } catch { /* 已关闭。 */ } }
  };
  const fail = (text: string) => { closeProbe(); phase = 'error'; message = text; };

  async function inspect() {
    const [tool, chrome, publishedEndpoint, reuseEnabled] = await Promise.all([
      toolAvailable(), chromeAvailable(), readEndpoint(file), isChromeReuseEnabled(options.rootDirectory, env),
    ]);
    return { tool, chrome, publishedEndpoint, reuseEnabled };
  }

  async function status(): Promise<BrowserConnectionStatus> {
    const probe = await inspect();
    if (socket && endpoint !== probe.publishedEndpoint && probe.publishedEndpoint) {
      closeProbe(); phase = 'ready'; message = 'Chrome 调试入口已变化，请重新连接。';
    }
    if (socket && socket.readyState > 1 && (phase === 'connected' || phase === 'connecting')) fail('Chrome 连接已关闭，请重新连接。');
    if (platform !== 'darwin' || !probe.tool || !probe.chrome) {
      closeProbe(); phase = 'unavailable';
      message = platform !== 'darwin' ? '当前日常 Chrome 连接功能仅支持 macOS。'
        : !probe.tool ? '未找到 agent-browser，请安装浏览器工具后重新检查。' : '未找到日常 Google Chrome，请安装后重新检查。';
    } else if (phase === 'connected' && socket?.readyState === 1 && verified) {
      message = '已连接日常 Chrome。连接有效期间，后续工作台调用会沿用这次授权。';
    } else if (phase === 'connecting' && socket && socket.readyState < 2) {
      message = '正在连接日常 Chrome；如出现浏览器授权弹窗，请选择允许。';
    } else if (phase !== 'error') {
      phase = probe.publishedEndpoint ? 'ready' : 'setup_required';
      message = probe.publishedEndpoint ? '已检测到日常 Chrome 调试入口，点击连接并在浏览器中允许。'
        : '请在日常 Chrome 的远程调试设置中开启连接，然后重新检查。';
    }
    return { phase, message, checkedAt: now().toISOString(), toolAvailable: probe.tool, chromeAvailable: probe.chrome,
      debuggingEnabled: !!probe.publishedEndpoint || (verified && socket?.readyState === 1),
      connectionVerified: phase === 'connected' && verified && socket?.readyState === 1,
      ...(browserVersion ? { browserVersion } : {}), ...(lastVerifiedAt ? { lastVerifiedAt } : {}),
      settingsUrl: CHROME_REMOTE_DEBUGGING_SETTINGS_URL, reuseEnabled: probe.reuseEnabled };
  }

  async function openSettings(): Promise<BrowserConnectionStatus> {
    try {
      await enableReuse(options.rootDirectory, now().toISOString());
      if (platform !== 'darwin' || !await chromeAvailable()) return status();
      await openChromeSettings();
      if (phase === 'error') { phase = 'setup_required'; message = ''; }
    } catch { fail('无法打开日常 Chrome 设置，请手动打开远程调试设置后重新检查。'); }
    return status();
  }

  function connect(): Promise<BrowserConnectionStatus> {
    if (connectPromise) return connectPromise;
    const requestedBeforeDisconnect = disconnectGeneration;
    connectPromise = (async () => {
      const current = await status();
      if (requestedBeforeDisconnect !== disconnectGeneration) return status();
      if (current.phase === 'connected' || current.phase === 'connecting') return current;
      const intent = ++generation;
      try { await enableReuse(options.rootDirectory, now().toISOString()); }
      catch { fail('无法保存浏览器连接设置，请检查工作台目录权限后重试。'); return status(); }
      const probe = await inspect();
      if (intent !== generation) return status();
      if (platform !== 'darwin' || !probe.tool || !probe.chrome) return status();
      if (!probe.publishedEndpoint) { phase = 'setup_required'; message = ''; return status(); }
      closeProbe(false);
      endpoint = probe.publishedEndpoint;
      try { socket = createSocket(endpoint); }
      catch { fail('无法连接日常 Chrome，请核对远程调试设置和浏览器授权后重试。'); return status(); }
      const ownSocket = socket;
      const active = () => generation === intent && socket === ownSocket;
      const onOpen = () => {
        if (!active()) return;
        try { ownSocket.send(JSON.stringify({ id: intent, method: 'Browser.getVersion' })); }
        catch { if (active()) fail('Chrome 连接请求发送失败，请重新连接。'); }
      };
      const onMessage = (event: Event) => {
        if (!active() || typeof (event as MessageEvent).data !== 'string') return;
        let response: { id?: unknown; error?: unknown; result?: { product?: unknown } };
        try { response = JSON.parse((event as MessageEvent).data); } catch { return; }
        if (relay) { relay.receive(response); return; }
        if (response?.id !== intent) return;
        if (response.error || typeof response.result?.product !== 'string' || !response.result.product.trim()) {
          fail('Chrome 未返回可确认的连接结果，请核对浏览器授权后重试。'); return;
        }
        if (ownSocket.readyState !== 1) { fail('Chrome 连接已关闭，请重新连接。'); return; }
        relay = createChromeCdpRelay(ownSocket);
        stopTimer(); verified = true; phase = 'connected';
        browserVersion = response.result.product.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200);
        lastVerifiedAt = now().toISOString();
      };
      const onClose = () => { if (active()) fail('Chrome 连接已关闭，请重新连接。'); };
      const onError = () => { if (active()) fail('Chrome 连接失败，请核对远程调试设置和浏览器授权后重试。'); };
      ownSocket.addEventListener('open', onOpen); ownSocket.addEventListener('message', onMessage);
      ownSocket.addEventListener('close', onClose); ownSocket.addEventListener('error', onError);
      removeListeners = () => {
        ownSocket.removeEventListener('open', onOpen); ownSocket.removeEventListener('message', onMessage);
        ownSocket.removeEventListener('close', onClose); ownSocket.removeEventListener('error', onError);
      };
      phase = 'connecting'; verified = false;
      timer = setTimeout(() => { if (active()) fail('Chrome 连接超时，请核对远程调试设置和授权后重试。'); }, options.timeoutMs ?? 20_000);
      timer.unref?.();
      const connecting = { ...current, phase: 'connecting' as const, message: '正在连接日常 Chrome；如出现浏览器授权弹窗，请选择允许。',
        checkedAt: now().toISOString(), debuggingEnabled: true, connectionVerified: false, reuseEnabled: true };
      if (ownSocket.readyState === 1) queueMicrotask(onOpen);
      return connecting;
    })().finally(() => { connectPromise = undefined; });
    return connectPromise;
  }

  async function disconnect(): Promise<BrowserConnectionStatus> {
    disconnectGeneration++;
    closeProbe(); phase = 'ready'; message = '';
    return status();
  }

  async function taskEndpoint(port: number) {
    const current = await status();
    if (current.connectionVerified && relay) return `ws://127.0.0.1:${port}${relay.route}`;
  }

  function upgrade(request: IncomingMessage, client: Duplex, head: Buffer, port: number) {
    if (relay) relay.upgrade(request, client, head, port);
    else client.destroy();
  }

  return { status, openSettings, connect, disconnect, taskEndpoint, upgrade };
}
