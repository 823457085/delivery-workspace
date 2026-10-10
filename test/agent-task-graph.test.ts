import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRun } from '../shared/agent-runtime.js';
import { buildAgentTaskGraph } from '../src/features/agent-workbench/agent-task-graph.js';
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
});
