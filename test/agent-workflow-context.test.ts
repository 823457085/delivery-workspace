import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRun } from '../shared/agent-runtime.js';
import type { RunView } from '../shared/types.js';
import { conversationWorkflowRuns, workflowAgentLanes, workflowContext } from '../src/features/agent-workbench/agent-workflow-context.js';
import type { AgentConversation } from '../src/features/agent-workbench/conversation.js';

function conversation(id: string, workspacePath: string, status: AgentRun['status'] = 'completed'): AgentConversation {
  const run: AgentRun = {
    id: `${id}-run`, provider: 'codex', mode: 'agent', accessMode: 'workspace', model: 'gpt-5.6-sol', reasoningEffort: 'high',
    objective: `${id} objective`, workspacePath, branch: 'feature/demo', headSha: '', status, sessionId: '', pid: null,
    result: '', error: '', events: [], createdAt: '2026-09-18T08:00:00.000Z', updatedAt: '2026-09-18T08:00:00.000Z',
  };
  return { id, title: `${id} title`, runs: [run], latest: run, updatedAt: run.updatedAt, source: 'workspace', loaded: true };
}

test('workflow context uses stable conversation and workspace identities', () => {
  const current = conversation('current', '/workspace/apex');
  assert.deepEqual(workflowContext(current), {
    conversationId: 'current', agentRunId: 'current-run', workspacePath: '/workspace/apex',
    branch: 'feature/demo', provider: 'codex',
  });
  assert.equal(workflowContext(undefined), undefined);
});

test('workflow panel keeps runs and parallel Agents scoped to the current conversation workspace', () => {
  const current = conversation('current', '/workspace/apex', 'running');
  const peer = conversation('peer', '/workspace/apex', 'queued');
  const completedPeer = conversation('done', '/workspace/apex', 'completed');
  const foreign = conversation('foreign', '/workspace/other', 'running');
  const lanes = workflowAgentLanes(current, [current, peer, completedPeer, foreign]);
  assert.deepEqual(lanes.map((lane) => [lane.id, lane.role]), [['current', 'main'], ['peer', 'parallel']]);

  const runs = [
    { runId: 'bound', context: { conversationId: 'current' } },
    { runId: 'other', context: { conversationId: 'peer' } },
    { runId: 'legacy' },
  ] as RunView[];
  assert.deepEqual(conversationWorkflowRuns(runs, 'current').map((run) => run.runId), ['bound']);
  assert.deepEqual(conversationWorkflowRuns(runs, ''), []);
});
