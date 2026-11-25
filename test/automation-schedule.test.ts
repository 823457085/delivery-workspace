import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error 运行时模块为原系统 ESM JavaScript，项目未为其维护全量类型声明。
const automationCore = await import('../server/jira-backend/automation-core.mjs');
const {
  buildRequirementSegmentTitles,
  findMatchingManagedSegmentSubtask,
  getIgnoredAutomationIssueKeys,
  isScheduledSliceIssue,
  shouldCompleteScheduledSlice,
} = automationCore;

test('优先沿用父任务的具体拆分标题，排期段数不一致时停止生成', () => {
  const parent = {
    summary: '【统一管理平台】完成微前端接入交付',
    description: '**子任务拆分**\n\n1）编写并定稿微前端接入契约（11/23–11/25，3 天）\n\n'
      + '2）【ELM】完成 ELM（elm-web）接入与账号工作台联调（2026-11-26 至 2026-11-30，3 个工作日）\n\n'
      + '3）完成四系统全链路联调自测\n\n**相关文档**\n- 本项没有子任务范围',
  };
  assert.deepEqual(buildRequirementSegmentTitles(parent, 3), [
    '【统一管理平台】编写并定稿微前端接入契约',
    '【ELM】完成 ELM（elm-web）接入与账号工作台联调',
    '【统一管理平台】完成四系统全链路联调自测',
  ]);
  assert.deepEqual(buildRequirementSegmentTitles(parent, 4), []);
  assert.deepEqual(buildRequirementSegmentTitles({ ...parent, description: 'h2. 子任务拆分\n# 实现消息列表\n# 实现消息详情\nh2. 相关文档\n# 无关范围' }, 2), [
    '【统一管理平台】实现消息列表', '【统一管理平台】实现消息详情',
  ]);
});

test('功能范围有逐段证据时生成实义标题，禁止兜底编号或丢弃额外范围', () => {
  const parent = {
    summary: '【商户管理】完成商户账户开发交付',
    description: 'h2. 前端范围\n* 商户列表查询，支持筛选\n* 账户详情展示\nh2. 验收标准\n* 验收原文',
  };
  assert.deepEqual(buildRequirementSegmentTitles(parent, 4), []);
  assert.deepEqual(buildRequirementSegmentTitles(parent, 2), [
    '【商户管理】完成商户列表查询', '【商户管理】完成账户详情展示',
  ]);
  assert.deepEqual(buildRequirementSegmentTitles(parent, 3), []);
  assert.deepEqual(buildRequirementSegmentTitles(parent, 5), []);
  assert.deepEqual(buildRequirementSegmentTitles({ ...parent, description: '*实现说明*\n细节待补充' }, 2), []);
  assert.deepEqual(buildRequirementSegmentTitles({ ...parent, description: '目标：支持账户列表筛选；展示账户详情' }, 2), []);
  assert.deepEqual(buildRequirementSegmentTitles({ ...parent, description: '前端范围：\n* 具体业务范围以来源 Jira 的需求与验收条件为准。' }, 3), []);
  assert.deepEqual(buildRequirementSegmentTitles({ ...parent, description: '*子任务拆分*\n1. 实现父任务第 1 项功能\n2. 待确认' }, 2), []);
});

test('受管子任务查重不会把 2 段与 20 段混为一条', () => {
  const old = { key: 'OPAY-386', description: '自动规则标识：delivery-3-day-split/delivery-segment-1-of-20' };
  assert.equal(findMatchingManagedSegmentSubtask([old], new Set(), { marker: 'delivery-segment-1-of-2' }), undefined);
  assert.equal(findMatchingManagedSegmentSubtask([old], new Set(), { marker: 'delivery-segment-1-of-20' }), old);
});

function issue(overrides: Record<string, unknown> = {}) {
  return {
    key: 'GBP-936',
    summary: '【认证权限】完成登录会话与动态菜单联调',
    description: 'schedule-group: apex-admin-bff-integration-20261026\nschedule-slice: 01',
    status: '开发中',
    statusCategory: '处理中',
    startDate: '2026-09-18',
    endDate: '2026-09-18',
    dueDate: null,
    parent: { key: 'GBP-934', summary: '【APEX重构】完成 Admin BFF 全量联调交付' },
    subtasks: [],
    ...overrides,
  };
}

test('明确排期的 APEX 重构父子任务不被旧排除规则跳过', () => {
  const parent = issue({ key: 'GBP-934', summary: '【APEX重构】完成 Admin BFF 全量联调交付', parent: null,
    description: 'schedule-group: apex-admin-bff-integration-20261026' });
  const child = issue();
  assert.deepEqual([...getIgnoredAutomationIssueKeys([parent, child])], []);

  const legacyParent = { ...parent, key: 'GBP-900', description: '' };
  const legacyChild = { ...child, key: 'GBP-901', description: '', parent: { key: 'GBP-900', summary: legacyParent.summary } };
  assert.deepEqual([...getIgnoredAutomationIssueKeys([legacyParent, legacyChild])].sort(), ['GBP-900', 'GBP-901']);
});

test('排期子任务只在结束日 18:00 后或逾期后完成', () => {
  const scheduled = issue();
  assert.equal(isScheduledSliceIssue(scheduled), true);
  assert.equal(shouldCompleteScheduledSlice(scheduled, new Date(2026, 8, 18, 17, 59)), false);
  assert.equal(shouldCompleteScheduledSlice(scheduled, new Date(2026, 8, 18, 18, 0)), true);
  assert.equal(shouldCompleteScheduledSlice(scheduled, new Date(2026, 8, 19, 9, 0)), true);
  assert.equal(shouldCompleteScheduledSlice({ ...scheduled, status: '已完成', statusCategory: '完成' }, new Date(2026, 8, 18, 19, 0)), false);
});
