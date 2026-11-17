import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile, chmod } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTaskFlowBridgeRoute, ensureTaskFlowBridgeToken } from '../server/taskflow-bridge.js';

const body = async (request: http.IncomingMessage, limit = 1024) => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > limit) throw new Error('too large'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};
const json = (response: http.ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
};

async function startRoute(token: string) {
  const runs = new Map<string, { id: string; status: string; result: string; error: string; updatedAt: string; resultReady?: boolean; key: string; input: unknown }>();
  const calls: string[] = [];
  const runtime = {
    getTaskFlowRun: (runId: string, key: string) => { const run = runs.get(runId); return run && run.key === key ? run : undefined; },
    startTaskFlow: async (input: { runId: string; key: string }) => {
      calls.push('start');
      const run = { id: input.runId, status: 'running', result: '分析中', error: '', updatedAt: new Date().toISOString(), key: input.key, input };
      runs.set(input.runId, run);
      return run;
    },
    stop: async (id: string) => { calls.push('stop'); const run = runs.get(id)!; run.status = 'cancelled'; return run; },
  };
  const route = createTaskFlowBridgeRoute({ token, runtime: runtime as never, body, json });
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!await route(request, response, url)) json(response, 404, {});
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const send = (value: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/taskflow/bridge`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(value),
  });
  return { runs, calls, send, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

const start = (runId: string, key: string, overrides: Record<string, unknown> = {}) => ({
  action: 'start', runId, key, provider: 'codex', mode: 'read', title: 'WRK-1 任务分析', objective: '分析任务', workspacePath: '',
  taskFlowUrl: `https://39.107.12.20/#view=tasks&task=${randomUUID()}`, ...overrides,
});

test('bridge token is created private once and reused without rewriting', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tf-bridge-token-'));
  try {
    const first = await ensureTaskFlowBridgeToken(path.join(directory, 'taskflow-bridge'));
    const second = await ensureTaskFlowBridgeToken(path.join(directory, 'taskflow-bridge'));
    assert.equal(first.token, second.token);
    assert.equal((await stat(first.file)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(first.file))).mode & 0o777, 0o700);
    await chmod(first.file, 0o644);
    await assert.rejects(ensureTaskFlowBridgeToken(path.join(directory, 'taskflow-bridge')), /权限不安全/);
    await writeFile(first.file, 'short\n', { mode: 0o600 });
    await chmod(first.file, 0o600);
    await assert.rejects(ensureTaskFlowBridgeToken(path.join(directory, 'taskflow-bridge')), /内容无效/);
    assert.equal((await readFile(first.file, 'utf8')).trim(), 'short');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('bridge route starts, reads and stops a TaskFlow workbench run for a token holder with an https hub link', async () => {
  const hub = await startRoute('a'.repeat(43));
  try {
    const runId = randomUUID(); const key = 'b'.repeat(64);
    let response = await hub.send(start(runId, key));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).run.status, 'running');
    response = await hub.send(start(runId, key));
    assert.equal(hub.calls.filter(call => call === 'start').length, 1);
    response = await hub.send({ action: 'read', runId, key });
    assert.equal((await response.json()).run.output, '分析中');
    response = await hub.send({ action: 'read', runId, key: 'c'.repeat(64) });
    assert.equal(response.status, 404);
    response = await hub.send({ action: 'stop', runId, key });
    const stopped = (await response.json()).run;
    assert.equal(stopped.status, 'cancelled');
    assert.match(stopped.workbenchUrl, new RegExp(`/agent\\?session=${runId}`));
  } finally { await hub.close(); }
});

test('bridge route rejects missing or wrong tokens, browser-origin calls, cookies, non-hub links and unknown fields', async () => {
  const hub = await startRoute('a'.repeat(43));
  try {
    const runId = randomUUID(); const key = 'd'.repeat(64);
    assert.equal((await hub.send(start(runId, key), { Authorization: '' })).status, 401);
    assert.equal((await hub.send(start(runId, key), { Authorization: `Bearer ${'z'.repeat(43)}` })).status, 401);
    assert.equal((await hub.send(start(runId, key), { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await hub.send(start(runId, key), { Cookie: 'sid=1' })).status, 403);
    assert.equal((await hub.send(start(runId, key, { taskFlowUrl: 'http://evil.example/#view=tasks&task=x' }))).status, 400);
    assert.equal((await hub.send(start(runId, key, { taskFlowUrl: 'javascript:alert(1)//#view=tasks' }))).status, 400);
    assert.equal((await hub.send({ ...start(runId, key), shell: 'rm -rf /' })).status, 400);
    assert.equal(hub.calls.length, 0);
  } finally { await hub.close(); }
});
