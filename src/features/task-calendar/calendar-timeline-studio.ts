import type { JiraIssue } from '../../../shared/hub';
import { isDone } from '../../shared/format';
import { plannedTaskRange } from '../../shared/task-schedule';
import { classifyIssueStage, type IssueStageId } from './task-triage-studio';

export interface GanttDayCell {
  day: string;
  monthDay: string;
  weekdayShort: string;
  isRestDay: boolean;
  isToday: boolean;
}

export interface GanttTimelineRow {
  issue: JiraIssue;
  startCol: number;
  endCol: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
  stage: IssueStageId;
  isOverdue: boolean;
  rangeLabel: string;
}

export interface TaskHealthSummary {
  total: number;
  doneCount: number;
  completionRate: number;
  overdueCount: number;
  unscheduledCount: number;
  assigneeCount: number;
}

const WEEKDAY_SHORT = ['日', '一', '二', '三', '四', '五', '六'];

export function formatLocalDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Builds a Monday-aligned N-day Gantt timeline window (default 14 days = 2-week sprint).
 */
export function buildGanttWindowDays(anchor: Date, windowDays = 14, today = new Date()): GanttDayCell[] {
  const count = Math.max(7, windowDays);
  const mondayOffset = (anchor.getDay() + 6) % 7;
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - mondayOffset);
  const todayKey = formatLocalDayKey(today);

  return Array.from({ length: count }, (_, idx) => {
    const current = new Date(start.getFullYear(), start.getMonth(), start.getDate() + idx);
    const key = formatLocalDayKey(current);
    const dow = current.getDay();
    return {
      day: key,
      monthDay: `${String(current.getMonth() + 1).padStart(2, '0')}/${String(current.getDate()).padStart(2, '0')}`,
      weekdayShort: WEEKDAY_SHORT[dow] || '',
      isRestDay: dow === 0 || dow === 6,
      isToday: key === todayKey,
    };
  });
}

function resolveIssueRange(issue: JiraIssue, dateField: string): { start: string; end: string } | undefined {
  if (dateField === 'planned') {
    return plannedTaskRange(issue);
  }
  const raw =
    dateField === 'created'
      ? issue.created
      : dateField === 'duedate'
        ? issue.dueDate
        : dateField === 'resolutiondate'
          ? issue.resolutionDate
          : issue.updated;
  const day = raw?.slice(0, 10) || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  return { start: day, end: day };
}

/**
 * Projects Jira issues onto a 14-day horizontal Gantt timeline (Frappe Gantt / Plane Roadmap style).
 */
export function buildGanttRows(
  issues: readonly JiraIssue[],
  days: readonly GanttDayCell[],
  dateField = 'planned',
  todayKey = formatLocalDayKey(new Date()),
): GanttTimelineRow[] {
  if (!days.length) return [];
  const windowStart = days[0]!.day;
  const windowEnd = days[days.length - 1]!.day;
  const indexByDay = new Map(days.map((cell, index) => [cell.day, index]));

  const rows: GanttTimelineRow[] = [];
  const seen = new Set<string>();

  for (const issue of issues) {
    if (seen.has(issue.key)) continue;
    const range = resolveIssueRange(issue, dateField);
    if (!range) continue;
    if (range.end < windowStart || range.start > windowEnd) continue;
    seen.add(issue.key);

    const clampedStart = range.start < windowStart ? windowStart : range.start;
    const clampedEnd = range.end > windowEnd ? windowEnd : range.end;
    const startCol = indexByDay.get(clampedStart) ?? 0;
    const endCol = indexByDay.get(clampedEnd) ?? days.length - 1;
    const done = isDone(issue);
    const deadline = (issue.endDate || issue.dueDate)?.slice(0, 10) || '';
    const isOverdue = !done && Boolean(deadline) && deadline < todayKey;

    rows.push({
      issue,
      startCol,
      endCol,
      continuesBefore: range.start < windowStart,
      continuesAfter: range.end > windowEnd,
      stage: classifyIssueStage(issue),
      isOverdue,
      rangeLabel: range.start === range.end ? range.start.slice(5) : `${range.start.slice(5)} → ${range.end.slice(5)}`,
    });
  }

  return rows.sort(
    (a, b) =>
      a.startCol - b.startCol ||
      (b.endCol - b.startCol) - (a.endCol - a.startCol) ||
      a.issue.key.localeCompare(b.issue.key),
  );
}

/**
 * Computes OpenProject / Plane workload & schedule health telemetry across filtered issues.
 */
export function summarizeTaskHealth(
  issues: readonly JiraIssue[],
  todayKey = formatLocalDayKey(new Date()),
): TaskHealthSummary {
  let doneCount = 0;
  let overdueCount = 0;
  let unscheduledCount = 0;
  const assignees = new Set<string>();

  for (const issue of issues) {
    const done = isDone(issue);
    if (done) doneCount++;
    const range = plannedTaskRange(issue);
    if (!range) {
      if (!done) unscheduledCount++;
    } else if (!done && range.end < todayKey) {
      overdueCount++;
    }
    const person = (issue.assignee || '').trim();
    if (person) assignees.add(person);
  }

  const total = issues.length;
  const completionRate = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  return {
    total,
    doneCount,
    completionRate,
    overdueCount,
    unscheduledCount,
    assigneeCount: assignees.size,
  };
}
