import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import { checkAgentRecovery } from '../server/agent-recovery.js';
import { runCodexLiveTurn } from '../server/codex-live-turn.js';
import type { AgentRun, AgentRuntimeHealth, CodexSessionDetail } from '../shared/agent-runtime.js';
import type { CodexSessionSource } from '../server/codex-session-source.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const turnId = '22222222-2222-4222-8222-222222222222';
const date = '2026-10-15T00:00:00.000Z';
function record(id: string, fields: Partial<AgentRun> = {}): AgentRun {
  return { id, conversationId: 'conversation', queueRootId: 'first', provider: 'codex', mode: 'ask', accessMode: 'workspace',
    objective: id, model: '', reasoningEffort: '', workspacePath: '/test/recovery', branch: '', headSha: '', status: 'running',
    sessionId, codexTurnId: turnId, pid: null, result: '此前已输出', error: '', events: [], createdAt: date, updatedAt: date, ...fields };
}
function nativeSession(fields: Partial<CodexSessionDetail> = {}): CodexSessionDetail {
  return { id: sessionId, title: '', preview: '', workspacePath: '/test/recovery', branch: '', headSha: '', model: '',
    reasoningEffort: '', archived: false, createdAt: date, updatedAt: date, turns: [], ...fields };
}
const emptySource: CodexSessionSource = { listSessions: async () => [], session: async () => nativeSession() };
const health: AgentRuntimeHealth = { provider: 'codex', label: 'mock', binary: '/mock-only', version: 'test', authenticated: true,
  ready: true, message: '', modes: ['ask'], models: [{ id: '', label: 'default' }], defaultModel: '', writable: false, checkedAt: date };

async function fixture(t: TestContext, records: AgentRun[], source = emptySource) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-recovery-'));
  await fs.writeFile(path.join(directory, 'agent-runs.json'), JSON.stringify(records));
  const executions: { id: string; sessionId: string }[] = [];
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => health, execute: async context => {
    executions.push({ id: context.run.id, sessionId: context.resumeSessionId || '' });
    await context.onSession(context.resumeSessionId || sessionId);
    return '恢复运行完成';
  } };
  const create = () => createAgentRuntimeService(directory, { adapters: [adapter], codexSessionSource: source,
    resolveWorkspace: async workspacePath => ({ workspacePath, branch: '', headSha: '' }) });
  const service = await create();
  t.after(async () => { await service.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { service, create, executions, directory };
}
async function eventually(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('等待恢复模拟运行完成超时');
}

test('仅精确原生结束轮次回填完成，读恢复列表和核对均不派发 CLI', async t => {
  const source: CodexSessionSource = { ...emptySource, session: async () => nativeSession({ turns: [
    { id: turnId, userMessage: 'first', agentMessage: '真实最终回复', createdAt: date, updatedAt: date, completedAt: date },
  ] }) };
  const { service, executions } = await fixture(t, [record('first')], source);
  assert.equal(service.recoveryRuns()[0].recovery?.state, 'pending');
  assert.equal(executions.length, 0);
  await service.reconcileRecovery();
  const first = service.recoveryRuns()[0];
  assert.equal(first.status, 'completed');
  assert.equal(first.result, '真实最终回复');
  assert.equal(first.recovery?.state, 'completed');
  await assert.rejects(service.retry(first.id), /无需重新执行/);
  await service.reconcileRecovery();
  assert.equal(executions.length, 0);
});

test('其他会话、错误轮次、仅缓存正文均不能证明任务结束', async () => {
  const run = record('first', { status: 'interrupted', recovery: { previousStatus: 'running', previousPid: null,
    state: 'pending', checkedAt: '', message: '' } });
  const complete = { id: turnId, userMessage: 'first', agentMessage: '看起来相同的正文', createdAt: date, updatedAt: date, completedAt: date };
  for (const session of [nativeSession({ id: 'different-session', turns: [complete] }),
    nativeSession({ turns: [{ ...complete, id: 'different-turn' }] }), nativeSession({ turns: [{ ...complete, completedAt: null }] })]) {
    const result = await checkAgentRecovery(run, { ...emptySource, session: async () => session }, () => false);
    assert.equal(result.status, 'interrupted');
    assert.equal(result.recovery?.state, 'needs-review');
    assert.equal(result.result, run.result);
  }
});

test('原 PID 仍存活时 retry 与从该运行直接续聊都不派发', async t => {
  const { service, executions } = await fixture(t, [record('first', { pid: process.pid })]);
  await service.reconcileRecovery();
  assert.equal(service.recoveryRuns()[0].recovery?.state, 'active');
  await assert.rejects(service.retry('first'), /仍存在|重复派发/);
  await assert.rejects(service.resume('first', '后续消息'), /仍存在|重复派发/);
  assert.equal(executions.length, 0);
});

test('恢复响应丢失后并发重试仍复用同一恢复子运行，服务重载也不重复执行', async t => {
  const { service, executions, create } = await fixture(t, [record('first')]);
  const [first, repeated] = await Promise.all([service.retry('first'), service.retry('first')]);
  assert.equal(first.id, repeated.id);
  assert.equal(first.recoveryOfRunId, 'first');
  await eventually(() => first.status === 'completed');
  assert.equal(executions.length, 1);
  await service.close();
  const restarted = await create();
  try {
    assert.equal((await restarted.retry('first')).id, first.id);
    assert.equal(executions.length, 1);
  } finally { await restarted.close(); }
});

test('前序 A 尚未结束时不能跳过恢复 B；A 恢复完成后 B 从其会话继续', async t => {
  const first = record('first');
  const queued = record('second', { parentRunId: 'first', status: 'queued', sessionId: '', codexTurnId: undefined,
    createdAt: '2026-10-15T00:00:01.000Z' });
  const { service, executions } = await fixture(t, [queued, first]);
  await assert.rejects(service.retry('second'), /前序任务/);
  const resumed = await service.retry('first');
  await eventually(() => resumed.status === 'completed');
  const second = await service.retry('second');
  await eventually(() => second.status === 'completed');
  assert.equal(second.sessionId, resumed.sessionId);
  assert.equal(executions.length, 2);
  assert.deepEqual(executions.map(item => item.sessionId), [sessionId, sessionId]);
  assert.equal((await service.retry('first')).id, resumed.id);
  assert.equal((await service.retry('second')).id, second.id);
  assert.equal(executions.length, 2);
});

test('从已排队后继续聊也不得绕过仍存活的原前序进程', async t => {
  const first = record('first', { pid: process.pid });
  const queued = record('second', { parentRunId: 'first', status: 'queued', codexTurnId: undefined,
    createdAt: '2026-10-15T00:00:01.000Z' });
  const { service, executions } = await fixture(t, [queued, first]);
  await assert.rejects(service.resume('second', '新消息'), /前序|仍存在|重复派发/);
  assert.equal(executions.length, 0);
});

test('旧进程仍存活时先拒绝启动，不切换分支或创建工作区', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-recovery-branches-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'agent-runs.json'), JSON.stringify([record('first', { pid: process.pid })]));
  let mutations = 0;
  const identity = { workspacePath: '/test/recovery', branch: 'feature/old', headSha: '' };
  const service = await createAgentRuntimeService(directory, { adapters: [{ id: 'codex', health: async () => health,
    execute: async () => { mutations++; return 'must not execute'; } }], codexSessionSource: emptySource,
    resolveWorkspace: async () => identity,
    switchWorkspaceBranch: async () => { mutations++; return { ...identity, branch: 'feature/new' }; },
    createIsolatedWorkspace: async () => { mutations++; return { ...identity, sourceWorkspacePath: identity.workspacePath,
      baseBranch: identity.branch, isolatedWorkspace: true }; },
  });
  try {
    const input = { provider: 'codex' as const, mode: 'ask' as const, objective: 'new task', model: '',
      workspacePath: identity.workspacePath, branch: 'feature/new' };
    await assert.rejects(service.start(input), /仍存在|重复派发/);
    await assert.rejects(service.start({ ...input, isolateWorkspace: true }), /仍存在|重复派发/);
    assert.equal(mutations, 0);
  } finally { await service.close(); }
});

test('重启后的待核对记录和排队父链不因新运行触发历史截断而消失', async t => {
  const records = Array.from({ length: 101 }, (_, index) => record(`old-${index}`, {
    status: index === 0 ? 'running' : 'queued', parentRunId: index ? `old-${index - 1}` : undefined,
    queueRootId: 'old-0', codexTurnId: index ? undefined : turnId,
    createdAt: new Date(Date.parse(date) + index * 1000).toISOString(),
  })).reverse();
  const { service } = await fixture(t, records);
  assert.equal(service.recoveryRuns().length, 101);
  const newer = await service.start({ provider: 'codex', mode: 'ask', model: '', objective: 'other conversation',
    workspacePath: '/test/other-recovery' });
  await eventually(() => newer.status === 'completed');
  assert.equal(service.recoveryRuns().length, 101);
  assert.ok(service.recoveryRuns().some(run => run.id === 'old-0'), '仍可核对并恢复最早前序任务');
});

test('PID 落盘之前不发送 initialize；落盘失败停止连接且不创建轮次', { timeout: 10000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-pid-protocol-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, 'peer.mjs');
  await fs.writeFile(binary, `#!/usr/bin/env node
import fs from 'node:fs';
import { createInterface } from 'node:readline';
const output = value => process.stdout.write(JSON.stringify(value) + '\\n');
fs.writeFileSync('ready', 'ready');
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method } = JSON.parse(line);
  fs.appendFileSync('rpc.log', method + '\\n');
  if (method === 'initialize') output({ id, result: {} });
  if (method === 'thread/start') output({ id, result: { thread: { id: '${sessionId}' } } });
  if (method === 'turn/start') {
    output({ id, result: { turn: { id: '${turnId}' } } });
    output({ method: 'turn/started', params: { threadId: '${sessionId}', turn: { id: '${turnId}' } } });
    output({ method: 'item/completed', params: { threadId: '${sessionId}', turnId: '${turnId}', item: { type: 'agentMessage', text: 'finished' } } });
    output({ method: 'turn/completed', params: { threadId: '${sessionId}', turn: { id: '${turnId}', status: 'completed' } } });
  }
});
`, { mode: 0o700 });
  for (const failed of [true, false]) {
    const workspacePath = path.join(directory, failed ? 'failure' : 'success');
    await fs.mkdir(workspacePath);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const controller = new AbortController();
    let recordedPid = 0;
    const running = runCodexLiveTurn(binary, { run: record('pid-check', { workspacePath }), imagePaths: [], signal: controller.signal,
      onPid: async pid => {
        recordedPid = pid;
        await gate;
        await fs.writeFile(failed ? workspacePath : path.join(workspacePath, 'pid'), String(pid));
      }, onSession() {}, onEvent() {},
    }, 'local protocol check');
    try {
      for (let attempt = 0; attempt < 600; attempt++) {
        if (await fs.access(path.join(workspacePath, 'ready')).then(() => true, () => false)) break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      await fs.access(path.join(workspacePath, 'ready'));
      assert.ok(recordedPid > 0);
      await assert.rejects(fs.access(path.join(workspacePath, 'rpc.log')), { code: 'ENOENT' });
      release();
      if (failed) {
        await assert.rejects(running, /EISDIR|directory/);
        await assert.rejects(fs.access(path.join(workspacePath, 'rpc.log')), { code: 'ENOENT' });
      } else {
        assert.equal(await running, 'finished');
        assert.equal(await fs.readFile(path.join(workspacePath, 'pid'), 'utf8'), String(recordedPid));
        assert.equal(await fs.readFile(path.join(workspacePath, 'rpc.log'), 'utf8'), 'initialize\ninitialized\nthread/start\nturn/start\n');
      }
      assert.throws(() => process.kill(recordedPid, 0), { code: 'ESRCH' });
    } finally { release(); controller.abort(); await running.catch(() => {}); }
  }
});
