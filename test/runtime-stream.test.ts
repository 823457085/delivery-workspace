import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentRuntimeStream } from '../server/agent-runtime-stream.js';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import { createRuntimeRefresh, createRuntimeStreamState } from '../src/features/agent-workbench/runtime-stream-state.js';
import type { AgentRun, AgentRuntimeDashboard } from '../shared/agent-runtime.js';

const run = (id: string, result = '', status: AgentRun['status'] = 'running'): AgentRun => ({ id, result, status, provider: 'codex',
  mode: 'ask', accessMode: 'workspace', model: '', reasoningEffort: '', objective: '', workspacePath: '/tmp', branch: '', headSha: '',
  sessionId: '', pid: 1, error: '', events: [], createdAt: id, updatedAt: '' });
const snapshot = (revision: number, runs: AgentRun[]): AgentRuntimeDashboard => ({ revision, runs, runtimes: [], codexSessions: [],
  conversationTitles: {}, codexSync: { total: 0, hidden: 0, syncedAt: '' }, activeWorkspaceLocks: [] });

test('执行器已输出但任务未完成时，SSE 正文立即可用且不调用健康查询', { timeout: 5000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-stream-'));
  let checks = 0;
  let output!: (text: string) => void;
  let finish!: () => void;
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => {
    checks++;
    return { provider: 'codex', label: '', binary: '', version: '', authenticated: true, ready: true, message: '',
      modes: ['ask'], models: [{ id: '', label: 'default' }], defaultModel: '', writable: false, checkedAt: '' };
  }, execute: async context => {
    output = context.onOutput!;
    await new Promise<void>(resolve => { finish = resolve; ready(); });
    return '完整结果';
  } };
  const service = await createAgentRuntimeService(directory, { adapters: [adapter],
    resolveWorkspace: async () => ({ workspacePath: directory, branch: '', headSha: '' }) });
  const frames: string[] = [];
  const stream = createAgentRuntimeStream(frame => frames.push(frame), true);
  const unsubscribe = service.subscribe(stream.update);
  try {
    await service.start({ provider: 'codex', mode: 'ask', model: '', workspacePath: directory, objective: 'test' });
    await started;
    const before = checks;
    output('逐段输出');
    await delay(130);
    const last = JSON.parse(frames.at(-1)!.split('data: ')[1]);
    assert.equal(last.runs[0].status, 'running');
    assert.equal(last.runs[0].result, '逐段输出');
    assert.equal(checks, before);
  } finally { finish?.(); unsubscribe(); stream.close(); await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('密集正文只推送变化运行，合并多会话并保持 SSE revision 顺序', async () => {
  const frames: string[] = [];
  const stream = createAgentRuntimeStream(frame => frames.push(frame), true);
  try {
    for (let i = 1; i <= 100; i++) stream.update(i, run('a', String(i)));
    stream.update(101, run('b', 'other'));
    await delay(130);
    assert.equal(frames.length, 1);
    assert.match(frames[0], /event: runs/);
    const data = JSON.parse(frames[0].split('data: ')[1]);
    assert.equal(data.runs.length, 2);
    assert.equal(data.runs[0].result, '100');
    stream.update(102, run('a', 'done', 'completed'));
    stream.update(103);
    assert.match(frames[1], /id: 102/);
    assert.match(frames[2], /id: 103\nevent: refresh/);
    stream.update(104, run('a'));
    stream.close();
    await delay(130);
    assert.equal(frames.length, 3);
  } finally { stream.close(); }
});

test('首屏及慢快照不能覆盖更新正文，完成事件清除运行锁，删除不会复活', () => {
  const state = createRuntimeStreamState();
  assert.equal(state.receive(2, [run('a', '实时')]), undefined);
  const initial = state.snapshot(snapshot(1, [run('a', '旧内容'), run('b')]));
  assert.equal(initial.runs.find(item => item.id === 'a')?.result, '实时');
  assert.equal(initial.activeWorkspaceLocks.length, 1);
  const complete = state.receive(3, [run('a', '完成', 'completed')], initial)!;
  assert.equal(complete.activeWorkspaceLocks.length, 0);
  assert.equal(complete.runs.find(item => item.id === 'b'), initial.runs.find(item => item.id === 'b'));
  assert.equal(state.snapshot(snapshot(1, [run('a', '慢响应')])).runs[0].result, '完成');
  assert.equal(state.receive(2, [run('a', '乱序')], complete)!.runs.find(item => item.id === 'a')?.result, '完成');
  assert.deepEqual(state.snapshot(snapshot(4, [])).runs, []);
});

test('连续刷新不打断在途请求，只在完成后补一次；卸载后不再刷新', async () => {
  let calls = 0;
  let resolve!: () => void;
  const refresh = createRuntimeRefresh(async () => { calls++; await new Promise<void>(done => { resolve = done; }); }, 0);
  try {
    refresh.request(); await delay(10);
    for (let i = 0; i < 100; i++) refresh.request();
    await delay(10); assert.equal(calls, 1);
    resolve(); await delay(10); assert.equal(calls, 2);
    refresh.request(); refresh.close(); resolve(); await delay(10);
    assert.equal(calls, 2);
  } finally { refresh.close(); resolve?.(); }
});
