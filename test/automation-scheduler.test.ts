import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error 调度器沿用原后端 ESM JavaScript，测试通过任务注入隔离外部写入。
import { createAutomationSchedulerTick } from '../server/jira-backend/automation-scheduler.mjs';

function fixture() {
  const events: string[] = [];
  const errors: string[] = [];
  const state = {
    settings: { enabled: true, dailyTimes: ['08:30'] },
    lastScheduledSlot: '',
    weeklyReport: { settings: { enabled: true, weekday: 5, time: '17:30' }, lastScheduledSlot: '' },
  };
  const tasks = {
    readState: async () => state,
    runScan: async (_trigger: string, slot: string) => { events.push('scan'); state.lastScheduledSlot = slot; },
    runWeeklyReport: async (_trigger: string, slot: string) => { events.push('report'); state.weeklyReport.lastScheduledSlot = slot; },
    reconcile: async () => { events.push('reconcile'); },
    onError: (name: string) => { errors.push(name); },
    now: () => new Date(2026, 8, 18, 18),
  };
  return { events, errors, state, tasks };
}

test('巡检失败后仍执行周报和 Jira 回读，下轮重试未完成巡检', async () => {
  const { events, errors, state, tasks } = fixture();
  let attempts = 0;
  const tick = createAutomationSchedulerTick({ ...tasks, runScan: async (trigger: string, slot: string) => {
    if (++attempts === 1) { events.push('scan failed'); throw new Error('Jira unavailable'); }
    await tasks.runScan(trigger, slot);
  } });
  await tick();
  assert.deepEqual(events, ['scan failed', 'report', 'reconcile']);
  assert.deepEqual(errors, ['Automation scan']);
  assert.equal(state.lastScheduledSlot, '');
  await tick();
  assert.deepEqual(events, ['scan failed', 'report', 'reconcile', 'scan', 'reconcile']);
  assert.equal(state.lastScheduledSlot, '2026-09-18 08:30');
});

test('维护超过定时间隔时合并重入，避免重复生成周报或回读', async () => {
  const { events, tasks } = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tick = createAutomationSchedulerTick({ ...tasks, runScan: async (trigger: string, slot: string) => {
    await gate;
    await tasks.runScan(trigger, slot);
  } });
  const first = tick();
  const second = tick();
  assert.equal(first, second);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['scan', 'report', 'reconcile']);
  await tick();
  assert.deepEqual(events, ['scan', 'report', 'reconcile', 'reconcile']);
});

test('读取扫描状态失败或周报失败，不阻止独立 Jira 回读', async () => {
  const { events, errors, tasks } = fixture();
  let reads = 0;
  const tick = createAutomationSchedulerTick({ ...tasks,
    readState: async () => {
      if (++reads === 1) throw new Error('temporary read failure');
      return tasks.readState();
    },
    runWeeklyReport: async () => { events.push('report failed'); throw new Error('report unavailable'); },
  });
  await tick();
  assert.deepEqual(events, ['report failed', 'reconcile']);
  assert.deepEqual(errors, ['Automation scan', 'Weekly report generation']);
});

test('暂停的策略不触发扫描或周报，回读失败后下一轮仍可执行', async () => {
  const { events, errors, state, tasks } = fixture();
  state.settings.enabled = false;
  state.weeklyReport.settings.enabled = false;
  let attempts = 0;
  const tick = createAutomationSchedulerTick({ ...tasks, reconcile: async () => {
    if (++attempts === 1) throw new Error('reconciliation unavailable');
    await tasks.reconcile();
  } });
  await tick();
  await tick();
  assert.deepEqual(events, ['reconcile']);
  assert.deepEqual(errors, ['Jira reconciliation']);
});
