import test from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';
import { Readable } from 'node:stream';
import { createDesktopAccountsRoute, createDesktopAccountsService } from '../server/desktop-accounts.js';
import { desktopAccountProviders, type DesktopAccountProvider, type DesktopAccountSnapshot } from '../shared/cursor-accounts.js';

const home = '/fixture/home';
const bundleIds = { codex: 'com.openai.codex', cursor: 'com.todesktop.230313mzl4w4u92', claude: 'com.anthropic.claudefordesktop',
  kiro: 'dev.kiro.desktop', antigravity: 'com.google.antigravity', workbuddy: 'com.tencent.workbuddy.mac' };
function fixture(platform: NodeJS.Platform = 'darwin') {
  const directories = new Set<string>();
  const bundles = new Map<string, string>();
  const files = new Map<string, string>();
  const calls: { file: string; args: string[] }[] = [];
  const reads: string[] = [];
  let sqliteOutput = '[]', failure = '';
  const service = createDesktopAccountsService({ platform, home, now: () => 'fixture-time',
    stat: async file => {
      if (!directories.has(file) && !files.has(file)) throw new Error('missing');
      return { size: Buffer.byteLength(files.get(file) || ''), isDirectory: () => directories.has(file), isFile: () => files.has(file) };
    },
    readFile: async file => { reads.push(file); if (!files.has(file)) throw new Error('missing'); return files.get(file)!; },
    exec: async (file, args) => {
      calls.push({ file, args });
      if (failure === file) throw new Error('private diagnostic with token=secret');
      if (file === '/usr/libexec/PlistBuddy') return { stdout: bundles.get(args[2]) || 'unrecognized.bundle' };
      if (file === '/usr/bin/sqlite3') return { stdout: sqliteOutput };
      if (file === '/usr/bin/open') return { stdout: '' };
      throw new Error('unexpected executable');
    },
  });
  const install = (app: string, bundle: string) => { directories.add(app); bundles.set(`${app}/Contents/Info.plist`, bundle); };
  return { service, install, files, calls, reads, sqlite: (value: string) => { sqliteOutput = value; }, fail: (file: string) => { failure = file; } };
}

test('桌面端发现仅接受固定路径及官方bundle id，不把普通ChatGPT误认成Codex', async () => {
  const f = fixture();
  f.install('/Applications/ChatGPT.app', 'com.openai.chat');
  assert.equal((await f.service.dashboard('codex')).status, 'not_installed');
  f.install(`${home}/Applications/ChatGPT.app`, bundleIds.codex);
  for (const [provider, name] of [['cursor', 'Cursor'], ['claude', 'Claude'], ['kiro', 'Kiro'], ['antigravity', 'Antigravity'], ['workbuddy', 'WorkBuddy']] as const) {
    f.install(`/Applications/${name}.app`, bundleIds[provider]);
  }
  for (const provider of desktopAccountProviders.filter(item => item !== 'grok')) {
    const value = await f.service.dashboard(provider);
    assert.equal(value.installed, true);
    assert.equal(value.canOpen, true);
    assert.equal(value.status, 'unknown');
    assert.equal(value.checkedAt, 'fixture-time');
    assert.equal('authenticated' in value, false);
    assert.equal('verified' in value, false);
  }
  assert.equal(f.calls.some(call => call.file === '/usr/bin/open'), false);
  assert.deepEqual(f.reads, []);
});

test('Cursor只读查询缓存邮箱，GET不读取token字段、不执行打开或更改数据库', async () => {
  const f = fixture();
  f.install('/Applications/Cursor.app', bundleIds.cursor);
  const database = `${home}/Library/Application Support/Cursor/User/globalStorage/state.vscdb`;
  f.files.set(database, 'fixture database');
  f.sqlite(JSON.stringify([{ value: 'person@example.test', accessToken: 'must-not-leak' }]));
  const value = await f.service.dashboard('cursor');
  assert.equal(value.status, 'recorded');
  assert.equal(value.email, 'person@example.test');
  assert.match(value.message, /本机账号记录/);
  assert.match(value.message, /应用内确认/);
  assert.equal(JSON.stringify(value).includes('must-not-leak'), false);
  const query = f.calls.find(call => call.file === '/usr/bin/sqlite3')!;
  assert.deepEqual(query.args, ['-readonly', '-json', database, "SELECT value FROM ItemTable WHERE key = 'cursorAuth/cachedEmail' LIMIT 1"]);
  assert.equal(f.calls.some(call => call.file === '/usr/bin/open'), false);
  assert.deepEqual(f.reads, []);
});

test('桌面缓存缺失、损坏或读取失败均为unknown，不泄露诊断或把旧记录当已登录', async () => {
  const f = fixture();
  f.install('/Applications/Cursor.app', bundleIds.cursor);
  f.files.set(`${home}/Library/Application Support/Cursor/User/globalStorage/state.vscdb`, 'fixture');
  for (const output of ['', 'not json secret', '[]', '{"value":"person@example.test"}', '[{"value":"secret-not-email"}]', '[{"value":null}]']) {
    f.sqlite(output);
    const value = await f.service.dashboard('cursor');
    assert.equal(value.status, 'unknown');
    assert.equal(value.email, undefined);
    assert.equal(value.canOpen, true);
    assert.equal(JSON.stringify(value).includes('secret'), false);
  }
  f.fail('/usr/bin/sqlite3');
  assert.equal((await f.service.dashboard('cursor')).status, 'unknown');
});

test('Claude仅投影合法lastKnownAccountUuid，未知邮箱/token字段不进入响应', async () => {
  const f = fixture();
  f.install('/Applications/Claude.app', bundleIds.claude);
  const file = `${home}/Library/Application Support/Claude/config.json`;
  const identity = '1b2b688d-86b0-43e4-bbed-9b2c07081eb5';
  f.files.set(file, JSON.stringify({ lastKnownAccountUuid: identity, email: 'unverified@example.test', token: 'must-not-leak' }));
  const value = await f.service.dashboard('claude');
  assert.equal(value.status, 'recorded');
  assert.equal(value.identity, identity);
  assert.equal(value.email, undefined);
  assert.equal(JSON.stringify(value).includes('must-not-leak'), false);
  assert.deepEqual(f.reads, [file]);
  f.files.set(file, JSON.stringify({ lastKnownAccountUuid: 'not-a-uuid' }));
  assert.equal((await f.service.dashboard('claude')).status, 'unknown');
  f.files.set(file, 'x'.repeat(1024 * 1024 + 1));
  const reads = f.reads.length;
  assert.equal((await f.service.dashboard('claude')).status, 'unknown');
  assert.equal(f.reads.length, reads);
});

test('Codex桌面不读取CLI auth文件，也不把CLI身份当作桌面登录状态', async () => {
  const f = fixture();
  f.install(`${home}/Applications/ChatGPT.app`, bundleIds.codex);
  f.files.set(`${home}/.codex/auth.json`, 'must-not-read');
  const value = await f.service.dashboard('codex');
  assert.equal(value.status, 'unknown');
  assert.equal(value.email, undefined);
  assert.equal(value.identity, undefined);
  assert.deepEqual(f.reads, []);
  assert.ok(f.calls.every(call => call.file === '/usr/libexec/PlistBuddy'));
});

test('打开应用绑定已验证的安装路径，Codex双安装时仍使用选定应用的设置入口', async () => {
  const f = fixture();
  f.install(`${home}/Applications/ChatGPT.app`, bundleIds.codex);
  f.install('/Applications/Codex.app', bundleIds.codex);
  f.install('/Applications/Cursor.app', bundleIds.cursor);
  for (const provider of ['codex', 'cursor'] as const) {
    const value = await f.service.open(provider);
    assert.equal(value.opened, true);
    assert.equal(value.status, 'unknown');
    assert.match(value.message, /打开应用不代表已登录/);
  }
  assert.deepEqual(f.calls.filter(call => call.file === '/usr/bin/open'), [
    { file: '/usr/bin/open', args: ['-a', `${home}/Applications/ChatGPT.app`, 'codex://settings'] },
    { file: '/usr/bin/open', args: ['-a', '/Applications/Cursor.app'] },
  ]);
  f.fail('/usr/bin/open');
  await assert.rejects(f.service.open('cursor'), error => error instanceof Error && /手动打开/.test(error.message) && !error.message.includes('secret'));
});

test('缺失或不支持的桌面入口不能启动进程，Grok Bot不冒充Grok Build', async () => {
  const f = fixture();
  f.install('/Applications/Grok Bot.app', 'com.anysphere.sand');
  assert.equal((await f.service.dashboard('cursor')).status, 'not_installed');
  const grok = await f.service.dashboard('grok');
  assert.equal(grok.status, 'unsupported');
  assert.equal(grok.canOpen, false);
  assert.match(grok.message, /不同产品/);
  await assert.rejects(f.service.open('cursor'), /未找到/);
  await assert.rejects(f.service.open('grok'), /不同产品/);
  await assert.rejects(f.service.dashboard('injected' as DesktopAccountProvider), /不支持/);
  assert.equal(f.calls.some(call => call.file === '/usr/bin/open'), false);
  const otherPlatform = fixture('linux');
  assert.equal((await otherPlatform.service.dashboard('cursor')).status, 'unsupported');
  assert.deepEqual(otherPlatform.calls, []);
});

const base = '/api/agent-runtimes/desktop-accounts';
const port = 5288;
function routeFixture() {
  const calls: string[][] = [];
  const snapshot = (provider: DesktopAccountProvider): DesktopAccountSnapshot => ({ provider, installed: true, status: 'unknown',
    canOpen: true, message: '请在应用内确认账号', checkedAt: 'fixture' });
  const handler = createDesktopAccountsRoute({
    dashboard: async provider => { calls.push(['dashboard', provider]); return snapshot(provider); },
    open: async provider => { calls.push(['open', provider]); return { ...snapshot(provider), opened: true as const }; },
  });
  const request = async (options: { method?: string; path?: string; body?: unknown; raw?: string; host?: string;
    remote?: string; origin?: string | null; confirmed?: string | null; contentType?: string } = {}) => {
    const req = Object.assign(Readable.from([options.raw ?? JSON.stringify('body' in options ? options.body : {})]), {
      method: options.method ?? 'POST', url: options.path ?? `${base}/cursor/open`,
      headers: { host: options.host ?? `127.0.0.1:${port}`, 'content-type': options.contentType ?? 'application/json',
        ...(options.origin === null ? {} : { origin: options.origin ?? `http://127.0.0.1:${port}` }),
        ...(options.confirmed === null ? {} : { 'x-delivery-confirmed': options.confirmed ?? 'yes' }) },
      socket: { remoteAddress: options.remote ?? '127.0.0.1' },
    }) as unknown as http.IncomingMessage;
    let status = 0, headers: Record<string, string> = {}, body = '';
    const res = { writeHead: (value: number, next: Record<string, string>) => { status = value; headers = next; },
      end: (value: string) => { body = value; } } as unknown as http.ServerResponse;
    await handler(req, res, port);
    return { status, headers, body: JSON.parse(body) };
  };
  return { calls, request };
}

test('桌面端GET只接受回环、可信Host与同源，读取不打开应用', async () => {
  const f = routeFixture();
  for (const remote of ['192.168.1.2', '', '203.0.113.1']) assert.equal((await f.request({ method: 'GET', path: `${base}/cursor`, remote })).status, 403);
  for (const host of ['evil.test:5288', 'localhost.evil.test:5288', '127.0.0.1:5199', '']) assert.equal((await f.request({ method: 'GET', path: `${base}/cursor`, host })).status, 403);
  assert.equal((await f.request({ method: 'GET', path: `${base}/cursor`, origin: 'https://evil.test' })).status, 403);
  assert.deepEqual(f.calls, []);
  for (const remote of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const value = await f.request({ method: 'GET', path: `${base}/cursor`, remote, origin: null, confirmed: null });
    assert.equal(value.status, 200);
    assert.equal(value.headers['Cache-Control'], 'no-store');
  }
  assert.deepEqual(f.calls, [['dashboard', 'cursor'], ['dashboard', 'cursor'], ['dashboard', 'cursor']]);
});

test('打开桌面端严格要求Origin、确认头和空JSON，拒绝请求注入路径、命令或deeplink', async () => {
  const f = routeFixture();
  for (const origin of [null, '', 'null', 'https://evil.test', 'http://localhost:5288']) assert.equal((await f.request({ origin })).status, 403);
  for (const confirmed of [null, '', 'true', 'YES']) assert.equal((await f.request({ confirmed })).status, 403);
  for (const contentType of ['', 'text/plain', 'application/jsonp']) assert.equal((await f.request({ contentType })).status, 415);
  for (const body of [null, [], 'cursor', { path: '/Applications/Other.app' }, { command: 'open' }, { url: 'cursor://arbitrary' }, { provider: 'codex' }]) {
    const value = await f.request({ body });
    assert.equal(value.status, 400);
    assert.equal(value.body.message, '输入格式不正确');
  }
  assert.equal((await f.request({ raw: '{invalid' })).status, 400);
  assert.equal((await f.request({ raw: 'x'.repeat(1025) })).status, 413);
  assert.deepEqual(f.calls, []);
});

test('路由白名单精确分发，GET open与未知操作不启动应用', async () => {
  const f = routeFixture();
  assert.equal((await f.request({ method: 'GET', path: `${base}/cursor/open`, origin: null })).status, 405);
  for (const path of [`${base}/cursor/login`, `${base}/cursor/open/extra`, `${base}/arbitrary/open`, `${base}/../cursor/open`, `${base}/%63ursor/open`, '/other/cursor/open']) {
    assert.equal((await f.request({ path })).status, 404);
  }
  assert.equal((await f.request({ method: 'DELETE' })).status, 405);
  assert.deepEqual(f.calls, []);
  for (const provider of desktopAccountProviders) {
    assert.equal((await f.request({ method: 'GET', path: `${base}/${provider}`, origin: null })).status, 200);
    assert.equal((await f.request({ path: `${base}/${provider}/open`, contentType: 'application/json; charset=utf-8' })).status, 200);
  }
  assert.equal(f.calls.filter(call => call[0] === 'open').length, desktopAccountProviders.length);
});
