import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeeklyReportRun, getDueWeeklyReportSlot, getNextWeeklyReportRun, getWeeklyReportRange } from '../server/jira-backend/weekly-report.mjs';

const settings = { enabled: true, weekday: 5, time: '17:30' };

test('周报按周五 17:30 自动调度，并且同一计划只执行一次', () => {
  const before = new Date(2026, 8, 18, 17, 0);
  assert.equal(getDueWeeklyReportSlot(settings, '', before), '2026-09-11 17:30');
  assert.match(getNextWeeklyReportRun(settings, before) || '', /^2026-09-18T09:30:00\.000Z$/);

  const after = new Date(2026, 8, 18, 18, 0);
  assert.equal(getDueWeeklyReportSlot(settings, '2026-09-11 17:30', after), '2026-09-18 17:30');
  assert.equal(getDueWeeklyReportSlot(settings, '2026-09-18 17:30', after), '');
});

test('周报范围固定为计划周的周一到周日', () => {
  const range = getWeeklyReportRange(new Date(2026, 8, 18, 18, 0));
  assert.equal(range.start, '2026-09-14');
  assert.equal(range.end, '2026-09-20');
});

test('周报汇总真实 Jira、Agent 与自动维护结果', () => {
  const run = createWeeklyReportRun({
    now: new Date(2026, 8, 18, 18, 0),
    source: 'jira',
    issues: [
      { key: 'APEX-1', summary: '【系统配置】完成错误码配置交付', status: '已完成', statusCategory: 'Done', updated: '2026-09-17T10:00:00+08:00', resolutionDate: '2026-09-17T10:00:00+08:00', assignee: '测试负责人' },
      { key: 'APEX-2', summary: '【商家管理】后台用户与角色权限联调', status: '进行中', statusCategory: 'In Progress', updated: '2026-09-18T10:00:00+08:00', endDate: '2026-09-22', assignee: '测试负责人', parent: { key: 'APEX-10', summary: '【APEX重构】Admin BFF 全量联调交付' } },
      { key: 'APEX-3', summary: '等待接口', status: '阻塞', statusCategory: 'In Progress', updated: '2026-09-18T11:00:00+08:00' },
      { key: 'APEX-4', summary: '【认证权限】登录会话联调', status: '开发中', statusCategory: 'In Progress', updated: '2026-09-18T11:00:00+08:00', endDate: '2026-09-18', assignee: '测试负责人' },
      { key: 'APEX-10', summary: '【APEX重构】Admin BFF 全量联调交付', status: '开发中', statusCategory: 'In Progress', updated: '2026-09-18T11:00:00+08:00', startDate: '2026-09-14', endDate: '2026-10-26', assignee: '测试负责人' },
      { key: 'APEX-11', summary: '【认证权限】完成登录会话接口联调', status: '已完成', statusCategory: 'Done', updated: '2026-09-18T11:00:00+08:00', resolutionDate: '2026-09-18T11:00:00+08:00', assignee: '测试负责人', parent: { key: 'APEX-10', summary: '【APEX重构】Admin BFF 全量联调交付' } },
    ],
    jobs: [
      { status: 'completed', updatedAt: '2026-09-18T12:00:00+08:00' },
      { status: 'blocked', updatedAt: '2026-09-18T13:00:00+08:00' },
    ],
    automationRuns: [{ localDate: '2026-09-18', transitionUpdatedCount: 2, transitionBlockedCount: 1 }]
  });
  assert.equal(run.completedCount, 2);
  assert.equal(run.inProgressCount, 3);
  assert.equal(run.blockedCount, 2);
  assert.equal(run.agentCompletedCount, 1);
  assert.equal(run.maintenanceUpdatedCount, 2);
  assert.match(run.content, /^Apex 工作周报\n\n周报时间：2026年9月14日 - 2026年9月20日/);
  assert.match(run.content, /一、本周进展\n\n1、完成【系统配置】错误码配置交付。/);
  assert.match(run.content, /完成【认证权限】登录会话接口联调。/);
  assert.doesNotMatch(run.content, /本周进展[\s\S]*完成【APEX重构】Admin BFF 全量联调交付/);
  assert.match(run.content, /二、本周未完成/);
  assert.match(run.content, /三、下周计划\n\n1、【商家管理】：完成【后台用户与角色权限联调】，计划【9月22日】完成，负责人【测试负责人】。/);
  assert.doesNotMatch(run.content, /下周计划[\s\S]*9月18日/);
  assert.doesNotMatch(run.content, /^#/m);
  assert.doesNotMatch(run.content, /^- /m);
});
