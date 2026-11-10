import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { createAgentGroupChatRoutes } from '../server/agent-group-chat-routes.js';

test('群聊重跑动作校验请求标识和原轮次，保留同源保护及旧动作兼容', async () => {
  const roomId = randomUUID(), roundId = randomUUID(), calls: unknown[][] = [];
  const json = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value));
  };
  const route = createAgentGroupChatRoutes({ action: async (...args: unknown[]) => { calls.push(args); return { accepted: true }; } } as never, {
    json, port: 5288, body: async request => {
      const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      return JSON.parse(Buffer.concat(chunks).toString());
    },
  });
  const server = createServer(async (request, response) => {
    try { await route(request, response, new URL(request.url!, 'http://localhost')); }
    catch (error) { json(response, 400, { message: error instanceof Error ? error.message : 'invalid' }); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/api/agent-runtimes/group-chat/rooms/${roomId}/action`;
  const headers = { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes', Origin: 'http://localhost:5288' };
  const body = { action: 'rerun', requestId: 'same-room-rerun', roundId };
  try {
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })).status, 200);
    assert.deepEqual(calls[0], [roomId, 'rerun', { requestId: body.requestId, roundId }]);
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...body, accessMode: 'full' }) })).status, 200);
    assert.deepEqual(calls[1], [roomId, 'rerun', { requestId: body.requestId, roundId, accessMode: 'full' }]);
    for (const invalid of [{ action: 'rerun' }, { action: 'rerun', requestId: 'missing-round' }, { ...body, workspacePath: '/other/project' }]) {
      assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify(invalid) })).status, 400);
    }
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://example.com' }, body: JSON.stringify(body) })).status, 403);
    assert.equal(calls.length, 2);
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ action: 'pause' }) })).status, 200);
    assert.deepEqual(calls[2], [roomId, 'pause', undefined]);
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ action: 'continue', accessMode: 'workspace' }) })).status, 200);
    assert.deepEqual(calls[3], [roomId, 'continue', { accessMode: 'workspace' }]);
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ action: 'pause', accessMode: 'full' }) })).status, 400);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('成员重试只接收当前成员和运行标识，拒绝参数扩展及跨站请求', async () => {
  const roomId = randomUUID(), turnId = randomUUID(), runId = randomUUID(), calls: unknown[][] = [];
  const json = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value));
  };
  const route = createAgentGroupChatRoutes({ retryAndContinue: async (...args: unknown[]) => { calls.push(args); return { accepted: true }; } } as never, {
    json, port: 5288, body: async request => {
      const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      return JSON.parse(Buffer.concat(chunks).toString());
    },
  });
  const server = createServer(async (request, response) => {
    try { await route(request, response, new URL(request.url!, 'http://localhost')); }
    catch (error) { json(response, 400, { message: error instanceof Error ? error.message : 'invalid' }); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/api/agent-runtimes/group-chat/rooms/${roomId}/retry`;
  const headers = { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes', Origin: 'http://localhost:5288' };
  try {
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ turnId, runId }) })).status, 200);
    assert.deepEqual(calls[0], [roomId, { turnId, runId }]);
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ turnId, runId, accessMode: 'full' }) })).status, 200);
    assert.deepEqual(calls[1], [roomId, { turnId, runId, accessMode: 'full' }]);
    for (const input of [{ turnId }, { turnId: 'invalid', runId }, { turnId, runId, provider: 'codex' }, { turnId, runId, accessMode: 'root' }]) {
      assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify(input) })).status, 400);
    }
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://example.com' }, body: JSON.stringify({ turnId, runId }) })).status, 403);
    assert.equal(calls.length, 2);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
