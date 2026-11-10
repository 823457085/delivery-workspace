import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { agentExecutionPrompt, createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import type { CodexSessionSource } from '../server/codex-session-source.js';
import type { AgentProvider, AgentRun, AgentRuntimeHealth, CodexSessionDetail, StartAgentRunInput } from '../shared/agent-runtime.js';
import { buildAgentConversationList } from '../src/features/agent-workbench/conversation.js';

const workspacePath = '/provider-continuation/workspace';
const identity = (selected: string) => ({ workspacePath: selected, branch: 'feature/provider-switch', headSha: 'abc123' });
const emptySource: CodexSessionSource = { listSessions: async () => [], session: async () => { throw new Error('missing fixture session'); } };
const input = (provider: AgentProvider, objective: string, continueConversationId?: string): StartAgentRunInput => ({
  provider, objective, mode: 'ask', model: 'test-model', workspacePath,
  ...(continueConversationId ? { continueConversationId } : {}),
});

function adapterFixture(controlled = false) {
  const executions: { provider: AgentProvider; run: AgentRun; resumeSessionId: string; forkSessionId: string }[] = [];
  const finishes = new Map<string, (result?: string) => void>();
  const adapters: AgentRuntimeAdapter[] = (['codex', 'cursor'] as const).map(provider => ({
    id: provider,
    health: async (): Promise<AgentRuntimeHealth> => ({ provider, label: provider, binary: `/fixture/${provider}`,
      version: 'test', authenticated: true, ready: true, message: 'ready', modes: ['agent', 'plan', 'ask'],
      models: [{ id: 'test-model', label: 'test-model' }], defaultModel: 'test-model', writable: true, checkedAt: new Date().toISOString() }),
    execute: async context => {
      executions.push({ provider, run: structuredClone(context.run), resumeSessionId: context.resumeSessionId || '',
        forkSessionId: context.forkSessionId || '' });
      await context.onSession(context.resumeSessionId || `${provider}-native-${context.run.id}`);
      if (!controlled) return `已完成：${context.run.objective}`;
      return new Promise<string>((resolve, reject) => {
        if (context.signal.aborted) { reject(new Error('fixture stopped')); return; }
        finishes.set(context.run.id, result => resolve(result ?? `已完成：${context.run.objective}`));
        context.signal.addEventListener('abort', () => reject(new Error('fixture stopped')), { once: true });
      });
    },
  }));
  return { adapters, executions, finishes };
}

async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(condition(), '等待运行状态超时');
}

async function completed(run: AgentRun) {
  await until(() => run.status === 'completed' && !!run.resultReady);
}

async function directory() {
  // 测试状态也限制在当前所选工作区，退出后删除。
  return fs.mkdtemp(path.join(process.cwd(), '.provider-continuation-'));
}

function storedRun(index: number, overrides: Partial<AgentRun> = {}): AgentRun {
  const id = `run-${index}-fixture`;
  return { id, conversationId: 'conversation-fixture', queueRootId: 'run-0-fixture', provider: 'codex', mode: 'ask',
    accessMode: 'workspace', model: 'test-model', reasoningEffort: '', objective: `request-${index}`, ...identity(workspacePath),
    status: 'completed', sessionId: 'codex-native-history', pid: null, result: `answer-${index}`, error: '', events: [],
    createdAt: new Date(Date.parse('2026-10-18T00:00:00Z') + index * 1000).toISOString(),
    updatedAt: new Date(Date.parse('2026-10-18T00:00:00Z') + index * 1000 + 500).toISOString(), ...overrides };
}

test('两种执行器共用的执行 prompt 包含内部交接，界面用户消息保持原文', () => {
  for (const provider of ['codex', 'cursor'] as const) {
    const run = storedRun(0, { provider, objective: '请按原任务继续',
      providerSwitch: { from: provider === 'cursor' ? 'codex' : 'cursor', context: 'INTERNAL_HANDOFF_MARKER：上一轮已完成验证。' },
      knowledgeContext: 'KNOWLEDGE_MARKER：本轮显式引用的笔记。' });
    const before = structuredClone(run);
    const prompt = agentExecutionPrompt(run);
    assert.ok(prompt.startsWith(run.objective));
    assert.match(prompt, /请按原任务继续/);
    assert.match(prompt, /INTERNAL_HANDOFF_MARKER：上一轮已完成验证。/);
    assert.match(prompt, /KNOWLEDGE_MARKER：本轮显式引用的笔记。/);
    assert.ok(prompt.indexOf(run.objective) < prompt.indexOf(run.providerSwitch!.context));
    assert.equal(run.objective, '请按原任务继续');
    assert.deepEqual(run, before);
  }
});

test('完全访问的必要登录和既有任务授权持续生效，不被缩成单次确认', () => {
  const full = agentExecutionPrompt(storedRun(0, { mode: 'agent', accessMode: 'full', objective: '继续测试登录' }));
  assert.match(full, /续聊、重试和恢复/);
  assert.match(full, /已有明确授权在原范围持续有效/);
  assert.match(full, /登录、认证续期和重复验证/);
  assert.match(full, /不再逐次询问/);
  assert.match(full, /提交、推送或更改外部系统必须由用户在任务中明确要求/);
  const ask = agentExecutionPrompt(storedRun(0, { mode: 'ask', accessMode: 'workspace' }));
  assert.match(ask, /只读模式/); assert.doesNotMatch(ask, /登录、认证续期和重复验证/);
});

test('同一对话双向切换执行器，原生会话各自新建且后续续聊只恢复对应执行器', { timeout: 10000 }, async () => {
  const state = await directory();
  const fixture = adapterFixture();
  const options = { adapters: fixture.adapters, resolveWorkspace: async (selected: string) => identity(selected), codexSessionSource: emptySource };
  let service = await createAgentRuntimeService(state, options);
  try {
    const original = await service.start(input('codex', '检查已有代码'));
    await completed(original);
    const originalSnapshot = structuredClone(original);
    const switched = await service.start(input('cursor', '请继续修复', original.conversationId));
    await completed(switched);
    assert.equal(switched.conversationId, original.conversationId);
    assert.equal(switched.workspacePath, original.workspacePath);
    assert.equal(switched.objective, '请继续修复');
    assert.equal(switched.providerSwitch?.from, 'codex');
    assert.match(switched.providerSwitch?.context || '', /检查已有代码/);
    assert.equal(fixture.executions[1].resumeSessionId, '');
    assert.equal(fixture.executions[1].forkSessionId, '');
    assert.notEqual(switched.sessionId, original.sessionId);
    assert.deepEqual(original, originalSnapshot);

    const cursorFollowup = await service.resume(switched.id, '补充验证');
    await completed(cursorFollowup);
    assert.equal(fixture.executions[2].provider, 'cursor');
    assert.equal(fixture.executions[2].resumeSessionId, switched.sessionId);
    assert.equal(cursorFollowup.providerSwitch, undefined);

    const back = await service.start(input('codex', '回到 Codex 检查结果', original.conversationId));
    await completed(back);
    assert.equal(fixture.executions[3].resumeSessionId, '');
    assert.equal(fixture.executions[3].forkSessionId, '');
    assert.notEqual(back.sessionId, original.sessionId);
    assert.notEqual(back.sessionId, switched.sessionId);
    assert.equal(back.providerSwitch?.from, 'cursor');
    const codexFollowup = await service.resume(back.id, '继续核对');
    await completed(codexFollowup);
    assert.equal(fixture.executions[4].resumeSessionId, back.sessionId);
    assert.deepEqual(original, originalSnapshot);

    const dashboard = await service.dashboard();
    const conversations = buildAgentConversationList(dashboard.runs, dashboard.codexSessions, {}, dashboard.conversationTitles);
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0].id, original.conversationId);
    assert.equal(conversations[0].title, '继续核对');
    assert.deepEqual(new Set(conversations[0].runs.map(run => run.objective)),
      new Set(['检查已有代码', '请继续修复', '补充验证', '回到 Codex 检查结果', '继续核对']));

    await service.close();
    service = await createAgentRuntimeService(state, options);
    const restored = (await service.dashboard()).runs.find(run => run.id === switched.id)!;
    assert.equal(restored.conversationId, original.conversationId);
    assert.equal(restored.objective, '请继续修复');
    assert.deepEqual(restored.providerSwitch, switched.providerSwitch);
  } finally { await service.close(); await fs.rm(state, { recursive: true, force: true }); }
});

test('运行中依次排队切 Cursor、续聊和切回 Codex，按提交顺序执行且不串用会话 ID', { timeout: 10000 }, async () => {
  const state = await directory();
  const fixture = adapterFixture(true);
  const service = await createAgentRuntimeService(state, { adapters: fixture.adapters,
    resolveWorkspace: async selected => identity(selected), codexSessionSource: emptySource });
  try {
    const first = await service.start(input('codex', '第一轮'));
    await until(() => fixture.finishes.has(first.id));
    const cursor = await service.start(input('cursor', '第二轮切换', first.conversationId));
    const followup = await service.resume(cursor.id, '第三轮 Cursor 续聊');
    const back = await service.start(input('codex', '第四轮切回', first.conversationId));
    assert.deepEqual(fixture.executions.map(item => item.run.id), [first.id]);
    assert.ok([cursor, followup, back].every(run => run.status === 'queued'));

    fixture.finishes.get(first.id)!('第一轮最终结果');
    await until(() => fixture.finishes.has(cursor.id));
    assert.equal(fixture.executions[1].resumeSessionId, '');
    assert.equal(fixture.executions[1].forkSessionId, '');
    assert.match(fixture.executions[1].run.providerSwitch?.context || '', /第一轮最终结果/);
    assert.equal(fixture.executions.length, 2);
    fixture.finishes.get(cursor.id)!('第二轮最终结果');
    await until(() => fixture.finishes.has(followup.id));
    assert.equal(fixture.executions[2].resumeSessionId, cursor.sessionId);
    assert.equal(fixture.executions[2].provider, 'cursor');
    assert.equal(fixture.executions.length, 3);
    fixture.finishes.get(followup.id)!('第三轮最终结果');
    await until(() => fixture.finishes.has(back.id));
    assert.equal(fixture.executions[3].resumeSessionId, '');
    assert.equal(fixture.executions[3].provider, 'codex');
    assert.match(fixture.executions[3].run.providerSwitch?.context || '', /第三轮最终结果/);
    fixture.finishes.get(back.id)!();
    await completed(back);
    assert.deepEqual(fixture.executions.map(item => item.run.id), [first.id, cursor.id, followup.id, back.id]);
    assert.equal(new Set((await service.dashboard()).runs.map(run => run.conversationId)).size, 1);
  } finally { await service.close(); await fs.rm(state, { recursive: true, force: true }); }
});

test('继续不存在的会话或不匹配的工作区不创建运行；同执行器继续只恢复已有原生会话', { timeout: 10000 }, async () => {
  const state = await directory();
  const fixture = adapterFixture();
  const service = await createAgentRuntimeService(state, { adapters: fixture.adapters,
    resolveWorkspace: async selected => identity(selected), codexSessionSource: emptySource });
  try {
    await assert.rejects(service.start(input('cursor', '无效来源', 'missing-conversation')), /会话|找不到/);
    assert.equal((await service.dashboard()).runs.length, 0);
    const first = await service.start(input('codex', '正常来源'));
    await completed(first);
    await assert.rejects(service.start({ ...input('cursor', '错误目录', first.conversationId), workspacePath: '/unrelated/workspace' }), /工作区|目录/);
    assert.equal((await service.dashboard()).runs.length, 1);
    const same = await service.start(input('codex', '继续当前执行器', first.conversationId));
    await completed(same);
    assert.equal(same.conversationId, first.conversationId);
    assert.equal(fixture.executions[1].resumeSessionId, first.sessionId);
    assert.equal(same.providerSwitch, undefined);
  } finally { await service.close(); await fs.rm(state, { recursive: true, force: true }); }
});

test('已准备隔离目录的旧会话切换执行器必须使用新目录，保留历史记录与隔离来源', { timeout: 10000 }, async () => {
  const state = await directory();
  const fixture = adapterFixture();
  const preparedPath = '/provider-continuation/prepared';
  const original = storedRun(0, { continuation: { ...identity(preparedPath), sessionId: 'codex-prepared-native',
    sourceWorkspacePath: workspacePath, baseBranch: 'main', isolatedWorkspace: true,
    forkSourceRunId: 'run-0-fixture', forkSourceTurnId: '11111111-1111-1111-1111-111111111111' } });
  await fs.writeFile(path.join(state, 'agent-runs.json'), JSON.stringify([original]));
  const service = await createAgentRuntimeService(state, { adapters: fixture.adapters,
    resolveWorkspace: async selected => identity(selected), codexSessionSource: emptySource });
  try {
    const before = structuredClone((await service.dashboard()).runs[0]);
    await assert.rejects(service.start(input('cursor', '拒绝旧目录', original.conversationId)), /工作区|目录/);
    assert.equal((await service.dashboard()).runs.length, 1);
    const switched = await service.start({ ...input('cursor', '在已隔离目录继续', original.conversationId), workspacePath: preparedPath });
    await completed(switched);
    assert.equal(switched.workspacePath, preparedPath);
    assert.equal(switched.sourceWorkspacePath, workspacePath);
    assert.equal(switched.baseBranch, 'main');
    assert.equal(switched.isolatedWorkspace, true);
    assert.equal(switched.conversationId, original.conversationId);
    assert.equal(fixture.executions[0].resumeSessionId, '');
    assert.deepEqual((await service.dashboard()).runs.find(run => run.id === original.id), before);
  } finally { await service.close(); await fs.rm(state, { recursive: true, force: true }); }
});

test('切换只向执行器内部传入最近六轮有界文字，用户消息、标题及工具日志不被混入', { timeout: 10000 }, async () => {
  const state = await directory();
  const fixture = adapterFixture();
  const stored = Array.from({ length: 8 }, (_, index) => storedRun(index, {
    objective: `request-${index}:${'文'.repeat(10_000)}`, result: `${'果'.repeat(10_000)}:answer-${index}`,
    events: [{ id: `event-${index}`, type: 'tool', message: 'PRIVATE_TOOL_LOG_MARKER', createdAt: '2026-10-18T00:00:00Z' }],
  }));
  await fs.writeFile(path.join(state, 'agent-runs.json'), JSON.stringify(stored));
  const service = await createAgentRuntimeService(state, { adapters: fixture.adapters,
    resolveWorkspace: async selected => identity(selected), codexSessionSource: emptySource });
  try {
    const switched = await service.start(input('cursor', '本轮用户要求', 'conversation-fixture'));
    await completed(switched);
    const context = fixture.executions[0].run.providerSwitch?.context || '';
    assert.ok(context.length > 0 && context.length < 40_000);
    assert.doesNotMatch(context, /request-0:|request-1:|PRIVATE_TOOL_LOG_MARKER/);
    for (let index = 2; index < 8; index++) assert.ok(context.includes(`request-${index}:`));
    assert.match(context, /:answer-7/);
    assert.equal(switched.objective, '本轮用户要求');
    const dashboard = await service.dashboard();
    const conversations = buildAgentConversationList(dashboard.runs, dashboard.codexSessions, {}, dashboard.conversationTitles);
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0].title, '本轮用户要求');
    assert.equal(conversations[0].latest.objective, '本轮用户要求');
  } finally { await service.close(); await fs.rm(state, { recursive: true, force: true }); }
});

test('同步 Codex 历史切换后保持 origin 和原生历史，删除对话后再次同步不会复活侧栏', { timeout: 10000 }, async () => {
  const state = await directory();
  const fixture = adapterFixture();
  const sessionId = '77777777-7777-7777-7777-777777777777';
  const detail: CodexSessionDetail = { id: sessionId, title: '原生任务', preview: '原生结果', ...identity(workspacePath),
    model: 'test-model', reasoningEffort: '', archived: false, createdAt: '2026-10-17T00:00:00Z', updatedAt: '2026-10-17T00:01:00Z',
    turns: [{ id: '11111111-1111-1111-1111-111111111111', userMessage: '原生历史要求', agentMessage: '原生历史结果',
      createdAt: '2026-10-17T00:00:00Z', updatedAt: '2026-10-17T00:01:00Z', completedAt: '2026-10-17T00:01:00Z' }] };
  const original = storedRun(0, { sessionId, originSessionId: sessionId });
  await fs.writeFile(path.join(state, 'agent-runs.json'), JSON.stringify([original]));
  const source: CodexSessionSource = { listSessions: async () => [detail], session: async () => detail };
  const service = await createAgentRuntimeService(state, { adapters: fixture.adapters,
    resolveWorkspace: async selected => identity(selected), codexSessionSource: source });
  try {
    await service.syncCodexSessions();
    const switched = await service.start(input('cursor', '接着处理', original.conversationId));
    await completed(switched);
    assert.equal(switched.conversationId, original.conversationId);
    assert.equal(switched.originSessionId, sessionId);
    assert.equal(fixture.executions[0].resumeSessionId, '');
    assert.match(fixture.executions[0].run.providerSwitch?.context || '', /原生历史要求/);
    assert.match(fixture.executions[0].run.providerSwitch?.context || '', /原生历史结果/);
    const dashboard = await service.dashboard();
    const conversations = buildAgentConversationList(dashboard.runs, dashboard.codexSessions, { [sessionId]: detail }, dashboard.conversationTitles);
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0].id, original.conversationId);
    assert.ok(conversations[0].runs.some(run => run.objective === '原生历史要求'));
    assert.deepEqual(await service.removeConversation(switched.id), { deleted: 2 });
    await service.syncCodexSessions();
    const removed = await service.dashboard();
    assert.deepEqual(removed.runs, []);
    assert.deepEqual(removed.codexSessions, []);
    assert.deepEqual(buildAgentConversationList(removed.runs, removed.codexSessions, { [sessionId]: detail }, removed.conversationTitles), []);
  } finally { await service.close(); await fs.rm(state, { recursive: true, force: true }); }
});

test('切换首轮尚未取得原生会话就失败时，重试保留内部交接且不能恢复来源执行器', { timeout: 10000 }, async () => {
  const state = await directory();
  const fixture = adapterFixture();
  const cursorAdapter = fixture.adapters.find(adapter => adapter.id === 'cursor')!;
  const executeCursor = cursorAdapter.execute;
  let attempts = 0;
  cursorAdapter.execute = async context => {
    if (attempts++ === 0) {
      fixture.executions.push({ provider: 'cursor', run: structuredClone(context.run),
        resumeSessionId: context.resumeSessionId || '', forkSessionId: context.forkSessionId || '' });
      throw new Error('fixture failure before native session');
    }
    return executeCursor(context);
  };
  const service = await createAgentRuntimeService(state, { adapters: fixture.adapters,
    resolveWorkspace: async selected => identity(selected), codexSessionSource: emptySource });
  try {
    const source = await service.start(input('codex', '来源要求'));
    await completed(source);
    const failed = await service.start(input('cursor', '待重试要求', source.conversationId));
    await until(() => failed.status === 'failed');
    assert.equal(failed.sessionId, '');
    const retried = await service.retry(failed.id);
    await completed(retried);
    assert.equal(retried.conversationId, source.conversationId);
    assert.equal(retried.objective, '待重试要求');
    assert.equal(retried.providerSwitch?.from, 'codex');
    assert.match(fixture.executions[2].run.providerSwitch?.context || '', /来源要求/);
    assert.equal(fixture.executions[2].resumeSessionId, '');
    assert.equal(fixture.executions[2].forkSessionId, '');
    assert.notEqual(retried.sessionId, source.sessionId);
  } finally { await service.close(); await fs.rm(state, { recursive: true, force: true }); }
});

test('跨执行器排队消息拒绝直接调整方向，暂停编辑也不从活动 Codex 继承会话 ID', { timeout: 10000 }, async () => {
  const state = await directory();
  const fixture = adapterFixture(true);
  const service = await createAgentRuntimeService(state, { adapters: fixture.adapters,
    resolveWorkspace: async selected => identity(selected), codexSessionSource: emptySource });
  try {
    const codex = await service.start(input('codex', '活动 Codex'));
    await until(() => fixture.finishes.has(codex.id));
    const cursor = await service.start(input('cursor', '待编辑的 Cursor 要求', codex.conversationId));
    const back = await service.start(input('codex', '随后切回 Codex', codex.conversationId));
    await assert.rejects(service.steer(cursor.id), /执行器|切换|调整/);
    assert.equal(codex.status, 'running');
    assert.equal(cursor.status, 'queued');
    const paused = await service.pauseForEdit(cursor.id);
    assert.equal(paused.pausedForEdit, true);
    assert.equal(paused.sessionId, '');
    assert.equal(codex.status, 'cancelled');
    assert.equal(fixture.executions.length, 1);
    const revised = await service.revise(cursor.id, '修订后的 Cursor 要求');
    await until(() => fixture.finishes.has(revised.id));
    assert.equal(fixture.executions[1].provider, 'cursor');
    assert.equal(fixture.executions[1].resumeSessionId, '');
    assert.equal(revised.providerSwitch?.from, 'codex');
    assert.equal(back.status, 'queued');
    fixture.finishes.get(revised.id)!();
    await until(() => fixture.finishes.has(back.id));
    assert.equal(fixture.executions[2].provider, 'codex');
    assert.equal(fixture.executions[2].resumeSessionId, '');
    assert.equal(fixture.executions[2].forkSessionId, '');
    fixture.finishes.get(back.id)!();
    await completed(back);
  } finally { await service.close(); await fs.rm(state, { recursive: true, force: true }); }
});

test('删除排队中的切换轮后，后续 Cursor 轮仍从新原生会话开始并取得交接', { timeout: 10000 }, async () => {
  const state = await directory();
  const fixture = adapterFixture(true);
  const service = await createAgentRuntimeService(state, { adapters: fixture.adapters,
    resolveWorkspace: async selected => identity(selected), codexSessionSource: emptySource });
  try {
    const codex = await service.start(input('codex', '先完成的 Codex'));
    await until(() => fixture.finishes.has(codex.id));
    const removed = await service.start(input('cursor', '不再执行的切换要求', codex.conversationId));
    const followup = await service.resume(removed.id, '保留的 Cursor 要求');
    assert.deepEqual(await service.removeQueuedRun(removed.id), { deleted: true });
    assert.equal(fixture.executions.length, 1);
    fixture.finishes.get(codex.id)!('删除后仍须交接的最终结果');
    await until(() => fixture.finishes.has(followup.id));
    assert.equal(fixture.executions[1].run.id, followup.id);
    assert.equal(fixture.executions[1].provider, 'cursor');
    assert.equal(fixture.executions[1].resumeSessionId, '');
    assert.equal(fixture.executions[1].forkSessionId, '');
    assert.match(fixture.executions[1].run.providerSwitch?.context || '', /删除后仍须交接的最终结果/);
    fixture.finishes.get(followup.id)!();
    await completed(followup);
    assert.ok(!(await service.dashboard()).runs.some(run => run.id === removed.id));
    assert.equal(followup.conversationId, codex.conversationId);
  } finally { await service.close(); await fs.rm(state, { recursive: true, force: true }); }
});

test('切回 Codex 尚未返回新会话 ID 时，也不能重试切换前失败的旧 Codex 轮次', { timeout: 10000 }, async () => {
  const state = await directory();
  const fixture = adapterFixture();
  const original = storedRun(0, { status: 'failed', sessionId: 'codex-old-native-session', error: 'fixture original failure' });
  await fs.writeFile(path.join(state, 'agent-runs.json'), JSON.stringify([original]));
  fixture.adapters.find(adapter => adapter.id === 'codex')!.execute = async context => {
    fixture.executions.push({ provider: 'codex', run: structuredClone(context.run),
      resumeSessionId: context.resumeSessionId || '', forkSessionId: context.forkSessionId || '' });
    // 新 CLI 已启动但尚未返回 session，不能以空 ID 误判可以回到旧 Codex 线程。
    return new Promise<string>((_resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(new Error('fixture stopped before session')), { once: true });
    });
  };
  const service = await createAgentRuntimeService(state, { adapters: fixture.adapters,
    resolveWorkspace: async selected => identity(selected), codexSessionSource: emptySource });
  try {
    const cursor = await service.start(input('cursor', '先切 Cursor', original.conversationId));
    await completed(cursor);
    const back = await service.start(input('codex', '切回的新 Codex', original.conversationId));
    await until(() => fixture.executions.length === 2);
    assert.equal(back.status, 'running');
    assert.equal(back.sessionId, '');
    assert.equal(fixture.executions[1].resumeSessionId, '');
    await assert.rejects(service.retry(original.id), /旧|最新|切换|执行器/);
    assert.equal((await service.dashboard()).runs.length, 3);
    assert.equal(fixture.executions.length, 2);
    assert.equal((await service.dashboard()).runs.find(run => run.id === original.id)?.sessionId, original.sessionId);
  } finally { await service.close(); await fs.rm(state, { recursive: true, force: true }); }
});

test('切回 Codex 后的普通排队续聊不能调整方向跨过中间切换轮并绑回最早 Codex', { timeout: 10000 }, async () => {
  const state = await directory();
  const fixture = adapterFixture(true);
  const service = await createAgentRuntimeService(state, { adapters: fixture.adapters,
    resolveWorkspace: async selected => identity(selected), codexSessionSource: emptySource });
  try {
    const first = await service.start(input('codex', 'Codex A'));
    await until(() => fixture.finishes.has(first.id));
    const cursor = await service.start(input('cursor', 'Cursor B', first.conversationId));
    const back = await service.start(input('codex', 'Codex C', first.conversationId));
    const followup = await service.resume(back.id, 'Codex D');
    assert.equal(followup.providerSwitch, undefined);
    await assert.rejects(service.steer(followup.id), /执行器|切换|调整|跨/);
    assert.equal(first.status, 'running');
    assert.equal(followup.parentRunId, back.id);
    assert.equal(followup.sessionId, '');
    assert.ok([cursor, back, followup].every(run => run.status === 'queued'));

    fixture.finishes.get(first.id)!();
    await until(() => fixture.finishes.has(cursor.id));
    fixture.finishes.get(cursor.id)!();
    await until(() => fixture.finishes.has(back.id));
    assert.equal(fixture.executions[2].resumeSessionId, '');
    fixture.finishes.get(back.id)!();
    await until(() => fixture.finishes.has(followup.id));
    assert.equal(fixture.executions[3].resumeSessionId, back.sessionId);
    assert.notEqual(fixture.executions[3].resumeSessionId, first.sessionId);
    assert.deepEqual(fixture.executions.map(item => item.run.id), [first.id, cursor.id, back.id, followup.id]);
    fixture.finishes.get(followup.id)!();
    await completed(followup);
  } finally { await service.close(); await fs.rm(state, { recursive: true, force: true }); }
});

test('重启后按原提交顺序恢复跨执行器排队链，不把尚未执行的切换轮当成历史边界', { timeout: 10000 }, async () => {
  const state = await directory();
  const fixture = adapterFixture();
  const first = storedRun(0, { status: 'running', sessionId: 'codex-original-native', result: '' });
  const cursor = storedRun(1, { provider: 'cursor', status: 'queued', sessionId: '', result: '', parentRunId: first.id,
    providerSwitch: { from: 'codex', context: '' } });
  const back = storedRun(2, { status: 'queued', sessionId: '', result: '', parentRunId: cursor.id,
    providerSwitch: { from: 'cursor', context: '' } });
  const followup = storedRun(3, { status: 'queued', sessionId: '', result: '', parentRunId: back.id });
  await fs.writeFile(path.join(state, 'agent-runs.json'), JSON.stringify([followup, back, cursor, first]));
  const service = await createAgentRuntimeService(state, { adapters: fixture.adapters,
    resolveWorkspace: async selected => identity(selected), codexSessionSource: emptySource });
  try {
    await assert.rejects(service.retry(cursor.id), /前序任务/);
    assert.equal(fixture.executions.length, 0);
    const restoredFirst = await service.retry(first.id);
    await completed(restoredFirst);
    const restoredCursor = await service.retry(cursor.id);
    await completed(restoredCursor);
    const restoredBack = await service.retry(back.id);
    await completed(restoredBack);
    const restoredFollowup = await service.retry(followup.id);
    await completed(restoredFollowup);
    assert.deepEqual(fixture.executions.map(item => item.provider), ['codex', 'cursor', 'codex', 'codex']);
    assert.deepEqual(fixture.executions.map(item => item.resumeSessionId),
      [first.sessionId, '', '', restoredBack.sessionId]);
    assert.match(restoredCursor.providerSwitch?.context || '', /已完成：request-0/);
    assert.match(restoredBack.providerSwitch?.context || '', /已完成：request-1/);
    for (const [source, restored] of [[first, restoredFirst], [cursor, restoredCursor], [back, restoredBack], [followup, restoredFollowup]]) {
      assert.equal(restored.recoveryOfRunId, source.id);
      assert.equal(restored.conversationId, first.conversationId);
      assert.equal((await service.retry(source.id)).id, restored.id);
    }
    assert.equal(fixture.executions.length, 4);
  } finally { await service.close(); await fs.rm(state, { recursive: true, force: true }); }
});

test('重启前已有跨执行器完成轮时，后续待恢复切换不能阻塞当前排队轮恢复', { timeout: 10000 }, async () => {
  const state = await directory();
  const fixture = adapterFixture();
  const first = storedRun(0);
  const cursor = storedRun(1, { provider: 'cursor', status: 'queued', sessionId: '', result: '', parentRunId: first.id,
    providerSwitch: { from: 'codex', context: '' } });
  const back = storedRun(2, { status: 'queued', sessionId: '', result: '', parentRunId: cursor.id,
    providerSwitch: { from: 'cursor', context: '' } });
  await fs.writeFile(path.join(state, 'agent-runs.json'), JSON.stringify([back, cursor, first]));
  const service = await createAgentRuntimeService(state, { adapters: fixture.adapters,
    resolveWorkspace: async selected => identity(selected), codexSessionSource: emptySource });
  try {
    await assert.rejects(service.retry(back.id), /前序任务/);
    const restoredCursor = await service.retry(cursor.id);
    await completed(restoredCursor);
    const restoredBack = await service.retry(back.id);
    await completed(restoredBack);
    assert.deepEqual(fixture.executions.map(item => item.provider), ['cursor', 'codex']);
    assert.ok(fixture.executions.every(item => !item.resumeSessionId && !item.forkSessionId));
  } finally { await service.close(); await fs.rm(state, { recursive: true, force: true }); }
});

test('后续跨执行器轮已经完成时，恢复旧中断轮仍被历史边界拒绝', { timeout: 10000 }, async () => {
  const state = await directory();
  const fixture = adapterFixture();
  const first = storedRun(0, { status: 'running', sessionId: 'codex-old-native', result: '' });
  const cursor = storedRun(1, { provider: 'cursor', sessionId: 'cursor-new-native', parentRunId: first.id,
    providerSwitch: { from: 'codex', context: '' } });
  await fs.writeFile(path.join(state, 'agent-runs.json'), JSON.stringify([cursor, first]));
  const service = await createAgentRuntimeService(state, { adapters: fixture.adapters,
    resolveWorkspace: async selected => identity(selected), codexSessionSource: emptySource });
  try {
    await assert.rejects(service.retry(first.id), /旧 Codex 线程/);
    assert.equal(fixture.executions.length, 0);
    assert.equal((await service.dashboard()).runs.length, 2);
  } finally { await service.close(); await fs.rm(state, { recursive: true, force: true }); }
});

test('再次重启后切换轮不能跳过未恢复的前序恢复子运行；前序恢复运行中仍可排队', { timeout: 10000 }, async () => {
  const state = await directory();
  const fixture = adapterFixture(true);
  const original = storedRun(0, { status: 'interrupted', result: '', recovery: {
    previousStatus: 'running', previousPid: null, state: 'resumed', resumedRunId: 'first-recovery',
    checkedAt: '', message: '',
  } });
  const previousRecovery = storedRun(2, { id: 'first-recovery', status: 'running', result: '',
    sessionId: original.sessionId, parentRunId: original.id, recoveryOfRunId: original.id });
  const cursor = storedRun(1, { provider: 'cursor', status: 'queued', sessionId: '', result: '', parentRunId: original.id,
    providerSwitch: { from: 'codex', context: '' } });
  await fs.writeFile(path.join(state, 'agent-runs.json'), JSON.stringify([previousRecovery, cursor, original]));
  const service = await createAgentRuntimeService(state, { adapters: fixture.adapters,
    resolveWorkspace: async selected => identity(selected), codexSessionSource: emptySource });
  try {
    await assert.rejects(service.retry(cursor.id), /前序任务/);
    assert.equal(fixture.executions.length, 0);
    const restoredFirst = await service.retry(previousRecovery.id);
    await until(() => fixture.finishes.has(restoredFirst.id));
    const restoredCursor = await service.retry(cursor.id);
    assert.equal(restoredCursor.status, 'queued');
    assert.equal(fixture.executions.length, 1);
    fixture.finishes.get(restoredFirst.id)!('第二次恢复的前序最终结果');
    await until(() => fixture.finishes.has(restoredCursor.id));
    assert.equal(fixture.executions[1].provider, 'cursor');
    assert.equal(fixture.executions[1].resumeSessionId, '');
    assert.match(restoredCursor.providerSwitch?.context || '', /第二次恢复的前序最终结果/);
    fixture.finishes.get(restoredCursor.id)!();
    await completed(restoredCursor);
    assert.equal(fixture.executions.length, 2);
  } finally { await service.close(); await fs.rm(state, { recursive: true, force: true }); }
});
