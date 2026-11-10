import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRun } from '../shared/agent-runtime';
import type { GroupRoom, GroupRound, GroupTurn } from '../shared/agent-group-chat';
import type { TeamNode } from '../shared/agent-team';
import { emptyDeliveryEvidence } from '../shared/delivery-acceptance';
import { groupRoundReply, groupMemberReply, groupChatMessageBlocks, type GroupChatMessageBlock } from '../src/features/agent-workbench/group-chat-replies';
import { groupChatSummaries } from '../src/features/agent-workbench/group-chat-summary';

const at = '2026-11-05T10:00:00.000Z';
const report = (value: object) => '```delivery-report\n' + JSON.stringify({ version: 1, ...value }) + '\n```';
function run(id: string, result: string, extra: Partial<AgentRun> = {}): AgentRun {
  return { id, provider: 'codex', mode: 'ask', accessMode: 'workspace', model: 'fixture', reasoningEffort: '',
    objective: '用户目标 L001', workspacePath: '/fixture', branch: '', headSha: '', status: 'completed', sessionId: '', pid: null,
    result, error: '', events: [], createdAt: at, updatedAt: at, ...extra };
}
function turn(id: string, result = ''): GroupTurn {
  return { id, runId: id, member: { id, name: id, capability: 'read', instructions: '仅处理本轮目标', enabled: true },
    attempt: 1, status: 'completed', result, error: '', updatedAt: at };
}
function round(turns: GroupTurn[]): GroupRound {
  return { id: 'round', requestId: 'request', requestHash: 'hash', text: '用户目标 L001', attachmentIds: [], accessMode: 'workspace',
    state: 'completed', turns, createdAt: at, updatedAt: at };
}
function room(value: GroupRound): GroupRoom {
  return { id: 'room', title: '测试群聊', workspacePath: '/fixture', executionPath: '/fixture', paused: false,
    cursorTrustPaths: [], rounds: [value], createdAt: at, updatedAt: at };
}

test('单成员普通 Markdown 与纯问答报告直接返回原文，保留链接、列表和 L 码', () => {
  const text = '## 本轮结果\n\n- L100 原样返回\n- [下载原表](/api/result.xlsx)\n\n| 项目 | 状态 |\n|---|---|\n| 接口 | L200 |\n';
  const value = round([turn('reader')]);
  assert.equal(groupRoundReply(value, [run('reader', text)]), text);
  assert.equal(groupRoundReply(value, [run('reader', report({ conversationReply: { text, resumeWorkflow: false } }))]), text);
  assert.equal(groupRoundReply(round([turn('saved', text)]), []), text);
  assert.equal(groupRoundReply(undefined, []), '');
  assert.equal(groupRoundReply(round([]), []), '');
  assert.equal(groupRoundReply(round([turn('first', text), turn('second', text)]), []), '');
});

test('混合报告与不完整协议不当作直接问答，成员摘要仍按本岗字段取原文', () => {
  const text = '**检查结果**\n\n- 原始响应 L020\n- [核对记录](/api/evidence)';
  const validationEvidence = emptyDeliveryEvidence();
  validationEvidence.tests = { status: 'failed', evidence: '原始失败证据 L030', sha: '' };
  const mixed = report({ conversationReply: { text: '不能替代岗位结果的问答' },
    taskResult: { role: 'verifier', status: 'blocked', summary: text }, validationEvidence });
  const value = round([turn('verifier')]), saved = run('verifier', mixed);
  assert.equal(groupRoundReply(value, [saved]), '');
  const member = groupChatSummaries(room(value), [saved])[0].members[0];
  assert.equal(groupMemberReply(member), text);
  assert.equal(member.run?.result, mixed, '完整验证证据仍留在原始报告中');
  for (const original of [mixed.slice(0, -3), mixed + '\n' + mixed,
    report({ taskPlan: { reason: '需先确认本轮范围' } }),
    report({ conversationReply: { text: '回答' }, questions: [{ text: '需要用户确认' }] })]) {
    assert.equal(groupRoundReply(value, [run('verifier', original)]), '');
  }
});

test('普通代码示例不被误判为内部报告，当前空结果不会回退旧尝试', () => {
  const text = '字段示例：\n```json\n{"status":"L010"}\n```';
  const value = round([turn('retry', '旧尝试结果 L999')]);
  assert.equal(groupRoundReply(value, [run('retry', text)]), text);
  const active = run('retry', '', { status: 'running' });
  assert.equal(groupRoundReply(value, [active]), '');
  assert.equal(groupMemberReply(groupChatSummaries(room(value), [active])[0].members[0]), '');
  assert.equal(groupMemberReply(undefined), '');
});

test('106 条历史运行沿用现有 current 语义分组，保留当前阻塞且不丢历史证据', () => {
  const turns = Array.from({ length: 106 }, (_, index) => turn(`node-${index}`));
  const nodes = turns.map((item, index): TeamNode & { purpose?: 'coordinate' } => ({
    id: item.id, runId: item.runId, round: index < 100 ? 0 : 1, profileId: index === 103 ? 'frontend' : index === 104 ? 'verifier' : index === 105 ? 'reviewer' : 'leader',
    stage: index === 103 ? 'implement' : index === 104 ? 'verify' : index === 105 ? 'review' : 'plan',
    status: index === 102 ? 'skipped' : index === 103 ? 'blocked' : 'completed',
    ...(index === 100 || index === 101 ? { purpose: 'coordinate' as const } : {}),
    dependencies: [], attempt: 1, createdAt: at, updatedAt: at,
  }));
  const value = round(turns);
  value.automatic = { taskId: 'task', config: { revision: 1, name: '原团队', members: [turns[0].member] }, inputs: [] };
  const runs = turns.map((item, index) => run(item.runId, `本岗记录 ${index}`, index === 103 ? { status: 'failed', error: '当前阻塞 L103' } : {}));
  const task = { id: 'task', round: 1, state: 'blocked' as const, nodes };
  const source = room(value), before = structuredClone({ source, runs, task });
  const summary = groupChatSummaries(source, runs, [task])[0];
  assert.deepEqual(summary.members.filter(member => member.current).map(member => member.turn.id), ['node-101', 'node-103', 'node-104', 'node-105']);
  assert.equal(summary.members.filter(member => !member.current).length, 102);
  assert.equal(summary.members.length, 106);
  assert.equal(summary.status, 'blocked');
  assert.ok(summary.blockers.some(item => item.text === '当前阻塞 L103'));
  assert.equal(groupMemberReply(summary.members[0]), '本岗记录 0');
  assert.deepEqual({ source, runs, task }, before, '折叠只消费展示状态，不改历史或运行记录');
});

type ChatMessage = GroupChatMessageBlock['message'];
function message(id: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: 'assistant', kind: 'handoff', profileId: 'verifier', text: `原始反馈 ${id}`, createdAt: at,
    task: { id: 'task' } as ChatMessage['task'], identity: { provider: 'codex', model: 'fixture' }, ...extra };
}

test('连续同岗交接只展开最后一条，历史原文、附件和来源完整保留', () => {
  const input = Array.from({ length: 24 }, (_, index) => message(`feedback-${index}`, {
    text: `第 ${index + 1} 条原始反馈\n\n- L${index}\n[原始报告](/api/report-${index})`, attachmentIds: [`attachment-${index}`],
  }));
  const before = structuredClone(input), blocks = groupChatMessageBlocks(input);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].message, input[23]);
  assert.equal(blocks[0].history.length, 23);
  assert.deepEqual([...blocks[0].history, blocks[0].message], input);
  assert.equal(blocks[0].history[0], input[0]);
  assert.deepEqual(input, before, '展示分组不改写消息原文或附件');
});

test('新用户、宿主回执、问题、普通回复和交付消息都重置交接分组边界', () => {
  const boundaries: Partial<ChatMessage>[] = [
    { role: 'user', kind: 'message', profileId: undefined },
    { hostGenerated: true },
    { kind: 'question' },
    { kind: 'message' },
    { kind: 'delivery' },
  ];
  for (const boundary of boundaries) {
    const input = [message('before'), message('boundary', boundary), message('after-1'), message('after-2')];
    const blocks = groupChatMessageBlocks(input);
    assert.deepEqual(blocks.map(block => block.message.id), ['before', 'boundary', 'after-2']);
    assert.deepEqual(blocks.map(block => block.history.map(item => item.id)), [[], [], ['after-1']]);
    assert.deepEqual(blocks.flatMap(block => [...block.history, block.message]), input);
  }
});

test('不同岗位、不同任务或缺少岗位身份不合并，相同文本也不跨消息边界去重', () => {
  const input = [message('qa-1'), message('qa-2'), message('review', { profileId: 'reviewer' }), message('qa-3'),
    message('other-task', { task: { id: 'other-task' } as ChatMessage['task'] }),
    message('unknown-1', { profileId: undefined }), message('unknown-2', { profileId: undefined }),
    message('same-1', { text: '相同原文' }), message('user', { role: 'user', kind: 'message', text: '继续' }), message('same-2', { text: '相同原文' })];
  const blocks = groupChatMessageBlocks(input);
  assert.deepEqual(blocks.map(block => block.message.id), ['qa-2', 'review', 'qa-3', 'other-task', 'unknown-1', 'unknown-2', 'same-1', 'user', 'same-2']);
  assert.deepEqual(blocks[0].history.map(item => item.id), ['qa-1']);
  assert.deepEqual(blocks.flatMap(block => [...block.history, block.message]), input);
});
