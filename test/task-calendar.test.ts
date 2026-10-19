import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMonthCalendar, groupTasksByDate, isWeekend, matchesPlannedFilter, monthTitle, taskQueryParams } from '../src/features/task-calendar/calendar-domain';
import type { JiraIssue } from '../shared/hub';
import { plannedOn } from '../src/shared/task-schedule';

test('月历从周一开始，并覆盖当月前后的完整周', () => {
  const cells = buildMonthCalendar(new Date(2026, 8, 15), new Date(2026, 8, 15));
  assert.equal(cells[0].day, '2026-08-31');
  assert.equal(cells.at(-1)?.day, '2026-10-04');
  assert.equal(cells.length, 35);
  assert.equal(monthTitle(new Date(2026, 8, 15)), '2026年09月');
});

test('周六和周日标记为休息日，工作日不标记', () => {
  assert.equal(isWeekend(new Date(2026, 8, 19)), true);
  assert.equal(isWeekend(new Date(2026, 8, 20)), true);
  assert.equal(isWeekend(new Date(2026, 8, 21)), false);
});

const issue = (fields: Partial<JiraIssue>) => ({ key: 'TEST-1', startDate: null, endDate: null, dueDate: null, updated: '2026-09-01T08:00:00Z', ...fields } as JiraIssue);

test('计划日历覆盖完整计划区间，优先计划结束且不以更新时间代替排期', () => {
  const task = issue({ startDate: '2026-09-30', endDate: '2026-10-02', dueDate: '2026-10-20' });
  const groups = groupTasksByDate([task], 'planned', new Date(2026, 9, 1));
  assert.deepEqual([...groups.keys()], ['2026-09-30', '2026-10-01', '2026-10-02']);
  assert.equal(plannedOn(task, '2026-10-01'), true);
  assert.equal(plannedOn(task, '2026-10-03'), false);
  assert.deepEqual([...groupTasksByDate([task], 'updated', new Date(2026, 9, 1)).keys()], ['2026-09-01']);
});

test('只有一个计划日期时按单日展示，无排期保留列表但不伪造日历日期', () => {
  const tasks = [issue({ startDate: '2026-10-10' }), issue({ dueDate: '2026-10-12' }), issue({}), issue({ startDate: '2026-10-20', endDate: '2026-10-19' })];
  const groups = groupTasksByDate(tasks, 'planned', new Date(2026, 9, 1));
  assert.deepEqual([...groups.keys()], ['2026-10-10', '2026-10-12']);
  assert.equal(matchesPlannedFilter(tasks[2], { dateField: 'planned', allTime: 'true' }), true);
  assert.equal(matchesPlannedFilter(tasks[2], { dateField: 'planned', allTime: 'false', start: '2026-10-01' }), false);
});

test('计划查询按区间交集筛选且不把未支持的日期字段或时间条件传给来源', () => {
  const applied = { dateField: 'planned', allTime: 'false', start: '2026-10-15', end: '2026-10-16', projects: 'APEX', includeDone: 'false', maxResults: '5000' };
  assert.equal(matchesPlannedFilter(issue({ startDate: '2026-10-01', endDate: '2026-10-15' }), applied), true);
  assert.equal(matchesPlannedFilter(issue({ startDate: '2026-10-17' }), applied), false);
  assert.deepEqual(taskQueryParams(applied), { dateField: 'updated', allTime: 'true', projects: 'APEX', includeDone: 'false', maxResults: '5000' });
  const updated = { ...applied, dateField: 'updated' };
  assert.deepEqual(taskQueryParams(updated), updated);
});

test('长期任务仅展开当前月历范围，切月后重新计算', () => {
  const task = issue({ startDate: '2020-01-01', endDate: '2030-12-31' });
  const september = groupTasksByDate([task], 'planned', new Date(2026, 8, 1));
  const october = groupTasksByDate([task], 'planned', new Date(2026, 9, 1));
  assert.equal(september.size, 35);
  assert.equal(october.size, 35);
  assert.equal(october.has('2026-10-15'), true);
  assert.equal(september.has('2026-10-15'), false);
});
