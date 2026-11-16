/**
 * 自然语言极速待办解析与 AI 协办提示词生成器
 * 借鉴 Todoist / Taskwarrior / Vikunja / Linear 快速创建体验：
 * 支持单行输入解析优先级（!高 / !1 / p0 / p1 / #高优）、相对或绝对截止日期（@今天 / @明天 / @周五 / @下周一 / @11-20 / @2026-11-20）以及行内备注（// 补充说明）。
 */
import type { TodoItem, WorkspaceTodoInput } from '../../../shared/workspace-todos';

export interface ParsedQuickTodo {
  title: string;
  details: string;
  dueDate: string;
  priority: WorkspaceTodoInput['priority'];
  matchedTokens: string[];
}

const WEEKDAY_MAP: Record<string, number> = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
};

function formatLocalYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return (
    candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === day
  );
}

function addLocalDays(base: Date, offsetDays: number): Date {
  const copy = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  copy.setDate(copy.getDate() + offsetDays);
  return copy;
}

function parseDateToken(rawToken: string, baseDate: Date): string | null {
  const token = rawToken.replace(/^@/, '').trim().toLowerCase();
  if (!token) return null;

  if (token === '今天' || token === '今日' || token === 'today') {
    return formatLocalYmd(addLocalDays(baseDate, 0));
  }
  if (token === '明天' || token === '明日' || token === 'tomorrow' || token === 'tmr') {
    return formatLocalYmd(addLocalDays(baseDate, 1));
  }
  if (token === '后天') {
    return formatLocalYmd(addLocalDays(baseDate, 2));
  }
  if (token === '大后天') {
    return formatLocalYmd(addLocalDays(baseDate, 3));
  }

  const relDaysMatch = token.match(/^\+?(\d{1,3})(?:d|天|天后)$/);
  if (relDaysMatch) {
    const days = Number(relDaysMatch[1]);
    return formatLocalYmd(addLocalDays(baseDate, days));
  }

  const weekdayMatch = token.match(
    /^(?:(本周|这周|下周)(?:周|星期)?|(本|这|下)(?:周|星期)|(?:周|星期))([一二三四五六日天])$/,
  );
  if (weekdayMatch) {
    const rawPrefix = weekdayMatch[1] || weekdayMatch[2] || '';
    const isNextWeek = rawPrefix.startsWith('下');
    const isThisWeek = rawPrefix.startsWith('本') || rawPrefix.startsWith('这');
    const targetDow = WEEKDAY_MAP[weekdayMatch[3]!]!;
    const currentDow = baseDate.getDay();
    // Convert Sunday=0 to ISO 1..7 (Mon=1 .. Sun=7) for predictable "本周 / 下周" semantics
    const currentIso = currentDow === 0 ? 7 : currentDow;
    const targetIso = targetDow === 0 ? 7 : targetDow;
    let delta = targetIso - currentIso;
    if (isNextWeek) {
      delta += 7;
    } else if ((!isThisWeek && delta < 0) || (isThisWeek && delta < 0)) {
      delta += 7;
    }
    return formatLocalYmd(addLocalDays(baseDate, delta));
  }

  const fullDateMatch = token.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (fullDateMatch) {
    const y = Number(fullDateMatch[1]);
    const m = Number(fullDateMatch[2]);
    const d = Number(fullDateMatch[3]);
    if (!isValidCalendarDate(y, m, d)) return null;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  const shortDateMatch = token.match(/^(\d{1,2})[-/.](\d{1,2})$/);
  if (shortDateMatch) {
    const m = Number(shortDateMatch[1]);
    const d = Number(shortDateMatch[2]);
    let y = baseDate.getFullYear();
    if (!isValidCalendarDate(y, m, d)) {
      if (isValidCalendarDate(y + 1, m, d)) y += 1;
      else return null;
    } else {
      const candidate = new Date(y, m - 1, d);
      const todayMidnight = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
      const diffDays = Math.round((candidate.getTime() - todayMidnight.getTime()) / 86_400_000);
      if (diffDays < -30 && isValidCalendarDate(y + 1, m, d)) {
        y += 1;
      }
    }
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  return null;
}

export function parseQuickTodoInput(raw: string, baseDate: Date = new Date()): ParsedQuickTodo {
  let working = raw.trim();
  let details = '';

  const noteMatch = working.match(/\s+(?:\/\/|｜)\s+(.+)$/);
  if (noteMatch && noteMatch.index !== undefined) {
    details = noteMatch[1]!.trim().slice(0, 2000);
    working = working.slice(0, noteMatch.index).trim();
  }

  let priority: WorkspaceTodoInput['priority'] = 'normal';
  let dueDate = '';
  const matchedTokens: string[] = [];
  const keptWords: string[] = [];

  for (const part of working.split(/\s+/).filter(Boolean)) {
    const lower = part.toLowerCase();
    if (
      ['!高', '！高', '!high', '！high', '!紧急', '！紧急', '!1', '！1', '#高优', '#紧急', '#urgent', 'p0', 'p1'].includes(lower)
    ) {
      priority = 'high';
      matchedTokens.push(part);
      continue;
    }
    if (['!普通', '！普通', '!normal', '！normal', 'p2', 'p3'].includes(lower)) {
      priority = 'normal';
      matchedTokens.push(part);
      continue;
    }
    if (part.startsWith('@') || part.startsWith('＠')) {
      const normalizedPart = `@${part.slice(1)}`;
      const parsedDate = parseDateToken(normalizedPart, baseDate);
      if (parsedDate) {
        dueDate = parsedDate;
        matchedTokens.push(part);
        continue;
      }
    }
    keptWords.push(part);
  }

  const title = (keptWords.join(' ').trim() || working).slice(0, 200);
  return {
    title,
    details,
    dueDate,
    priority,
    matchedTokens,
  };
}

export function buildTodoAgentPrompt(item: Pick<TodoItem, 'title' | 'details' | 'priority' | 'dueDate'>): string {
  const metaParts: string[] = [];
  if (item.priority === 'high') metaParts.push('优先级：高');
  if (item.dueDate) metaParts.push(`截止日期：${item.dueDate}`);
  const lines = [
    `请协助我推进并落地以下个人待办事项：`,
    `- 事项：${item.title}`,
  ];
  if (metaParts.length) lines.push(`- 约束：${metaParts.join(' · ')}`);
  if (item.details?.trim()) lines.push(`- 补充说明：${item.details.trim()}`);
  lines.push('', '请先结合当前工作区代码或上下文给出清晰执行步骤，如果可以直接处理请协助完成并验证。');
  return lines.join('\n');
}
