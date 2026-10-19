/** Jira 计划区间：优先计划结束日期，缺失时使用截止日期；只有一个日期时视为单日。 */
export function plannedTaskRange(issue: { startDate?: string | null; endDate?: string | null; dueDate?: string | null }) {
  const start = issue.startDate?.slice(0, 10) || '';
  const end = (issue.endDate || issue.dueDate)?.slice(0, 10) || '';
  const from = start || end, to = end || start;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return undefined;
  return { start: from, end: to };
}

export function plannedOn(issue: Parameters<typeof plannedTaskRange>[0], day: string) {
  const range = plannedTaskRange(issue);
  return !!range && range.start <= day && day <= range.end;
}
