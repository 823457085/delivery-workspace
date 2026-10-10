import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { forkCodexThread, runCodexLiveTurn, type LiveSteer } from '../server/codex-live-turn.js';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import type { AgentRun } from '../shared/agent-runtime.js';
import { codexWriterHeldMessage } from '../shared/codex-session-error.js';

const fixture = path.resolve('test/fixtures/codex-live-server.mjs');
const sample: AgentRun = { id: 'test', provider: 'codex', mode: 'ask', accessMode: 'workspace', model: '', reasoningEffort: '',
  objective: 'test', workspacePath: os.tmpdir(), branch: '', headSha: '', status: 'running', sessionId: '', pid: null,
  result: '', error: '', events: [], createdAt: '', updatedAt: '' };

test('Codex 可在指定已完成轮次无消息分叉，且不启动新用户轮次', { timeout: 5000 }, async () => {
  const sessionId = await forkCodexThread(fixture, { sessionId: '11111111-1111-1111-1111-111111111111',
    lastTurnId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', workspacePath: os.tmpdir(),
    mode: 'ask', accessMode: 'workspace', model: '', reasoningEffort: '' });
  assert.equal(sessionId, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
});

test('分叉必须返回新线程和精确历史轮次，失败时不启动用户轮次', { timeout: 5000 }, async () => {
  for (const [turnId, expected] of [
    ['cccccccc-cccc-cccc-cccc-cccccccccccc', /独立会话 ID/],
    ['dddddddd-dddd-dddd-dddd-dddddddddddd', /指定的历史轮次/],
  ] as const) {
    let sessionUpdates = 0;
    await assert.rejects(runCodexLiveTurn(fixture, { run: sample,
      forkSessionId: '11111111-1111-1111-1111-111111111111', forkLastTurnId: turnId,
      imagePaths: [], signal: new AbortController().signal, onPid() {}, onSession() { sessionUpdates++; }, onEvent() {},
    }, 'new user turn'), expected);
    assert.equal(sessionUpdates, 0);
  }
});

test('Codex 完成回执须等待轮次 ID 持久化', { timeout: 5000 }, async () => {
  let release!: () => void;
  let recorded = false;
  const recording = new Promise<void>(resolve => { release = resolve; });
  const pending = runCodexLiveTurn(fixture, { run: sample, resumeSessionId: '11111111-1111-1111-1111-111111111111',
    imagePaths: [], signal: new AbortController().signal, onPid() {}, onSession() {}, onEvent() {},
    onTurn: async () => { recorded = true; await recording; },
  }, 'original');
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  for (let attempt = 0; attempt < 50 && !recorded; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(recorded, true);
  assert.equal(settled, false);
  release();
  await pending;
  assert.equal(settled, true);
});

test('Codex 每轮按选中的速度档位覆盖全局配置，历史运行仍沿用原配置', { timeout: 5000 }, async () => {
  for (const serviceTier of ['default', 'priority', undefined] as const) {
    const result = await runCodexLiveTurn(fixture, { run: { ...sample, serviceTier }, imagePaths: [],
      signal: new AbortController().signal, onPid() {}, onSession() {}, onEvent() {},
    }, 'speed-tier-test');
    const args = (JSON.parse(result) as { args: string[] }).args;
    const tierFlags = args.filter(value => value.startsWith('service_tier='));
    assert.deepEqual(tierFlags, serviceTier ? [`service_tier="${serviceTier}"`] : []);
  }
});

test('Codex 原会话有 active writer 时显示可操作的中文提示', { timeout: 5000 }, async () => {
  let sessionId = '';
  await assert.rejects(runCodexLiveTurn(fixture, { run: sample, resumeSessionId: 'original-session', imagePaths: [],
    signal: new AbortController().signal, onPid() {}, onSession(id) { sessionId = id; }, onEvent() {},
  }, 'writer-busy'), (error: unknown) => {
    assert.match(String(error), /原会话的写入权.*未必有任务运行/);
    assert.doesNotMatch(String(error), /12345678-1234-1234-1234-123456789abc|active writer/);
    return true;
  });
  assert.equal(sessionId, 'original-session');
});

test('归档的原 Codex 会话恢复后只续接一次并启动一轮', { timeout: 5000 }, async () => {
  const id = '11111111-1111-1111-1111-111111111111';
  let sessionId = '';
  const result = await runCodexLiveTurn(fixture, { run: sample, resumeSessionId: id, imagePaths: [],
    signal: new AbortController().signal, onPid() {}, onSession(value) { sessionId = value; }, onEvent() {},
  }, 'original');
  assert.equal(sessionId, id);
  assert.deepEqual(JSON.parse(result), { threadId: id,
    requests: ['thread/resume', 'thread/unarchive', 'thread/resume', 'turn/start'] });
});

test('取消归档被拒绝时不启动 Codex 轮次', { timeout: 5000 }, async () => {
  let sessionId = '';
  await assert.rejects(runCodexLiveTurn(fixture, { run: sample,
    resumeSessionId: '22222222-2222-2222-2222-222222222222', imagePaths: [],
    signal: new AbortController().signal, onPid() {}, onSession(value) { sessionId = value; }, onEvent() {},
  }, 'original'), /restore denied/);
  assert.equal(sessionId, '');
});

test('取消归档返回其他会话 ID 时不启动 Codex 轮次', { timeout: 5000 }, async () => {
  let sessionId = '';
  await assert.rejects(runCodexLiveTurn(fixture, { run: sample,
    resumeSessionId: '55555555-5555-5555-5555-555555555555', imagePaths: [],
    signal: new AbortController().signal, onPid() {}, onSession(value) { sessionId = value; }, onEvent() {},
  }, 'original'), /恢复归档会话返回的 ID 不一致/);
  assert.equal(sessionId, '');
});

test('占用和其他会话的归档错误均不触发取消归档', { timeout: 5000 }, async () => {
  for (const [id, expected] of [
    ['33333333-3333-3333-3333-333333333333', /原会话的写入权/],
    ['44444444-4444-4444-4444-444444444444', /11111111-1111-1111-1111-111111111111 is archived/],
  ] as const) {
    let sessionId = '';
    await assert.rejects(runCodexLiveTurn(fixture, { run: sample, resumeSessionId: id, imagePaths: [],
      signal: new AbortController().signal, onPid() {}, onSession(value) { sessionId = value; }, onEvent() {},
    }, 'original', async () => { throw new Error(codexWriterHeldMessage); }), expected);
    assert.equal(sessionId, '');
  }
});

test('只有原会话 resume 的精确 writer 冲突才切换桌面续接，保持会话与请求不变', { timeout: 5000 }, async () => {
  const id = '33333333-3333-3333-3333-333333333333';
  let calls = 0;
  let session = '';
  const context = { run: sample, resumeSessionId: id, imagePaths: ['/tmp/image.png'], signal: new AbortController().signal,
    onPid() {}, onSession(value: string) { session = value; }, onEvent() {} };
  const result = await runCodexLiveTurn(fixture, context, 'unchanged prompt', async (forwarded, prompt) => {
    calls++;
    assert.equal(forwarded, context); assert.equal(prompt, 'unchanged prompt');
    forwarded.onSession(id);
    return 'desktop completed';
  });
  assert.equal(result, 'desktop completed'); assert.equal(calls, 1); assert.equal(session, id);
  await assert.rejects(runCodexLiveTurn(fixture, context, 'writer-busy', async () => { throw new Error('desktop refused'); }), /desktop refused/);
  let invalidFallback = 0;
  await assert.rejects(runCodexLiveTurn(fixture, { ...context, resumeSessionId: 'original-session' }, 'writer-busy',
    async () => { invalidFallback++; return ''; }), /写入权/);
  assert.equal(invalidFallback, 0);
});

test('历史 writer 错误在服务端迁移文案，保留状态、会话和诊断事件', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-writer-migration-'));
  const old = 'Codex 原会话已有正在执行的任务，请等待其完成或结束后重新执行';
  const diagnostic = { id: 'event', type: 'diagnostic', message: old, createdAt: '' };
  await fs.writeFile(path.join(directory, 'agent-runs.json'), JSON.stringify([
    { ...sample, id: 'legacy', status: 'failed', error: old, sessionId: 'original-session', events: [diagnostic] },
    { ...sample, id: 'raw', status: 'failed', error: 'thread 33333333-3333-3333-3333-333333333333 already has an active writer' },
    { ...sample, id: 'cursor', provider: 'cursor', status: 'failed', error: old },
  ]));
  const service = await createAgentRuntimeService(directory, { adapters: [] });
  try {
    const runs = (await service.dashboard()).runs;
    assert.equal(runs.find(run => run.id === 'legacy')?.error, codexWriterHeldMessage);
    assert.equal(runs.find(run => run.id === 'raw')?.error, codexWriterHeldMessage);
    assert.equal(runs.find(run => run.id === 'cursor')?.error, old);
    const saved = JSON.parse(await fs.readFile(path.join(directory, 'agent-runs.json'), 'utf8'));
    const legacy = saved.find((run: AgentRun) => run.id === 'legacy');
    assert.equal(legacy.status, 'failed'); assert.equal(legacy.sessionId, 'original-session');
    assert.deepEqual(legacy.events, [diagnostic]);
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('Codex 超过 30 分钟及数小时仍可插入，直到正常完成或用户中断', { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const stop of [false, true]) {
    const controller = new AbortController();
    let ready!: (steer: LiveSteer) => void;
    const available = new Promise<LiveSteer>(resolve => { ready = resolve; });
    const running = runCodexLiveTurn(fixture, { run: sample, imagePaths: [], signal: controller.signal,
      onPid() {}, onSession() {}, onEvent() {}, onSteer(value) { if (value) ready(value); } }, 'long-running');
    const settled = running.catch(error => error as Error);
    try {
      const steer = await available;
      t.mock.timers.tick(31 * 60_000);
      t.mock.timers.tick(3 * 60 * 60_000);
      if (stop) { controller.abort(); assert.match(String(await settled), /中断/); }
      else {
        await steer({ id: 'after-hours', text: 'complete', imagePaths: [] });
        assert.equal(JSON.parse(await running).input[0].text, 'complete');
      }
    } finally { controller.abort(); await settled; }
  }
});

test('正文增量在当前轮结束前可见，保留空白、隔离消息并以完成消息为准', { timeout: 5000 }, async () => {
  const controller = new AbortController();
  const outputs: string[] = [];
  let streamed!: () => void;
  const received = new Promise<void>(resolve => { streamed = resolve; });
  let steer!: LiveSteer;
  let finished = false;
  const running = runCodexLiveTurn(fixture, { run: sample, imagePaths: [], signal: controller.signal,
    onPid() {}, onSession() {}, onEvent() {}, onSteer(value) { if (value) steer = value; },
    onOutput(value) { outputs.push(value); if (value === '最终') streamed(); },
  }, 'stream-test').then(value => { finished = true; return value; });
  try {
    await received;
    assert.equal(finished, false);
    assert.deepEqual(outputs, ['第一段 ', '第一段 \n继续', '第一段 \n继续', '最终']);
    await steer({ id: 'end', text: 'complete', imagePaths: [] });
    const result = await running;
    assert.equal(outputs.at(-1), result);
    assert.equal(JSON.parse(result).input[0].text, 'complete');
  } finally { controller.abort(); await running.catch(() => {}); }
});

test('完成通知先于插入回执时，仍正确确认送达；中断可关闭持久在线连接', { timeout: 5000 }, async () => {
  await fs.chmod(fixture, 0o755);
  for (const mode of ['completion-before-ack', 'abort']) {
    const controller = new AbortController();
    let ready!: (steer: LiveSteer) => void;
    const available = new Promise<LiveSteer>(resolve => { ready = resolve; });
    const running = runCodexLiveTurn(fixture, { run: sample, imagePaths: [], signal: controller.signal,
      onPid() {}, onSession() {}, onEvent() {}, onSteer(steer) { if (steer) ready(steer); } }, 'original');
    const settled = running.catch(error => error as Error);
    try {
      const deliver = await available;
      if (mode === 'abort') { controller.abort(); assert.match(String(await settled), /中断/); }
      else {
        await deliver({ id: 'race', text: mode, imagePaths: [] });
        assert.equal(JSON.parse(await running).input[0].text, mode);
      }
    } finally { controller.abort(); await settled; }
  }
});

test('app-server 实时插入使用同一个 thread/turn，保留图片且无需结束当前轮', { timeout: 5000 }, async () => {
  await fs.chmod(fixture, 0o755);
  let deliver!: LiveSteer;
  let ready!: () => void;
  const available = new Promise<void>(resolve => { ready = resolve; });
  const controller = new AbortController();
  const running = runCodexLiveTurn(fixture, { run: sample, resumeSessionId: 'original-session', imagePaths: [], signal: controller.signal,
    onPid() {}, onSession(id) { assert.equal(id, 'original-session'); }, onEvent() {},
    onSteer(steer) { if (steer) { deliver = steer; ready(); } },
  }, 'original');
  try {
    await available;
    await assert.rejects(deliver({ id: 'rejected', text: 'reject', imagePaths: [] }), /already completed/);
    await deliver({ id: 'supplement', text: 'focus on tests', imagePaths: ['/tmp/image.png'] });
    const result = JSON.parse(await running);
    assert.equal(result.threadId, 'original-session');
    assert.equal(result.expectedTurnId, 'turn-live-test');
    assert.equal(result.input[1].path, '/tmp/image.png');
    assert.equal(controller.signal.aborted, false);
    await assert.rejects(deliver({ id: 'late', text: 'late', imagePaths: [] }), /结束/);
  } finally { controller.abort(); await running.catch(() => {}); }
});

test('实时补充写入原轮、沿用权限，发送仍排队；失败不产生幽灵轮次', { timeout: 5000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-live-input-'));
  let finish!: () => void;
  let ready!: () => void;
  let aborted = false;
  const available = new Promise<void>(resolve => { ready = resolve; });
  const received: unknown[] = [];
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => ({ provider: 'codex', label: 'test', binary: '', version: '',
    authenticated: true, ready: true, message: '', modes: ['ask'], models: [{ id: '', label: '' }], defaultModel: '', writable: false, checkedAt: '' }),
    execute: async context => {
      context.onSession('session-live-test');
      context.signal.addEventListener('abort', () => { aborted = true; finish(); });
      context.onSteer?.(async input => {
        if (input.text.includes('reject')) throw new Error('expired turn');
        received.push(input);
      });
      ready();
      await new Promise<void>(resolve => { finish = resolve; });
      return 'done';
    } };
  const service = await createAgentRuntimeService(directory, { adapters: [adapter], resolveWorkspace: async () => ({ workspacePath: os.tmpdir(), branch: '', headSha: '' }),
    resolveKnowledge: async () => 'knowledge', resolveAttachments: async () => [{ filePath: '/tmp/image.png', attachment: { id: 'image', name: 'image', mimeType: 'image/png', size: 1, url: '/image' } }] });
  try {
    const run = await service.start({ provider: 'codex', mode: 'ask', model: '', serviceTier: 'default', objective: 'original', workspacePath: os.tmpdir() });
    await available;
    const queued = await service.resume(run.id, 'queued', '');
    const same = await service.resume(run.id, 'supplement', '', '', ['image'], 'workspace', 'next');
    assert.equal(same.id, run.id);
    assert.equal(same.status, 'running');
    assert.equal(queued.status, 'queued');
    assert.equal(queued.serviceTier, 'default');
    assert.equal(aborted, false);
    assert.equal(same.supplements?.length, 1);
    assert.match(JSON.stringify(received), /knowledge/);
    assert.match(JSON.stringify(received), /image.png/);
    await assert.rejects(service.resume(run.id, 'reject', '', '', [], undefined, 'next'), /expired turn/);
    await assert.rejects(service.resume(run.id, 'escalate', '', '', [], 'full', 'next'), /权限/);
    await assert.rejects(service.resume(run.id, 'fast', '', '', [], 'workspace', 'next', 'priority'), /速度/);
    assert.equal((await service.dashboard()).runs.length, 2);
    assert.equal(run.supplements?.length, 1);
    const saved = JSON.parse(await fs.readFile(path.join(directory, 'agent-runs.json'), 'utf8'));
    assert.equal(saved.find((item: AgentRun) => item.id === run.id).supplements[0].objective, 'supplement');
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
