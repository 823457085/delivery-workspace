import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type http from 'node:http';
import { createCursorAccountsRoute } from '../server/cursor-accounts-route.js';
import type { AccountProvider, CursorAccountAction, CursorAccountsDashboard } from '../shared/cursor-accounts.js';

const base = '/api/agent-runtimes/cursor-accounts';
const port = 5199;
const state: CursorAccountsDashboard = { provider: 'cursor', available: true, accounts: [], current: null, pendingRecovery: false,
  activePids: [], blockedReason: '', checkedAt: 'fixture', operation: null };
function fixture(provider: AccountProvider = 'cursor') {
  const calls: unknown[][] = [];
  const handler = createCursorAccountsRoute({
    dashboard: async (refresh = false) => { calls.push(['dashboard', refresh]); return { ...state, provider }; },
    start: async (action: CursorAccountAction, name?: string) => { calls.push(['start', action, name]); return { ...state, provider }; },
    cancel: async (id: string) => { calls.push(['cancel', id]); return { ...state, provider }; },
  }, provider);
  const request = async (options: { path?: string; method?: string; body?: unknown; raw?: string;
    host?: string; origin?: string | null; confirmed?: string | null; contentType?: string; remote?: string } = {}) => {
    const stream = Readable.from([options.raw ?? JSON.stringify(options.body ?? {})]);
    const req = Object.assign(stream, { url: options.path ?? base, method: options.method ?? 'POST',
      headers: { host: options.host ?? `127.0.0.1:${port}`,
        ...(options.origin === null ? {} : { origin: options.origin ?? `http://127.0.0.1:${port}` }),
        ...(options.confirmed === null ? {} : { 'x-delivery-confirmed': options.confirmed ?? 'yes' }),
        'content-type': options.contentType ?? 'application/json' },
      socket: { remoteAddress: options.remote ?? '127.0.0.1' } }) as unknown as http.IncomingMessage;
    let status = 0, headers: Record<string, string> = {}, body = '';
    const res = { writeHead: (code: number, values: Record<string, string>) => { status = code; headers = values; },
      end: (value: string) => { body = value; } } as unknown as http.ServerResponse;
    await handler(req, res, port);
    return { status, headers, body: JSON.parse(body) };
  };
  return { request, calls };
}

test('账号路由仅接受本机回环与可信Host，读取不触发变更且禁止跨源', async () => {
  const { request, calls } = fixture();
  for (const remote of ['192.168.1.20', '203.0.113.20', '']) assert.equal((await request({ method: 'GET', remote })).status, 403);
  for (const host of ['evil.test:5199', '127.0.0.1:3000', 'localhost.evil.test:5199', '']) {
    assert.equal((await request({ method: 'GET', host })).status, 403);
  }
  assert.equal((await request({ method: 'GET', origin: 'https://evil.test' })).status, 403);
  assert.deepEqual(calls, []);
  for (const remote of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const response = await request({ method: 'GET', origin: null, confirmed: null, remote });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, state);
    assert.equal(response.headers['Cache-Control'], 'no-store');
  }
  await request({ method: 'GET', path: `${base}?refresh=1`, confirmed: null });
  await request({ method: 'GET', path: `${base}?refresh=true`, confirmed: null });
  assert.deepEqual(calls, [['dashboard', false], ['dashboard', false], ['dashboard', false], ['dashboard', true], ['dashboard', false]]);
});

test('账号写操作要求匹配Origin、确认头、JSON媒体类型，不接受命令注入或未知字段', async () => {
  const { request, calls } = fixture();
  for (const origin of [null, '', 'null', 'https://evil.test', 'http://localhost:5199']) {
    assert.equal((await request({ path: `${base}/save`, body: { name: 'work' }, origin })).status, 403);
  }
  for (const confirmed of [null, '', 'true', 'YES']) {
    assert.equal((await request({ path: `${base}/save`, body: { name: 'work' }, confirmed })).status, 403);
  }
  for (const contentType of ['text/plain', 'text/application/json', 'application/jsonp', '']) {
    assert.equal((await request({ path: `${base}/save`, body: { name: 'work' }, contentType })).status, 415);
  }
  for (const body of [[], 'work', {}, { name: '' }, { name: '../work' }, { name: 'work;whoami' },
    { name: 'x'.repeat(41) }, { name: 'work', command: 'login' }]) {
    const response = await request({ path: `${base}/login`, body });
    assert.equal(response.status, 400);
    assert.equal(response.body.message, '输入格式不正确');
  }
  assert.equal((await request({ path: `${base}/save`, raw: '{invalid' })).status, 400);
  assert.equal((await request({ path: `${base}/save`, raw: 'null' })).status, 400);
  assert.equal((await request({ path: `${base}/save`, raw: JSON.stringify({ name: '中'.repeat(400) }) })).status, 413);
  assert.equal((await request({ path: `${base}/restore`, body: { name: 'work' } })).status, 400);
  assert.equal((await request({ path: `${base}/cancel`, body: { operationId: 'bad' } })).status, 400);
  assert.equal((await request({ method: 'DELETE' })).status, 405);
  assert.equal((await request({ path: `${base}/run`, body: {} })).status, 404);
  assert.equal((await request({ path: '/other/cursor-accounts/save', body: { name: 'work' } })).status, 404);
  assert.deepEqual(calls, []);
});

test('合法保存登录切换删除恢复与取消精确转发；只读GET操作路径不执行命令', async () => {
  const { request, calls } = fixture();
  for (const action of ['save', 'login', 'use', 'delete']) {
    const response = await request({ path: `${base}/${action}`, body: { name: 'work_2' }, contentType: 'application/json; charset=utf-8' });
    assert.equal(response.status, 202);
    assert.deepEqual(response.body, state);
  }
  assert.equal((await request({ path: `${base}/restore`, body: {} })).status, 202);
  const operationId = 'ef0d0161-a03f-42c6-a873-a52713657ec8';
  assert.equal((await request({ path: `${base}/cancel`, body: { operationId } })).status, 200);
  assert.equal((await request({ method: 'GET', path: `${base}/login`, origin: null, confirmed: null })).status, 405);
  assert.equal((await request({ path: `${base}/save`, body: { name: 'local' }, host: 'localhost:5199', origin: 'http://localhost:5199' })).status, 202);
  assert.deepEqual(calls, [['start', 'save', 'work_2'], ['start', 'login', 'work_2'], ['start', 'use', 'work_2'], ['start', 'delete', 'work_2'],
    ['start', 'restore', undefined], ['cancel', operationId], ['start', 'save', 'local']]);
});


test('三个账号平台新路由各自转发，旧 Cursor 别名仅由 Cursor 处理', async () => {
  for (const provider of ['cursor', 'codex', 'claude'] as const) {
    const { request, calls } = fixture(provider);
    const currentBase = `/api/agent-runtimes/accounts/${provider}`;
    const fetched = await request({ method: 'GET', path: currentBase, origin: null, confirmed: null });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.provider, provider);
    assert.equal((await request({ path: `${currentBase}/save`, body: { name: 'work' } })).status, 202);
    assert.equal((await request({ path: `${currentBase}/delete`, body: { name: '@previous' } })).status, 400);
    assert.equal((await request({ path: `${currentBase}/delete`, body: { name: 'work' }, confirmed: null })).status, 403);
    assert.equal((await request({ path: `${currentBase}/delete`, body: { name: 'work' } })).status, 202);
    assert.deepEqual(calls, [['dashboard', false], ['start', 'save', 'work'], ['start', 'delete', 'work']]);
    assert.equal((await request({ method: 'GET', path: '/api/agent-runtimes/accounts/unknown', origin: null })).status, 404);
    const other = provider === 'cursor' ? 'codex' : 'cursor';
    assert.equal((await request({ path: `/api/agent-runtimes/accounts/${other}/login`, body: { name: 'work' } })).status, 404);
    assert.equal((await request({ method: 'GET', path: base, origin: null })).status, provider === 'cursor' ? 200 : 404);
  }
});
