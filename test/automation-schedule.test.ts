import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error 运行时模块为原系统 ESM JavaScript，项目未为其维护全量类型声明。
const automationCore = await import('../server/jira-backend/automation-core.mjs');
const {
  getIgnoredAutomationIssueKeys,
  isScheduledSliceIssue,
  shouldCompleteScheduledSlice,
} = automationCore;

function issue(overrides: Record<string, unknown> = {}) {
  return {
    key: 'DEMO-936',
    summary: '【认证权限】完成登录会话与动态菜单联调',
    description: 'schedule-group: fixture-schedule-group\nschedule-slice: 01',
    status: '开发中',
    statusCategory: '处理中',
    startDate: '2026-09-18',
    endDate: '2026-09-18',
    dueDate: null,
    parent: { key: 'DEMO-934', summary: '【APEX重构】完成 Admin BFF 全量联调交付' },
    subtasks: [],
    ...overrides,
  };
}

test('明确排期的 APEX 重构父子任务不被旧排除规则跳过', () => {
  const parent = issue({ key: 'DEMO-934', summary: '【APEX重构】完成 Admin BFF 全量联调交付', parent: null,
    description: 'schedule-group: fixture-schedule-group' });
  const child = issue();
  assert.deepEqual([...getIgnoredAutomationIssueKeys([parent, child])], []);

  const legacyParent = { ...parent, key: 'DEMO-900', description: '' };
  const legacyChild = { ...child, key: 'DEMO-901', description: '', parent: { key: 'DEMO-900', summary: legacyParent.summary } };
  assert.deepEqual([...getIgnoredAutomationIssueKeys([legacyParent, legacyChild])].sort(), ['DEMO-900', 'DEMO-901']);
});

test('排期子任务只在结束日 18:00 后或逾期后完成', () => {
  const scheduled = issue();
  assert.equal(isScheduledSliceIssue(scheduled), true);
  assert.equal(shouldCompleteScheduledSlice(scheduled, new Date(2026, 8, 18, 17, 59)), false);
  assert.equal(shouldCompleteScheduledSlice(scheduled, new Date(2026, 8, 18, 18, 0)), true);
  assert.equal(shouldCompleteScheduledSlice(scheduled, new Date(2026, 8, 19, 9, 0)), true);
  assert.equal(shouldCompleteScheduledSlice({ ...scheduled, status: '已完成', statusCategory: '完成' }, new Date(2026, 8, 18, 19, 0)), false);
});
