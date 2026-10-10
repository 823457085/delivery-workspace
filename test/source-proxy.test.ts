import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { proxySource, WRITE_ROUTES } from '../server/source-proxy.js';

async function fixture(t: TestContext) {
  const received: { url: string; origin?: string; body: string }[] = [];
  let base = '';
  const backend = {
    dispatch: async (request: http.IncomingMessage, response: http.ServerResponse, target: string) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      received.push({ url: target, origin: request.headers.origin, body });
      const status = new URL(target, 'http://embedded').searchParams.get('status');
      if (status === 'throw') throw new Error('embedded failure');
      response.writeHead(Number(status || 200), {
        'Content-Type': 'application/json',
        'X-Delivery-Source': 'Delivery-Unified',
      });
      response.end(JSON.stringify({ message: status === '409' ? 'Catchup state changed, refresh and retry' : 'embedded accepted' }));
    },
  };
  const gateway = http.createServer(async (request, response) => {
    try { await proxySource(request, response, new URL(request.url!, `http://127.0.0.1:${request.socket.localPort}`), backend); }
    catch (error) { response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ message: String(error) })); }
  });
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
  t.after(async () => {
    gateway.closeAllConnections();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
  });
  const post = (key: string, overrides: Record<string, string> = {}, body = '{"fixture":true}') => fetch(`${base}/api/source/${key}`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes', ...overrides }, body,
  });
  return { base, post, received };
}

test('all confirmed writes enter the embedded backend without a 5188 network hop', async (t) => {
  const { base, post, received } = await fixture(t);
  for (const [key, path] of Object.entries(WRITE_ROUTES)) {
    const response = await post(key);
    assert.equal(response.status, 200, `${key}: ${await response.text()}`);
    assert.deepEqual(received.at(-1), { url: path, origin: base, body: '{"fixture":true}' });
    assert.equal(response.headers.get('x-delivery-source'), 'Delivery-Unified');
  }
});

test('source writes fail closed for missing or foreign origin, bad host, missing confirmation and non-JSON input', async (t) => {
  const { post, received, base } = await fixture(t);
  const rejectedHeaders: Record<string, string>[] = [
    { Origin: '' }, { Origin: 'https://evil.test' }, { Origin: 'http://localhost:1' },
    { Origin: 'http://localhost.evil.test:5199' }, { 'X-Delivery-Confirmed': '' },
  ];
  for (const headers of rejectedHeaders) assert.equal((await post('merge-action', headers)).status, 403, JSON.stringify(headers));
  const badHost = await new Promise<number | undefined>((resolve, reject) => {
    const request = http.request(`${base}/api/source/merge-action`, { method: 'POST', headers: { Host: 'evil.test', Origin: base, 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' } }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end('{}');
  });
  assert.equal(badHost, 403);
  assert.equal((await post('merge-action', { 'Content-Type': 'application/json-malicious' })).status, 415);
  assert.equal(received.length, 0);
  assert.equal((await post('merge-action', { Origin: base.replace('127.0.0.1', 'localhost'), 'Content-Type': 'application/json; charset=utf-8' })).status, 200);
});

test('embedded backend statuses are preserved without retries', async (t) => {
  const { post, received } = await fixture(t);
  for (const status of [400, 409, 503]) {
    const response = await post(`merge-action?status=${status}`);
    assert.equal(response.status, status);
    if (status === 409) assert.match(await response.text(), /refresh and retry/);
  }
  assert.equal(received.length, 3);
});

test('reads remain mapped and unmapped routes never enter the backend', async (t) => {
  const { base, received } = await fixture(t);
  const response = await fetch(`${base}/api/source/evidence?requirementId=REQ-001&filename=test.png`);
  assert.equal(response.status, 200);
  assert.equal(received[0].origin, undefined);
  assert.equal(received[0].url, '/api/automation/catchup/merge/evidence?requirementId=REQ-001&filename=test.png');
  assert.equal((await fetch(`${base}/api/source/constructor`)).status, 400);
  assert.equal(received.length, 1);
});

test('an embedded handler failure does not crash the gateway', async (t) => {
  const { post } = await fixture(t);
  assert.equal((await post('merge-action?status=throw')).status, 400);
  assert.equal((await post('merge-action')).status, 200);
});
