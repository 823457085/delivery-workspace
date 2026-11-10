import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRun } from '../shared/agent-runtime.js';
import type { GroupRoom, GroupRound } from '../shared/agent-group-chat.js';
import { buildGroupChatConversation } from '../src/features/agent-workbench/group-chat-conversation.js';
import { conversationDeliveries } from '../src/features/agent-workbench/conversation-deliveries.js';

const at = (minute: number) => `2026-11-04T09:${String(minute).padStart(2, '0')}:00.000Z`;
function run(id: string, created = 0, options: Partial<AgentRun> = {}): AgentRun {
  return { id, provider: 'codex', mode: 'agent', accessMode: 'workspace', model: 'gpt-6.1-sol', reasoningEffort: '',
    objective: `原始目标 ${id}`, workspacePath: '/same/workspace', branch: 'feature/fixture', headSha: 'fixture-sha',
    status: 'completed', sessionId: 'shared-native-session', pid: null, result: `原始结果 ${id}`, error: '', events: [],
    createdAt: at(created), updatedAt: at(created), ...options };
}
function team(taskId: string): NonNullable<AgentRun['team']> {
  return { taskId, nodeId: 'node', stageKey: 'stage', profileId: 'frontend', profileRevision: 1 };
}
function round(id: string): GroupRound {
  return { id, requestId: id, requestHash: id, text: '用户原文 L123', attachmentIds: [], accessMode: 'workspace',
    state: 'completed', turns: [], createdAt: at(0), updatedAt: at(0) };
}
function room(): GroupRoom {
  return { id: 'room', title: '团队原始标题 L456', workspacePath: '/same/workspace', executionPath: '/same/workspace',
    paused: false, cursorTrustPaths: [], rounds: [], createdAt: at(0), updatedAt: at(1) };
}

test('没有真实房间或所属运行时不伪造会话和运行', () => {
  assert.equal(buildGroupChatConversation(undefined, [run('unrelated')]), undefined);
  assert.equal(buildGroupChatConversation(room(), []), undefined);
  assert.equal(buildGroupChatConversation(room(), [run('unrelated')]), undefined);
});

test('房间投影保留历轮直接、自动、旧轮次和备用运行的真实身份并按时间去重排序', () => {
  const value = room(), direct = run('direct', 3, { team: team(value.id) });
  const automatic = round('automatic-round');
  automatic.automatic = { taskId: 'automatic-task', config: { revision: 1, name: '团队', members: [] }, inputs: [] };
  const history = round('historical-round');
  history.automatic = { taskId: 'historical-task', config: { revision: 1, name: '团队', members: [] }, inputs: [] };
  const legacy = run('legacy', 1), fallback = run('failed-original', 0, { status: 'failed', error: '原错误 L789' });
  const binding = { provider: 'codex' as const, model: 'gpt-6.1-sol', reasoningEffort: '' as const };
  history.turns.push({ id: 'turn', runId: legacy.id, member: { id: 'member', name: '前端', instructions: '职责', capability: 'read', enabled: true },
    attempt: 2, status: 'completed', result: '', error: '', updatedAt: at(1),
    fallbacks: [{ from: binding, to: binding, reason: '原失败后接续', runId: fallback.id, at: at(1) }] });
  value.rounds = [history, automatic];
  const current = run('automatic', 4, { team: team('automatic-task') });
  const historical = run('historical', 2, { team: team('historical-task') });
  const duplicate = { ...direct, result: '最新回读原文', updatedAt: at(6) };
  const input = [current, direct, legacy, fallback, historical, duplicate];
  const before = structuredClone({ value, input });
  const conversation = buildGroupChatConversation(value, input)!;
  assert.deepEqual(conversation.runs.map(item => item.id), [fallback.id, legacy.id, historical.id, duplicate.id, current.id]);
  for (const item of [fallback, legacy, historical, duplicate, current]) assert.equal(conversation.runs.find(candidate => candidate.id === item.id), item);
  assert.equal(conversation.latest, duplicate);
  assert.equal(conversation.id, 'group:room');
  assert.equal(conversation.title, value.title);
  assert.equal(conversation.updatedAt, at(6));
  assert.equal(conversation.source, 'workspace');
  assert.equal(conversation.loaded, true);
  assert.deepEqual({ value, input }, before);
});

test('同目录、同原生线程和其他房间的运行不能混入当前群聊', () => {
  const value = room(), own = run('own', 1, { team: team(value.id) });
  const other = run('other', 20, { team: team('other-room'), status: 'running' });
  const plain = run('plain', 30, { conversationId: value.id, status: 'running' });
  const conversation = buildGroupChatConversation(value, [other, plain, own])!;
  assert.deepEqual(conversation.runs, [own]);
  assert.equal(conversation.latest, own);
  assert.equal(conversation.updatedAt, at(1));
});

test('latest优先运行中再排队再最新更新，持续回读保留最新对象且房间ID稳定', () => {
  const value = room(), running = run('running', 0, { status: 'running', team: team(value.id) });
  const queued = run('queued', 1, { status: 'queued', updatedAt: at(10), team: team(value.id) });
  const done = run('done', 2, { updatedAt: at(20), team: team(value.id) });
  value.updatedAt = at(25);
  const first = buildGroupChatConversation(value, [done, queued, running])!;
  assert.equal(first.latest, running);
  assert.equal(first.updatedAt, value.updatedAt);
  const completed = { ...running, status: 'completed' as const, result: '本次真实回读', updatedAt: at(30) };
  const second = buildGroupChatConversation(value, [completed, queued, done])!;
  assert.equal(second.id, first.id);
  assert.equal(second.latest, queued);
  assert.equal(second.runs.find(item => item.id === completed.id), completed);
  assert.equal(second.updatedAt, completed.updatedAt);
  const queueDone = { ...queued, status: 'completed' as const };
  assert.equal(buildGroupChatConversation(value, [completed, queueDone, done])!.latest, completed);
  const fresherRunning = { ...running, id: 'new-running', updatedAt: at(35) };
  assert.equal(buildGroupChatConversation(value, [running, fresherRunning])!.latest, fresherRunning);
});

function retriedReview(partial = '') {
  const value = room(), current = round('group-round');
  const members = ['leader', 'frontend', 'verifier', 'reviewer', 'reporter'];
  const runs = members.map((member, index) => run(member, index < 3 ? index : index + 1, {
    team: { ...team(value.id), nodeId: member },
  }));
  current.turns = members.map(member => ({ id: member, runId: member,
    member: { id: member, name: member, instructions: '职责', capability: 'read', enabled: true },
    attempt: member === 'reviewer' ? 2 : 1, status: 'completed', result: '', error: '', updatedAt: at(6),
  }));
  const failed = run('review-failed', 3, { status: 'failed', result: partial, error: '本次审查失败',
    team: { ...team(value.id), nodeId: 'reviewer' }, changedFiles: [{ path: 'partial.md', status: 'generated' }] });
  if (!partial) failed.changedFiles = [];
  runs.splice(3, 0, failed); value.rounds = [current];
  return { value, runs, failed };
}

test('群聊五个岗位的第四个失败重试仍是第四轮，成果总数与编号一致', () => {
  const { value, runs, failed } = retriedReview();
  const conversation = buildGroupChatConversation(value, runs)!;
  const items = conversationDeliveries(conversation);
  assert.deepEqual(items.map(item => [item.round, item.run.id]), [
    [5, 'reporter'], [4, 'reviewer'], [3, 'verifier'], [2, 'frontend'], [1, 'leader'],
  ]);
  assert.equal(conversation.runs.length, 6);
  assert.strictEqual(conversation.runs[3], failed, '失败尝试保留在原始执行记录');
  assert.strictEqual(items[1].run, runs[4], '文件和回复仍属于真实产出运行');
});

test('重试尚无成果时保留该轮部分产出，重试有成果后沿用编号并使用新运行身份', () => {
  const { value, runs, failed } = retriedReview('原始部分审查结果 L123');
  const current = runs.find(item => item.id === 'reviewer')!;
  current.status = 'running'; current.result = '';
  const before = conversationDeliveries(buildGroupChatConversation(value, runs));
  assert.equal(before.length, 5);
  assert.strictEqual(before.find(item => item.round === 4)!.run, failed);
  assert.equal(failed.result, '原始部分审查结果 L123');
  current.status = 'completed'; current.result = '当前审查结果 L456';
  current.changedFiles = [{ path: 'review.md', status: 'generated' }];
  const after = conversationDeliveries(buildGroupChatConversation(value, runs));
  assert.equal(after.length, 5);
  assert.strictEqual(after.find(item => item.round === 4)!.run, current);
  assert.strictEqual(after.find(item => item.round === 4)!.run.changedFiles, current.changedFiles);
  assert.equal(failed.result, '原始部分审查结果 L123');
});

test('同毫秒创建的重试优先当前发言绑定的产出，不受接口运行列表顺序影响', () => {
  const { value, runs, failed } = retriedReview('历史部分审查结果');
  const current = runs.find(item => item.id === 'reviewer')!;
  current.createdAt = failed.createdAt;
  const items = conversationDeliveries(buildGroupChatConversation(value, [...runs].reverse()));
  assert.equal(items.length, 5);
  assert.strictEqual(items.find(item => item.round === 4)!.run, current);
});

test('未关联到成员发言的历史运行不会因回退编号相同而吞掉已知成果', () => {
  const { value, runs } = retriedReview();
  const legacy = run('legacy-unmapped', 0, { team: { ...team(value.id), nodeId: 'legacy-node' } });
  const items = conversationDeliveries(buildGroupChatConversation(value, [legacy, ...runs]));
  assert.equal(items.length, 6);
  assert.ok(items.some(item => item.run === legacy));
  assert.ok(items.some(item => item.run.id === 'leader'));
});

test('后续协作轮次的同名成员独立编号，备用执行仍归属于原发言', () => {
  const value = room(), first = round('first'), second = round('second');
  const member = { id: 'reviewer', name: '代码审查', instructions: '职责', capability: 'read' as const, enabled: true };
  const binding = { provider: 'codex' as const, model: 'gpt-6.1-sol', reasoningEffort: '' as const };
  first.turns = [{ id: 'first-review', runId: 'first-retry', member, attempt: 2, status: 'completed', result: '', error: '', updatedAt: at(2),
    fallbacks: [{ from: binding, to: binding, reason: '首次执行失败', runId: 'first-failure', at: at(1) }] }];
  second.turns = [{ id: 'second-review', runId: 'second-result', member, attempt: 1, status: 'completed', result: '', error: '', updatedAt: at(3) }];
  value.rounds = [first, second];
  const failed = run('first-failure', 0, { status: 'failed' });
  const retried = run('first-retry', 1), next = run('second-result', 2);
  const conversation = buildGroupChatConversation(value, [failed, retried, next])!;
  assert.deepEqual(conversationDeliveries(conversation).map(item => [item.round, item.run.id]), [[2, next.id], [1, retried.id]]);
  assert.equal(conversation.runs.length, 3);
});
