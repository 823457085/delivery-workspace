export function dateTime(value?: string | number | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
export function day(value?: string | null) { return value ? value.slice(0, 10) : '—'; }
export function safeUrl(value?: string) {
  try { const url = new URL(value || ''); return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
export function isDone(issue: { status: string; statusCategory: string }) { return /done|完成|关闭|resolved|closed/i.test(`${issue.status} ${issue.statusCategory}`); }
export function searchMatches(value: unknown, query: string) { return !query.trim() || JSON.stringify(value).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()); }
export function countBy<T>(items: T[], key: (item: T) => string) {
  const counts = new Map<string, number>();
  for (const item of items) { const label = key(item) || '未设置'; counts.set(label, (counts.get(label) || 0) + 1); }
  return [...counts].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}
export const statusLabels: Record<string, string> = {
  APPROVED: '自测已通过', EXCEPTION_MERGED: '例外已合入', AWAITING_REVIEW: '等待审核', BLOCKED: '阻塞', HOLD: '暂缓', RUNNING: '执行中',
  QUEUED: '排队中', DISPATCHING: '派发中', PENDING: '等待执行', MERGED: 'Git 已合入', NOT_MERGED: '未合入',
  NOT_STARTED: '未开始', IN_PROGRESS: '进行中', PAUSED: '已暂停', ENDED: '已结束', NOT_READY: '正式交付待补',
  waiting: '等待依赖', pending: '待派发', queued: '排队中', dispatching: '派发中', dispatched: '已派发',
  running: '执行中', review: '等待审核', completed: '已完成', blocked: '阻塞', failed: '失败',
  cancelled: '已取消', canceled: '已取消', skipped: '已跳过', paused: '已暂停', success: '成功', active: '运行中',
  PASS: '通过', FAIL: '失败', 'N/A': '有理由跳过', jira: 'Jira 实时', mock: '模拟来源',
};
export function statusTone(value?: string) {
  if (value === 'EXCEPTION_MERGED') return 'warning';
  if (value === 'NOT_MERGED' || value === 'NOT_STARTED') return 'info';
  if (/blocked|fail|error|阻塞/i.test(value || '')) return 'danger';
  if (/review|hold|pause|pending|waiting|queued|N\/A|暂缓|待/i.test(value || '')) return 'warning';
  if (/approved|merged|completed|success|pass|jira|完成/i.test(value || '')) return 'success';
  if (/running|progress|active|dispatch|进行/i.test(value || '')) return 'primary';
  return 'info';
}
