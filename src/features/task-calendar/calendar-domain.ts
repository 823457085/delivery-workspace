import type { JiraIssue } from '../../../shared/hub';
import { plannedOn, plannedTaskRange } from '../../shared/task-schedule';

export const calendarWeekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export interface TaskFilter {
  assignee: string;
  projects: string;
  versions: string;
  keyword: string;
  start: string;
  end: string;
  dateField: string;
  allTime: boolean;
  includeSubtasks: boolean;
  includeDone: boolean;
  maxResults: string;
  sortOrder: string;
}

export const advancedTaskDefaults = {
  assignee: 'currentUser()',
  versions: '',
  start: '',
  end: '',
  dateField: 'planned',
  allTime: true,
  maxResults: '5000',
  sortOrder: 'default',
} satisfies Partial<TaskFilter>;

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

export interface CalendarTaskSegment {
  issue: JiraIssue;
  startColumn: number;
  endColumn: number;
  lane: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/** 按当前日历的实际日期连续性合并任务；每周单独排布，重叠任务使用不同轨道。 */
export function buildCalendarWeeks(cells: MonthCalendarCell[], itemsByDay: Map<string, JiraIssue[]>) {
  const weeks = Array.from({ length: Math.ceil(cells.length / 7) }, (_, index) => ({
    days: cells.slice(index * 7, index * 7 + 7), segments: [] as CalendarTaskSegment[], laneCount: 0,
  }));
  const occurrences = new Map<string, { issue: JiraIssue; days: number[] }>();
  cells.forEach((cell, index) => {
    for (const issue of itemsByDay.get(cell.day) || []) {
      let entry = occurrences.get(issue.key);
      if (!entry) { entry = { issue, days: [] }; occurrences.set(issue.key, entry); }
      if (entry.days.at(-1) !== index) entry.days.push(index);
    }
  });
  for (const { issue, days } of occurrences.values()) {
    for (let first = 0; first < days.length;) {
      let last = first;
      while (last + 1 < days.length && days[last + 1] === days[last] + 1) last++;
      const start = days[first], end = days[last];
      for (let week = Math.floor(start / 7); week <= Math.floor(end / 7); week++) {
        const from = Math.max(start, week * 7), to = Math.min(end, week * 7 + 6);
        weeks[week].segments.push({ issue, startColumn: from % 7, endColumn: to % 7, lane: 0,
          continuesBefore: from > start, continuesAfter: to < end });
      }
      first = last + 1;
    }
  }
  for (const week of weeks) {
    const occupied: number[] = [];
    week.segments.sort((a, b) => a.startColumn - b.startColumn || b.endColumn - a.endColumn || a.issue.key.localeCompare(b.issue.key));
    for (const segment of week.segments) {
      const mask = ((1 << (segment.endColumn - segment.startColumn + 1)) - 1) << segment.startColumn;
      let lane = occupied.findIndex(value => !(value & mask));
      if (lane < 0) { lane = occupied.length; occupied.push(0); }
      occupied[lane] |= mask;
      segment.lane = lane;
    }
    week.laneCount = occupied.length;
  }
  return weeks;
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
