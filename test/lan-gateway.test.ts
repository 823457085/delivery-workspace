import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import { createLanGateway, lanInterfaces, sameSubnet } from '../server/lan-gateway.js';
import { proxySource } from '../server/source-proxy.js';

async function listen(t: TestContext, server: http.Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return (server.address() as { port: number }).port;
}

async function fixture(t: TestContext, allowedClients?: readonly string[]) {
  const received: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  let closeStream!: () => void;
  const streamClosed = new Promise<void>((resolve) => { closeStream = resolve; });
  const record = async (request: http.IncomingMessage, response: http.ServerResponse, url = request.url!) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    received.push({ url, headers: request.headers, body });
    response.writeHead(new URL(url, 'http://local').searchParams.has('conflict') ? 409 : 200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ accepted: true }));
  };
  const upstream = http.createServer(async (request, response) => {
    if (request.url === '/events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: {"ready":true}\n\n');
      response.once('close', closeStream);
    } else if (request.url?.startsWith('/api/source/')) {
      await proxySource(request, response, new URL(request.url, 'http://local'), { dispatch: record });
    } else { await record(request, response); }
  });
  const upstreamPort = await listen(t, upstream);
  const gateway = createLanGateway({ address: '127.0.0.1', netmask: '255.0.0.0' }, upstreamPort, allowedClients);
  const port = await listen(t, gateway);
  const base = `http://127.0.0.1:${port}`;
  const get = (url = '/agent', headers: Record<string, string> = {}) => fetch(`${base}${url}`, { headers });
  const post = (url: string, headers: Record<string, string> = {}, body = '{"test":true}') => fetch(`${base}${url}`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes', ...headers }, body,
  });
  return { base, get, post, received, upstreamPort, streamClosed };
}

test('only physical private LAN IPv4 interfaces are exposed', () => {
  const entry = (address: string, internal = false): os.NetworkInterfaceInfoIPv4 => ({ address, internal, family: 'IPv4', netmask: '255.255.255.0', mac: '', cidr: null });
  assert.deepEqual(lanInterfaces({ en0: [entry('192.168.1.5')], en7: [entry('172.20.100.50')], en8: [entry('10.2.3.4')], en9: [entry('8.8.8.8')], en10: [entry('172.32.0.1')], en11: [entry('10.0.0.1', true)], utun0: [entry('10.0.0.2')], lo0: [entry('127.0.0.1', true)] }), [
    { address: '192.168.1.5', netmask: '255.255.255.0' },
    { address: '172.20.100.50', netmask: '255.255.255.0' },
    { address: '10.2.3.4', netmask: '255.255.255.0' },
  ]);
});

test('clients must belong to the bound interface subnet', () => {
  const network = { address: '172.20.100.50', netmask: '255.255.255.0' };
  assert.equal(sameSubnet('172.20.100.10', network), true);
  assert.equal(sameSubnet('::ffff:172.20.100.10', network), true);
  for (const client of ['172.20.101.10', '8.8.8.8', '127.0.0.1', '::1', 'invalid']) assert.equal(sameSubnet(client, network), false);
});

test('VPN allowlist rejects unlisted peers even on the same subnet or with spoofed forwarding headers', async (t) => {
  const allowedClients = ['127.0.0.2'];
  const { get, post, received } = await fixture(t, allowedClients);
  // 修改原数组不能扩大已经启动的入口权限。
  allowedClients.push('127.0.0.1');
  const headers = { 'X-Forwarded-For': '127.0.0.2', 'X-Real-IP': '127.0.0.2', Forwarded: 'for=127.0.0.2' };
  assert.equal((await get('/agent', headers)).status, 403);
  assert.equal((await post('/api/workspace/browse', headers, '{}')).status, 403);
  assert.equal((await post('/api/source/merge-action', headers)).status, 403);
  assert.equal(received.length, 0);
});

test('an empty VPN allowlist never falls back to trusting the LAN subnet', async (t) => {
  const { get, received } = await fixture(t, []);
  assert.equal((await get()).status, 403);
  assert.equal(received.length, 0);
  assert.throws(() => createLanGateway({ address: '127.0.0.1', netmask: '255.0.0.0' }, 5199, ['127.0.0.0/8']), /独立 IPv4/);
});

test('authorized VPN peers keep password-free access, origin protection and explicit write confirmation', async (t) => {
  const { base, get, post, received } = await fixture(t, ['127.0.0.1']);
  const page = await get();
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('www-authenticate'), null);
  assert.equal((await get('/agent', { Origin: 'http://evil.test' })).status, 403);
  const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
    const request = http.get(base, { headers: { Host: 'evil.test' } }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(wrongHost, 403);
  assert.equal((await post('/api/workspace/browse', { Origin: '' }, '{}')).status, 403);
  assert.equal((await post('/api/source/merge-action', { 'X-Delivery-Confirmed': '' })).status, 403);
  assert.equal((await post('/api/source/merge-action')).status, 200);
  assert.equal(received.length, 2);
});

test('pages and APIs open without credentials or a browser login challenge', async (t) => {
  const { get, received } = await fixture(t);
  for (const url of ['/agent', '/api/agent-runtimes']) {
    const result = await get(url);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('www-authenticate'), null);
    assert.equal(result.headers.get('cache-control'), 'no-store');
  }
  // 之前浏览器缓存过的凭据不会再次触发登录，也不传给主服务。
  for (const value of ['Bearer invalid', 'Basic malformed', `Basic ${Buffer.from('delivery:old-password').toString('base64')}`]) {
    const result = await get('/agent', { Authorization: value });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('www-authenticate'), null);
  }
  assert.equal(received.length, 5);
  assert.equal(received.every((request) => request.headers.authorization === undefined), true);
});

test('password-free requests still reject rebinding hosts and foreign or missing write origins', async (t) => {
  const { base, get, post, received } = await fixture(t);
  for (const Origin of ['', 'null', 'http://evil.test', `${base}.evil.test`]) assert.equal((await post('/write', { Origin })).status, 403);
  assert.equal((await get('/agent', { Origin: 'http://evil.test' })).status, 403);
  assert.equal((await get('/agent', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const request = http.get(base, { headers: { Host: 'evil.test' } }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(status, 403);
  assert.equal(received.length, 0);
});

test('remote directory endpoints retain origin guards and do not proxy to native selection', async t => {
  const { get, post, received } = await fixture(t);
  for (const endpoint of ['/api/workspace/browse', '/api/workspace/select-directory']) {
    assert.equal((await get(endpoint)).status, 405);
    assert.equal((await post(endpoint, { Origin: 'http://evil.test' }, '{}')).status, 403);
    assert.equal((await post(endpoint, { Origin: '' }, '{}')).status, 403);
    assert.equal((await post(endpoint, {}, '{"path":"/"}')).status, 400);
  }
  assert.equal(received.length, 0);
});

test('forwards the original path, body and status without leaking credentials or spoofed proxy headers', async (t) => {
  const { post, received, upstreamPort } = await fixture(t);
  const body = '{"objective":"局域网测试"}';
  const response = await post('/test?conflict=1&page=2', { Forwarded: 'host=evil.test', 'X-Forwarded-For': '8.8.8.8', 'X-Real-IP': '8.8.8.8' }, body);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { accepted: true });
  assert.equal(received.length, 1);
  assert.equal(received[0].url, '/test?conflict=1&page=2');
  assert.equal(received[0].body, body);
  assert.equal(received[0].headers.host, `127.0.0.1:${upstreamPort}`);
  assert.equal(received[0].headers.origin, `http://127.0.0.1:${upstreamPort}`);
  for (const name of ['authorization', 'forwarded', 'x-forwarded-for', 'x-real-ip']) assert.equal(received[0].headers[name], undefined);
});

test('the existing backend confirmation and content-type protections still apply through the gateway', async (t) => {
  const { post, received } = await fixture(t);
  assert.equal((await post('/api/source/merge-action', { 'X-Delivery-Confirmed': '' })).status, 403);
  assert.equal((await post('/api/source/merge-action', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal(received.length, 0);
  assert.equal((await post('/api/source/merge-action')).status, 200);
  assert.equal(received.length, 1);
  assert.equal(received[0].url, '/api/automation/catchup/merge/actions');
  assert.equal(received[0].headers['x-delivery-confirmed'], 'yes');
});

test('SSE is streamed before completion and upstream closes when the client leaves', { timeout: 4000 }, async (t) => {
  const { base, streamClosed } = await fixture(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${base}/events`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('www-authenticate'), null);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const reader = response.body!.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.equal(new TextDecoder().decode(first.value), 'data: {"ready":true}\n\n');
  controller.abort();
  await streamClosed;
});

test('an unavailable local server produces 502 without crashing the LAN entry', async (t) => {
  const temporary = http.createServer();
  const unusedPort = await listen(t, temporary);
  await new Promise<void>((resolve) => temporary.close(() => resolve()));
  const gateway = createLanGateway({ address: '127.0.0.1', netmask: '255.0.0.0' }, unusedPort);
  const port = await listen(t, gateway);
  const response = await fetch(`http://127.0.0.1:${port}/agent`);
  assert.equal(response.status, 502);
  assert.equal(await response.text(), '本机工作台暂时不可用');
});
