import type http from 'node:http';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { desktopAccountProviders, type DesktopAccountProvider, type DesktopAccountSnapshot } from '../shared/cursor-accounts.js';
interface FileInfo { size: number; isDirectory(): boolean; isFile(): boolean }
interface Options {
  platform?: NodeJS.Platform;
  home?: string;
  stat?: (file: string) => Promise<FileInfo>;
  readFile?: (file: string) => Promise<string>;
  exec?: (file: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string }>;
  now?: () => string;
}
const exec = promisify(execFile);
const applications = {
  codex: { label: 'Codex', names: ['Codex.app', 'ChatGPT.app'], bundleId: 'com.openai.codex' },
  cursor: { label: 'Cursor', names: ['Cursor.app'], bundleId: 'com.todesktop.230313mzl4w4u92' },
  claude: { label: 'Claude', names: ['Claude.app'], bundleId: 'com.anthropic.claudefordesktop' },
  kiro: { label: 'Kiro', names: ['Kiro.app'], bundleId: 'dev.kiro.desktop' },
  antigravity: { label: 'Antigravity', names: ['Antigravity.app'], bundleId: 'com.google.antigravity' },
  workbuddy: { label: 'WorkBuddy', names: ['WorkBuddy.app'], bundleId: 'com.tencent.workbuddy.mac' },
} as const;
const emailSchema = z.string().max(320).email();
const identitySchema = z.string().uuid();
const cursorEmailQuery = "SELECT value FROM ItemTable WHERE key = 'cursorAuth/cachedEmail' LIMIT 1";

export class DesktopAccountError extends Error {}

/** Launch only installed official applications. Cached desktop identity is never proof of authentication. */
export function createDesktopAccountsService(options: Options = {}) {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const stat = options.stat ?? (file => fs.stat(file));
  const readFile = options.readFile ?? (file => fs.readFile(file, 'utf8'));
  const run = options.exec ?? ((file, args, settings) => exec(file, args, { ...settings, encoding: 'utf8' }));
  const now = options.now ?? (() => new Date().toISOString());

  async function findApplication(provider: Exclude<DesktopAccountProvider, 'grok'>) {
    const spec = applications[provider];
    for (const directory of [path.join(home, 'Applications'), '/Applications']) {
      for (const name of spec.names) {
        const application = path.join(directory, name);
        try {
          if (!(await stat(application)).isDirectory()) continue;
          const { stdout } = await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(application, 'Contents/Info.plist')],
            { timeout: 3000, maxBuffer: 4096 });
          if (stdout.trim() === spec.bundleId) return application;
        } catch { /* Missing or unrecognized bundles are not eligible to be launched. */ }
      }
    }
    return undefined;
  }

  async function inspect(provider: DesktopAccountProvider): Promise<{ snapshot: DesktopAccountSnapshot; application?: string }> {
    const initial: DesktopAccountSnapshot = { provider, installed: false, status: 'unsupported', canOpen: false,
      checkedAt: now(), message: '当前系统暂不支持桌面端账号入口。' };
    if (!desktopAccountProviders.includes(provider)) throw new DesktopAccountError('不支持的桌面端账号平台');
    if (provider === 'grok') return { snapshot: { ...initial, message: 'Grok Bot 桌面端与 Grok Build CLI 是不同产品，暂不联动登录。' } };
    if (platform !== 'darwin') return { snapshot: initial };
    const application = await findApplication(provider);
    const label = applications[provider].label;
    if (!application) return { snapshot: { ...initial, status: 'not_installed', message: `未找到已安装的 ${label} 桌面端。` } };
    const snapshot: DesktopAccountSnapshot = { ...initial, installed: true, status: 'unknown', canOpen: true,
      message: `已找到 ${label} 桌面端，请在应用内确认当前登录账号。` };
    try {
      if (provider === 'cursor') {
        const database = path.join(home, 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
        if ((await stat(database)).isFile()) {
          const { stdout } = await run('/usr/bin/sqlite3', ['-readonly', '-json', database, cursorEmailQuery], { timeout: 3000, maxBuffer: 4096 });
          const rows: unknown = JSON.parse(stdout);
          const email = emailSchema.safeParse(Array.isArray(rows) && rows.length ? rows[0]?.value : undefined);
          if (email.success) {
            snapshot.email = email.data;
            snapshot.status = 'recorded';
            snapshot.message = '读取到 Cursor 桌面端的本机账号记录，登录状态请在应用内确认。';
          }
        }
      } else if (provider === 'claude') {
        const file = path.join(home, 'Library/Application Support/Claude/config.json');
        const info = await stat(file);
        if (info.isFile() && info.size <= 1024 * 1024) {
          const metadata: unknown = JSON.parse(await readFile(file));
          const identity = identitySchema.safeParse(metadata && typeof metadata === 'object' && !Array.isArray(metadata)
            ? (metadata as Record<string, unknown>).lastKnownAccountUuid : undefined);
          if (identity.success) {
            snapshot.identity = identity.data;
            snapshot.status = 'recorded';
            snapshot.message = '读取到 Claude 桌面端的本机账号记录，邮箱和登录状态请在应用内确认。';
          }
        }
      }
      // Codex's auth.json describes CLI credentials, not the running desktop account.
      // Other applications have no verified public identity reader in this integration.
    } catch { /* Keep the desktop available to open; do not expose database/configuration diagnostics. */ }
    return { snapshot, application };
  }

  async function dashboard(provider: DesktopAccountProvider) { return (await inspect(provider)).snapshot; }
  async function open(provider: DesktopAccountProvider) {
    const { snapshot, application } = await inspect(provider);
    if (!snapshot.canOpen || !application) throw new DesktopAccountError(snapshot.message);
    try {
      const args = ['-a', application, ...(provider === 'codex' ? ['codex://settings'] : [])];
      await run('/usr/bin/open', args, { timeout: 10_000, maxBuffer: 4096 });
    } catch { throw new DesktopAccountError('未能打开桌面应用，请从“应用程序”中手动打开。'); }
    return { ...snapshot, opened: true as const, checkedAt: now(),
      message: `已打开 ${applications[provider as Exclude<DesktopAccountProvider, 'grok'>].label}，请在应用内完成登录并确认账号；打开应用不代表已登录。` };
  }
  return { dashboard, open };
}

type Service = Pick<ReturnType<typeof createDesktopAccountsService>, 'dashboard' | 'open'>;
const routeBase = '/api/agent-runtimes/desktop-accounts';
export function createDesktopAccountsRoute(service: Service) {
  return async (request: http.IncomingMessage, response: http.ServerResponse, port: number) => {
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(value));
    };
    try {
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress || '');
      if (!local || ![`localhost:${port}`, `127.0.0.1:${port}`].includes(request.headers.host || '')) {
        send(403, { message: '仅接受本机看板请求' }); return;
      }
      const expectedOrigin = `http://${request.headers.host}`;
      if (request.headers.origin && request.headers.origin !== expectedOrigin) {
        send(403, { message: '请求来源不匹配' }); return;
      }
      const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
      const match = url.pathname.match(/^\/api\/agent-runtimes\/desktop-accounts\/([a-z]+)(\/open)?$/);
      if (!match || !desktopAccountProviders.includes(match[1] as DesktopAccountProvider)) {
        send(404, { message: '桌面端账号操作不存在' }); return;
      }
      const provider = match[1] as DesktopAccountProvider;
      if (request.method === 'GET' && url.pathname === `${routeBase}/${provider}`) {
        send(200, await service.dashboard(provider)); return;
      }
      if (request.method !== 'POST') { send(405, { message: '请求方法不支持' }); return; }
      if (request.headers.origin !== expectedOrigin || request.headers['x-delivery-confirmed'] !== 'yes') {
        send(403, { message: '请在当前面板确认打开桌面端' }); return;
      }
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        send(415, { message: '请发送 JSON' }); return;
      }
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 1024) { send(413, { message: '请求内容过大' }); return; }
      }
      z.object({}).strict().parse(JSON.parse(body || '{}'));
      if (match[2] !== '/open') { send(404, { message: '桌面端账号操作不存在' }); return; }
      send(200, await service.open(provider));
    } catch (error) {
      send(400, { message: error instanceof z.ZodError || error instanceof SyntaxError ? '输入格式不正确'
        : error instanceof DesktopAccountError ? error.message : '桌面端账号操作未完成' });
    }
  };
}
