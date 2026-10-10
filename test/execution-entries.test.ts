import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRun } from '../shared/agent-runtime';
import type { Job } from '../shared/hub';
import { executionEntries, executionScope } from '../src/features/auto-delivery/execution-entries';

function run(id: string, overrides: Partial<AgentRun> = {}): AgentRun {
  return { id, provider: 'codex', mode: 'ask', accessMode: 'workspace', model: '', reasoningEffort: '', objective: id,
    workspacePath: '/repo', branch: 'main', headSha: '', status: 'completed', sessionId: id, pid: null,
    result: '', error: '', events: [], createdAt: '2026-09-23T01:00:00Z', updatedAt: '2026-09-23T01:00:00Z', ...overrides };
}
function job(id: string, overrides: Partial<Job> = {}): Job {
  return { id, title: id, issueKey: 'TASK-1', issueUrl: '', category: '', categoryLabel: '', model: '',
    status: 'running', workspacePath: '/repo', branch: 'main', threadId: '', attempts: 1,
    createdAt: '2026-09-23T00:00:00Z', updatedAt: '2026-09-23T00:00:00Z', ...overrides };
}
test('执行优先展示运行轮，不让新排队消息遮住它；历史轮不重复占行', () => {
  const rows = executionEntries([run('root'), run('running', { parentRunId: 'root', status: 'running' }),
    run('queued', { parentRunId: 'running', status: 'queued', createdAt: '2026-09-23T02:00:00Z' })], []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].run?.id, 'running');
  assert.equal(executionScope(rows[0].status), 'active');
});
test('没有正在执行的轮次时只展示最新状态，不把历史失败留在需关注', () => {
  const rows = executionEntries([run('failed', { status: 'failed' }), run('done', { parentRunId: 'failed', createdAt: '2026-09-23T02:00:00Z' })], []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].run?.id, 'done');
  assert.equal(executionScope(rows[0].status), 'history');
});
test('只按正式会话 ID 关联自动化任务，同目录不同会话和空 ID 不合并', () => {
  const rows = executionEntries([run('one', { sessionId: 'thread-1' }), run('two', { sessionId: 'thread-2' })],
    [job('linked', { threadId: 'thread-1' }), job('unlinked'), job('pending-id', { clientThreadId: 'thread-2' })]);
  assert.equal(rows.length, 4);
  assert.equal(rows.find(row => row.run?.id === 'one')?.job?.id, 'linked');
  assert.equal(rows.find(row => row.run?.id === 'two')?.job, undefined);
});
test('缺少父轮、未知状态和空数据可显示，不误算成已完成', () => {
  assert.equal(executionEntries([run('child', { parentRunId: 'missing' })], []).length, 1);
  assert.deepEqual(executionEntries([], []), []);
  assert.equal(executionScope('failed'), 'attention');
  assert.equal(executionScope('unknown'), 'attention');
  assert.equal(executionScope('interrupted'), 'history');
  assert.equal(executionScope('pending'), 'active');
});
test('同一正式会话的新排队任务不能被旧的已完成轮次隐藏', () => {
  const rows = executionEntries([run('old', { sessionId: 'thread-1' })],
    [job('new', { threadId: 'thread-1', status: 'pending', updatedAt: '2026-09-23T02:00:00Z' })]);
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.id === 'job:new')?.status, 'pending');
});
