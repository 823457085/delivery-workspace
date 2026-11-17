import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { createBrowserConnection, isChromeReuseEnabled } from '../server/browser-connection.js';
import { CHROME_REMOTE_DEBUGGING_SETTINGS_URL } from '../shared/browser-connection.js';

const debugPath = '/devtools/browser/12345678-1234-1234-1234-123456789abc';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-chrome-connect-'));
  const debugPortFile = path.join(root, 'DevToolsActivePort');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { rootDirectory: root, debugPortFile, env: {}, platform: 'darwin' as const,
    toolAvailable: async () => true, chromeAvailable: async () => true, openChromeSettings: async () => {} };
}

class FakeSocket extends EventTarget {
  readyState = 0;
  sent: string[] = [];
  closed = 0;
  send(text: string) { this.sent.push(text); }
  close() { this.closed++; this.readyState = 3; this.dispatchEvent(new Event('close')); }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  reply(result: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: JSON.parse(this.sent[0]!).id, result }) })); }
}

test('只读状态不启动浏览器；有效端点仅为ready，不等同连接成功', async t => {
  const options = await fixture(t);
  let connections = 0;
  const service = createBrowserConnection({ ...options, createSocket: () => { connections++; return new FakeSocket(); } });
  assert.equal((await service.status()).phase, 'setup_required');
  assert.equal((await service.status()).reuseEnabled, false);
  await fs.writeFile(options.debugPortFile, `9222\n${debugPath}\n`);
  const ready = await service.status();
  assert.equal(ready.phase, 'ready');
  assert.equal(ready.debuggingEnabled, true);
  assert.equal(ready.connectionVerified, false);
  assert.equal(connections, 0);
  assert.equal(ready.settingsUrl, CHROME_REMOTE_DEBUGGING_SETTINGS_URL);
  assert.equal(JSON.stringify(ready).includes(debugPath), false, '不暴露Chrome调试能力地址');
});

test('打开设置只调用日常Chrome并持久化私有偏好，断开不清除复用设置', async t => {
  const options = await fixture(t);
  let opened = 0;
  const service = createBrowserConnection({ ...options, openChromeSettings: async () => { opened++; } });
  assert.equal(await isChromeReuseEnabled(options.rootDirectory, { DELIVERY_AGENT_BROWSER_REUSE_CHROME: '1' }), true);
  const result = await service.openSettings();
  assert.equal(opened, 1);
  assert.equal(result.reuseEnabled, true);
  assert.equal(result.phase, 'setup_required');
  assert.equal(await isChromeReuseEnabled(options.rootDirectory, {}), true, '新轮次无需修改env或重启');
  const preference = path.join(options.rootDirectory, '.local', 'data', 'agent-browser', 'connection-preferences.json');
  assert.equal(JSON.parse(await fs.readFile(preference, 'utf8')).enabled, true);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(preference)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(preference))).mode & 0o777, 0o700);
  }
  assert.equal((await service.disconnect()).reuseEnabled, true);
});

test('缺少自动化工具不阻断连接准备；不支持平台与非法端点不能假报connected', async t => {
  const options = await fixture(t);
  assert.equal((await createBrowserConnection({ ...options, toolAvailable: async () => false }).status()).phase, 'setup_required');
  assert.equal((await createBrowserConnection({ ...options, platform: 'linux' }).status()).phase, 'unavailable');
  for (const invalid of [`65536\n${debugPath}`, `0\n${debugPath}`, `9222\nws://elsewhere/devtools/browser/test`, `9222\n${debugPath}/extra`]) {
    await fs.writeFile(options.debugPortFile, invalid);
    const result = await createBrowserConnection(options).connect();
    assert.equal(result.phase, 'setup_required');
    assert.equal(result.debuggingEnabled, false);
    assert.equal(result.connectionVerified, false);
  }
});

test('并行任务复用一次 Chrome 握手，各自收到正确回复，断开撤销所有任务连接', async t => {
  const options = await fixture(t);
  const chrome = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const methods: string[] = [];
  let upgrades = 0;
  let nextSession = 0;
  chrome.on('connection', socket => {
    upgrades++;
    socket.on('message', data => {
      const { id, method, sessionId } = JSON.parse(data.toString());
      methods.push(method);
      const result = method === 'Target.attachToBrowserTarget' ? { sessionId: 'task-' + ++nextSession }
        : { product: 'Chrome/fixture', task: sessionId };
      socket.send(JSON.stringify({ id, sessionId, result }));
    });
  });
  await once(chrome, 'listening');
  await fs.writeFile(options.debugPortFile, `${(chrome.address() as { port: number }).port}\n${debugPath}\n`);
  const service = createBrowserConnection(options);
  const server = http.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  server.on('upgrade', (request, socket, head) => service.upgrade(request, socket, head, port));
  t.after(async () => {
    await service.disconnect();
    chrome.clients.forEach(socket => socket.terminate());
    chrome.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  assert.equal(await service.taskEndpoint(port), undefined);
  const [first, concurrent] = await Promise.all([service.connect(), service.connect()]);
  assert.equal(first.phase, 'connecting');
  assert.equal(concurrent.phase, 'connecting');
  assert.equal(first.connectionVerified, false);
  let result = await service.status();
  for (let i = 0; i < 100 && result.phase !== 'connected'; i++) { await delay(5); result = await service.status(); }
  assert.equal(result.phase, 'connected');
  assert.equal(result.connectionVerified, true);
  assert.equal(result.browserVersion, 'Chrome/fixture');
  assert.ok(result.lastVerifiedAt);
  assert.equal((await service.connect()).phase, 'connected');
  assert.deepEqual(methods, ['Browser.getVersion']);
  const endpoint = await service.taskEndpoint(port);
  assert.ok(endpoint);
  await assert.rejects(once(new WebSocket(endpoint, { origin: 'https://elsewhere.invalid' }), 'open'));
  await assert.rejects(once(new WebSocket(endpoint + '-wrong'), 'open'));
  const a = new WebSocket(endpoint), b = new WebSocket(endpoint);
  const answers = await Promise.all([a, b].map(async client => {
    await once(client, 'open');
    const reply = once(client, 'message');
    client.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
    return JSON.parse((await reply)[0].toString());
  }));
  assert.deepEqual(answers.map(answer => answer.id), [1, 1]);
  assert.deepEqual(answers.map(answer => answer.sessionId), [undefined, undefined]);
  assert.deepEqual(new Set(answers.map(answer => answer.result.task)), new Set(['task-1', 'task-2']));
  assert.equal(upgrades, 1);
  const closed = Promise.all([once(a, 'close'), once(b, 'close')]);
  const disconnected = await service.disconnect();
  await closed;
  assert.equal(disconnected.phase, 'ready');
  assert.equal(disconnected.connectionVerified, false);
  assert.equal(disconnected.reuseEnabled, true);
  assert.equal(methods.includes('Browser.close'), false);
  assert.equal(await service.taskEndpoint(port), undefined);
  await assert.rejects(once(new WebSocket(endpoint), 'open'));
});

test('拒绝、超时、远端关闭和迟到结果不能保留或恢复connected', async t => {
  const options = await fixture(t);
  await fs.writeFile(options.debugPortFile, `9222\n${debugPath}\n`);
  const created: FakeSocket[] = [];
  const service = createBrowserConnection({ ...options, timeoutMs: 20, createSocket: () => { const socket = new FakeSocket(); created.push(socket); return socket; } });
  t.after(async () => { await service.disconnect(); });
  await service.connect();
  created[0]!.dispatchEvent(new Event('error'));
  assert.equal((await service.status()).phase, 'error');
  await service.connect(); created[1]!.open();
  created[1]!.reply({ product: 'Chrome/fixture' });
  assert.equal((await service.status()).phase, 'connected');
  created[1]!.close();
  assert.equal((await service.status()).phase, 'reconnecting');
  assert.equal((await service.status()).connectionVerified, false);
  await service.connect(); created[2]!.open();
  await delay(35);
  assert.equal((await service.status()).phase, 'reconnecting');
  created[2]!.reply({ product: 'Chrome/too-late' });
  assert.equal((await service.status()).phase, 'reconnecting');
  assert.equal((await service.status()).connectionVerified, false);
});

test('Chrome端点变化会撤销原连接；配置目录链接不能写到工作台外', async t => {
  const options = await fixture(t);
  await fs.writeFile(options.debugPortFile, `9222\n${debugPath}\n`);
  const socket = new FakeSocket();
  const service = createBrowserConnection({ ...options, createSocket: () => socket });
  t.after(() => service.disconnect().then(() => {}));
  await service.connect(); socket.open(); socket.reply({ product: 'Chrome/fixture' });
  assert.equal((await service.status()).phase, 'connected');
  await fs.writeFile(options.debugPortFile, `9333\n${debugPath}\n`);
  assert.equal((await service.status()).phase, 'reconnecting');
  assert.equal(socket.closed, 1);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-chrome-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const another = await fixture(t);
  await fs.symlink(outside, path.join(another.rootDirectory, '.local'));
  const unsafe = createBrowserConnection(another);
  assert.equal((await unsafe.connect()).phase, 'error');
  assert.deepEqual(await fs.readdir(outside), []);
});

test('断开可以取消仍在初始可用性检查中的连接请求', async t => {
  const options = await fixture(t);
  await fs.writeFile(options.debugPortFile, `9222\n${debugPath}\n`);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let checks = 0;
  let connections = 0;
  const service = createBrowserConnection({ ...options,
    toolAvailable: async () => { if (checks++ === 0) { entered(); await gate; } return true; },
    createSocket: () => { connections++; return new FakeSocket(); },
  });
  const pending = service.connect();
  await started;
  assert.equal((await service.disconnect()).phase, 'ready');
  release();
  const result = await pending;
  assert.equal(result.phase, 'ready');
  assert.equal(result.connectionVerified, false);
  assert.equal(connections, 0, '用户断开后不启动迟到的WebSocket连接');
});

test('已授权的 Chrome 在后台自动恢复，同一入口拒绝后不反复请求，手动断开停止恢复', async t => {
  const options = await fixture(t);
  const sockets: FakeSocket[] = [];
  const service = createBrowserConnection({ ...options, reconnectDelayMs: 10, createSocket: () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  } });
  t.after(async () => { await service.disconnect(); });
  const publish = (port: number) => fs.writeFile(options.debugPortFile, `${port}\n${debugPath}\n`);
  async function nextSocket(count: number) {
    for (let i = 0; sockets.length < count && i < 100; i++) await delay(10);
    assert.equal(sockets.length, count);
    return sockets[count - 1]!;
  }
  function approve(socket: FakeSocket) {
    socket.open();
    socket.reply({ product: 'Chrome/fixture' });
  }

  await publish(9222);
  await service.connect();
  approve(await nextSocket(1));
  await fs.unlink(options.debugPortFile);
  sockets[0]!.close();
  assert.equal((await service.status()).phase, 'reconnecting');
  assert.equal(await service.taskEndpoint(5288), undefined);
  await publish(9333);
  (await nextSocket(2)).dispatchEvent(new Event('error'));
  await delay(60);
  assert.equal(sockets.length, 2, '拒绝连接后不能反复弹授权');
  await publish(9444);
  approve(await nextSocket(3));
  assert.equal((await service.status()).connectionVerified, true);
  sockets[2]!.close();
  await service.disconnect();
  await publish(9555);
  await delay(60);
  assert.equal(sockets.length, 3, '取消自动恢复后不发起新连接');
  assert.equal((await service.status()).phase, 'ready');
});


test('没有 agent-browser 仍可完成 Chrome 握手，工具缺失不伪造已验证状态', async t => {
  const options = await fixture(t);
  await fs.writeFile(options.debugPortFile, `9222\n${debugPath}\n`);
  const socket = new FakeSocket();
  const service = createBrowserConnection({ ...options, toolAvailable: async () => false, createSocket: () => socket });
  t.after(async () => { await service.disconnect(); });
  const ready = await service.status();
  assert.equal(ready.toolAvailable, false);assert.equal(ready.phase, 'ready');assert.equal(ready.connectionVerified, false);
  const connecting = await service.connect();assert.equal(connecting.phase, 'connecting');
  socket.open();socket.reply({ product: 'Chrome/fixture' });
  const connected = await service.status();assert.equal(connected.phase, 'connected');assert.equal(connected.connectionVerified, true);assert.equal(connected.toolAvailable, false);
});
