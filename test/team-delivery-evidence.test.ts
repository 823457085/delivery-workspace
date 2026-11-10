import test from 'node:test';
import assert from 'node:assert/strict';
import { teamDeliveryEvidence } from '../shared/agent-workflow-evidence';
import { emptyDeliveryEvidence, type DeliveryAcceptanceRecord } from '../shared/delivery-acceptance';
import { evaluateWorkflow, type AgentWorkflowRecord } from '../shared/agent-workflow';
import type { AgentRun } from '../shared/agent-runtime';
import { reconcileDeliveryRecords } from '../src/features/workbench/domain';
import { createDeliveryAcceptanceSourceResolver } from '../server/delivery-acceptance-source';
import { buildAgentConversations } from '../src/features/agent-workbench/conversation';
import { buildAgentTaskGraph } from '../src/features/agent-workbench/agent-task-graph';

const report = (value: unknown) => `\`\`\`delivery-report\n${JSON.stringify({ version: 1, ...value as object })}\n\`\`\``;
function fixture() {
  const record: AgentWorkflowRecord = { id: 'flow-1', templateId: 'engineering', parentConversationId: 'parent', objective: '修复计算',
    acceptanceCriteria: [{ id: 'AC-1', text: '计算正确' }], allowedPaths: ['src/**'], attachmentIds: [], maxRounds: 2, escalated: false,
    decisions: [], createdAt: '2026-10-26T01:00:00.000Z', updatedAt: '2026-10-26T01:00:00.000Z' };
  const snapshot = { kind: 'git-tree' as const, value: 'candidate-1' };
  const evidence = { ...emptyDeliveryEvidence(), tests: { status: 'passed' as const, evidence: 'npm test 退出码 0', sha: '' } };
  const run = (stage: 'implement' | 'verify' | 'review', step: number, result: string): AgentRun => ({
    id: `run-${step}`, conversationId: `conversation-${step}`, provider: 'codex', mode: 'agent', accessMode: 'workspace', model: 'gpt-6.1-sol', reasoningEffort: 'high',
    objective: record.objective, workspacePath: '/isolated', branch: 'feature/test', headSha: '', status: 'completed', sessionId: '', pid: null,
    result, resultReady: true, error: '', events: [], createdAt: `2026-10-26T01:0${step}:00.000Z`, updatedAt: `2026-10-26T01:0${step}:30.000Z`,
    workflowSnapshot: snapshot, task: { parentConversationId: 'parent', dependsOnConversationIds: [], role: stage === 'implement' ? 'worker' : stage === 'verify' ? 'verifier' : 'reviewer',
      title: stage, source: 'workflow', sourceId: 'workflow:flow-1', workflow: { id: record.id, templateId: record.templateId, stage, round: 0, step } },
  });
  const runs = [
    { ...run('implement', 1, report({ taskResult: { role: 'implementer', status: 'succeeded' } })), changedFiles: [{ path: 'src/api.ts', status: 'modified' as const }] },
    run('verify', 2, report({ validationEvidence: evidence, taskResult: { role: 'verifier', status: 'succeeded',
      acceptance: [{ id: 'AC-1', status: 'passed', evidence: '实际测试通过' }] } })),
    run('review', 3, report({ taskResult: { role: 'reviewer', status: 'succeeded', verdict: 'approved' } })),
  ];
  return { record, runs, evidence, summary: evaluateWorkflow(record, runs).summary };
}

test('团队实现会话预填同一候选版本的独立验证证据，普通会话保持原行为', () => {
  const { runs, evidence, summary } = fixture();
  assert.equal(summary.state, 'awaiting_acceptance');
  assert.deepEqual(teamDeliveryEvidence(runs[0], runs, [summary]), { checks: evidence, updatedAt: runs[2].updatedAt, active: false });
  assert.equal(teamDeliveryEvidence({ ...runs[0], task: undefined }, runs, [summary]), undefined);
  const delivery = reconcileDeliveryRecords([], [], runs, { includeStandalone: true, workflows: [summary] })
    .find(item => item.id === 'agent:conversation-1')!;
  assert.deepEqual(delivery.reportedEvidence, evidence);
  assert.equal(delivery.updatedAt, runs[2].updatedAt);
  assert.equal(delivery.workflowActive, false);
  assert.equal(delivery.acceptanceStatus, 'pending');
});

test('版本不符、验证缺失或失败、审查失败及流程未通过时不能预填旧证据', () => {
  for (const mutate of [
    ({ runs }: ReturnType<typeof fixture>) => { runs[1].workflowSnapshot = { kind: 'git-tree', value: 'other' }; },
    ({ runs }: ReturnType<typeof fixture>) => { runs[1] = { ...runs[1], resultReady: false }; },
    ({ runs }: ReturnType<typeof fixture>) => { runs[1].result = report({ validationEvidence: emptyDeliveryEvidence(), taskResult: { role: 'verifier', status: 'failed' } }); },
    ({ runs }: ReturnType<typeof fixture>) => { runs[2].result = report({ taskResult: { role: 'reviewer', status: 'blocked', verdict: 'approved' } }); },
    ({ summary }: ReturnType<typeof fixture>) => { summary.state = 'reworking'; },
    ({ summary }: ReturnType<typeof fixture>) => { summary.state = 'cancelled'; },
  ]) {
    const value = fixture(); mutate(value);
    assert.equal(teamDeliveryEvidence(value.runs[0], value.runs, [value.summary])?.checks, undefined);
  }
  const value = fixture();
  assert.equal(teamDeliveryEvidence(value.runs[0], value.runs, [])?.active, true, '流程状态缺失时不允许确认验收');
});

test('团队后续运行使已有人工验收失效，前后端使用相同来源并阻止执行中通过', async () => {
  const { runs, record, summary, evidence } = fixture();
  const saved: DeliveryAcceptanceRecord = { recordId: 'agent:conversation-1', revision: 1, source: { runId: runs[0].id, updatedAt: runs[2].updatedAt },
    checks: evidence, decision: 'rejected', summary: '需要重新核对', updatedAt: runs[2].updatedAt };
  const resolve = createDeliveryAcceptanceSourceResolver(() => ({ requirements: [], fixes: [], runs, workflows: [summary] }));
  assert.deepEqual(await resolve(saved.recordId), { ...saved.source, active: false });
  const conversations = buildAgentConversations(runs);
  assert.equal(buildAgentTaskGraph(conversations.find(item => item.id === 'conversation-1'), conversations,
    new Map([['conversation-1', saved]]), true, [summary]).find(item => item.id === 'conversation-1')?.acceptanceStatus, 'rejected');
  const next = { ...runs[1], id: 'run-4', status: 'running' as const, resultReady: false,
    createdAt: '2026-10-26T02:00:00.000Z', updatedAt: '2026-10-26T02:00:30.000Z',
    task: { ...runs[1].task!, workflow: { ...runs[1].task!.workflow!, step: 4 } } };
  runs.push(next);
  Object.assign(summary, evaluateWorkflow(record, runs).summary);
  const delivery = reconcileDeliveryRecords([], [], runs, { includeStandalone: true, workflows: [summary], acceptances: [saved] })
    .find(item => item.id === saved.recordId)!;
  assert.equal(delivery.acceptanceStatus, 'stale');
  assert.equal(delivery.reportedEvidence, undefined);
  assert.equal(delivery.workflowActive, true);
  assert.deepEqual(await resolve(saved.recordId), { runId: runs[0].id, updatedAt: next.updatedAt, active: true });
});

test('兼容旧步骤记录时，新实现或审查早于验证均阻止沿用旧验收证据', () => {
  for (const mutate of [
    ({ runs }: ReturnType<typeof fixture>) => { runs[0].createdAt = '2026-10-26T02:00:00.000Z'; },
    ({ runs }: ReturnType<typeof fixture>) => { runs[2].createdAt = '2026-10-26T01:01:30.000Z'; },
  ]) {
    const value = fixture(); mutate(value);
    const evidence = teamDeliveryEvidence(value.runs[0], value.runs, [value.summary]);
    assert.equal(evidence?.checks, undefined);
    assert.equal(evidence?.active, true);
  }
});

test('实现后代码发生变化并已重新验证、重新审查同一新版本时，允许预填新证据', () => {
  const value = fixture();
  const snapshot = { kind: 'git-tree' as const, value: 'reverified-candidate' };
  value.runs[1].workflowSnapshot = snapshot;
  value.runs[2].workflowSnapshot = snapshot;
  value.summary.snapshot = snapshot;
  assert.notEqual(value.runs[0].workflowSnapshot?.value, snapshot.value);
  assert.deepEqual(teamDeliveryEvidence(value.runs[0], value.runs, [value.summary]),
    { checks: value.evidence, updatedAt: value.runs[2].updatedAt, active: false });
});
