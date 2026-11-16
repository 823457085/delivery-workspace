import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createBrowserConnectionRoute } from '../server/browser-connection-route.js';
import type { BrowserConnectionStatus } from '../shared/browser-connection.js';

test('Chrome连接API只允许本机同源固定动作，不接受地址或跨站连接请求', async t => {
  const calls: string[] = [];
  const state: BrowserConnectionStatus = {
    phase: 'setup_required', message: '请开启调试', checkedAt: new Date().toISOString(),
    toolAvailable: true, chromeAvailable: true, debuggingEnabled: false,
    connectionVerified: false, settingsUrl: 'chrome://inspect/#remote-debugging', reuseEnabled: true,
  };
  const method = (name: string) => async () => { calls.push(name); return state; };
  let route: ReturnType<typeof createBrowserConnectionRoute>;
  const server = http.createServer(async (request, response) => {
    try {
      if (!await route(request, response, new URL(request.url!, 'http://localhost'))) {
        response.writeHead(404); response.end();
      }
    } catch { response.writeHead(400); response.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  route = createBrowserConnectionRoute({ status: method('status'), openSettings: method('settings'),
    connect: method('connect'), disconnect: method('disconnect') }, {
    port,
    json: (response, status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(value));
    },
    body: async request => { let text = ''; for await (const chunk of request) text += chunk; return JSON.parse(text); },
  });
  const read = await fetch(`${origin}/api/browser/connection`);
  assert.equal(read.status, 200);
  assert.equal((await read.json()).connectionVerified, false);
  assert.equal(read.headers.get('cache-control'), 'no-store');
  const post = (action: string, headers: Record<string, string>, body = '{}') =>
    fetch(`${origin}/api/browser/connection/${action}`, { method: 'POST', headers, body });
  assert.equal((await post('connect', { 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await post('connect', { Origin: 'https://untrusted.invalid', 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await post('connect', { Origin: origin, 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post('connect', { Origin: origin, 'Content-Type': 'application/json' }, '{"url":"http://untrusted.invalid"}')).status, 400);
  const foreignHostStatus = await new Promise<number>(resolve => {
    http.get(`${origin}/api/browser/connection`, { headers: { Host: 'untrusted.invalid' } }, response => {
      response.resume(); resolve(response.statusCode!);
    });
  });
  assert.equal(foreignHostStatus, 403);
  assert.deepEqual(calls, ['status'], '拒绝请求不得触发浏览器动作');
  for (const action of ['open-settings', 'connect', 'disconnect']) {
    assert.equal((await post(action, { Origin: origin, 'Content-Type': 'application/json' })).status, 200);
  }
  assert.deepEqual(calls, ['status', 'settings', 'connect', 'disconnect']);
  assert.equal((await fetch(`${origin}/api/browser/connection/connect`)).status, 405);
  assert.equal((await post('unknown', { Origin: origin, 'Content-Type': 'application/json' })).status, 404);
});
