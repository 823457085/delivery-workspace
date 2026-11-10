import test from 'node:test';
import assert from 'node:assert/strict';
import { chinaWorkingDates, isChinaWorkingDay, splitWorkingDates } from '../shared/china-work-calendar.mjs';
// @ts-expect-error 原系统 ESM 模块没有全量类型声明。
const { buildTaskDateSegments } = await import('../server/jira-backend/automation-core.mjs');

test('2026 官方七个假期的每一天均休息，六个调休补班日均工作', () => {
  const holidays = [['01-01', '01-03'], ['02-15', '02-23'], ['04-04', '04-06'], ['05-01', '05-05'], ['06-19', '06-21'], ['09-25', '09-27'], ['10-01', '10-07']];
  let count = 0;
  for (const [start, end] of holidays) for (let time = Date.parse(`2026-${start}T00:00:00Z`); time <= Date.parse(`2026-${end}T00:00:00Z`); time += 86400000) {
    assert.equal(isChinaWorkingDay(new Date(time).toISOString().slice(0, 10)), false); count++;
  }
  assert.equal(count, 33);
  for (const day of ['01-04', '02-14', '02-28', '05-09', '09-20', '10-10']) assert.equal(isChinaWorkingDay(`2026-${day}`), true);
  assert.equal(isChinaWorkingDay('2026-12-25'), true, '境外节日不当作大陆休假');
  assert.equal(isChinaWorkingDay('2026-11-07'), false);
});

test('跨已收录年份使用各自日历，元旦后补班周日也计入', () => {
  assert.deepEqual(chinaWorkingDates('2025-12-31', '2026-01-06'), ['2025-12-31', '2026-01-04', '2026-01-05', '2026-01-06']);
  assert.deepEqual(splitWorkingDates(chinaWorkingDates('2025-12-31', '2026-01-06')), [['2025-12-31'], ['2026-01-04', '2026-01-05', '2026-01-06']]);
  assert.equal(isChinaWorkingDay('2025-10-08'), false);
  assert.equal(isChinaWorkingDay('2025-10-11'), true);
});

test('无效日期和未收录年份明确报错，不猜测节假日', () => {
  for (const invalid of ['2026-02-30', '2026-13-01', '0000-01-01', 'bad']) assert.throws(() => isChinaWorkingDay(invalid), /真实/);
  assert.throws(() => chinaWorkingDates('2027-01-01', '2027-01-08'), /2027.*日历/);
  assert.throws(() => chinaWorkingDates('2026-05-11', '2026-05-01'), /早于/);
});

test('旧自动拆任务入口同样跳过国庆和休息日，计入官方补班', () => {
  const parts = buildTaskDateSegments({ issueType: '任务', status: '开发中', startDate: '2026-09-30', endDate: '2026-10-12' });
  assert.deepEqual(parts.map((p: any) => [p.startDate, p.endDate]), [['2026-09-30', '2026-09-30'], ['2026-10-08', '2026-10-10'], ['2026-10-12', '2026-10-12']]);
  for (const part of parts) assert.ok(chinaWorkingDates(part.startDate, part.endDate).length <= 3);
});
