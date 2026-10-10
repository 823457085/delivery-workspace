import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { createGateway, passwordRecord } from './gateway.mjs';

const origin = 'https://192.0.2.1:8443';
const password = 'test-password-not-a-real-credential';
const credentials = await passwordRecord('admin', password);
async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return server.address().port;
}
async function fixture(t) {
  let clock = 1;
  const received = [];
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ready\n\n'); return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push({ headers: req.headers, path: req.url, body });
    res.writeHead(req.url === '/conflict' ? 409 : 200, { 'Content-Type': 'application/json', 'Set-Cookie': 'upstream=secret' });
    res.end('{"ok":true}');
  });
  const upstreamPort = await listen(t, upstream);
  const gateway = createGateway({ origin, upstreamPort, macHost: '127.0.0.1:5220', ...credentials }, { now: () => clock });
  t.after(() => gateway.close());
  const port = await listen(t, http.createServer(gateway.handler));
  function request(path, { method = 'GET', body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: { Host: new URL(origin).host, ...headers } }, res => {
        const chunks = [];
        res.on('data', chunk => { chunks.push(chunk); });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString(), raw: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end(body);
    });
  }
  const login = (value = password, headers = {}) => request('/remote/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams({ username: 'admin', password: value }).toString() });
  const cookie = result => result.headers['set-cookie'][0].split(';')[0];
  return { request, login, cookie, received, port, advance: ms => { clock += ms; }, expire: () => { clock += 13 * 60 * 60 * 1000; }, stopUpstream: () => new Promise(resolve => upstream.close(resolve)) };
}

test('every page, asset and API requires authentication; login has restrictive CSP', async t => {
  const { request, received } = await fixture(t);
  for (const path of ['/agent', '/assets/index.js', '/.env', '/remote/logout']) {
    const result = await request(path);
    assert.equal(result.status, 303);
    assert.equal(result.headers.location, '/remote/login');
  }
  assert.equal((await request('/api/agent-runtimes')).status, 401);
  const login = await request('/remote/login');
  assert.equal(login.status, 200);
  assert.match(login.text, /type="password"/);
  assert.match(login.headers['content-security-policy'], /form-action 'self'/);
  assert.equal(login.headers['referrer-policy'], 'same-origin');
  assert.equal(received.length, 0);
});

test('host, cross-site login, forged forwarding headers and missing origin are rejected', async t => {
  const { login, request, received } = await fixture(t);
  for (const headers of [{ Origin: '' }, { Origin: 'https://evil.test' }, { 'Sec-Fetch-Site': 'cross-site' }, { Host: 'evil.test' }]) assert.equal((await login(password, headers)).status, 403);
  assert.equal((await request('/api/agent-runtimes', { headers: { Authorization: 'Basic bogus', 'X-Forwarded-For': '127.0.0.1', 'X-Forwarded-Host': 'localhost:5199' } })).status, 401);
  assert.equal(received.length, 0);
});

test('external top-level links reach only the public login page, not business resources', async t => {
  const { request, login, cookie, received } = await fixture(t);
  const Cookie = cookie(await login());
  for (const site of ['cross-site', 'same-site']) {
    const headers = { 'Sec-Fetch-Site': site, 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', Cookie };
    const page = await request('/remote/login', { headers });
    assert.equal(page.status, 200);
    assert.match(page.text, /登录工作台/);
    assert.doesNotMatch(page.text, /已登录/);
    for (const path of ['/', '/agent']) {
      const result = await request(path, { headers });
      assert.equal(result.status, 303);
      assert.equal(result.headers.location, '/remote/login');
    }
    for (const path of ['/api/agent-runtimes', '/assets/index.js', '/remote/logout']) assert.equal((await request(path, { headers })).status, 403);
    assert.equal((await login(password, headers)).status, 403);
    assert.equal((await request('/remote/login', { headers: { ...headers, 'Sec-Fetch-Dest': 'iframe' } })).status, 403);
    assert.equal((await request('/remote/login', { headers: { ...headers, 'Sec-Fetch-Mode': 'cors' } })).status, 403);
    assert.equal((await request('/remote/login', { headers: { ...headers, Host: 'evil.test' } })).status, 403);
  }
  assert.equal(received.length, 0);
});

test('password validation and brute-force limit do not leak account existence', async t => {
  const { login } = await fixture(t);
  for (let i = 0; i < 5; i++) {
    const result = await login('incorrect');
    assert.equal(result.status, 401);
    assert.match(result.text, /账号或密码错误/);
  }
  assert.equal((await login()).status, 429);
  assert.equal((await login(password, { 'X-Forwarded-For': '8.8.8.8' })).status, 429);
});

test('secure sessions forward exact payloads without credentials and keep write confirmation', async t => {
  const { request, login, cookie, received } = await fixture(t);
  const result = await login();
  assert.equal(result.status, 303);
  assert.match(result.headers['set-cookie'][0], /HttpOnly; Secure; SameSite=Strict/);
  const Cookie = cookie(result);
  assert.equal((await request('/api/write', { method: 'POST', headers: { Cookie, Origin: origin } })).status, 403);
  const response = await request('/conflict', { method: 'POST', headers: { Cookie, Origin: origin, 'X-Delivery-Confirmed': 'yes', Authorization: 'Bearer not-forwarded', 'X-Forwarded-For': 'evil', 'Content-Type': 'application/json' }, body: '{"test":1}' });
  assert.equal(response.status, 409);
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(received[0].headers.host, '127.0.0.1:5220');
  assert.equal(received[0].headers.origin, 'http://127.0.0.1:5220');
  for (const key of ['cookie', 'authorization', 'x-forwarded-for']) assert.equal(received[0].headers[key], undefined);
  assert.equal(received[0].body, '{"test":1}');
});

test('logout revokes session, refuses GET mutation and expired cookies cannot be replayed', async t => {
  const { request, login, cookie, expire } = await fixture(t);
  const Cookie = cookie(await login());
  assert.equal((await request('/remote/logout', { headers: { Cookie } })).status, 405);
  assert.equal((await request('/remote/logout', { method: 'POST', headers: { Cookie, Origin: origin } })).status, 303);
  assert.equal((await request('/api/list', { headers: { Cookie } })).status, 401);
  const fresh = cookie(await login());
  expire();
  assert.equal((await request('/api/list', { headers: { Cookie: fresh } })).status, 401);
});

test('authenticated read-only directory selection does not require mutation confirmation', async t => {
  const { request, login, cookie, received } = await fixture(t);
  const Cookie = cookie(await login());
  for (const path of ['/api/workspace/browse', '/api/workspace/select-directory']) {
    assert.equal((await request(path, { method: 'POST', headers: { Cookie, Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 200);
    assert.equal((await request(path, { method: 'POST', headers: { Cookie }, body: '{}' })).status, 403);
  }
  assert.equal(received.length, 2);
});

test('remember login is opt-in, expires after 30 days and remains revocable', async t => {
  const { request, login, cookie, advance } = await fixture(t);
  const page = await request('/remote/login');
  assert.match(page.text, /autocomplete="current-password"/);
  assert.match(page.text, /name="remember" type="checkbox" value="yes"/);
  assert.doesNotMatch(page.text, /\bchecked\b/);
  const regular = await login();
  assert.match(regular.headers['set-cookie'][0], /Max-Age=43200/);
  const rememberedLogin = () => request('/remote/login', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password, remember: 'yes' }).toString(),
  });
  const remembered = await rememberedLogin();
  assert.match(remembered.headers['set-cookie'][0], /HttpOnly; Secure; SameSite=Strict; Max-Age=2592000/);
  const Cookie = cookie(remembered);
  advance(13 * 60 * 60 * 1000);
  assert.equal((await request('/api/list', { headers: { Cookie: cookie(regular) } })).status, 401);
  assert.equal((await request('/api/list', { headers: { Cookie } })).status, 200);
  advance(30 * 24 * 60 * 60 * 1000 - 13 * 60 * 60 * 1000);
  assert.equal((await request('/api/list', { headers: { Cookie } })).status, 401);
  const fresh = cookie(await rememberedLogin());
  await request('/remote/logout', { method: 'POST', headers: { Cookie: fresh, Origin: origin } });
  assert.equal((await request('/api/list', { headers: { Cookie: fresh } })).status, 401);
});

test('SSE streams immediately and logout closes the existing stream', { timeout: 5000 }, async t => {
  const { port, request, login, cookie } = await fixture(t);
  const Cookie = cookie(await login());
  let disconnected;
  const closed = new Promise(resolve => { disconnected = resolve; });
  await new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/events', headers: { Host: new URL(origin).host, Cookie, 'Accept-Encoding': 'gzip' } }, res => {
      assert.equal(res.headers['content-encoding'], undefined);
      res.once('data', chunk => { assert.equal(String(chunk), 'data: ready\n\n'); resolve(); });
      res.on('close', disconnected);
    });
    req.on('error', reject);
  });
  await request('/remote/logout', { method: 'POST', headers: { Cookie, Origin: origin } });
  await closed;
});

test('authenticated JSON supports gzip without changing content or buffering SSE', async t => {
  const { request, login, cookie } = await fixture(t);
  const result = await request('/api/data', { headers: { Cookie: cookie(await login()), 'Accept-Encoding': 'gzip' } });
  assert.equal(result.status, 200);
  assert.equal(result.headers['content-encoding'], 'gzip');
  assert.equal(result.headers['content-length'], undefined);
  assert.equal(gunzipSync(result.raw).toString(), '{"ok":true}');
});

test('offline Mac fails closed with 502, without exposing internal details', async t => {
  const { stopUpstream, request, login, cookie } = await fixture(t);
  const Cookie = cookie(await login());
  await stopUpstream();
  const result = await request('/agent', { headers: { Cookie } });
  assert.equal(result.status, 502);
  assert.match(result.text, /Mac 暂时离线/);
});
