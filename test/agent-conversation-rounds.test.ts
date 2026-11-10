import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRun } from '../shared/agent-runtime.js';
import { agentConversationRoundCount, agentConversationRunRounds, type AgentConversation } from '../src/features/agent-workbench/conversation.js';
import { conversationDeliveries, conversationFileDeliveries } from '../src/features/agent-workbench/conversation-deliveries.js';
import { conversationMarkdown } from '../src/features/agent-workbench/conversation-export.js';

function run(id: string, fields: Partial<AgentRun> = {}): AgentRun {
  return { id, provider: 'codex', mode: 'agent', accessMode: 'workspace', model: '', reasoningEffort: '', objective: `目标 ${id}`,
    workspacePath: '/fixture', branch: '', headSha: '', status: 'completed', sessionId: 'same-native-session', pid: null,
    result: `结果 ${id}`, error: '', events: [], createdAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z', ...fields };
}
function conversation(runs: AgentRun[], fields: Partial<AgentConversation> = {}): AgentConversation {
  return { id: 'fixture', title: '同一任务续接', runs, latest: runs.at(-1)!, updatedAt: '', source: 'workspace', loaded: true, ...fields };
}
const steerEvent = { id: 'steer', type: 'lifecycle' as const, message: '已调整方向：停止当前轮后将立即执行此消息', createdAt: '' };

test('第四轮调整方向沿用第四轮，正常后续消息才计第五轮且各展示使用同一编号', () => {
  const fourth = run('fourth', { status: 'cancelled', changedFiles: [{ path: 'fourth.md', status: 'generated' }] });
  const resumed = run('resumed', { parentRunId: fourth.id, events: [steerEvent], changedFiles: [{ path: 'resumed.md', status: 'generated' }] });
  const selected = conversation([run('one'), run('two'), run('three'), fourth, resumed]);
  const before = structuredClone(selected);
  assert.deepEqual([...agentConversationRunRounds(selected).values()], [1, 2, 3, 4, 4]);
  assert.equal(agentConversationRoundCount(selected), 4);
  assert.deepEqual(conversationDeliveries(selected).map(item => item.round), [4, 4, 3, 2, 1]);
  assert.deepEqual(conversationFileDeliveries(selected).map(item => item.round), [4, 4]);
  const markdown = conversationMarkdown(selected);
  assert.match(markdown, /第 4 轮 · 用户\n\n目标 resumed/);
  assert.doesNotMatch(markdown, /第 5 轮/);
  assert.deepEqual(selected, before, '展示编号不修改运行、文件或历史');
  selected.runs.push(run('next', { parentRunId: resumed.id }));
  assert.equal(agentConversationRunRounds(selected).get('next'), 5);
  assert.equal(agentConversationRoundCount(selected), 5);
});

test('连续编辑与恢复继承最初轮号，只有明确标记才合并', () => {
  const original = run('original', { status: 'cancelled' });
  const edit = run('edit', { revisesRunId: original.id });
  const editedAgain = run('edited-again', { revisesRunId: edit.id });
  const recovered = run('recovered', { recoveryOfRunId: editedAgain.id });
  const ordinary = run('ordinary', { parentRunId: recovered.id, objective: recovered.objective });
  const selected = conversation([original, edit, editedAgain, recovered, ordinary]);
  assert.deepEqual([...agentConversationRunRounds(selected).values()], [1, 1, 1, 1, 2]);
  assert.equal(agentConversationRoundCount(selected), 2);
});

test('群聊提供的原发言编号优先，失败与重试保留已有current去重语义', () => {
  const failed = run('failed', { status: 'failed' }), retried = run('retried', { recoveryOfRunId: failed.id });
  const selected = conversation([failed, retried], { runRounds: { failed: { round: 4, current: false }, retried: { round: 4, current: true } } });
  assert.deepEqual([...agentConversationRunRounds(selected).values()], [4, 4]);
  assert.equal(agentConversationRoundCount(selected), 4);
  assert.deepEqual(conversationDeliveries(selected).map(item => [item.round, item.run.id]), [[4, retried.id]]);
});

test('缺失父记录或相似工具文本不猜轮号，空会话计零', () => {
  const missing = run('missing', { revisesRunId: 'truncated-history' });
  const other = run('other', { parentRunId: missing.id, events: [{ ...steerEvent, type: 'tool' }] });
  assert.deepEqual([...agentConversationRunRounds(conversation([missing, other])).values()], [1, 2]);
  assert.equal(agentConversationRoundCount(), 0);
  assert.equal(agentConversationRunRounds().size, 0);
});

test('调整方向的持久化轮次来源不依赖已裁剪的运行事件', () => {
  const fourth = run('fourth', { status: 'cancelled' });
  const resumed = run('resumed', { parentRunId: fourth.id, roundContinuationOfRunId: fourth.id, events: [] });
  const selected = conversation([run('one'), run('two'), run('three'), fourth, resumed]);
  assert.equal(agentConversationRunRounds(selected).get(resumed.id), 4);
  assert.equal(agentConversationRoundCount(selected), 4);
});
