import type { AutomationData, CatchupData, JiraIssue, MergeData } from '../../../shared/hub';
import { isCurrentStepResult, type ExecutionDashboard } from '../../../shared/design-execution';
import type { AgentRun } from '../../../shared/agent-runtime';

export interface DeliveryRecord {
  id: string; source: string; issueKeys: string[]; title: string; status: string;
  threadId: string; clientThreadId?: string; workspacePath: string; branch: string;
  updatedAt: string; result: string; error: string; detailPath: string;
  links: { label: string; url: string }[];
  currentStatus?: string;
  jiraStatuses?: { key: string; status: string }[];
  jiraSubtask?: boolean;
  agentStatus?: string;
}
/** 历史记录不可充当运行心跳；当前状态只使用已关联 Jira 和本机运行快照，不按标题猜关联。 */
export function reconcileDeliveryRecords(records: DeliveryRecord[], issues: JiraIssue[], runs: AgentRun[]) {
  const jira = new Map(issues.map(issue => [issue.key.toUpperCase(), issue]));
  return records.map(record => {
    const linked = record.issueKeys.map(key => jira.get(key)).filter((issue): issue is JiraIssue => !!issue);
    // 以主关联任务判断子任务，避免把附带 DEV 子任务的主交付记录一并隐藏。
    const primaryIssue = jira.get(record.issueKeys[0] || '');
    const jiraSubtask = !!primaryIssue && (!!primaryIssue.parent || /^(子任务|sub[- ]?task)$/i.test(primaryIssue.issueType));
    const related = record.threadId ? runs.filter(run => [run.id, run.sessionId, run.originSessionId].includes(record.threadId)) : [];
    const active = related.find(run => run.status === 'running') || related.find(run => run.status === 'queued');
    const latest = [...related].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
    const done = linked.length > 0 && linked.length === record.issueKeys.length
      && linked.every(issue => /^(done|完成|已完成|关闭|已关闭|resolved|closed)$/i.test(issue.statusCategory) || /^(done|完成|已完成|关闭|已关闭|resolved|closed)$/i.test(issue.status));
    const currentStatus = active?.status || (done ? 'completed' : record.source === '合入审核' && recordGroup(record.status) === 'review' ? 'review' : latest?.status === 'failed' ? 'blocked'
      : linked.length ? 'pending' : latest?.status || 'unknown');
    return { ...record, currentStatus, jiraSubtask, jiraStatuses: linked.map(issue => ({ key: issue.key, status: issue.status })), agentStatus: active?.status || latest?.status };
  });
}
export type DeliveryRecordFilter = 'actionable' | 'running' | 'review' | 'blocked' | 'results' | 'all';
export function issueKey(value = '') { const key = value.trim().toUpperCase(); return /^[A-Z][A-Z0-9_]*-\d+$/.test(key) ? key : ''; }
function keys(...values: string[]) { return [...new Set(values.map(issueKey).filter(Boolean))]; }
export function threadUrl(id = '') {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? `codex://threads/${id}` : undefined;
}
export function workbenchPath(key: string) { return `/workbench?issue=${encodeURIComponent(key)}`; }
export function recordGroup(status: string) {
  if (['running', 'in_progress', 'dispatching', 'dispatched', 'active'].includes(status.toLowerCase())) return 'running';
  if (['review', 'awaiting_review'].includes(status.toLowerCase())) return 'review';
  if (['blocked', 'failed', 'error'].includes(status.toLowerCase())) return 'blocked';
  return 'other';
}
export function hasDeliveryResult(record: DeliveryRecord) {
  return !!record.result.trim() || !!record.error.trim() || record.links.length > 0;
}
export function recordMatchesFilter(record: DeliveryRecord, filter: DeliveryRecordFilter) {
  const group = recordGroup(record.currentStatus ?? record.status);
  if (filter === 'all') return true;
  if (filter === 'results') return hasDeliveryResult(record);
  // 子任务只保留历史和真实 Agent 活动，不再仅凭 Jira 或旧失败记录产生待办。
  if (record.jiraSubtask && !['running', 'queued'].includes(record.agentStatus || '')) return false;
  if (filter === 'actionable') return ['running', 'review', 'blocked'].includes(group) || ['pending', 'queued'].includes(record.currentStatus || '');
  return group === filter;
}
export function plannedToday(issue: JiraIssue, today: string) {
  if (/done|完成|关闭|resolved|closed/i.test(`${issue.status} ${issue.statusCategory}`)) return false;
  const start = issue.startDate?.slice(0, 10), end = (issue.endDate || issue.dueDate)?.slice(0, 10);
  return !!(start && end ? start <= today && today <= end : start ? start === today : end === today);
}
export function localDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function deliveryRecords(automation?: AutomationData, design?: ExecutionDashboard, catchup?: CatchupData, merge?: MergeData): DeliveryRecord[] {
  const records: DeliveryRecord[] = [];
  for (const job of automation?.jobs || []) {
    const artifact = (type: string) => `/api/source/artifact?${new URLSearchParams({ id: job.id, type })}`;
    records.push({ id: `job:${job.id}`, source: job.categoryLabel || '自动交付', issueKeys: keys(job.issueKey), title: job.title,
      status: job.status, threadId: job.threadId, clientThreadId: job.clientThreadId, workspacePath: job.workspacePath, branch: job.branch,
      updatedAt: job.updatedAt, result: job.result || '', error: job.error || '', detailPath: `/delivery/queue?job=${encodeURIComponent(job.id)}`,
      links: [{ label: '方案文档', url: job.artifactUrl || '' }, { label: '合并请求', url: job.mrUrl || '' },
        { label: '自测报告', url: job.selfTestReportPath ? artifact('report') : '' },
        { label: '多语言 Excel', url: job.i18nXlsxPath ? artifact('i18n') : '' },
        ...(job.selfTestScreenshots || []).map((_, index) => ({ label: `自测截图 ${index + 1}`, url: `${artifact('screenshot')}&index=${index}` }))].filter(link => link.url) });
  }
  for (const run of design?.runs || []) {
    records.push({ id: `design:${run.id}`, source: '技术方案', issueKeys: keys(run.input.issueKey, run.artifacts.requirementKey, run.artifacts.devParentKey, run.artifacts.designTaskKey, run.artifacts.implementationTaskKey),
      title: run.input.title, status: run.status, threadId: run.threadId, workspacePath: run.input.workspacePath, branch: run.input.branch,
      updatedAt: run.updatedAt, result: run.steps.filter(isCurrentStepResult).map(step => step.result!.summary).filter(Boolean).join('\n\n'),
      error: run.error, detailPath: '/design', links: run.artifacts.documentUrl ? [{ label: '方案文档', url: run.artifacts.documentUrl }] : [] });
  }
  for (const item of catchup?.requirements || []) {
    const session = item.session;
    if (!session.threadId && !session.clientThreadId && !session.result && !session.error) continue;
    records.push({ id: `catchup:${item.id}`, source: '追平执行', issueKeys: keys(session.jiraKey), title: item.title,
      status: session.status, threadId: session.threadId, clientThreadId: session.clientThreadId, workspacePath: session.workspacePath, branch: session.branch,
      updatedAt: session.updatedAt, result: session.result, error: session.error, detailPath: `/catchup/execution?requirement=${encodeURIComponent(item.id)}`, links: [] });
  }
  for (const item of merge?.items || []) {
    const run = item.pipeline;
    if (!run.threadId && !run.clientThreadId && !run.result && !run.error && !['review', 'blocked'].includes(recordGroup(item.status))) continue;
    records.push({ id: `merge:${item.requirementId}`, source: '合入审核', issueKeys: keys(item.jiraKey), title: item.title,
      status: item.status, threadId: run.threadId, clientThreadId: run.clientThreadId, workspacePath: item.sessionWorkspacePath || item.deliveryWorkspacePath, branch: item.sourceBranch,
      updatedAt: run.updatedAt, result: run.result || run.evidence?.summary || '', error: run.error,
      detailPath: `/catchup/merge?requirement=${encodeURIComponent(item.requirementId)}`, links: item.mrUrl ? [{ label: '合并请求', url: item.mrUrl }] : [] });
  }
  return records.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
}
export function forIssue(records: DeliveryRecord[], key: string) {
  const normalized = issueKey(key);
  return normalized ? records.filter(record => record.issueKeys.includes(normalized)) : [];
}
