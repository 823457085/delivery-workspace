import type { AutomationData, CatchupData, JiraIssue, MergeData } from '../../../shared/hub';
import { isCurrentStepResult, type ExecutionDashboard } from '../../../shared/design-execution';
import type { AgentRun } from '../../../shared/agent-runtime';
import type { RequirementDevelopmentRecord, RequirementProgress } from '../../../shared/requirement-development';
import { deliveryAcceptanceStatus, type DeliveryAcceptanceRecord, type DeliveryAcceptanceStatus } from '../../../shared/delivery-acceptance';
import { jiraIssueKey, type JiraFixRecord } from '../../../shared/jira-fix';
import { plannedOn } from '../../shared/task-schedule';
import { agentRunProjectPath, buildAgentConversations } from '../agent-workbench/conversation';

export interface DeliveryRecord {
  id: string; source: string; issueKeys: string[]; title: string; status: string;
  threadId: string; clientThreadId?: string; workspacePath: string; branch: string;
  updatedAt: string; result: string; error: string; detailPath: string;
  links: { label: string; url: string }[];
  currentStatus?: string;
  jiraStatuses?: { key: string; status: string }[];
  jiraSubtask?: boolean;
  agentStatus?: string;
  sourceId?: string;
  sourceKind?: 'launch' | 'agent';
  sourceKnown?: boolean;
  runId?: string;
  project?: string;
  agentRuns?: AgentRun[];
  agentStateKnown?: boolean;
  acceptance?: DeliveryAcceptanceRecord;
  acceptanceStatus?: DeliveryAcceptanceStatus;
  acceptanceKnown?: boolean;
  requirementProgress?: RequirementProgress;
}
/** 历史记录不可充当运行心跳；当前状态只使用已关联 Jira 和本机运行快照，不按标题猜关联。 */
export function reconcileDeliveryRecords(records: DeliveryRecord[], issues: JiraIssue[], runs: AgentRun[],
  options: { includeStandalone?: boolean; runtimeKnown?: boolean; acceptances?: DeliveryAcceptanceRecord[]; acceptanceKnown?: boolean } = {}) {
  const jira = new Map(issues.map(issue => [issue.key.toUpperCase(), issue]));
  const acceptances = new Map((options.acceptances || []).map(record => [record.recordId, record]));
  const conversations = buildAgentConversations(runs);
  const direct = (record: DeliveryRecord) => {
    const source = record.sourceId ? conversations.filter(group => group.runs.some(run => run.task?.sourceId === record.sourceId)) : [];
    return source.length ? source : conversations.filter(group => group.runs.some(run => run.id === (record.runId || record.threadId)));
  };
  // 明确业务归属优先，旧物理会话只能在唯一命中时回退；多轮记录随会话保留。
  const explicit = new Map(records.map(record => [record.id, direct(record)]));
  const claimed = new Set([...explicit.values()].flat().map(group => group.id));
  const relatedGroups = (record: DeliveryRecord) => {
    const known = explicit.get(record.id) || [];
    if (known.length || !record.threadId) return known;
    const session = conversations.filter(group => group.runs.some(run => [run.sessionId, run.originSessionId].includes(record.threadId)));
    return session.length === 1 && !claimed.has(session[0].id) ? session : [];
  };
  const associated = new Map(records.map(record => [record.id, relatedGroups(record)]));
  const consumed = new Set([...associated.values()].flat().map(group => group.id));
  const all = [...records];
  if (options.includeStandalone) for (const group of conversations) {
    if (consumed.has(group.id)) continue;
    const run = group.latest;
    const record: DeliveryRecord = { id: `agent:${group.id}`, source: 'Agent 会话', sourceKind: 'agent', issueKeys: [],
      title: run.task?.title || run.objective, status: run.status, threadId: run.provider === 'codex' ? run.sessionId || run.originSessionId || '' : '',
      workspacePath: run.workspacePath, project: agentRunProjectPath(run), branch: run.branch, updatedAt: group.updatedAt,
      result: '', error: '', detailPath: agentRunPath(run.id), links: [], runId: run.id };
    all.push(record); associated.set(record.id, [group]);
  }
  return all.map(record => {
    const linked = record.issueKeys.map(key => jira.get(key)).filter((issue): issue is JiraIssue => !!issue);
    // 以主关联任务判断子任务，避免把附带 DEV 子任务的主交付记录一并隐藏。
    const primaryIssue = jira.get(record.issueKeys[0] || '');
    const jiraSubtask = !!primaryIssue && (!!primaryIssue.parent || /^(子任务|sub[- ]?task)$/i.test(primaryIssue.issueType));
    const related = (associated.get(record.id) || []).flatMap(group => group.runs)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const latest = related.find(run => run.status === 'running') || related.find(run => run.status === 'queued') || related[0];
    const agentStatus = options.runtimeKnown === false ? undefined : latest?.status;
    const active = ['running', 'queued'].includes(agentStatus || '') ? agentStatus : undefined;
    const done = linked.length > 0 && linked.length === record.issueKeys.length
      && linked.every(issue => /^(done|完成|已完成|关闭|已关闭|resolved|closed)$/i.test(issue.statusCategory) || /^(done|完成|已完成|关闭|已关闭|resolved|closed)$/i.test(issue.status));
    const launchStatus = !latest && record.sourceKind === 'launch' && record.sourceKnown !== false
      ? ['failed', 'uncertain'].includes(record.status) ? 'blocked' : ['preparing', 'starting'].includes(record.status) ? 'pending' : undefined : undefined;
    const currentStatus = active || (done ? 'completed' : record.source === '合入审核' && recordGroup(record.status) === 'review' ? 'review' : agentStatus === 'failed' ? 'blocked'
      : linked.length ? 'pending' : launchStatus || (agentStatus === 'completed' ? 'ended' : agentStatus) || 'unknown');
    const result: DeliveryRecord = { ...record, currentStatus, jiraSubtask, jiraStatuses: linked.map(issue => ({ key: issue.key, status: issue.status })),
      agentStatus, agentStateKnown: options.runtimeKnown !== false, agentRuns: related, runId: latest?.id || record.runId,
      threadId: record.threadId || (latest?.provider === 'codex' ? latest.sessionId || latest.originSessionId || '' : ''),
      project: record.project || (latest ? agentRunProjectPath(latest) : ''),
      workspacePath: record.workspacePath || latest?.workspacePath || '', branch: record.branch || latest?.branch || '',
      updatedAt: latest && Date.parse(latest.updatedAt) > (Date.parse(record.updatedAt) || 0) ? latest.updatedAt : record.updatedAt };
    const acceptance = acceptances.get(record.id);
    return { ...result, acceptance, acceptanceKnown: options.acceptanceKnown !== false,
      acceptanceStatus: deliveryAcceptanceStatus(acceptance, { runId: result.runId || '', updatedAt: result.updatedAt }) };
  }).sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
}
export function agentRunPath(id: string) { return `/agent?run=${encodeURIComponent(id)}`; }
export function agentStatusLabel(status?: string) { return status === 'completed' ? '本轮已结束' : undefined; }
export function deliveryStatusLabel(record: DeliveryRecord) {
  if (record.sourceKind === 'agent') return agentStatusLabel(record.status);
  if (record.sourceKind === 'launch') return ({ preparing: '准备中', starting: '启动中', started: '已启动', uncertain: '启动状态待核实' } as Record<string, string>)[record.status];
  return undefined;
}
export function launchDeliveryRecords(requirements: RequirementDevelopmentRecord[] = [], fixes: JiraFixRecord[] = [],
  known: { requirements?: boolean; fixes?: boolean } = {}): DeliveryRecord[] {
  return [...new Map([
    ...requirements.map(record => ({ id: `requirement:${record.id}`, sourceId: `requirement:${record.id}`, source: '需求开发', sourceKind: 'launch' as const,
      sourceKnown: known.requirements !== false, issueKeys: keys(jiraIssueKey(record.input.issueKey), ...(record.progress?.issueKeys || [])), title: record.input.title,
      status: record.status, threadId: '', workspacePath: record.workspacePath, project: record.input.project, branch: record.input.branch,
      updatedAt: record.progress?.updatedAt || record.createdAt, result: '', error: record.error, detailPath: '/design', links: [], runId: record.runId,
      requirementProgress: record.progress })),
    ...fixes.map(record => ({ id: `jira-fix:${record.id}`, sourceId: `jira-fix:${record.id}`, source: 'Jira 修复', sourceKind: 'launch' as const,
      sourceKnown: known.fixes !== false, issueKeys: keys(record.issue?.key || jiraIssueKey(record.input.issueKey)), title: record.issue?.summary || record.input.issueKey,
      status: record.status, threadId: '', workspacePath: record.workspacePath, project: record.issue?.project || '', branch: record.input.branch,
      updatedAt: record.createdAt, result: '', error: record.error, detailPath: '/agent?view=jira-fix', links: [], runId: record.runId })),
  ].map(record => [record.id, record])).values()];
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
  return !!record.result.trim() || !!record.error.trim() || record.links.length > 0 || !!record.agentRuns?.some(run => run.result || run.error);
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
export function deliveryRecordCount(records: DeliveryRecord[], filter: DeliveryRecordFilter,
  readiness: { incomplete: boolean; runtimeKnown: boolean }) {
  if (filter === 'running' ? !readiness.runtimeKnown : readiness.incomplete) return undefined;
  return records.filter(record => recordMatchesFilter(record, filter)).length;
}
export function plannedToday(issue: JiraIssue, today: string) {
  if (/done|完成|关闭|resolved|closed/i.test(`${issue.status} ${issue.statusCategory}`)) return false;
  return plannedOn(issue, today);
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
    if (!session || (!session.threadId && !session.clientThreadId && !session.result && !session.error)) continue;
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
