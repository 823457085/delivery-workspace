import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type http from 'node:http';
import { createWorkspaceRestart, createWorkspaceRestartRoute, restartTaskActive } from '../server/workspace-restart.js';
import type { WorkspaceRestartState } from '../shared/workspace-restart.js';

type RestartOptions = Parameters<typeof createWorkspaceRestart>[0];
function restartFixture(t: TestContext, options: Partial<RestartOptions> = {}) {
  const calls = { available: 0, blockers: 0, hold: 0, release: 0, restart: 0 };
  const service = createWorkspaceRestart({
    available: async () => { calls.available++; return true; },
    blockers: async () => { calls.blockers++; return []; },
    hold: () => { calls.hold++; return () => { calls.release++; }; },
    restart: async () => { calls.restart++; },
    intervalMs: 5, idleChecks: 2, ...options,
  });
  t.after(async () => { service.close(); await service.idle(); });
  return { service, calls };
}
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 800;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('重启测试未在 800ms 内达到预期状态');
}

test('活动任务状态兼容大小写，未启动合入 pending 可单独排除', () => {
  for (const status of ['queued', 'QUEUED', 'dispatching', 'DISPATCHING', 'dispatched', 'DISPATCHED', 'running', 'RUNNING']) {
    assert.equal(restartTaskActive(status), true);
    assert.equal(restartTaskActive(status, false), true);
  }
  for (const status of ['pending', 'PENDING']) {
    assert.equal(restartTaskActive(status), true);
    assert.equal(restartTaskActive(status, false), false);
  }
  for (const status of ['idle', 'completed', 'BLOCKED', 'HOLD', undefined]) {
    assert.equal(restartTaskActive(status), false);
    assert.equal(restartTaskActive(status, false), false);
  }
});

test('等待现有任务自然结束，期间不封锁请求，空闲后再重启', async t => {
  let checks = 0;
  let running = true;
  const { service, calls } = restartFixture(t, {
    blockers: async () => { checks++; return running ? ['Agent 运行中'] : []; },
  });
  assert.equal((await service.request()).status, 'waiting');
  await until(() => checks >= 3);
  const state = await service.dashboard();
  assert.equal(state.status, 'waiting');
  assert.match(state.message, /Agent 运行中/);
  assert.equal(service.isRestarting(), false);
  assert.equal(calls.hold, 0);
  assert.equal(calls.restart, 0);
  running = false;
  await until(() => calls.restart === 1);
  assert.equal(calls.hold, 1);
});

test('重复重启请求共用等待状态，只检查一次托管状态且只重启一次', async t => {
  const { service, calls } = restartFixture(t);
  const states = await Promise.all(Array.from({ length: 5 }, () => service.request()));
  for (const state of states) assert.deepEqual(state, states[0]);
  assert.equal(calls.blockers, 0);
  assert.equal(calls.available, 1);
  await until(() => calls.restart === 1);
  assert.equal((await service.request()).status, 'restarting');
  assert.equal(calls.blockers, 3);
  assert.equal(calls.hold, 1);
  assert.equal(calls.restart, 1);
  assert.equal(service.isRestarting(), true);
});

test('显式等待空闲跳过暂停准备，重复的默认请求不打断原任务', async t => {
  let checks = 0, prepared = 0, running = true;
  const { service, calls } = restartFixture(t, {
    prepare: async () => { prepared++; running = false; },
    blockers: async () => { checks++; return running ? ['Agent 运行中'] : []; },
  });
  assert.match((await service.request('when-idle')).message, /等待当前任务结束/);
  await Promise.all([service.request(), service.request('when-idle')]);
  await until(() => checks >= 3);
  assert.equal(running, true);
  assert.equal(prepared, 0);
  assert.equal(calls.hold, 0);
  assert.equal(calls.restart, 0);
  assert.equal(service.isRestarting(), false);
  running = false;
  await until(() => calls.restart === 1);
  assert.equal(prepared, 0);
  assert.equal(calls.hold, 1);
  assert.equal(service.isRestarting(), true);
});

test('只更新页面时共用同一次构建，Agent 仍可运行', async t => {
  let updates = 0;
  let finish!: (value: 'refresh') => void;
  const build = new Promise<'refresh'>(resolve => { finish = resolve; });
  const { service, calls } = restartFixture(t, {
    update: async () => { updates++; return build; },
    prepare: async () => assert.fail('页面更新不应暂停任务'),
  });
  const states = await Promise.all([service.request(), service.request()]);
  assert.equal(states[0].status, 'building');
  assert.deepEqual(states[0], states[1]);
  await until(() => updates === 1);
  assert.equal(service.isRestarting(), false);
  finish('refresh');
  await service.idle();
  assert.equal((await service.dashboard()).status, 'idle');
  assert.equal(calls.blockers, 0);
  assert.equal(calls.hold, 0);
  assert.equal(calls.restart, 0);
});

test('构建失败后可重试，只有构建成功才保存任务并进入重启', async t => {
  const events: string[] = [];
  let fail = true;
  const { service, calls } = restartFixture(t, {
    update: async () => {
      events.push('build');
      if (fail) throw new Error('构建失败');
      return 'restart';
    },
    prepare: async () => { events.push('prepare'); },
  });
  assert.equal((await service.request()).status, 'building');
  await until(async () => (await service.dashboard()).status === 'failed');
  assert.deepEqual(events, ['build']);
  assert.equal(calls.hold, 0);
  assert.equal(calls.restart, 0);
  fail = false;
  assert.equal((await service.request()).status, 'building');
  await until(() => calls.restart === 1);
  assert.deepEqual(events, ['build', 'build', 'prepare']);
});

test('立即重启先保存并暂停任务，封住新请求，重复点击只准备和重启一次', async t => {
  const events: string[] = [];
  let running = true;
  const { service, calls } = restartFixture(t, {
    idleChecks: 1,
    prepare: async () => { events.push('prepare'); running = false; },
    blockers: async () => { events.push('check'); return running ? ['Agent 运行中'] : []; },
    hold: () => { events.push('hold'); return () => { events.push('release'); }; },
    restart: async () => { events.push('restart'); calls.restart++; },
  });
  await Promise.all([service.request(), service.request('when-idle')]);
  assert.equal(service.isRestarting(), true);
  await until(() => calls.restart === 1);
  assert.deepEqual(events, ['hold', 'prepare', 'check', 'check', 'restart']);
  assert.equal((await service.request()).status, 'restarting');
});

test('保存任务失败时释放维护并允许重试，失败期间不重启', async t => {
  let failed = true, prepared = 0;
  const { service, calls } = restartFixture(t, {
    idleChecks: 1,
    prepare: async () => { prepared++; if (failed) throw new Error('暂停任务失败'); },
  });
  await service.request();
  await until(async () => (await service.dashboard()).status === 'failed');
  assert.equal(calls.restart, 0);
  assert.equal(calls.release, 1);
  assert.equal(service.isRestarting(), false);
  failed = false;
  await service.request();
  await until(() => calls.restart === 1);
  assert.equal(prepared, 2);
});

test('准备后校验失败，重试会重新保存期间新增的任务', async t => {
  let failed = true, prepared = 0;
  const { service, calls } = restartFixture(t, {
    idleChecks: 1,
    prepare: async () => { prepared++; },
    blockers: async () => { if (failed) throw new Error('任务状态读取失败'); return []; },
  });
  await service.request();
  await until(async () => (await service.dashboard()).status === 'failed');
  assert.equal(prepared, 1);
  assert.equal(calls.restart, 0);
  failed = false;
  await service.request();
  await until(() => calls.restart === 1);
  assert.equal(prepared, 2);
});

test('仅连续空闲达到阈值才进入维护，并在重启前再次核对', async t => {
  const events: string[] = [];
  let checks = 0;
  const { service } = restartFixture(t, {
    idleChecks: 3,
    blockers: async () => { events.push(`check:${++checks}`); return checks === 2 ? ['排队中'] : []; },
    hold: () => { events.push('hold'); return () => { events.push('release'); }; },
    restart: async () => { events.push('restart'); },
  });
  await service.request();
  await until(() => events.includes('restart'));
  assert.deepEqual(events, ['check:1', 'check:2', 'check:3', 'check:4', 'check:5', 'hold', 'check:6', 'restart']);
});

test('维护后发现晚到任务会释放维护并继续等待，任务结束后才重启', async t => {
  const events: string[] = [];
  let held = false, busy = true;
  const { service } = restartFixture(t, {
    idleChecks: 1,
    blockers: async () => held && busy || events.includes('release') && busy ? ['晚到任务'] : [],
    hold: () => { held = true; events.push('hold'); return () => { held = false; events.push('release'); }; },
    restart: async () => { events.push('restart'); },
  });
  await service.request();
  await until(async () => (await service.dashboard()).message.includes('晚到任务'));
  assert.equal((await service.dashboard()).status, 'waiting');
  assert.equal(service.isRestarting(), false);
  assert.deepEqual(events, ['hold', 'release']);
  busy = false;
  await until(() => events.includes('restart'));
  assert.deepEqual(events, ['hold', 'release', 'hold', 'restart']);
});

test('显式等待空闲发现晚到任务时恢复等待，不转为暂停任务', async t => {
  const events: string[] = [];
  let held = false, busy = true;
  const { service } = restartFixture(t, {
    idleChecks: 1,
    prepare: async () => { events.push('prepare'); },
    blockers: async () => held && busy || events.includes('release') && busy ? ['晚到任务'] : [],
    hold: () => { held = true; events.push('hold'); return () => { held = false; events.push('release'); }; },
    restart: async () => { events.push('restart'); },
  });
  await service.request('when-idle');
  await until(async () => (await service.dashboard()).message.includes('晚到任务'));
  assert.equal((await service.dashboard()).status, 'waiting');
  assert.equal(service.isRestarting(), false);
  assert.deepEqual(events, ['hold', 'release']);
  busy = false;
  await until(() => events.includes('restart'));
  assert.deepEqual(events, ['hold', 'release', 'hold', 'restart']);
});

test('读取阻塞状态失败不重启并释放维护，重试成功后再执行', async t => {
  let held = false, failRead = true, releases = 0, restarts = 0;
  const { service } = restartFixture(t, {
    idleChecks: 1,
    blockers: async () => { if (held && failRead) throw new Error('状态读取失败'); return []; },
    hold: () => { held = true; return () => { held = false; releases++; }; },
    restart: async () => { restarts++; },
  });
  await service.request();
  await until(async () => (await service.dashboard()).status === 'failed');
  assert.equal((await service.dashboard()).message, '状态读取失败');
  assert.equal(releases, 1);
  assert.equal(restarts, 0);
  assert.equal(service.isRestarting(), false);
  failRead = false;
  assert.equal((await service.request()).status, 'waiting');
  await until(() => restarts === 1);
  assert.equal((await service.dashboard()).status, 'restarting');
});

test('非托管服务返回 unavailable，不执行任何空闲检查或重启', async t => {
  const { service, calls } = restartFixture(t, { available: async () => false });
  const state = await service.dashboard();
  assert.equal(state.status, 'unavailable');
  assert.match(state.message, /PM2/);
  assert.deepEqual(await service.request(), state);
  assert.equal(calls.blockers, 0);
  assert.equal(calls.hold, 0);
  assert.equal(calls.restart, 0);
});

const port = 5199;
function routeFixture(state: WorkspaceRestartState = { status: 'waiting', message: '等待空闲', startedAt: 'fixture' }) {
  const calls: string[] = [];
  const modes: ('when-idle' | undefined)[] = [];
  const handler = createWorkspaceRestartRoute({
    dashboard: async () => { calls.push('dashboard'); return state; },
    request: async mode => { calls.push('request'); modes.push(mode); return state; },
  });
  async function request(options: { method?: string; body?: unknown; raw?: string; host?: string;
    origin?: string | null; confirmed?: string | null; contentType?: string; remote?: string } = {}) {
    const req = Object.assign(Readable.from([options.raw ?? JSON.stringify(options.body ?? {})]), {
      url: '/api/workspace/restart', method: options.method ?? 'POST',
      headers: { host: options.host ?? `127.0.0.1:${port}`,
        ...(options.origin === null ? {} : { origin: options.origin ?? `http://127.0.0.1:${port}` }),
        ...(options.confirmed === null ? {} : { 'x-delivery-confirmed': options.confirmed ?? 'yes' }),
        'content-type': options.contentType ?? 'application/json' },
      socket: { remoteAddress: options.remote ?? '127.0.0.1' },
    }) as unknown as http.IncomingMessage;
    let status = 0, headers: Record<string, string> = {}, body = '';
    const res = { writeHead: (code: number, value: Record<string, string>) => { status = code; headers = value; },
      end: (value: string) => { body = value; } } as unknown as http.ServerResponse;
    await handler(req, res, port);
    return { status, headers, body: JSON.parse(body) };
  }
  return { request, calls, modes };
}

test('重启路由只接受本机回环与可信 Host，GET 只读且拒绝跨源', async () => {
  const { request, calls } = routeFixture();
  for (const remote of ['192.168.1.2', '203.0.113.10', '']) assert.equal((await request({ method: 'GET', remote })).status, 403);
  for (const host of ['evil.test:5199', 'localhost.evil.test:5199', '127.0.0.1:3000', '']) {
    assert.equal((await request({ method: 'GET', host })).status, 403);
  }
  assert.equal((await request({ method: 'GET', origin: 'https://evil.test' })).status, 403);
  assert.deepEqual(calls, []);
  for (const remote of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const response = await request({ method: 'GET', remote, origin: null, confirmed: null });
    assert.equal(response.status, 200);
    assert.equal(response.headers['Cache-Control'], 'no-store');
  }
  assert.deepEqual(calls, ['dashboard', 'dashboard', 'dashboard']);
});

test('重启 POST 要求同源确认，拒绝命令、未知模式或其他参数', async () => {
  const { request, calls } = routeFixture();
  for (const origin of [null, '', 'null', 'https://evil.test', 'http://localhost:5199']) {
    assert.equal((await request({ origin })).status, 403);
  }
  for (const confirmed of [null, '', 'true', 'YES']) assert.equal((await request({ confirmed })).status, 403);
  for (const contentType of ['text/plain', 'application/jsonp', '']) assert.equal((await request({ contentType })).status, 415);
  for (const body of [[], 'restart', { command: 'pm2 restart other' }, { process: 'other' }, { force: true },
    { mode: 'immediate' }, { mode: null }, { mode: true }, { mode: 'when-idle', force: true }]) {
    const response = await request({ body });
    assert.equal(response.status, 400);
    assert.equal(response.body.message, '输入格式不正确');
  }
  for (const raw of ['null', '{invalid']) assert.equal((await request({ raw })).status, 400);
  assert.equal((await request({ raw: JSON.stringify({ command: '中'.repeat(400) }) })).status, 413);
  assert.equal((await request({ method: 'DELETE' })).status, 405);
  assert.deepEqual(calls, []);
  assert.equal((await request({ body: {}, contentType: 'application/json; charset=utf-8' })).status, 202);
  assert.equal((await request({ host: 'localhost:5199', origin: 'http://localhost:5199' })).status, 202);
  assert.deepEqual(calls, ['request', 'request']);
});

test('重启路由原样传递等待空闲模式，空对象保留默认行为', async () => {
  const { request, calls, modes } = routeFixture();
  assert.equal((await request({ body: { mode: 'when-idle' } })).status, 202);
  assert.equal((await request({ body: {} })).status, 202);
  assert.deepEqual(calls, ['request', 'request']);
  assert.deepEqual(modes, ['when-idle', undefined]);
});

test('非托管服务的重启请求返回 503，状态仍可读取', async () => {
  const { request, calls } = routeFixture({ status: 'unavailable', message: '未托管', startedAt: 'fixture' });
  assert.equal((await request({ method: 'GET', origin: null, confirmed: null })).status, 200);
  const response = await request();
  assert.equal(response.status, 503);
  assert.equal(response.body.status, 'unavailable');
  assert.deepEqual(calls, ['dashboard', 'request']);
});
