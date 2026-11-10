import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCalendarWeeks, buildMonthCalendar, groupTasksByDate, isWeekend, matchesPlannedFilter, monthTitle, taskQueryParams } from '../src/features/task-calendar/calendar-domain';
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

const layout = (tasks: JiraIssue[], anchor = new Date(2026, 10, 1)) =>
  buildCalendarWeeks(buildMonthCalendar(anchor), groupTasksByDate(tasks, 'planned', anchor));

test('同一周内的连续排期合并为一个跨列任务条，单日任务仍对应原日期', () => {
  const [first, second] = layout([
    issue({ key: 'LONG-1', startDate: '2026-11-02', endDate: '2026-11-06' }),
    issue({ key: 'DAY-1', startDate: '2026-11-05' }),
  ]);
  assert.equal(first.segments.length, 0);
  assert.deepEqual(second.segments.map(s => [s.issue.key, s.startColumn, s.endColumn, s.lane]), [
    ['LONG-1', 0, 4, 0], ['DAY-1', 3, 3, 1],
  ]);
});

test('跨周任务在周末与下周一衔接，包含首尾两天且不延长排期', () => {
  const weeks = layout([issue({ startDate: '2026-10-30', endDate: '2026-11-03' })]);
  const segments = weeks.flatMap(w => w.segments);
  assert.deepEqual(segments.map(s => [s.startColumn, s.endColumn, s.continuesBefore, s.continuesAfter]), [
    [4, 6, false, true], [0, 1, true, false],
  ]);
  assert.equal(segments.reduce((total, s) => total + s.endColumn - s.startColumn + 1, 0), 5);
});

test('六个重叠任务全部展开且不会覆盖，同一轨道可复用不相交的日期', () => {
  const tasks = Array.from({ length: 6 }, (_, i) => issue({ key: `OVERLAP-${i}`, startDate: '2026-11-02', endDate: '2026-11-04' }));
  tasks.push(issue({ key: 'LATER-1', startDate: '2026-11-05', endDate: '2026-11-06' }));
  const week = layout(tasks)[1];
  assert.equal(week.segments.length, 7);
  assert.equal(week.laneCount, 6);
  assert.equal(week.segments.find(s => s.issue.key === 'LATER-1')?.lane, 0);
  for (const a of week.segments) for (const b of week.segments) {
    if (a !== b && a.lane === b.lane) assert.ok(a.endColumn < b.startColumn || b.endColumn < a.startColumn);
  }
});

test('间断日期不会被合并，重复输入不会产生重复条，布局不依赖接口顺序', () => {
  const cells = buildMonthCalendar(new Date(2026, 10, 1));
  const a = issue({ key: 'A-1' }), b = issue({ key: 'B-1' });
  const map = new Map([['2026-11-02', [b, a, a]], ['2026-11-04', [a]]]);
  const weeks = buildCalendarWeeks(cells, map);
  assert.deepEqual(weeks[1].segments.map(s => [s.issue.key, s.startColumn, s.endColumn, s.lane]), [
    ['A-1', 0, 0, 0], ['B-1', 0, 0, 1], ['A-1', 2, 2, 0],
  ]);
  map.set('2026-11-02', [a, b]);
  assert.deepEqual(buildCalendarWeeks(cells, map), weeks);
});

test('长期跨月任务仅覆盖月历可见范围，时间字段日历仍为单日', () => {
  const anchor = new Date(2026, 10, 1);
  const task = issue({ startDate: '2020-01-01', endDate: '2030-12-31', updated: '2026-11-03T08:00:00Z' });
  const weeks = layout([task], anchor);
  assert.equal(weeks.length, 6);
  for (const week of weeks) {
    assert.equal(week.segments.length, 1);
    assert.deepEqual([week.segments[0].startColumn, week.segments[0].endColumn, week.laneCount], [0, 6, 1]);
  }
  const updated = buildCalendarWeeks(buildMonthCalendar(anchor), groupTasksByDate([task], 'updated', anchor));
  const segments = updated.flatMap(w => w.segments);
  assert.equal(segments.length, 1);
  assert.deepEqual([segments[0].startColumn, segments[0].endColumn], [1, 1]);
});
