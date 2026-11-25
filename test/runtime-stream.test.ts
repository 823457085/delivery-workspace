import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentRuntimeStream } from '../server/agent-runtime-stream.js';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import { createRuntimeRefresh, createRuntimeStreamState } from '../src/features/agent-workbench/runtime-stream-state.js';
import { agentConversationContinuation, buildAgentConversations } from '../src/features/agent-workbench/conversation.js';
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
    const teamRun = { ...run('b', 'other'), teamContext: '服务端团队提示词' };
    stream.update(101, teamRun);
    await delay(130);
    assert.equal(frames.length, 1);
    assert.match(frames[0], /event: runs/);
    const data = JSON.parse(frames[0].split('data: ')[1]);
    assert.equal(data.runs.length, 2);
    assert.equal(data.runs[0].result, '100');
    assert.equal(data.runs[1].teamContext, undefined);
    assert.equal(teamRun.teamContext, '服务端团队提示词');
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

test('同毫秒新增运行在 SSE 中保持队尾执行器，旧轮正文更新不改变发送顺序', () => {
  const state = createRuntimeStreamState();
  const active = { ...run('codex-active'), conversationId: 'conversation', createdAt: '2026-10-19T00:00:00.000Z' };
  const queued = { ...active, id: 'cursor-queued', provider: 'cursor' as const, status: 'queued' as const };
  const initial = snapshot(1, [active]);
  const switched = state.receive(2, [queued], initial)!;
  assert.deepEqual(switched.runs.map(item => item.id), [queued.id, active.id]);
  assert.equal(agentConversationContinuation(buildAgentConversations(switched.runs)[0]).provider, 'cursor');
  const updated = state.receive(3, [{ ...active, result: '继续输出' }], switched)!;
  assert.deepEqual(updated.runs.map(item => item.id), [queued.id, active.id]);
  assert.equal(agentConversationContinuation(buildAgentConversations(updated.runs)[0]).id, queued.id);
  const slow = state.snapshot(initial);
  assert.deepEqual(slow.runs.map(item => item.id), [queued.id, active.id]);
  assert.equal(slow.runs[1].result, '继续输出');
});

test('发送回执先更新该条消息，慢快照和其他运行的事件仍按各自版本合并', () => {
  const state = createRuntimeStreamState();
  const base = state.snapshot(snapshot(1, [run('a', '原结果')]));
  const accepted = state.accept(4, run('b', '已受理', 'queued'), base)!;
  assert.equal(accepted.revision, 1);
  assert.equal(accepted.runs[0].id, 'b');
  const other = state.receive(2, [run('a', '其他会话已更新')], accepted)!;
  assert.equal(other.runs.find(item => item.id === 'a')?.result, '其他会话已更新');
  assert.equal(state.snapshot(snapshot(3, [run('a', '已落盘')])).runs[0].result, '已受理');
  const updated = state.receive(5, [run('b', '流式正文')], other)!;
  assert.equal(updated.runs[0].result, '流式正文');
  assert.equal(state.accept(4, run('b', '迟到回执'), updated)!.runs[0].result, '流式正文');
  assert.deepEqual(state.snapshot(snapshot(6, [])).runs, []);
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

test('SSE 保留 HTTP 快照中的旧会话，后续完整快照仍可清理历史', () => {
  const recent = Array.from({ length: 50 }, (_, index) => ({ ...run(`recent-${index}`), conversationId: 'busy',
    createdAt: new Date(2026, 9, 16, 0, 0, index).toISOString() }));
  const anchors = ['older-a', 'older-b'].map(id => ({ ...run(id, '', 'completed'), conversationId: id,
    createdAt: '2026-10-01T00:00:00.000Z' }));
  const state = createRuntimeStreamState();
  const initial = state.snapshot(snapshot(1, [...recent, ...anchors]));
  const updated = state.receive(2, [{ ...recent[0], result: '新正文' }], initial)!;
  assert.equal(updated.runs.length, 52);
  assert.ok(anchors.every(anchor => updated.runs.some(item => item.id === anchor.id)));
  assert.equal(updated.runs.find(item => item.id === recent[0].id)?.result, '新正文');
  assert.equal(state.snapshot(snapshot(3, [recent[0]])).runs.length, 1);
});

test('会话摘要保留运行与变更状态，打开后按页读取原文，并按会话推送轻量更新', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-conversation-index-'));
  const stored = Array.from({ length: 20 }, (_, index) => {
    const id = `history-${index}`;
    const at = new Date(Date.UTC(2026, 10, 24, 12, 0, 20 - index)).toISOString();
    return { ...run(id, `第 ${index} 轮回复`, 'completed'), conversationId: 'history',
      createdAt: at, updatedAt: at, pid: null, workspacePath: directory, sessionId: 'native-history',
      objective: `任务 ${index}\n${'详细内容'.repeat(1000)}${index === 19 ? '只在最后一页出现的关键词' : ''}`,
      changedFiles: [{ path: 'result.txt', status: 'generated' as const }],
      events: [{ id: 'event', type: 'message' as const, message: '完整过程', createdAt: at }],
      teamContext: '服务端上下文',
    };
  });
  const other = { ...run('other', '另一会话的回复', 'completed'), conversationId: 'other', pid: null,
    createdAt: stored[0].createdAt, updatedAt: stored[0].updatedAt, workspacePath: directory };
  await fs.writeFile(path.join(directory, 'agent-runs.json'), JSON.stringify([...stored, other]));
  const service = await createAgentRuntimeService(directory, { adapters: [] });
  const frames: string[] = [];
  const stream = createAgentRuntimeStream(frame => frames.push(frame), true, service.summarizeRun);
  try {
    const summaries = service.conversationSnapshot().runs;
    assert.equal(summaries.length, 21);
    assert.equal(summaries[0].objective, stored[0].objective.slice(0, 512));
    assert.equal(summaries[0].summaryOnly, true);
    assert.equal(summaries[0].resultReady, true);
    assert.equal(summaries[0].hasChangedFiles, true);
    assert.equal(summaries[0].changedFiles, undefined);
    assert.equal(summaries[0].result, '');
    assert.deepEqual(summaries[0].events, []);
    assert.equal(summaries[0].teamContext, undefined);

    const first = service.conversationHistory('native-history');
    assert.equal(first.runs.length, 16);
    assert.equal(first.runs[0].objective, stored[0].objective);
    assert.equal(first.runs[0].events[0].message, '完整过程');
    assert.ok(first.olderCursor);
    const last = service.conversationHistory('history', first.olderCursor);
    assert.deepEqual([...first.runs, ...last.runs].map(item => item.id), stored.map(item => item.id));
    assert.equal(last.olderCursor, null);
    assert.throws(() => service.conversationHistory('history', 'other'), /会话历史已更新/);
    const pending = service.getRun(stored[18].id)!;
    pending.pausedForEdit = true;
    const withPending = service.conversationHistory('history');
    assert.equal(withPending.runs.at(-1)?.id, pending.id);
    assert.deepEqual(service.conversationHistory('history', withPending.olderCursor!).runs.map(item => item.id), [stored[19].id]);
    const search = service.searchConversationHistory('最后一页出现的关键词');
    assert.deepEqual(search.conversationIds, ['history']);
    assert.match(search.snippets.history, /最后一页出现的关键词/);

    stream.update(1, service.getRun(stored[0].id));
    stream.update(2, service.getRun('other'));
    stream.update(3);
    const frame = JSON.parse(frames[0].split('data: ')[1]);
    assert.deepEqual(frame.conversationIds, ['history', 'other']);
    assert.ok(frame.runs.every((item: AgentRun) => item.summaryOnly && !item.result && item.events.length === 0));
  } finally { stream.close(); await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
