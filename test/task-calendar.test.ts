import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMonthCalendar, isWeekend, monthTitle } from '../src/features/task-calendar/calendar-domain';

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
