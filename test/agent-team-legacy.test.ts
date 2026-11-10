import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { legacyTeamTask, legacyTeamTasks } from '../server/agent-team-legacy.js';
import { defaultTeamProfileConfig } from '../shared/agent-team.js';
import type { AgentRun, AgentWorkflowSummary } from '../shared/agent-runtime.js';
import { emptyDeliveryEvidence, type DeliveryAcceptanceRecord } from '../shared/delivery-acceptance.js';

const startedAt = '2026-10-26T09:00:00.000Z', endedAt = '2026-10-26T10:00:00.000Z';
function fixture() {
  const implementation: AgentRun = { id: 'implement-1', conversationId: 'original-conversation', provider: 'codex', mode: 'agent', accessMode: 'workspace',
    model: 'historical-model', reasoningEffort: 'ultra', objective: '原任务', workspacePath: '/isolated/source', sourceWorkspacePath: '/source',
    branch: 'feature/v1', headSha: 'a'.repeat(40), status: 'completed', sessionId: 'native-1', pid: null, result: '实现原文 L123456', error: '', events: [],
    workflowSnapshot: { kind: 'git-tree', value: 'b'.repeat(40) }, createdAt: startedAt, updatedAt: startedAt };
  const review: AgentRun = { ...implementation, id: 'review-1', provider: 'claude', model: 'historical-reviewer', reasoningEffort: '',
    mode: 'ask', result: '审查原文 L654321', updatedAt: endedAt };
  const summary: AgentWorkflowSummary = { id: 'workflow-v1', templateId: 'engineering', parentConversationId: 'parent-1', objective: '原任务',
    acceptanceCriteria: [{ id: 'AC-1', text: '原标准' }], allowedPaths: ['src/**'], state: 'awaiting_acceptance', stage: 'review', round: 1,
    maxRounds: 2, escalated: true, reason: '原始原因', nextStep: '人工验收', actions: [], implementationConversationId: 'original-conversation',
    snapshot: implementation.workflowSnapshot, createdAt: startedAt, updatedAt: startedAt,
    providerFallback: { from: 'claude', to: 'codex', reason: '原始切换原因', at: startedAt },
    steps: [{ step: 2, stage: 'review', round: 1, runId: review.id, conversationId: 'review-conversation', profileId: 'reviewer', provider: 'codex',
      model: 'summary-model', reasoningEffort: 'high', status: 'completed', outcome: 'passed', reason: '审查通过' },
    { step: 1, stage: 'implement', round: 1, runId: implementation.id, conversationId: 'original-conversation', profileId: 'engineer', provider: 'claude',
      model: 'summary-model', reasoningEffort: 'high', status: 'completed', outcome: 'passed', reason: '实现完成' }] };
  const runs = new Map([implementation, review].map(run => [run.id, run]));
  const runtime = { workflows: () => [summary], getRun: (id: string) => runs.get(id) };
  const checks = emptyDeliveryEvidence();
  for (const item of Object.values(checks)) { item.status = 'not_applicable'; item.evidence = '隔离单元测试人工验收夹具，不代表真实用户验收'; }
  const acceptance: DeliveryAcceptanceRecord = { recordId: 'agent:original-conversation', revision: 3, source: { runId: implementation.id, updatedAt: endedAt },
    checks, decision: 'accepted', summary: '人工确认', updatedAt: endedAt };
  return { implementation, review, summary, runs, runtime, acceptance };
}

test('V1 只读投影保留真实步骤顺序、完整模型强度、运行产物与唯一验收归属，不改原记录', () => {
  const f = fixture(), before = structuredClone(f.summary), config = defaultTeamProfileConfig();
  const task = legacyTeamTask(f.runtime, f.summary.id, config, () => f.acceptance)!;
  assert.equal(task.legacy, true);
  assert.equal(task.legacyAcceptanceRecordId, 'agent:original-conversation');
  assert.equal(task.state, 'accepted');
  assert.deepEqual(task.nodes.map(node => node.runId), ['implement-1', 'review-1']);
  assert.deepEqual(task.nodes.map(node => node.effectiveChoice), [
    { provider: 'codex', model: 'historical-model', reasoningEffort: 'ultra' },
    { provider: 'claude', model: 'historical-reviewer', reasoningEffort: '' },
  ]);
  assert.equal(task.candidateEvidenceAt, endedAt, '最晚运行结果决定验收版本，不能只用旧 summary 时间');
  assert.equal(task.artifacts?.[1].hash, createHash('sha256').update(f.review.result).digest('hex'));
  assert.equal(task.artifacts?.[1].path, '/agent?run=review-1');
  assert.equal(task.sourceWorkspacePath, '/source');
  assert.equal(task.round, 1);
  assert.equal(task.maxRounds, null);
  assert.equal(task.budgetLimit, null);
  assert.equal(task.acceptance?.revision, 3);
  assert.equal(task.providerFallback?.reason, '原始切换原因');
  assert.deepEqual(f.summary, before);
  task.profileConfig.revision = 90;
  assert.equal(config.revision, 1);
  assert.equal(legacyTeamTasks(f.runtime, config).length, 1);
  assert.equal(legacyTeamTask(f.runtime, 'missing', config), undefined);
});

test('V1 进行中、已取消或来源过期的历史验收不能使投影看起来已通过', () => {
  const f = fixture(), config = defaultTeamProfileConfig();
  for (const state of ['implementing', 'verifying', 'reviewing', 'reworking', 'blocked', 'needs_decision', 'cancelled', 'taken_over'] as const) {
    f.summary.state = state;
    const task = legacyTeamTask(f.runtime, f.summary.id, config, () => f.acceptance)!;
    assert.notEqual(task.state, 'accepted', state);
    assert.equal(task.acceptance, undefined, state);
  }
  f.summary.state = 'awaiting_acceptance';
  f.acceptance.source.updatedAt = startedAt;
  assert.equal(legacyTeamTask(f.runtime, f.summary.id, config, () => f.acceptance)?.state, 'awaiting_acceptance');
  f.acceptance.source.updatedAt = endedAt; f.acceptance.recordId = 'agent:other-conversation';
  assert.equal(legacyTeamTask(f.runtime, f.summary.id, config, () => f.acceptance)?.acceptance, undefined);
});
