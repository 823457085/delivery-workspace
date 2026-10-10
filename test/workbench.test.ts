import test from 'node:test';
import assert from 'node:assert/strict';
import type { AutomationData, JiraIssue } from '../shared/hub';
import type { ExecutionDashboard } from '../shared/design-execution';
import { emptyArtifacts } from '../shared/design-execution';
import { deliveryRecords, forIssue, hasDeliveryResult, plannedToday, recordGroup, recordMatchesFilter, threadUrl } from '../src/features/workbench/domain';

const threadId = '01a08b3e-f123-7cb3-9dd3-6db3d9313032';
const automation = { jobs: [
  { id: 'APEX-29:design', issueKey: 'APEX-29', status: 'completed', updatedAt: '2026-09-09T10:00:00Z', threadId },
  { id: 'APEX-295:implementation', issueKey: 'APEX-295', status: 'blocked', updatedAt: '2026-09-11T10:00:00Z', threadId, selfTestReportPath: '/private/report.md', selfTestScreenshots: ['screen.png'] },
  { id: 'APEX-295:design', issueKey: 'APEX-295', status: 'dispatching', clientThreadId: threadId, updatedAt: '2026-09-10T10:00:00Z' },
] } as AutomationData;
test('任务关联使用完整 Jira key，不误连相似编号或重复计算同一来源记录', () => {
  const records = deliveryRecords(automation);
  assert.equal(forIssue(records, 'apex-295').length, 2);
  assert.equal(forIssue(records, 'APEX-29').length, 1);
  assert.equal(forIssue(records, '').length, 0);
  assert.equal(records[0].id, 'job:APEX-295:implementation');
});
test('未返回正式会话 ID 时不使用 clientThreadId 创建跳转', () => {
  const record = deliveryRecords(automation).find(item => item.id === 'job:APEX-295:design')!;
  assert.equal(threadUrl(record.threadId), undefined);
  assert.equal(threadUrl(threadId), `codex://threads/${threadId}`);
  for (const invalid of ['javascript:alert(1)', 'new', `${threadId}?prompt=run`, '']) assert.equal(threadUrl(invalid), undefined);
});
test('附件使用已有受限下载接口，不暴露本地文件 URL', () => {
  const record = deliveryRecords(automation)[0];
  assert.equal(record.links.find(link => link.label === '自测报告')?.url, '/api/source/artifact?id=APEX-295%3Aimplementation&type=report');
  assert.equal(record.links.find(link => link.label === '自测截图 1')?.url, '/api/source/artifact?id=APEX-295%3Aimplementation&type=screenshot&index=0');
});
test('方案关联已回写的 DEV 层级，重试不把旧阶段结果当本轮结果', () => {
  const design = { runs: [{ id: 'run', input: { issueKey: 'APEX-295', title: '方案' }, status: 'running', threadId,
    updatedAt: '2026-09-11T11:00:00Z', artifacts: { ...emptyArtifacts(), requirementKey: 'APEX-295', devParentKey: 'APEX-300', designTaskKey: 'APEX-301' },
    steps: [
      { id: 'intake', status: 'passed', attempts: 1, resultAttempt: 1, result: { summary: '已核实需求' } },
      { id: 'design', status: 'running', attempts: 2, resultAttempt: 1, result: { summary: '旧方案' } },
    ] }] } as ExecutionDashboard;
  const records = deliveryRecords(automation, design);
  const record = forIssue(records, 'APEX-301')[0];
  assert.equal(record.id, 'design:run');
  assert.equal(record.result, '已核实需求');
  assert.equal(record.status, 'running');
  assert.deepEqual(record.issueKeys, ['APEX-295', 'APEX-300', 'APEX-301']);
});
test('今日计划不以更新时间代替计划日期，不包含已完成或日期范围外任务', () => {
  const issue = { status: '开发中', statusCategory: 'indeterminate', startDate: '2026-09-10', endDate: '2026-09-12' } as JiraIssue;
  assert.equal(plannedToday(issue, '2026-09-11'), true);
  assert.equal(plannedToday(issue, '2026-09-13'), false);
  assert.equal(plannedToday({ ...issue, statusCategory: 'done' }, '2026-09-11'), false);
  assert.equal(plannedToday({ ...issue, startDate: null, endDate: null, dueDate: null, updated: '2026-09-11' }, '2026-09-11'), false);
  assert.equal(plannedToday({ ...issue, startDate: null, endDate: null, dueDate: '2026-09-11' }, '2026-09-11'), true);
});
test('待审、已合入和执行完成独立分类，空来源不产生演示记录', () => {
  assert.equal(recordGroup('AWAITING_REVIEW'), 'review');
  assert.equal(recordGroup('BLOCKED'), 'blocked');
  assert.equal(recordGroup('completed'), 'other');
  assert.equal(recordGroup('MERGED'), 'other');
  assert.deepEqual(deliveryRecords(), []);
});
test('工作台默认待处理只聚合运行、待审和阻塞，结果判定不依赖会话', () => {
  const records = deliveryRecords(automation);
  const running = records.find(record => record.status === 'dispatching')!;
  const blocked = records.find(record => record.status === 'blocked')!;
  const completed = records.find(record => record.status === 'completed')!;

  assert.equal(recordMatchesFilter(running, 'actionable'), true);
  assert.equal(recordMatchesFilter(blocked, 'actionable'), true);
  assert.equal(recordMatchesFilter(completed, 'actionable'), false);
  assert.equal(hasDeliveryResult(blocked), true);
  assert.equal(hasDeliveryResult({ ...completed, threadId, result: '', error: '', links: [] }), false);
});
