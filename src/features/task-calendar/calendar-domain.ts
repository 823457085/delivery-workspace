import type { JiraIssue } from '../../../shared/hub';
import { plannedOn, plannedTaskRange } from '../../shared/task-schedule';

export const calendarWeekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export function taskQueryParams(applied: Record<string, string>) {
  if (applied.dateField !== 'planned') return applied;
  // 来源接口没有计划区间查询；只请求已支持的字段，再按原始计划日期筛选本次返回的任务。
  const { start: _start, end: _end, ...params } = applied;
  return { ...params, dateField: 'updated', allTime: 'true' };
}

export function matchesPlannedFilter(issue: JiraIssue, applied: Record<string, string>) {
  if (applied.dateField !== 'planned' || applied.allTime === 'true' || (!applied.start && !applied.end)) return true;
  const range = plannedTaskRange(issue);
  return !!range && (!applied.start || range.end >= applied.start) && (!applied.end || range.start <= applied.end);
}

export function groupTasksByDate(items: JiraIssue[], field: string, anchor: Date) {
  const groups = new Map<string, JiraIssue[]>();
  if (field === 'planned') {
    for (const cell of buildMonthCalendar(anchor)) {
      const scheduled = items.filter(item => plannedOn(item, cell.day));
      if (scheduled.length) groups.set(cell.day, scheduled);
    }
  } else {
    for (const item of items) {
      const value = field === 'created' ? item.created : field === 'duedate' ? item.dueDate : field === 'resolutiondate' ? item.resolutionDate : item.updated;
      if (value) { const key = value.slice(0, 10); groups.set(key, [...(groups.get(key) || []), item]); }
    }
  }
  return groups;
}

export interface MonthCalendarCell {
  day: string;
  dateNumber: number;
  isCurrentMonth: boolean;
  isRestDay: boolean;
  isToday: boolean;
}

function dayKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function isWeekend(date: Date) {
  return date.getDay() === 0 || date.getDay() === 6;
}

export function monthTitle(date: Date) {
  return `${date.getFullYear()}年${String(date.getMonth() + 1).padStart(2, '0')}月`;
}

export function buildMonthCalendar(anchor: Date, today = new Date()): MonthCalendarCell[] {
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const firstDay = new Date(year, month, 1);
  const mondayOffset = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cellCount = Math.ceil((mondayOffset + daysInMonth) / 7) * 7;
  const gridStart = new Date(year, month, 1 - mondayOffset);
  const todayKey = dayKey(today);

  return Array.from({ length: cellCount }, (_, index) => {
    const date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index);
    return {
      day: dayKey(date),
      dateNumber: date.getDate(),
      isCurrentMonth: date.getMonth() === month,
      isRestDay: isWeekend(date),
      isToday: dayKey(date) === todayKey,
    };
  });
}
