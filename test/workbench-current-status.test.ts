import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileDeliveryRecords, recordMatchesFilter, type DeliveryRecord } from '../src/features/workbench/domain';
import type { JiraIssue } from '../shared/hub';
import type { AgentRun } from '../shared/agent-runtime';

const record = { id: 'job:1', issueKeys: ['DEMO-1'], status: 'blocked', threadId: 'thread-1', result: '', error: '历史失败', links: [] } as unknown as DeliveryRecord;
const done = { key: 'DEMO-1', status: '已完成', statusCategory: 'Done' } as JiraIssue;
const run = (status: AgentRun['status'], sessionId = 'thread-1') => ({ id: 'run-1', sessionId, status, updatedAt: '2026-09-23T10:00:00Z' }) as AgentRun;

test('Jira 完成后移出待办但保留历史失败证据', () => {
  const [item] = reconcileDeliveryRecords([record], [done], []);
  assert.equal(item.currentStatus, 'completed');
  assert.equal(item.status, 'blocked');
  assert.equal(recordMatchesFilter(item, 'actionable'), false);
  assert.equal(recordMatchesFilter(item, 'results'), true);
});
test('历史执行中并不表示当前 Agent 正在运行', () => {
  const [item] = reconcileDeliveryRecords([{ ...record, status: 'running' }], [], []);
  assert.equal(item.currentStatus, 'unknown');
  assert.equal(recordMatchesFilter(item, 'running'), false);
});
test('真实运行、排队与 Jira 状态分开，不能关联其他会话', () => {
  const [active] = reconcileDeliveryRecords([record], [done], [run('running')]);
  assert.equal(active.agentStatus, 'running');
  assert.equal(active.jiraStatuses?.[0].status, '已完成');
  assert.equal(recordMatchesFilter(active, 'running'), true);
  const [queued] = reconcileDeliveryRecords([record], [], [run('queued')]);
  assert.equal(recordMatchesFilter(queued, 'running'), false);
  assert.equal(recordMatchesFilter(queued, 'actionable'), true);
  const [other] = reconcileDeliveryRecords([record], [done], [run('running', 'other')]);
  assert.equal(other.agentStatus, undefined);
  assert.equal(other.currentStatus, 'completed');
});
test('多个 Jira 仅部分完成不能关闭整条交付待办', () => {
  const [item] = reconcileDeliveryRecords([{ ...record, issueKeys: ['DEMO-1', 'DEMO-2'] }], [done], []);
  assert.equal(item.currentStatus, 'pending');
});
test('Jira 子任务不进入待处理、待审核或阻塞统计，历史结果仍保留', () => {
  const subtask = { key: 'DEMO-1', status: '开发中', statusCategory: '处理中', issueType: '子任务', parent: { key: 'DEMO-2' } } as JiraIssue;
  for (const source of ['联调自测', '合入审核']) {
    for (const runs of [[], [run('failed')]]) {
      const [item] = reconcileDeliveryRecords([{ ...record, source, status: 'review' }], [subtask], runs);
      for (const filter of ['actionable', 'review', 'blocked'] as const) assert.equal(recordMatchesFilter(item, filter), false);
      assert.equal(recordMatchesFilter(item, 'all'), true);
      assert.equal(recordMatchesFilter(item, 'results'), true);
      assert.equal(item.error, record.error);
      assert.equal(item.status, 'review');
    }
  }
});
test('子任务判定只看主关联 Jira，不因关联子任务或标题误隐藏主任务', () => {
  const parent = { key: 'DEMO-1', status: '开发中', statusCategory: '处理中', issueType: '任务', parent: null } as JiraIssue;
  const subtask = { ...parent, key: 'DEMO-2', issueType: 'Sub-task', parent: { key: 'DEMO-1' } } as JiraIssue;
  const [item] = reconcileDeliveryRecords([{ ...record, title: '子任务汇总', issueKeys: ['DEMO-1', 'DEMO-2'] }], [parent, subtask], []);
  assert.equal(recordMatchesFilter(item, 'actionable'), true);
  const [child] = reconcileDeliveryRecords([{ ...record, issueKeys: ['DEMO-2'] }], [subtask], []);
  assert.equal(recordMatchesFilter(child, 'actionable'), false);
});
test('子任务的真实 Agent 运行与排队仍可监控，不因 Jira 分类隐藏', () => {
  const subtask = { key: 'DEMO-1', status: '开发中', statusCategory: '处理中', issueType: '子任务', parent: null } as JiraIssue;
  for (const status of ['running', 'queued'] as const) {
    const [item] = reconcileDeliveryRecords([record], [subtask], [run(status)]);
    assert.equal(recordMatchesFilter(item, 'actionable'), true);
    assert.equal(recordMatchesFilter(item, 'running'), status === 'running');
  }
});
test('已完成 Jira 不再计入旧审核或失败状态，未完成不能按关键词误判完成', () => {
  const [completed] = reconcileDeliveryRecords([{ ...record, source: '合入审核', status: 'review' }], [done], [run('failed')]);
  for (const filter of ['actionable', 'review', 'blocked'] as const) assert.equal(recordMatchesFilter(completed, filter), false);
  const [pending] = reconcileDeliveryRecords([record], [{ ...done, status: '未完成', statusCategory: '处理中' }], []);
  assert.equal(recordMatchesFilter(pending, 'actionable'), true);
});
