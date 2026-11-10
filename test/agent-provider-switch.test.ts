import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRun } from '../shared/agent-runtime.js';
import { agentConversationContinuation, agentConversationInsertRun, buildAgentConversations, canSteerAgentRun } from '../src/features/agent-workbench/conversation.js';
import { providerSwitchInput } from '../src/features/agent-workbench/provider-switch.js';

const run: AgentRun = { id: 'source', provider: 'codex', mode: 'agent', accessMode: 'full', model: 'codex-model', reasoningEffort: 'high',
  objective: '已发送需求', workspacePath: '/isolated/workspace', branch: 'feature/current', headSha: '', status: 'completed',
  sessionId: 'codex-session', pid: null, result: '已完成的结果', error: '', events: [], createdAt: '2026-09-23T00:00:00Z', updatedAt: '2026-09-23T00:00:00Z' };
const selection = { provider: 'cursor' as const, model: 'auto', reasoningEffort: 'high' as const, accessMode: 'workspace' as const };

test('切到 Cursor 保留对话和纯用户要求，不复用 Codex session 或推理强度', () => {
  const conversation = buildAgentConversations([run])[0];
  const input = providerSwitchInput(conversation, '请继续修复', selection);
  assert.equal(input.provider, 'cursor');
  assert.equal(input.model, 'auto');
  assert.equal(input.mode, 'agent');
  assert.equal(input.workspacePath, '/isolated/workspace');
  assert.equal(input.reasoningEffort, '');
  assert.equal(input.accessMode, 'workspace');
  assert.equal(input.continueConversationId, conversation.id);
  for (const key of ['sessionId', 'parentRunId', 'branch', 'attachmentIds']) assert.equal(key in input, false);
  assert.equal(input.objective, '请继续修复');
  assert.equal(conversation.latest.sessionId, 'codex-session');
});

test('切回 Codex 保留只读模式，并使用 Codex 模型和推理强度', () => {
  const conversation = buildAgentConversations([{ ...run, provider: 'cursor', mode: 'ask' }])[0];
  const input = providerSwitchInput(conversation, '分析问题', { provider: 'codex', model: 'codex-model', reasoningEffort: 'high', accessMode: 'full', serviceTier: 'default' });
  assert.equal(input.provider, 'codex');
  assert.equal(input.mode, 'ask');
  assert.equal(input.accessMode, 'workspace');
  assert.equal(input.reasoningEffort, 'high');
  assert.equal(input.serviceTier, 'default');
});

test('切到 Claude 保留当前对话，不携带 Codex 专属参数或原生会话 ID', () => {
  const conversation = buildAgentConversations([run])[0];
  const input = providerSwitchInput(conversation, '继续检查', {
    ...selection, provider: 'claude', model: 'sonnet', serviceTier: 'priority',
  });
  assert.equal(input.provider, 'claude');
  assert.equal(input.model, 'sonnet');
  assert.equal(input.continueConversationId, conversation.id);
  assert.equal(input.reasoningEffort, 'high', 'Claude 保留本轮选定强度');
  assert.equal('serviceTier' in input, false);
  assert.equal('sessionId' in input, false);
});

test('历史交接交由服务端，不将旧附件、工具日志或历史正文混入用户消息', () => {
  const runs = Array.from({ length: 8 }, (_, index) => ({ ...run, id: String(index), parentRunId: index ? '0' : '',
    objective: `${index}:${'文'.repeat(10_000)}`, result: `${'果'.repeat(10_000)}:${index}`, createdAt: `2026-09-23T00:0${index}:00Z` }));
  const input = providerSwitchInput(buildAgentConversations(runs)[0], '新要求', selection);
  assert.equal(input.objective, '新要求');
  assert.equal(input.continueConversationId, '0');
});

test('旧执行器运行、新执行器排队时，续聊跟随最后发送的消息且不插入旧轮次', () => {
  const active = { ...run, status: 'running' as const, conversationId: 'conversation', updatedAt: '2026-09-23T00:03:00Z' };
  const queued = { ...run, id: 'queued', conversationId: 'conversation', provider: 'cursor' as const,
    status: 'queued' as const, sessionId: '', createdAt: '2026-09-23T00:01:00Z' };
  const conversation = buildAgentConversations([queued, active])[0];
  assert.equal(conversation.latest.id, active.id, '进度仍显示正在执行的旧轮次');
  assert.equal(agentConversationContinuation(conversation).id, queued.id);
  assert.equal(agentConversationInsertRun(conversation), undefined);
  const switchedBack = { ...queued, id: 'back-to-codex', provider: 'codex' as const, createdAt: '2026-09-23T00:02:00Z' };
  const roundTrip = buildAgentConversations([active, queued, switchedBack])[0];
  assert.equal(agentConversationContinuation(roundTrip).id, switchedBack.id);
  assert.equal(agentConversationInsertRun(roundTrip), undefined, '切回同名执行器也不能插入旧原生 session');
  const followup = { ...switchedBack, id: 'codex-followup', parentRunId: switchedBack.id, createdAt: '2026-09-23T00:03:00Z' };
  assert.equal(agentConversationInsertRun(buildAgentConversations([followup, switchedBack, queued, active])[0]), undefined,
    '切回后继续排队的 Codex 消息也不能插入切换前的轮次');
});

test('同一原生会话的普通排队续聊仍允许向当前轮插入', () => {
  const active = { ...run, status: 'running' as const, conversationId: 'conversation' };
  const queued = { ...run, id: 'queued', status: 'queued' as const, conversationId: 'conversation', createdAt: '2026-09-23T00:01:00Z' };
  const conversation = buildAgentConversations([active, queued])[0];
  assert.equal(agentConversationContinuation(conversation).id, queued.id);
  assert.equal(agentConversationInsertRun(conversation)?.id, active.id);
});

test('乱序完成后的预备隔离上下文优先于创建更晚的同执行器消息', () => {
  const earlier = { ...run, conversationId: 'conversation', updatedAt: '2026-09-23T00:03:00Z', continuation: {
    sessionId: 'prepared-session', workspacePath: '/prepared/workspace', branch: 'feature/prepared', headSha: 'prepared-head',
    sourceWorkspacePath: run.workspacePath, baseBranch: run.branch, isolatedWorkspace: true as const,
  } };
  const later = { ...run, id: 'created-later', conversationId: 'conversation',
    createdAt: '2026-09-23T00:01:00Z', updatedAt: '2026-09-23T00:02:00Z' };
  const conversation = buildAgentConversations([later, earlier])[0];
  assert.equal(conversation.runs.at(-1)?.id, later.id);
  assert.equal(conversation.latest.id, earlier.id);
  assert.equal(agentConversationContinuation(conversation).id, earlier.id);
  assert.equal(providerSwitchInput(conversation, '继续检查', selection).workspacePath, '/prepared/workspace');
  const cursorQueued = { ...later, provider: 'cursor' as const, status: 'queued' as const, sessionId: '' };
  const afterSwitch = buildAgentConversations([cursorQueued, earlier])[0];
  assert.equal(agentConversationContinuation(afterSwitch).id, cursorQueued.id, '已排队的跨执行器消息不被旧预备目录覆盖');
});

test('同毫秒创建时按后端新到旧记录识别最后发送的执行器', () => {
  const active = { ...run, conversationId: 'conversation', status: 'running' as const };
  const first = { ...run, id: 'cursor-first', conversationId: 'conversation', provider: 'cursor' as const,
    status: 'queued' as const, sessionId: '' };
  const last = { ...first, id: 'codex-last', provider: 'codex' as const };
  const conversation = buildAgentConversations([last, first, active])[0];
  assert.deepEqual(conversation.runs.map(item => item.id), [active.id, first.id, last.id]);
  assert.equal(conversation.latest.id, active.id);
  assert.equal(agentConversationContinuation(conversation).id, last.id);
  assert.equal(agentConversationInsertRun(conversation), undefined);
});

test('调整方向只显示在未跨执行器父链的排队消息，切回后的普通续聊也不能提前执行', () => {
  const active = { ...run, id: 'a', status: 'running' as const };
  const cursor = { ...run, id: 'b', parentRunId: 'a', provider: 'cursor' as const, status: 'queued' as const,
    providerSwitch: { from: 'codex' as const, context: '' } };
  const codex = { ...run, id: 'c', parentRunId: 'b', status: 'queued' as const,
    providerSwitch: { from: 'cursor' as const, context: '' } };
  const followup = { ...run, id: 'd', parentRunId: 'c', status: 'queued' as const };
  const ordinary = { ...run, id: 'ordinary', parentRunId: 'a', status: 'queued' as const };
  const runs = [followup, codex, cursor, ordinary, active];
  assert.equal(canSteerAgentRun(cursor, active, runs), false);
  assert.equal(canSteerAgentRun(codex, active, runs), false);
  assert.equal(canSteerAgentRun(followup, active, runs), false, '普通续聊自身没有切换标记，也要检查祖先');
  assert.equal(canSteerAgentRun(followup, active, runs.map(item => ({ ...item, providerSwitch: undefined }))), false,
    '父链执行器不同也构成切换边界');
  assert.equal(canSteerAgentRun(ordinary, active, runs), true);
  assert.equal(canSteerAgentRun(ordinary, undefined, runs), false);
  assert.equal(canSteerAgentRun({ ...ordinary, status: 'completed' }, active, runs), false);
});
