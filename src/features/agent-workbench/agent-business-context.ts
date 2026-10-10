/**
 * 设计说明：Agent 业务上下文只关联现有 Jira、本地项目、接口联调和交付记录，不复制原页面状态，也不执行写操作。
 * 交付只按显式任务标识或 CLI Session 关联；工作区仅用于定位项目，不能代表会话归属。
 */
import type { ApexBffReviewState } from '../../../shared/apex-bff-review';
import type { AutomationData, CatchupData, CatchupRequirement, JiraIssue, Job, LocalProject, MergeData, MergeItem,
  ProjectsData } from '../../../shared/hub';
import type { AgentConversation } from './conversation';
import type { MenuPagePlan } from '../api-integration/page-plan';
import { buildReviewCatalog, type ReviewCatalogItem } from '../api-integration/review-catalog';
import { isDone } from '../../shared/format';

const reviewIdsByPath = new Map(buildReviewCatalog().map(item => [item.path, item.id]));

function reviewProgress(page: MenuPagePlan, review: ApexBffReviewState, catalog?: Pick<ReviewCatalogItem, 'id' | 'path'>[]) {
  const idsByPath = catalog ? new Map(catalog.map(item => [item.path, item.id])) : reviewIdsByPath;
  const paths = new Set(page.operations.map(item => item.path));
  const records = [...paths].map(path => review[idsByPath.get(path) || '']);
  return { total: paths.size, confirmed: records.filter(record => !!record?.confirmedAt).length,
    blocked: records.filter(record => !!record?.blocker && !record.confirmedAt).length };
}

export type AgentBusinessMentionType = 'jira' | 'project' | 'interface' | 'merge';

export interface AgentBusinessMention {
  id: string;
  type: AgentBusinessMentionType;
  label: string;
  detail: string;
  value: string;
}

export interface AgentInterfaceContext {
  page: MenuPagePlan;
  progress?: { confirmed: number; blocked: number; total: number };
}

export interface AgentBusinessContext {
  jiraIssues: JiraIssue[];
  /** 项目级需求入口，不能作为当前会话已执行或已交付的依据。 */
  refactorIssues?: JiraIssue[];
  project?: LocalProject;
  interfacePage?: AgentInterfaceContext;
  jobs: Job[];
  catchup: CatchupRequirement[];
  merges: MergeItem[];
}

export interface AgentBusinessSnapshot {
  issues?: JiraIssue[];
  automation?: AutomationData;
  catchup?: CatchupData;
  merge?: MergeData;
  projects?: ProjectsData;
  pages?: MenuPagePlan[];
  review?: ApexBffReviewState;
  catalog?: Pick<ReviewCatalogItem, 'id' | 'path'>[];
  refactorRepository?: string;
}

function normalizePath(value = '') {
  return value.replaceAll('\\', '/').replace(/\/$/, '');
}

function conversationText(conversation?: AgentConversation) {
  if (!conversation) return '';
  return [conversation.title, ...conversation.runs.flatMap(run => [run.objective, run.result, run.error])].filter(Boolean).join('\n');
}

function explicitValue(text: string, name: string) {
  const match = text.match(new RegExp(`@${name}:([^\\s@]+)`, 'i'));
  return match?.[1] || '';
}

function referenceTokens(text: string) {
  return new Set((text.match(/\b[A-Z][A-Z0-9]+(?:-[A-Z0-9]+)+\b/g) || []).map(value => value.toUpperCase()));
}

function matchesExecutionIdentity(threadId: string, conversation: AgentConversation) {
  if (!threadId) return false;
  return conversation.id === threadId || conversation.runs.some(run => run.id === threadId || run.sessionId === threadId || run.originSessionId === threadId);
}

export function buildAgentBusinessContext(conversation: AgentConversation | undefined, snapshot: AgentBusinessSnapshot): AgentBusinessContext {
  if (!conversation) return { jiraIssues: [], jobs: [], catchup: [], merges: [] };
  const text = conversationText(conversation);
  const references = referenceTokens(text);
  const explicitProject = explicitValue(text, '项目');
  const explicitInterface = explicitValue(text, '接口');
  const explicitMerge = explicitValue(text, '合入').toUpperCase();
  const project = snapshot.projects?.projects.find(item => item.projectId === explicitProject)
    || snapshot.projects?.projects.find(item => normalizePath(item.path) === normalizePath(conversation.latest.workspacePath));
  const page = snapshot.pages?.find(item => item.id === explicitInterface);
  const matchesThread = (...ids: (string | undefined)[]) => ids.some(id => matchesExecutionIdentity(id || '', conversation));
  const jobs = (snapshot.automation?.jobs || []).filter(job => references.has(job.issueKey.toUpperCase())
    || matchesThread(job.threadId, job.clientThreadId));
  const catchup = (snapshot.catchup?.requirements || []).filter(item => references.has(item.session?.jiraKey?.toUpperCase() || '')
    || references.has(item.id.toUpperCase()) || !!explicitMerge && item.id.toUpperCase() === explicitMerge
    || matchesThread(item.session?.threadId, item.session?.clientThreadId));
  const merges = (snapshot.merge?.items || []).filter(item => references.has(item.jiraKey.toUpperCase())
    || references.has(item.requirementId.toUpperCase()) || !!explicitMerge && item.requirementId.toUpperCase() === explicitMerge
    || matchesThread(item.pipeline.threadId, item.pipeline.clientThreadId));
  const keys = new Set([...references, ...jobs.map(item => item.issueKey.toUpperCase()),
    ...catchup.map(item => item.session?.jiraKey?.toUpperCase() || ''), ...merges.map(item => item.jiraKey.toUpperCase())]);
  const jiraIssues = (snapshot.issues || []).filter(issue => keys.has(issue.key.toUpperCase()));
  // 只为已识别的 APEX 重构仓库展示项目任务；不把同工作区的其他会话交付归入当前会话。
  const refactorIssues = snapshot.refactorRepository && project?.repository === snapshot.refactorRepository
    ? (snapshot.issues || []).filter(issue => !issue.parent && /APEX.*重构|重构.*APEX/i.test(issue.summary))
      .sort((a, b) => Number(isDone(a)) - Number(isDone(b)) || Date.parse(b.updated) - Date.parse(a.updated))
    : [];

  return {
    jiraIssues,
    refactorIssues,
    project,
    interfacePage: page ? { page, progress: snapshot.review ? reviewProgress(page, snapshot.review, snapshot.catalog) : undefined } : undefined,
    jobs,
    catchup,
    merges,
  };
}

export function buildAgentBusinessMentions(snapshot: AgentBusinessSnapshot): AgentBusinessMention[] {
  const issues = [...(snapshot.issues || [])].sort((first, second) => Date.parse(second.updated) - Date.parse(first.updated));
  return [
    ...issues.map(issue => ({ id: `jira:${issue.key}`, type: 'jira' as const, label: issue.key,
      detail: `${issue.status} · ${issue.summary}`, value: `@Jira:${issue.key}` })),
    ...(snapshot.projects?.projects || []).map(project => ({ id: `project:${project.projectId}`, type: 'project' as const,
      label: project.displayName || project.projectName, detail: `${project.branch || '未识别分支'} · ${project.displayPath || project.path}`,
      value: `@项目:${project.projectId}` })),
    ...(snapshot.pages || []).map(page => ({ id: `interface:${page.id}`, type: 'interface' as const, label: page.title,
      detail: `${page.menu} · ${page.operations.length} 个接口`, value: `@接口:${page.id}` })),
    ...(snapshot.merge?.items || []).map(item => ({ id: `merge:${item.requirementId}`, type: 'merge' as const,
      label: item.requirementId, detail: `${item.status} · ${item.title}`, value: `@合入:${item.requirementId}` })),
  ];
}
