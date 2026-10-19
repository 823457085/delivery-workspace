import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import { createStateBackupStore } from '../server/state-backup.js';
import type { AgentRun } from '../shared/agent-runtime.js';

async function fixture(t: TestContext, shouldFail: (runs: AgentRun[]) => boolean, completion?: Promise<string>, initialRuns?: AgentRun[]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-persistence-'));
  const store = await createStateBackupStore(directory);
  const write = store.writeJson;
  if (initialRuns) await write('agent-runtimes/agent-runs.json', initialRuns);
  let failures = 0, executions = 0;
  const executedObjectives: string[] = [];
  t.mock.method(store, 'writeJson', async (relative: string, value: unknown) => {
    if (relative === 'agent-runtimes/agent-runs.json' && shouldFail(value as AgentRun[])) {
      failures++;
      throw new Error('fixture state persistence failed');
    }
    return write(relative, value);
  });
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => ({ provider: 'codex', label: 'fixture', binary: '',
    version: '', authenticated: true, ready: true, message: '', modes: ['ask'], models: [{ id: '', label: 'default' }],
    defaultModel: '', writable: false, checkedAt: '' }), execute: async context => {
    executions++;
    executedObjectives.push(context.run.objective);
    await context.onSession('fixture-session-1234');
    return completion ?? 'fixture completed';
  } };
  const service = await createAgentRuntimeService(path.join(directory, 'agent-runtimes'), { stateBackup: store, adapters: [adapter],
    resolveWorkspace: async workspacePath => ({ workspacePath, branch: '', headSha: '' }) });
  t.after(async () => { await service.close(); await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { service, directory, executedObjectives, counters: () => ({ failures, executions }),
    saved: () => store.readJson<AgentRun[]>('agent-runtimes/agent-runs.json'),
    start: (objective = 'fixture only') => service.start({ provider: 'codex', mode: 'ask', model: '', workspacePath: directory, objective }) };
}

test('首次入队保存失败不留下幽灵任务，后续成功发送只执行新任务', async t => {
  const f = await fixture(t, runs => runs.some(run => run.objective === 'rejected request'));
  await assert.rejects(f.start('rejected request'), /fixture state persistence failed/);
  assert.deepEqual((await f.service.dashboard()).runs, []);
  const accepted = await f.start('accepted request');
  for (let attempt = 0; attempt < 100 && accepted.status !== 'completed'; attempt++) await delay(5);
  assert.equal(accepted.status, 'completed');
  assert.deepEqual(f.executedObjectives, ['accepted request']);
  assert.ok((await f.saved()).every(run => run.objective !== 'rejected request'));
});

test('续聊入队失败保留既有运行和排队，不向订阅者发布失败消息', async t => {
  let finish!: (value: string) => void;
  const completion = new Promise<string>(resolve => { finish = resolve; });
  t.after(() => finish('fixture cleanup'));
  const f = await fixture(t, runs => runs.some(run => run.objective === 'rejected reply'), completion);
  const active = await f.start('active request');
  const queued = await f.service.resume(active.id, 'accepted queued reply');
  const published: string[] = [];
  f.service.subscribe((_revision, run) => { if (run) published.push(run.objective); });
  await assert.rejects(f.service.resume(active.id, 'rejected reply'), /fixture state persistence failed/);
  const dashboard = await f.service.dashboard();
  assert.deepEqual(dashboard.runs, [queued, active]);
  assert.equal(active.status, 'running');
  assert.equal(queued.status, 'queued');
  assert.equal(dashboard.activeWorkspaceLocks[0]?.runId, active.id);
  assert.ok(!published.includes('rejected reply'));
  assert.ok((await f.saved()).every(run => run.objective !== 'rejected reply'));
  finish('fixture completed');
  for (let attempt = 0; attempt < 100 && (queued as AgentRun).status !== 'completed'; attempt++) await delay(5);
  assert.equal(queued.status, 'completed');
  assert.deepEqual(f.executedObjectives, ['active request', 'accepted queued reply']);
});

test('入队保存失败不因历史裁剪丢失原有第100条记录', async t => {
  const history: AgentRun[] = Array.from({ length: 100 }, (_, index) => ({ id: `history-${index}`, conversationId: 'history',
    queueRootId: 'history-0', provider: 'codex', mode: 'ask', accessMode: 'workspace', objective: `history ${index}`,
    model: '', reasoningEffort: '', workspacePath: '/fixture-only', branch: '', headSha: '', status: 'completed',
    sessionId: 'fixture-history-session', pid: null, result: '', error: '', events: [],
    createdAt: new Date(100_000 - index).toISOString(), updatedAt: new Date(100_000 - index).toISOString() }));
  const f = await fixture(t, runs => runs.some(run => run.objective === 'rejected request'), undefined, history);
  await assert.rejects(f.start('rejected request'), /fixture state persistence failed/);
  await assert.rejects(f.service.retry('history-99'), /只有失败、中断或已取消/);
  assert.deepEqual((await f.saved()).map(run => run.id), history.map(run => run.id));
  assert.deepEqual(f.executedObjectives, []);
});

test('启动记录保存失败不会执行 CLI，也不会遗留运行锁或未处理拒绝', async t => {
  let fail = true;
  const f = await fixture(t, runs => {
    if (fail && runs.some(run => run.status === 'running')) { fail = false; return true; }
    return false;
  });
  const run = await f.start();
  for (let attempt = 0; attempt < 100 && run.status !== 'failed'; attempt++) await delay(5);
  assert.equal(run.status, 'failed');
  assert.match(run.error, /fixture state persistence failed/);
  assert.deepEqual(f.counters(), { failures: 1, executions: 0 });
  assert.deepEqual((await f.service.dashboard()).activeWorkspaceLocks, []);
});

test('收尾记录保存失败保留已有结果并挂起后续队列，不重复派发或宣告已保存', async t => {
  let finish!: (value: string) => void;
  const completion = new Promise<string>(resolve => { finish = resolve; });
  const f = await fixture(t, runs => runs.some(run => run.status === 'completed'), completion);
  const first = await f.start();
  const next = await f.service.resume(first.id, 'next fixture only');
  finish('fixture final result');
  for (let attempt = 0; attempt < 100 && first.status !== 'interrupted'; attempt++) await delay(5);
  assert.equal(first.status, 'interrupted');
  assert.equal(first.result, 'fixture final result');
  assert.match(first.error, /记录保存失败/);
  assert.equal(first.recovery?.state, 'needs-review');
  assert.equal(next.status, 'interrupted');
  assert.equal(next.recovery?.previousStatus, 'queued');
  assert.equal(f.counters().executions, 1);
  assert.deepEqual((await f.service.dashboard()).activeWorkspaceLocks, []);
});
