import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { BrowserConnectionStatus } from '../shared/browser-connection.js';
import { createBrowserConnection, type BrowserConnectionOptions } from './browser-connection.js';

const exec = promisify(execFile);
type HostOptions = Pick<BrowserConnectionOptions, 'rootDirectory' | 'debugPortFile'> & { dataDirectory: string };
type ControlResults = {
  status: BrowserConnectionStatus;
  'open-settings': BrowserConnectionStatus;
  connect: BrowserConnectionStatus;
  disconnect: BrowserConnectionStatus;
  'task-endpoint': string | null;
};
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** 工作台通过私有 Unix socket 使用连接进程，重启时无需触碰已授权的 Chrome。 */
export function createBrowserConnectionHost(options: HostOptions) {
  const local = createBrowserConnection(options);
  if (process.platform !== 'darwin') {
    return { ...local, taskEndpoint: async () => undefined };
  }

  const root = realpathSync(options.rootDirectory);
  const identity = createHash('sha256').update(root).update('\0').update(realpathSync(options.dataDirectory)).digest('hex').slice(0, 20);
  const uid = process.getuid!();
  const directory = path.join('/tmp', `delivery-chrome-${uid}-${identity}`);
  const socketPath = path.join(directory, 'control.sock');
  let disconnectGeneration = 0;
  let pendingConnect: Promise<BrowserConnectionStatus> | undefined;

  const stat = (file: string) => fs.lstat(file).catch(error => { if (!missing(error)) throw error; });
  async function privateSocket() {
    const parent = await stat(directory);
    if (!parent) return undefined;
    if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o077) !== 0) {
      throw new Error('Chrome 连接的本机控制目录权限不正确。');
    }
    const socket = await stat(socketPath);
    if (socket && (!socket.isSocket() || socket.uid !== uid)) throw new Error('Chrome 连接的本机控制入口不可用。');
    return socket;
  }

  async function request<Action extends keyof ControlResults>(action: Action): Promise<ControlResults[Action] | undefined> {
    if (!await privateSocket()) return undefined;
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath, path: `/${action}`, agent: false,
        method: action === 'status' || action === 'task-endpoint' ? 'GET' : 'POST',
        signal: AbortSignal.timeout(action === 'open-settings' ? 12_000 : 4000) }, response => {
        response.setEncoding('utf8');
        let body = '';
        response.on('error', reject);
        response.on('data', chunk => {
          body += chunk;
          if (body.length > 8192) req.destroy(new Error('Chrome 连接状态响应过长。'));
        });
        response.on('end', () => {
          if (response.statusCode !== 200) { reject(new Error('Chrome 连接后台暂不可用，请重试。')); return; }
          try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
        });
      });
      req.on('error', (error: NodeJS.ErrnoException) => {
        if (missing(error) || error.code === 'ECONNREFUSED') resolve(undefined);
        else reject(error);
      });
      req.end();
    });
  }
  async function status() { return await request('status') ?? local.status(); }

  async function start() {
    await fs.mkdir(directory, { mode: 0o700 }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    const previous = await privateSocket();
    if (await request('status')) return;
    // 仅在控制 socket 已失效且仍是同一个文件时移除它。
    if (previous && (await privateSocket())?.ino === previous.ino) {
      await fs.unlink(socketPath).catch(error => { if (!missing(error)) throw error; });
    }
    const worker = fileURLToPath(new URL('./browser-connection-worker.ts', import.meta.url));
    const env = Object.fromEntries([
      'PATH', 'HOME', 'TMPDIR', 'DELIVERY_AGENT_BROWSER_BIN', 'DELIVERY_AGENT_BROWSER_CHROME_BIN', 'DELIVERY_AGENT_BROWSER_REUSE_CHROME',
    ].map(key => [key, process.env[key]]));
    await exec(process.execPath, ['--import', 'tsx', worker, 'launch', root, socketPath, options.debugPortFile ?? ''],
      { env, cwd: root, timeout: 5000 });
    const deadline = Date.now() + 5000;
    do {
      if (await request('status')) return;
      await delay(50);
    } while (Date.now() < deadline);
    throw new Error('Chrome 连接后台未能启动，请重试。');
  }

  function connect() {
    if (pendingConnect) return pendingConnect;
    const requestedBeforeDisconnect = disconnectGeneration;
    pendingConnect = (async () => {
      if (!await request('status')) await start();
      if (requestedBeforeDisconnect !== disconnectGeneration) return status();
      const result = await request('connect');
      if (!result) throw new Error('Chrome 连接后台暂不可用，请重试。');
      return result;
    })().finally(() => { pendingConnect = undefined; });
    return pendingConnect;
  }

  return {
    status,
    openSettings: async () => await request('open-settings') ?? local.openSettings(),
    connect,
    async disconnect() {
      disconnectGeneration++;
      await pendingConnect?.catch(() => {});
      return await request('disconnect') ?? local.disconnect();
    },
    async taskEndpoint() {
      try { return await request('task-endpoint') ?? undefined; }
      catch { return undefined; } // 浏览器后台暂不可用时仍允许启动普通 Codex 轮次。
    },
  };
}
