/**
 * 设计说明：Agent 业务上下文核心关联逻辑，不依赖静态接口清单 JSON，避免首屏打包数百 KB 联调工作簿数据。
 * 交付只按显式任务标识或 CLI Session 关联；工作区仅用于定位项目，不能代表会话归属。
 */
import type { ApexBffReviewState } from '../../../shared/apex-bff-review';
import type { AutomationData, CatchupData, CatchupRequirement, JiraIssue, Job, LocalProject, MergeData, MergeItem,
  ProjectsData } from '../../../shared/hub';
import { agentRunContextPath, type AgentConversation } from './conversation';
import type { MenuPagePlan } from '../api-integration/page-plan';
import { isDone } from '../../shared/format';
import { normalizeWorkspacePath, projectWorkspaceReference, workspacePathFromReference } from './agent-project-reference';

function reviewProgress(page: MenuPagePlan, review: ApexBffReviewState, reviewIdsByPath?: ReadonlyMap<string, string>) {
  const paths = new Set(page.operations.map(item => item.path));
  const records = [...paths].map(path => review[reviewIdsByPath?.get(path) || '']);
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
}

function conversationText(conversation?: AgentConversation) {
  if (!conversation) return '';
  return [conversation.title, ...conversation.runs.flatMap(run => [run.objective, run.result, run.error])].filter(Boolean).join('\n');
}

function explicitValue(text: string, name: string) {
  const match = text.match(new RegExp(`@${name}:([^\\s@]+)`, 'i'));
  return match?.[1] || '';
}

function lastExplicitValue(text: string, name: string) {
  return [...text.matchAll(new RegExp(`@${name}:([^\\s@]+)`, 'gi'))].at(-1)?.[1] || '';
}

function referenceTokens(text: string) {
  return new Set((text.match(/\b[A-Z][A-Z0-9]+(?:-[A-Z0-9]+)+\b/g) || []).map(value => value.toUpperCase()));
}

function matchesExecutionIdentity(threadId: string, conversation: AgentConversation) {
  if (!threadId) return false;
  return conversation.id === threadId || conversation.runs.some(run => run.id === threadId || run.sessionId === threadId || run.originSessionId === threadId);
}

function conversationProject(conversation: AgentConversation, projects: LocalProject[] = []) {
  // 只由最近一条用户目标中的项目引用定位，不让旧轮次或 Agent 回复覆盖新选择。
  const reference = [...conversation.runs].reverse().map(run => run.objective)
    .find(value => /@(?:项目|工作区):[^\s@]+/.test(value)) || conversation.title;
  const workspace = lastExplicitValue(reference, '工作区');
  const projectId = lastExplicitValue(reference, '项目');
  if (workspace) {
    const workspacePath = workspacePathFromReference(workspace);
    return workspacePath ? projects.find(project => normalizeWorkspacePath(project.path) === workspacePath
      && (!projectId || project.projectId === projectId)) : undefined;
  }
  const candidates = projectId ? projects.filter(project => project.projectId === projectId) : projects;
  const workspacePath = normalizeWorkspacePath(agentRunContextPath(conversation.latest));
  const current = candidates.find(project => normalizeWorkspacePath(project.path) === workspacePath);
  return current || (projectId && candidates.length === 1 ? candidates[0] : undefined);
}

export function buildAgentBusinessContextCore(
  conversation: AgentConversation | undefined,
  snapshot: AgentBusinessSnapshot,
  reviewIdsByPath?: ReadonlyMap<string, string>,
): AgentBusinessContext {
  if (!conversation) return { jiraIssues: [], jobs: [], catchup: [], merges: [] };
  const text = conversationText(conversation);
  const references = referenceTokens(text);
  const explicitInterface = explicitValue(text, '接口') || text.match(/^接口页编号：([^\s]+)$/m)?.[1];
  const explicitMerge = explicitValue(text, '合入').toUpperCase();
  const project = conversationProject(conversation, snapshot.projects?.projects);
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
  const refactorIssues = project?.repository === 'titan-project/titan-fe-project/ops/admin'
    ? (snapshot.issues || []).filter(issue => !issue.parent && /APEX.*重构|重构.*APEX/i.test(issue.summary))
      .sort((a, b) => Number(isDone(a)) - Number(isDone(b)) || Date.parse(b.updated) - Date.parse(a.updated))
    : [];

  return {
    jiraIssues,
    refactorIssues,
    project,
    interfacePage: page ? { page, progress: snapshot.review ? reviewProgress(page, snapshot.review, reviewIdsByPath) : undefined } : undefined,
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
    ...(snapshot.projects?.projects || []).map(project => ({ id: `project:${encodeURIComponent(normalizeWorkspacePath(project.path))}`, type: 'project' as const,
      label: project.displayName || project.projectName, detail: `${project.branch || '未识别分支'} · ${project.displayPath || project.path}`,
      value: projectWorkspaceReference(project) })),
    ...(snapshot.pages || []).map(page => ({ id: `interface:${page.id}`, type: 'interface' as const, label: page.title,
      detail: `${page.menu} · ${page.operations.length} 个接口`, value: `@接口:${page.id}` })),
    ...(snapshot.merge?.items || []).map(item => ({ id: `merge:${item.requirementId}`, type: 'merge' as const,
      label: item.requirementId, detail: `${item.status} · ${item.title}`, value: `@合入:${item.requirementId}` })),
  ];
}
