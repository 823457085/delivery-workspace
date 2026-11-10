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
  assert.equal(executionScope('skipped'), 'history');
  assert.equal(executionScope('pending'), 'active');
});
test('同一正式会话的新排队任务不能被旧的已完成轮次隐藏', () => {
  const rows = executionEntries([run('old', { sessionId: 'thread-1' })],
    [job('new', { threadId: 'thread-1', status: 'pending', updatedAt: '2026-09-23T02:00:00Z' })]);
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.id === 'job:new')?.status, 'pending');
});
test('父链截断后仍按稳定会话合并，同目录同物理会话的独立对话不合并', () => {
  const runs = [run('older', { conversationId: 'stable', parentRunId: 'missing-a', sessionId: 'shared-thread' }),
    run('newer', { conversationId: 'stable', parentRunId: 'missing-b', sessionId: 'shared-thread',
      createdAt: '2026-09-23T02:00:00Z', updatedAt: '2026-09-23T02:00:00Z' }),
    run('independent', { conversationId: 'other', parentRunId: 'older', sessionId: 'shared-thread' })];
  const original = structuredClone(runs);
  const rows = executionEntries(runs, []);
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.id === 'agent:stable')?.run?.id, 'newer');
  assert.equal(rows.find(row => row.id === 'agent:other')?.run?.id, 'independent');
  assert.deepEqual(runs, original);
});
test('标题仅提取已知任务包装，Jira 标题与用户命名原文优先，位置码不改写', () => {
  const objective = '你的角色：开发者\n职责：读取项目\n以下为按时间排序的真实团队对话，仅作为上下文：\n'
    + JSON.stringify([{ speaker: '用户', text: '旧任务' }, { speaker: '用户', text: '修复 L_TASK_1001\n保留原始输入' }]);
  const value = run('wrapped', { conversationId: 'stable', objective, sessionId: 'thread-1' });
  const original = structuredClone(value);
  assert.equal(executionEntries([value], [])[0].title, '修复 L_TASK_1001');
  assert.equal(executionEntries([run('current', { objective: '内部说明\n## 当前任务\n检查 L_TASK_1002\n## 限制\n只读' })], [])[0].title, '检查 L_TASK_1002');
  assert.equal(executionEntries([run('unknown', { objective: '未知包装 L_ORIGINAL\n不能猜测删除' })], [])[0].title, '未知包装 L_ORIGINAL');
  const linked = job('linked', { threadId: 'thread-1', title: '【Jira】L_TITLE_1003 原文\n补充行' });
  assert.equal(executionEntries([value], [linked])[0].title, linked.title);
  const title = '自定义 L_CUSTOM_1004  会话标题';
  assert.equal(executionEntries([value], [linked], { stable: title })[0].title, title);
  assert.deepEqual(value, original);
  assert.equal(linked.title, '【Jira】L_TITLE_1003 原文\n补充行');
});
test('正式报告展示公开摘要，异常始终保留原文，原始结果与任务不修改', () => {
  const summary = '已核验 L_RESULT_1001，真实接口待验证';
  const result = '```delivery-report\n' + JSON.stringify({ version: 1, taskResult: { summary } }) + '\n```';
  const value = run('reported', { objective: '核对 L_TASK_1001', result });
  const original = structuredClone(value);
  assert.equal(executionEntries([value], [])[0].summary, summary);
  const error = ' L_API_ERROR：服务返回原文\n请保留位置码。';
  const failed = { ...value, error, status: 'failed' as const };
  assert.equal(executionEntries([failed], [])[0].summary, error);
  const linked = job('business', { title: 'L_TITLE', result: '业务结果 L_JOB_RESULT', error: '业务异常 L_JOB_ERROR' });
  assert.equal(executionEntries([], [linked])[0].summary, linked.error);
  assert.deepEqual(value, original);
  assert.equal(failed.result, result);
  assert.equal(failed.objective, value.objective);
});
test('执行器来源覆盖 API 与 Grok，活动仅用于执行中而不覆盖异常或终态结果', () => {
  const sources = executionEntries([run('api', { provider: 'api' }), run('grok', { provider: 'grok' }),
    run('deepseek', { provider: 'deepseek' }), run('workbuddy', { provider: 'workbuddy' })], []);
  assert.equal(sources.find(row => row.run?.id === 'api')?.source, '模型 API');
  assert.equal(sources.find(row => row.run?.id === 'grok')?.source, 'Grok（xAI）');
  assert.equal(sources.find(row => row.run?.id === 'deepseek')?.source, 'DeepSeek');
  assert.equal(sources.find(row => row.run?.id === 'workbuddy')?.source, '腾讯 WorkBuddy');
  const active = run('active', { status: 'running', result: '已保存阶段结果 L_PROGRESS',
    events: [{ id: 'tool', type: 'tool', message: 'run_command', createdAt: '2026-09-23T01:00:00Z' }] });
  const original = structuredClone(active);
  assert.equal(executionEntries([active], [])[0].summary, '执行命令');
  assert.equal(executionEntries([{ ...active, status: 'queued' }], [])[0].summary, '已提交执行器，等待开始');
  assert.equal(executionEntries([{ ...active, status: 'completed' }], [])[0].summary, active.result);
  assert.equal(executionEntries([{ ...active, error: 'L_ERROR 原文' }], [])[0].summary, 'L_ERROR 原文');
  assert.deepEqual(active, original);
});
