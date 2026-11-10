import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type http from 'node:http';
import { createJenkinsDeploymentsRoute } from '../server/jenkins-deployments-route.js';

const port = 5199;
const runId = '2fca9bbb-741c-4b4e-a163-e809edfe385a';
function fixture(yunxiao?: Parameters<typeof createJenkinsDeploymentsRoute>[1]) {
  const calls: unknown[][] = [];
  const reply = async (name: string, ...args: unknown[]) => { calls.push([name, ...args]); return { ok: true }; };
  const service = {
    snapshot: async () => ({ ...await reply('snapshot'), projects: [] }), jobs: () => reply('jobs'), saveConfig: (value: unknown) => reply('config', value),
    checkConnection: () => reply('check'), saveBinding: (value: unknown) => reply('binding', value), saveManualBinding: (value: unknown) => reply('manual', value), deleteBinding: (value: unknown) => reply('delete', value),
    startRun: (value: unknown) => reply('start', value), getRun: (id: string) => reply('run', id), log: (id: string, offset: number) => reply('log', id, offset),
  } as unknown as Parameters<typeof createJenkinsDeploymentsRoute>[0];
  const route = createJenkinsDeploymentsRoute(service, yunxiao);
  async function request(options: { path?: string; method?: string; body?: unknown; raw?: string; host?: string; origin?: string | null;
    confirmed?: string | null; contentType?: string; remote?: string } = {}) {
    const stream = Readable.from([options.raw ?? JSON.stringify(options.body ?? {})]);
    const req = Object.assign(stream, { url: options.path ?? '/api/deployments/config', method: options.method ?? 'POST',
      headers: { host: options.host ?? `127.0.0.1:${port}`, 'content-type': options.contentType ?? 'application/json',
        ...(options.origin === null ? {} : { origin: options.origin ?? `http://127.0.0.1:${port}` }),
        ...(options.confirmed === null ? {} : { 'x-delivery-confirmed': options.confirmed ?? 'yes' }) },
      socket: { remoteAddress: options.remote ?? '127.0.0.1' } }) as unknown as http.IncomingMessage;
    let status = 0, body = '', headers: Record<string, string> = {};
    const res = { writeHead: (code: number, values: Record<string, string>) => { status = code; headers = values; },
      end: (value: string) => { body = value; } } as unknown as http.ServerResponse;
    await route(req, res, port);
    return { status, headers, body: JSON.parse(body) };
  }
  return { calls, request };
}

test('部署路由拒绝非本机 socket/Host/跨源，GET 不需要确认头且无缓存', async () => {
  const f = fixture();
  for (const remote of ['192.168.1.1', '203.0.113.2', '']) assert.equal((await f.request({ method: 'GET', path: '/api/deployments', remote })).status, 403);
  for (const host of ['evil.test:5199', 'localhost.evil.test:5199', '127.0.0.1:3000', '']) assert.equal((await f.request({ method: 'GET', path: '/api/deployments', host })).status, 403);
  for (const origin of ['https://evil.test', 'null', 'http://localhost:5199']) assert.equal((await f.request({ method: 'GET', path: '/api/deployments', origin })).status, 403);
  assert.deepEqual(f.calls, []);
  for (const remote of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const response = await f.request({ method: 'GET', path: '/api/deployments', origin: null, confirmed: null, remote });
    assert.equal(response.status, 200);
    assert.equal(response.headers['Cache-Control'], 'no-store');
  }
  assert.deepEqual(f.calls, [['snapshot'], ['snapshot'], ['snapshot']]);
});

test('云效部署同样校验来源与确认头，只转发当前页面的明确提交', async () => {
  const calls: string[] = [];
  const cloud = { saveConfig: async () => { calls.push('config'); return { hasToken: true }; },
    prepare: async () => { calls.push('prepare'); return { name: '流水线', sources: [] }; },
    startRun: async () => { calls.push('start'); return { id: runId }; },
    getRun: async () => { calls.push('run'); return { id: runId }; },
  } as unknown as Parameters<typeof createJenkinsDeploymentsRoute>[1];
  const f = fixture(cloud);
  for (const path of ['/api/deployments/yunxiao/config', '/api/deployments/yunxiao/prepare', '/api/deployments/yunxiao/runs']) {
    assert.equal((await f.request({ path, confirmed: null })).status, 403);
    assert.equal((await f.request({ path, origin: 'https://evil.test' })).status, 403);
  }
  assert.deepEqual(calls, []);
  assert.equal((await f.request({ path: '/api/deployments/yunxiao/config' })).status, 200);
  assert.equal((await f.request({ path: '/api/deployments/yunxiao/prepare' })).status, 200);
  assert.equal((await f.request({ path: '/api/deployments/yunxiao/runs' })).status, 202);
  assert.equal((await f.request({ method: 'GET', path: `/api/deployments/yunxiao/runs/${runId}` })).status, 200);
  assert.deepEqual(calls, ['config', 'prepare', 'start', 'run']);
});

test('部署写操作严格要求Origin/确认头/JSON/体积，不解析任意路径或越界日志offset', async () => {
  const f = fixture();
  for (const origin of [null, '', 'null', 'https://evil.test', 'http://localhost:5199']) assert.equal((await f.request({ origin })).status, 403);
  for (const confirmed of [null, '', 'true', 'YES']) assert.equal((await f.request({ confirmed })).status, 403);
  for (const contentType of ['', 'text/plain', 'application/jsonp', 'text/application/json']) assert.equal((await f.request({ contentType })).status, 415);
  assert.equal((await f.request({ raw: '中'.repeat(34_000) })).status, 413);
  assert.equal((await f.request({ raw: 'invalid-json' })).status, 400);
  assert.equal((await f.request({ path: '/other/deployments/config' })).status, 404);
  assert.equal((await f.request({ method: 'DELETE' })).status, 405);
  assert.equal((await f.request({ path: '/api/deployments/connection/check', body: { deploy: true } })).status, 400);
  for (const offset of ['-1', '1.1', 'a', '1e10', '9007199254740992']) {
    assert.equal((await f.request({ method: 'GET', path: `/api/deployments/runs/${runId}/log?start=${offset}` })).status, 400);
  }
  assert.deepEqual(f.calls, []);
});

test('部署API精确转发，未知路由不触发服务，响应为直接契约对象', async () => {
  const f = fixture();
  const cases = [
    { path: '/api/deployments/config', method: 'POST', body: { baseUrl: 'https://jenkins.test', username: 'u', token: 'test' }, expected: ['config', { baseUrl: 'https://jenkins.test', username: 'u', token: 'test' }] },
    { path: '/api/deployments/connection/check', method: 'POST', body: {}, expected: ['check'] },
    { path: '/api/deployments/jobs', method: 'GET', expected: ['jobs'] },
    { path: '/api/deployments/bindings', method: 'POST', body: { projectId: 'a' }, expected: ['binding', { projectId: 'a' }] },
    { path: '/api/deployments/bindings/delete', method: 'POST', body: { id: runId }, expected: ['delete', { id: runId }] },
    { path: '/api/deployments/runs', method: 'POST', body: { bindingId: runId }, expected: ['start', { bindingId: runId }] },
    { path: `/api/deployments/runs/${runId}`, method: 'GET', expected: ['run', runId] },
    { path: `/api/deployments/runs/${runId}/log?start=15`, method: 'GET', expected: ['log', runId, 15] },
  ];
  for (const item of cases) {
    const response = await f.request(item);
    assert.equal(response.status, item.path === '/api/deployments/runs' ? 202 : 200);
    assert.deepEqual(response.body, { ok: true });
    assert.deepEqual(f.calls.at(-1), item.expected);
  }
  const count = f.calls.length;
  for (const path of ['/api/deployments/jobs/../../deployments/unknown', '/api/deployments/runs/bad', '/api/deployments/runs/test/log', '/api/deployments/not-found']) {
    assert.equal((await f.request({ path, method: 'GET' })).status, 404);
  }
  assert.equal(f.calls.length, count);
  assert.equal((await f.request({ host: 'localhost:5199', origin: 'http://localhost:5199' })).status, 200);
});

test('手动关联和云效日志仍限制本机来源；新增关联不触发部署', async () => {
  const calls: unknown[][] = [];
  const cloud = {
    links: async () => [{ id: 'project' }],
    saveManualBinding: async (input: unknown) => { calls.push(['manual', input]); return { url: 'https://flow.aliyun.com/pipelines/123/current' }; },
    log: async (...args: unknown[]) => { calls.push(['log', ...args]); return { text: 'L_RAW 日志', nextOffset: 10, moreData: true }; },
  } as unknown as Parameters<typeof createJenkinsDeploymentsRoute>[1];
  const f = fixture(cloud);
  for (const confirmed of [null, 'true']) assert.equal((await f.request({ path: '/api/deployments/bindings/manual', confirmed })).status, 403);
  assert.equal((await f.request({ path: '/api/deployments/bindings/manual', origin: 'https://evil.test' })).status, 403);
  assert.equal((await f.request({ method: 'GET', path: '/api/deployments/links' })).status, 200);
  const input = { projectId: 'project', environment: 'test', url: 'https://jenkins.test/job/demo/' };
  const manual = await f.request({ path: '/api/deployments/bindings/manual', body: input });
  assert.equal(manual.status, 200); assert.deepEqual(manual.body, { provider: 'jenkins', binding: { ok: true } });
  assert.deepEqual(f.calls, [['manual', input]]);
  const cloudInput = { ...input, url: 'https://flow.aliyun.com/pipelines/123/current' };
  const cloudManual = await f.request({ path: '/api/deployments/bindings/manual', body: cloudInput });
  assert.equal(cloudManual.status, 200); assert.equal(cloudManual.body.provider, 'yunxiao');
  assert.deepEqual(f.calls.at(-1), ['snapshot']);
  assert.equal((await f.request({ path: '/api/deployments/bindings/manual', body: { ...input, deploy: true } })).status, 400);
  const logPath = `/api/deployments/yunxiao/runs/${runId}/log`;
  for (const query of ['jobId=bad', 'jobId=7&start=-1', 'jobId=7&start=9007199254740992']) {
    assert.equal((await f.request({ method: 'GET', path: `${logPath}?${query}` })).status, 400);
  }
  assert.equal((await f.request({ method: 'GET', path: `${logPath}?jobId=7&start=5`, origin: 'https://evil.test' })).status, 403);
  const log = await f.request({ method: 'GET', path: `${logPath}?jobId=7&start=5` });
  assert.equal(log.status, 200); assert.equal(log.body.text, 'L_RAW 日志');
  assert.deepEqual(calls, [['manual', cloudInput], ['log', runId, '7', 5]]);
});
