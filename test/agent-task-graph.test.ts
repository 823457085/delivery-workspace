import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRun } from '../shared/agent-runtime.js';
import { emptyDeliveryEvidence } from '../shared/delivery-acceptance.js';
import { agentTaskBoardColumn, buildAgentTaskGraph } from '../src/features/agent-workbench/agent-task-graph.js';
import type { AgentConversation } from '../src/features/agent-workbench/conversation.js';

function conversation(id: string, title: string, task?: AgentRun['task']): AgentConversation {
  const run: AgentRun = { id: `${id}-run`, provider: 'codex', mode: 'agent', accessMode: 'workspace', model: 'gpt-5.6-sol',
    reasoningEffort: 'high', objective: title, workspacePath: `/worktrees/${id}`, sourceWorkspacePath: '/repo', baseBranch: 'main',
    isolatedWorkspace: true, branch: `codex/${id}`, headSha: 'abc', status: id === 'review' ? 'queued' : 'completed', sessionId: '',
    pid: null, result: '', error: '', events: [], changedFiles: id === 'worker' ? [{ path: 'src/a.ts', status: 'modified' }] : [],
    ...(task ? { task } : {}), createdAt: '2026-09-18T08:00:00.000Z', updatedAt: '2026-09-18T08:00:00.000Z' };
  return { id, title, runs: [run], latest: run, updatedAt: run.updatedAt, source: 'workspace', loaded: true };
}

test('task graph follows persisted parent and dependency links without guessing workspace peers', () => {
  const main = conversation('main', '主任务');
  const worker = conversation('worker', '普通标题', { parentConversationId: 'main', dependsOnConversationIds: [], role: 'worker',
    title: '实现接口', source: 'manual' });
  const review = conversation('review', '普通标题', { parentConversationId: 'main', dependsOnConversationIds: ['worker'], role: 'reviewer',
    title: '复核改动', source: 'manual' });
  const unrelated = conversation('other', '同工作区但未关联');
  const nodes = buildAgentTaskGraph(review, [main, worker, review, unrelated]);
  assert.deepEqual(nodes.map((node) => [node.id, node.role, node.title]), [
    ['main', 'main', '主任务'], ['worker', 'worker', '实现接口'], ['review', 'reviewer', '复核改动'],
  ]);
  assert.deepEqual(nodes[2].dependsOnConversationIds, ['worker']);
  assert.equal(nodes[1].changedFiles, 1);
  assert.equal(nodes[1].events, 0);
  assert.equal(nodes[1].resultReady, false);
  assert.equal(nodes[1].workspacePath, '/worktrees/worker');
});

test('task board maps runtime status and reviewer role to stable columns', () => {
  assert.equal(agentTaskBoardColumn('queued', 'worker'), 'queued');
  assert.equal(agentTaskBoardColumn('running', 'worker'), 'running');
  assert.equal(agentTaskBoardColumn('queued', 'reviewer'), 'review');
  assert.equal(agentTaskBoardColumn('completed', 'reviewer'), 'completed');
  for (const status of ['failed', 'interrupted', 'cancelled'] as const) assert.equal(agentTaskBoardColumn(status, 'worker'), 'blocked');
});

test('task graph reads human acceptance by persisted agent conversation and marks stale results', () => {
  const main = conversation('main', '主任务');
  const evidence = emptyDeliveryEvidence();
  const accepted = { recordId: 'agent:main', source: { runId: 'main-run', updatedAt: main.latest.updatedAt }, checks: evidence,
    decision: 'accepted' as const, summary: '已核对', revision: 1, updatedAt: main.latest.updatedAt };
  const nodes = buildAgentTaskGraph(main, [main], new Map([['main', accepted]]));
  assert.equal(nodes[0].runId, 'main-run');
  assert.equal(nodes[0].acceptanceStatus, 'accepted');
  const stale = buildAgentTaskGraph(main, [main], new Map([['main', { ...accepted, source: { ...accepted.source, runId: 'old-run' } }]]));
  assert.equal(stale[0].acceptanceStatus, 'stale');
});

test('task graph exposes run lineage and recovery facts without inventing a new action', () => {
  const main = conversation('main', '主任务');
  const recoveredRun: AgentRun = { ...main.latest, id: 'recovered-run', parentRunId: 'previous-run', recoveryOfRunId: 'previous-run',
    status: 'interrupted', recovery: { previousStatus: 'running', previousPid: 42, state: 'needs-review',
      checkedAt: main.latest.updatedAt, message: '请先核对原轮次' } };
  const recovered: AgentConversation = { ...main, runs: [recoveredRun], latest: recoveredRun, updatedAt: recoveredRun.updatedAt };
  const node = buildAgentTaskGraph(recovered, [recovered])[0];
  assert.equal(node.runId, 'recovered-run');
  assert.equal(node.parentRunId, 'previous-run');
  assert.equal(node.recoveryOfRunId, 'previous-run');
  assert.equal(node.recoveryState, 'needs-review');
  assert.equal(node.recoveryMessage, '请先核对原轮次');
});
