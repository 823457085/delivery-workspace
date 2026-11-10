import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultTeamProfileConfig, type TeamChatMessage } from '../shared/agent-team.js';
import type { AgentRun } from '../shared/agent-runtime.js';
import type { AdvancedTeamTask } from '../src/features/agent-workbench/team-api.js';
import { groupChatMessages } from '../src/features/agent-workbench/group-chat-messages.js';

const at = (minute: number) => `2026-11-05T09:${String(minute).padStart(2, '0')}:00Z`;
function message(id: string, role: TeamChatMessage['role'], minute: number, text: string, extra: Partial<TeamChatMessage> = {}): TeamChatMessage {
  return { id, role, text, createdAt: at(minute), kind: 'message', ...extra };
}
function task(messages: TeamChatMessage[]): AdvancedTeamTask {
  return { id: 'task', parentConversationId: 'group', sourceWorkspacePath: '/workspace', objective: '初始任务', attachmentIds: [],
    profileConfig: defaultTeamProfileConfig(), planRevision: 1, nodes: [], state: 'running', round: 1, maxRounds: null,
    createdAt: at(0), updatedAt: at(30), interactionMode: 'chat', chat: { workspaceBound: true, pendingInputs: [], messages } };
}
function run(id: string, nodeId: string, profileId: 'leader' | 'verifier'): AgentRun {
  return { id, provider: 'codex', mode: 'ask', accessMode: 'workspace', model: 'fixture', reasoningEffort: '', objective: '内部任务提示词',
    workspacePath: '/workspace', branch: '', headSha: '', status: 'completed', sessionId: id, pid: null, result: '完整原始报告', error: '', events: [],
    createdAt: at(1), updatedAt: at(25), team: { taskId: 'task', nodeId, profileId, stageKey: 'plan', profileRevision: 1 } };
}

test('同一轮 AI 岗位互问和回传在群聊显示，无需用户先发追问', () => {
  const value = task([
    message('initial', 'user', 0, '初始任务'),
    message('peer-ask', 'assistant', 2, '向工程实现提问：请确认数据来源。', { kind: 'collaboration', profileId: 'reviewer' }),
    message('peer-reply', 'assistant', 3, '数据来自详情接口。', { kind: 'collaboration', profileId: 'engineer', replyTo: 'peer-ask' }),
    message('peer-next', 'assistant', 4, '数据来自详情接口。', { kind: 'collaboration', profileId: 'engineer', replyTo: 'another-ask' }),
  ]);
  const visible = groupChatMessages([value], []);
  assert.deepEqual(visible.map(item => [item.id, item.replyTo]), [
    ['peer-ask', undefined], ['peer-reply', 'peer-ask'], ['peer-next', 'another-ask'],
  ]);
});

test('群聊追问后的协调和验证答复按时间显示，已有岗位报告不能吞掉用户与回复', () => {
  const value = task([
    message('initial', 'user', 0, '初始任务'),
    message('initial-report', 'assistant', 2, '初始岗位报告', { nodeId: 'leader', profileId: 'leader' }),
    message('question', 'assistant', 3, '请核对附件', { kind: 'question', nodeId: 'verifier', profileId: 'verifier' }),
    message('followup', 'user', 18, '新增内容是否通俗易懂？', { nodeId: 'leader', attachmentIds: ['xlsx'] }),
    message('verification', 'assistant', 23, '核对结论 L_123：术语可以更直白。', { kind: 'handoff', nodeId: 'verifier', profileId: 'verifier' }),
    message('coordination:leader:1', 'assistant', 19, '已读取附件，四条具体建议。', { nodeId: 'leader', profileId: 'leader' }),
    message('dispatch', 'assistant', 20, '交给验证（codex · fixture）处理。', { kind: 'handoff', nodeId: 'verifier', profileId: 'leader' }),
  ]);
  const runs = [run('leader-run', 'leader', 'leader'), run('verify-run', 'verifier', 'verifier')];
  value.nodes = runs.map(item => ({ id: item.team!.nodeId, profileId: item.team!.profileId, stage: 'plan', status: 'completed',
    runId: item.id, dependencies: [], round: 1, attempt: 1, createdAt: at(1), updatedAt: at(25) }));
  const before = structuredClone({ value, runs });
  const visible = groupChatMessages([value], runs);
  assert.deepEqual(visible.map(item => item.id), ['question', 'followup', 'coordination:leader:1', 'verification']);
  assert.equal(visible.at(-1)?.text, '核对结论 L_123：术语可以更直白。');
  assert.deepEqual(visible.find(item => item.id === 'followup')?.attachmentIds, ['xlsx']);
  assert.deepEqual(visible.at(-1)?.identity, { provider: 'codex', model: 'fixture' });
  assert.deepEqual({ value, runs }, before, '展示不得修改保存的消息、节点或运行内容');
});

test('同次追问的相同岗位正文仅显示一次，不合并不同追问、问题和发送者', () => {
  const value = task([
    message('initial', 'user', 0, '初始任务'), message('followup', 'user', 1, '请解释'),
    message('reply', 'assistant', 2, '解释原文', { profileId: 'leader' }),
    message('handoff', 'assistant', 3, '解释原文', { kind: 'handoff', profileId: 'leader' }),
    message('other-author', 'assistant', 4, '解释原文', { profileId: 'verifier' }),
    message('question-1', 'assistant', 5, '请确认', { kind: 'question' }),
    message('question-2', 'assistant', 6, '请确认', { kind: 'question' }),
    message('followup-again', 'user', 7, '请解释'), message('reply-again', 'assistant', 8, '解释原文', { profileId: 'leader' }),
    message('meaningful-handoff', 'assistant', 9, '交给验证（codex · fixture）处理。\n这是一条包含具体结论的回复。', { kind: 'handoff', profileId: 'leader' }),
    message('delivery', 'assistant', 10, '单独的交付区展示', { kind: 'delivery' }),
  ]);
  assert.deepEqual(groupChatMessages([value], []).map(item => item.id),
    ['followup', 'reply', 'other-author', 'question-1', 'question-2', 'followup-again', 'reply-again', 'meaningful-handoff']);
});

test('旧暂停继续回执每条用户输入保留最后一条，阶段和工具流水不进入聊天', () => {
  const value = task([
    message('initial', 'user', 0, '初始任务'), message('pause', 'user', 1, '暂停任务'),
    message('status:stopping', 'assistant', 2, '已请求暂停，正在核对当前执行是否结束；后续步骤不会启动。', { kind: 'progress', profileId: 'leader' }),
    message('status:paused', 'assistant', 3, '当前执行已停止，已有改动保留；回复“继续执行”后恢复。', { kind: 'progress', profileId: 'leader', provider: 'codex', model: 'fixture' }),
    message('resume', 'user', 4, '继续执行'),
    message('status:resume', 'assistant', 5, '按你的回复继续执行。', { kind: 'progress', profileId: 'leader' }),
    message('status:stage', 'assistant', 6, '正在派发总协调', { kind: 'progress', profileId: 'leader' }),
    message('tool', 'assistant', 7, '执行命令：pwd', { kind: 'progress', nodeId: 'leader' }),
    message('followup', 'user', 8, '解释当前结果'),
    message('status:received', 'assistant', 9, '已收到消息，当前阶段退出后由 Leader 继续处理。', { kind: 'progress', profileId: 'leader' }),
    message('status:thinking', 'assistant', 10, 'Leader 正在理解你的消息并安排处理。', { kind: 'progress', profileId: 'leader' }),
  ]);
  const visible = groupChatMessages([value], []);
  assert.deepEqual(visible.map(item => item.id), ['pause', 'status:paused', 'resume', 'status:resume', 'followup', 'status:received']);
  for (const receipt of visible.filter(item => item.kind === 'progress')) {
    assert.equal(receipt.hostGenerated, true);
    assert.equal(receipt.identity, undefined, '宿主状态回执不能冒充某个模型的回复');
  }
});

test('新宿主回执按replyTo独立保留，重复暂停也有自己的确认且不重复旧status', () => {
  const value = task([
    message('initial', 'user', 0, '初始任务'), message('pause-1', 'user', 1, '暂停任务'),
    message('status:old', 'assistant', 2, '当前执行已停止，已有改动保留；回复“继续执行”后恢复。', { kind: 'progress', profileId: 'leader' }),
    message('pause-2', 'user', 3, '暂停任务'),
    message('receipt-1', 'assistant', 4, '暂停请求已确认。', { hostGenerated: true, replyTo: 'pause-1', profileId: 'leader' }),
    message('receipt-2', 'assistant', 5, '暂停请求已确认。', { hostGenerated: true, replyTo: 'pause-2', profileId: 'leader' }),
  ]);
  const visible = groupChatMessages([value], []);
  assert.deepEqual(visible.map(item => item.id), ['pause-1', 'pause-2', 'receipt-1', 'receipt-2']);
  assert.ok(visible.filter(item => item.hostGenerated).every(item => !item.identity));
});
