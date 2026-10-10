/** 公网只读验收：不启动 Agent、不修改业务数据、不输出密码、Cookie 或工作区内容。 */
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import https from 'node:https';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';

const credentials = JSON.parse(await readFile(path.join(process.env.DELIVERY_REMOTE_CONFIG_DIR || path.join(os.homedir(), '.config/delivery-remote'), 'login.json'), 'utf8'));
const origin = new URL(credentials.url).origin;
const get = (pathname, options = {}) => new Promise((resolve, reject) => {
  const request = https.request(`${origin}${pathname}`, { method: options.method ?? 'GET', headers: { 'Accept-Encoding': 'gzip', ...options.headers }, signal: options.signal ?? AbortSignal.timeout(30_000) }, response => {
    const headers = Object.fromEntries(Object.entries(response.headers).filter(([, value]) => value !== undefined).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value]));
    const stream = response.headers['content-encoding'] === 'gzip' ? response.pipe(createGunzip()) : response;
    response.on('error', error => stream.destroy(error));
    resolve(new Response(Readable.toWeb(stream), { status: response.statusCode, headers }));
  });
  request.on('error', reject);
  request.end(options.body ? String(options.body) : undefined);
});
assert.equal((await get('/agent')).status, 303);
for (const endpoint of ['/api/health', '/api/agent-runtimes', '/api/agent-runtimes/events']) assert.equal((await get(endpoint)).status, 401);
console.log('PASS: 未登录页面跳转登录，业务和实时接口返回 401');
const login = await get('/remote/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: credentials.username, password: credentials.password }) });
assert.equal(login.status, 303);
const Cookie = login.headers.get('set-cookie').split(';')[0];
const headers = { Cookie, Origin: origin };
const home = await get('/agent', { headers });
assert.equal(home.status, 200);
assert.match(await home.text(), /id="app"/);
const health = await get('/api/health', { headers });
assert.equal(health.status, 200);
assert.equal((await health.json()).ok, true);
console.log('PASS: 真实密码登录、真实 Mac 页面和健康接口');
const started = Date.now();
const runtime = await get('/api/agent-runtimes', { headers });
assert.equal(runtime.status, 200);
assert.equal(typeof await runtime.json(), 'object');
console.log(`PASS: 工作台真实会话数据完整读取（${Date.now() - started}ms），未打印内容`);
for (const endpoint of ['/api/workspace/browse', '/api/workspace/select-directory']) {
  const result = await get(endpoint, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: os.homedir() }) });
  assert.equal(result.status, 200);
  const data = await result.json();
  assert.equal(data.path ?? data.workspacePath, os.homedir());
}
console.log('PASS: 远程列举和选择 Mac 目录，不启动任务');
assert.equal((await get('/api/workspace/browse', { method: 'POST', headers: { Cookie, Origin: 'https://evil.invalid', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 20_000);
try {
  const events = await get('/api/agent-runtimes/events', { headers, signal: controller.signal });
  assert.equal(events.status, 200);
  assert.match(events.headers.get('content-type'), /text\/event-stream/);
  const frame = await events.body.getReader().read();
  assert.match(new TextDecoder().decode(frame.value), /event: ready/);
  console.log('PASS: 真实 SSE 首帧到达，跨站请求被拒绝');
} finally { clearTimeout(timeout); controller.abort(); }
assert.equal((await get('/remote/logout', { method: 'POST', headers })).status, 303);
assert.equal((await get('/api/health', { headers })).status, 401);
console.log('PASS: 退出后旧会话不可重放；所有 HTTPS 请求使用默认受信任证书校验');
