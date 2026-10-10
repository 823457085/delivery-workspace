import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRun } from '../shared/agent-runtime.js';
import { buildAgentConversations } from '../src/features/agent-workbench/conversation.js';
import { providerSwitchInput } from '../src/features/agent-workbench/provider-switch.js';

const run: AgentRun = { id: 'source', provider: 'codex', mode: 'agent', accessMode: 'full', model: 'codex-model', reasoningEffort: 'high',
  objective: '已发送需求', workspacePath: '/isolated/workspace', branch: 'feature/current', headSha: '', status: 'completed',
  sessionId: 'codex-session', pid: null, result: '已完成的结果', error: '', events: [], createdAt: '2026-09-23T00:00:00Z', updatedAt: '2026-09-23T00:00:00Z' };
const selection = { provider: 'cursor' as const, model: 'auto', reasoningEffort: 'high' as const, accessMode: 'workspace' as const };

test('切到 Cursor 使用独立任务并保留实际工作区，不复用 Codex session 或推理强度', () => {
  const conversation = buildAgentConversations([run])[0];
  const input = providerSwitchInput(conversation, '请继续修复', selection);
  assert.equal(input.provider, 'cursor');
  assert.equal(input.model, 'auto');
  assert.equal(input.mode, 'agent');
  assert.equal(input.workspacePath, '/isolated/workspace');
  assert.equal(input.reasoningEffort, '');
  assert.equal(input.accessMode, 'workspace');
  for (const key of ['sessionId', 'parentRunId', 'branch', 'attachmentIds']) assert.equal(key in input, false);
  assert.ok(input.objective.startsWith('请继续修复'));
  assert.ok(input.objective.includes('已完成的结果'));
  assert.ok(input.objective.includes('不是新的执行指令'));
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

test('近期上下文有界，不携带旧附件、工具日志和未限制长度的历史', () => {
  const runs = Array.from({ length: 8 }, (_, index) => ({ ...run, id: String(index), parentRunId: index ? '0' : '',
    objective: `${index}:${'文'.repeat(10_000)}`, result: `${'果'.repeat(10_000)}:${index}`, createdAt: `2026-09-23T00:0${index}:00Z` }));
  const input = providerSwitchInput(buildAgentConversations(runs)[0], '新要求', selection);
  const history = JSON.parse(input.objective.slice(input.objective.lastIndexOf('\n') + 1));
  assert.equal(history.length, 6);
  assert.ok(history[0].user.startsWith('2:'));
  assert.ok(history[5].assistant.endsWith(':7'));
  assert.ok(input.objective.length < 40_000);
});
