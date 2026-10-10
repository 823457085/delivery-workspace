import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRun, CodexSessionDetail, CodexSessionSummary } from '../shared/agent-runtime.js';
import { agentRunErrorText, buildAgentConversationList, buildAgentConversations, findAgentConversation,
  isRestartableAgentRun, isRetryableSessionBusyRun, reconcileAgentConversation, resumedConversationId } from '../src/features/agent-workbench/conversation.js';

function run(id: string, parentRunId = '', createdAt = '2026-09-16T00:00:00.000Z'): AgentRun {
  return { id, ...(parentRunId ? { parentRunId } : {}), provider: 'codex', mode: 'ask', accessMode: 'workspace', model: '', reasoningEffort: '', objective: `message-${id}`,
    workspacePath: '/repo', branch: 'feature/test', headSha: 'abc', status: 'completed', sessionId: 'session-12345678',
    pid: null, result: `result-${id}`, error: '', events: [], createdAt, updatedAt: createdAt };
}

test('运行记录按 parentRunId 聚合为连续会话并按最新更新时间排序', () => {
  const conversations = buildAgentConversations([
    run('child-2', 'child-1', '2026-09-16T00:03:00.000Z'),
    run('root-2', '', '2026-09-16T00:02:00.000Z'),
    run('root-1', '', '2026-09-16T00:00:00.000Z'),
    run('child-1', 'root-1', '2026-09-16T00:01:00.000Z'),
  ]);
  assert.deepEqual(conversations.map((conversation) => conversation.id), ['root-1', 'root-2']);
  assert.deepEqual(conversations[0].runs.map((item) => item.id), ['root-1', 'child-1', 'child-2']);
  assert.equal(conversations[0].latest.id, 'child-2');
  assert.equal(conversations[0].title, 'message-child-2');
});

test('乱序执行时以活跃或最后更新的运行作为会话最新轮次，消息仍按创建顺序显示', () => {
  const earlier = { ...run('356142ee', '', '2026-10-09T03:52:49.000Z'), conversationId: 'conversation-one',
    status: 'running' as const, updatedAt: '2026-10-09T04:08:24.923Z' };
  const later = { ...run('75998ef8', '', '2026-10-09T03:56:31.000Z'), conversationId: 'conversation-one',
    status: 'completed' as const, updatedAt: '2026-10-09T04:08:23.983Z' };
  const [active] = buildAgentConversations([later, earlier]);
  assert.deepEqual(active.runs.map((item) => item.id), ['356142ee', '75998ef8']);
  assert.equal(active.latest.id, '356142ee');
  assert.equal(active.latest.status, 'running');
  assert.equal(active.title, 'message-356142ee');
  assert.equal(active.updatedAt, earlier.updatedAt);

  const queued = { ...later, status: 'queued' as const, updatedAt: '2026-10-09T04:09:00.000Z' };
  const [stillActive] = buildAgentConversations([earlier, queued]);
  assert.equal(stillActive.latest.id, '356142ee');
  assert.equal(stillActive.updatedAt, queued.updatedAt);

  const completed = { ...earlier, status: 'completed' as const, updatedAt: '2026-10-09T04:10:00.000Z' };
  const [finished] = buildAgentConversations([later, completed]);
  assert.equal(finished.latest.id, '356142ee');
  assert.equal(finished.latest.status, 'completed');
  assert.equal(finished.updatedAt, completed.updatedAt);
});

test('父运行不在当前窗口时保留为独立会话，不猜测跨 Session 关系', () => {
  const conversations = buildAgentConversations([run('orphan', 'missing-parent')]);
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].id, 'orphan');
});

test('持久会话 ID 保留三条侧栏行，分叉后的新运行仍归属原行', () => {
  const first = { ...run('first', 'missing-parent'), conversationId: 'conversation-first' };
  const second = { ...run('second', 'first'), conversationId: 'conversation-second', sessionId: 'session-second' };
  const third = { ...run('third', 'first'), conversationId: 'conversation-third' };
  const forked = { ...run('forked', '', '2026-09-16T00:01:00.000Z'), conversationId: 'conversation-third', sessionId: 'session-forked' };
  const conversations = buildAgentConversations([first, second, third, forked]);
  assert.deepEqual(new Set(conversations.map((item) => item.id)), new Set(['conversation-first', 'conversation-second', 'conversation-third']));
  assert.deepEqual(findAgentConversation(conversations, 'conversation-third')?.runs.map((item) => item.id), ['third', 'forked']);
  assert.equal(resumedConversationId(findAgentConversation(conversations, 'conversation-third')!, forked), 'conversation-third');
  assert.equal(findAgentConversation(conversations, 'forked')?.id, 'conversation-third');
});

test('续聊后用新运行定位当前会话，首次续接历史会话同样使用新运行', () => {
  const [local] = buildAgentConversations([run('root'), run('child', 'root')]);
  assert.equal(resumedConversationId(local, run('next', 'child')), 'next');

  const session: CodexSessionSummary = { id: '99999999-9999-9999-9999-999999999999', title: '历史任务', preview: '历史回答',
    workspacePath: '/repo', branch: 'feature/test', headSha: 'abc', model: 'test-model', reasoningEffort: 'high', archived: false,
    createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:01:00.000Z' };
  const [history] = buildAgentConversationList([], [session], {});
  assert.equal(resumedConversationId(history, run('continued')), 'continued');
});

test('超过 50 条后发送，根运行被淘汰仍能定位发送前选中的同一会话', () => {
  const runs = Array.from({ length: 51 }, (_, index) => run(`run-${index}`, index ? `run-${index - 1}` : '',
    new Date(Date.UTC(2026, 8, 22, 0, index)).toISOString()));
  const before = buildAgentConversations(runs.slice(0, 50));
  const after = buildAgentConversations(runs.slice(1));
  assert.equal(findAgentConversation(after, before[0].id), undefined);
  assert.equal(reconcileAgentConversation(after, before[0].id, before)?.latest.id, 'run-50');
  assert.equal(findAgentConversation(after, resumedConversationId(before[0], runs[50]))?.id, 'run-1');
  // 下一次刷新也使用仍在窗口中的最近运行恢复，不再保存将被截断的根 ID。
  assert.equal(findAgentConversation(after, before[0].latest.id)?.id, 'run-1');
});

test('SSE 先到或发送期间切换会话，只迁移原会话，不抢占其他会话', () => {
  const before = buildAgentConversations([run('root'), run('child', 'root'), run('other')]);
  const after = buildAgentConversations([run('child', 'root'), run('next', 'child'), run('other')]);
  assert.equal(reconcileAgentConversation(after, 'root', before)?.id, 'child');
  assert.equal(reconcileAgentConversation(after, 'other', before)?.id, 'other');
  assert.equal(reconcileAgentConversation([before.find(item => item.id === 'other')!], 'root', before), undefined);
});

test('子运行 ID 和原 Codex session ID 都能解析到聚合后的稳定会话', () => {
  const session: CodexSessionSummary = { id: '88888888-8888-8888-8888-888888888888', title: '历史任务', preview: '历史回答',
    workspacePath: '/repo', branch: 'feature/test', headSha: 'abc', model: 'test-model', reasoningEffort: 'high', archived: false,
    createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:01:00.000Z' };
  const root = { ...run('root'), originSessionId: session.id };
  const child = { ...run('child', 'root'), originSessionId: session.id };
  const conversations = buildAgentConversationList([root, child], [session], {});
  assert.equal(findAgentConversation(conversations, 'child')?.id, 'root');
  assert.equal(findAgentConversation(conversations, session.id)?.id, 'root');
});

test('两条独立会话引用同一原 Codex session 时，不按共享别名误选其中一条', () => {
  const first = { ...run('first'), conversationId: 'conversation-first', originSessionId: 'shared-origin' };
  const second = { ...run('second'), conversationId: 'conversation-second', originSessionId: 'shared-origin' };
  const conversations = buildAgentConversations([first, second]);
  assert.equal(findAgentConversation(conversations, 'shared-origin'), undefined);
  assert.equal(findAgentConversation(conversations, 'second')?.id, 'conversation-second');
});

test('会话 ID 与另一会话的历史轮次重名时优先选择列表中的精确会话', () => {
  const [current] = buildAgentConversations([run('current')]);
  current.runs = [run('remembered')];
  const [remembered] = buildAgentConversations([run('remembered')]);
  assert.equal(findAgentConversation([current, remembered], 'remembered')?.id, 'remembered');
});

test('仅对 Codex 原会话占用失败提供重试', () => {
  const busy = { ...run('busy'), status: 'failed' as const, error: 'Codex CLI 执行失败：原会话正在其他 Codex 窗口运行，请结束后重试' };
  assert.equal(isRetryableSessionBusyRun(busy), true);
  assert.equal(isRetryableSessionBusyRun({ ...busy, provider: 'cursor' }), false);
  assert.equal(isRetryableSessionBusyRun({ ...busy, error: '网络连接超时' }), false);
  assert.equal(isRestartableAgentRun(busy), true);
  assert.equal(isRestartableAgentRun({ ...busy, status: 'interrupted' }), true);
  assert.equal(isRestartableAgentRun({ ...busy, status: 'completed' }), false);
});

test('错误文案由接口返回，前端原样展示，包括历史 active writer 文案', () => {
  const raw = 'thread 01a0f258-cd9d-76f2-80ab-f0a807e0c954 already has an active writer';
  const legacy = { ...run('legacy'), status: 'failed' as const, error: raw };
  assert.equal(agentRunErrorText(legacy), raw);
  assert.equal(isRetryableSessionBusyRun(legacy), true);
  assert.equal(agentRunErrorText({ ...legacy, provider: 'cursor' }), raw);
  assert.equal(agentRunErrorText({ ...legacy, status: 'completed' }), raw);
  assert.equal(agentRunErrorText({ ...legacy, error: `other: ${raw}` }), `other: ${raw}`);
});

test('历史 Codex 会话续接后保留原消息并合并本地新轮次', () => {
  const session: CodexSessionSummary = { id: '11111111-1111-1111-1111-111111111111', title: '历史任务', preview: '历史回答',
    workspacePath: '/repo', branch: 'feature/test', headSha: 'abc', model: 'test-model', reasoningEffort: 'high', archived: false,
    createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:01:00.000Z' };
  const detail: CodexSessionDetail = { ...session, turns: [{ id: 'turn-1', userMessage: '原问题', agentMessage: '原回答',
    createdAt: session.createdAt, updatedAt: session.updatedAt }] };
  const continued = { ...run('local-run', '', '2026-09-16T00:02:00.000Z'), originSessionId: session.id,
    sessionId: session.id, objective: '继续处理', result: '续接回答' };
  const conversations = buildAgentConversationList([continued], [session], { [session.id]: detail });
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].id, continued.id);
  assert.equal(conversations[0].title, '继续处理');
  assert.deepEqual(conversations[0].runs.map((item) => item.objective), ['原问题', '继续处理']);
  assert.equal(conversations[0].latest.id, continued.id);
  assert.equal(conversations[0].source, 'workspace');
});

test('两个本地会话共享原 Codex session 时不复制完整同步历史到每一行', () => {
  const session: CodexSessionSummary = { id: '66666666-6666-6666-6666-666666666666', title: '原会话', preview: '原回答',
    workspacePath: '/repo', branch: 'feature/test', headSha: 'abc', model: 'test-model', reasoningEffort: 'high', archived: false,
    createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:03:00.000Z' };
  const detail: CodexSessionDetail = { ...session, turns: [{ id: 'original-turn', userMessage: '原问题', agentMessage: '原回答',
    createdAt: session.createdAt, updatedAt: session.createdAt }] };
  const first = { ...run('first', '', '2026-09-16T00:01:00.000Z'), conversationId: 'conversation-first',
    originSessionId: session.id, sessionId: session.id };
  const second = { ...run('second', '', '2026-09-16T00:02:00.000Z'), conversationId: 'conversation-second',
    originSessionId: session.id, sessionId: session.id };
  const conversations = buildAgentConversationList([first, second], [session], { [session.id]: detail });
  assert.deepEqual(new Set(conversations.map((item) => item.id)), new Set(['conversation-first', 'conversation-second']));
  assert.deepEqual(findAgentConversation(conversations, 'conversation-first')?.runs.map((item) => item.id), ['first']);
  assert.deepEqual(findAgentConversation(conversations, 'conversation-second')?.runs.map((item) => item.id), ['second']);
});

test('预分叉 Codex thread 尚无用户轮次时仍归属原行，不在同步列表新增一行', () => {
  const preparedId = '44444444-4444-4444-4444-444444444444';
  const preparedSession: CodexSessionSummary = { id: preparedId, title: '预分叉会话', preview: '尚无用户消息',
    workspacePath: '/forked-repo', branch: 'feature/forked', headSha: 'def', model: 'test-model', reasoningEffort: 'high', archived: false,
    createdAt: '2026-09-16T00:01:00.000Z', updatedAt: '2026-09-16T00:01:00.000Z' };
  const unrelated = { ...preparedSession, id: '55555555-5555-5555-5555-555555555555', title: '其他会话' };
  const local = { ...run('local-run'), conversationId: 'conversation-original', continuation: {
    sessionId: preparedId, workspacePath: '/forked-repo', branch: 'feature/forked', headSha: 'def',
    sourceWorkspacePath: '/repo', baseBranch: 'feature/test', isolatedWorkspace: true as const,
  } };
  const conversations = buildAgentConversationList([local], [preparedSession, unrelated], {});
  assert.deepEqual(new Set(conversations.map((item) => item.id)), new Set(['conversation-original', unrelated.id]));
  assert.deepEqual(findAgentConversation(conversations, 'conversation-original')?.runs.map((item) => item.id), ['local-run']);
});

test('历史详情未读取时先显示会话摘要，不以空白骨架屏遮住内容', () => {
  const session: CodexSessionSummary = { id: '22222222-2222-2222-2222-222222222222', title: '历史任务', preview: '可立即展示的历史摘要',
    workspacePath: '/repo', branch: 'feature/test', headSha: 'abc', model: 'test-model', reasoningEffort: 'high', archived: false,
    createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:01:00.000Z' };
  const [conversation] = buildAgentConversationList([], [session], {});
  assert.equal(conversation.loaded, false);
  assert.equal(conversation.runs[0].result, session.preview);
});

test('已读取的 Codex 历史会话使用最后一次用户提问作为标题', () => {
  const session: CodexSessionSummary = { id: '33333333-3333-3333-3333-333333333333', title: '历史任务', preview: '历史回答',
    workspacePath: '/repo', branch: 'feature/test', headSha: 'abc', model: 'test-model', reasoningEffort: 'high', archived: false,
    createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:02:00.000Z' };
  const detail: CodexSessionDetail = { ...session, turns: [
    { id: 'turn-1', userMessage: '最初问题', agentMessage: '最初回答', createdAt: session.createdAt, updatedAt: session.createdAt },
    { id: 'turn-2', userMessage: '最后提问', agentMessage: '最后回答', createdAt: session.updatedAt, updatedAt: session.updatedAt },
  ] };
  const [conversation] = buildAgentConversationList([], [session], { [session.id]: detail });
  assert.equal(conversation.title, '最后提问');
});

test('手动会话标题覆盖最新消息生成的标题', () => {
  const [conversation] = buildAgentConversationList([run('root'), run('child', 'root')], [], {}, { root: '自定义会话标题' });
  assert.equal(conversation.title, '自定义会话标题');
});
