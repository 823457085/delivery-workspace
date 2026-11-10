import type { JiraDevTaskView } from '../../../shared/jira-dev';
import { agentConversationProjectPath, type AgentConversation } from './conversation';

export const jiraDevTasksQueryKey = ['jira-dev-tasks'] as const;

export async function readJiraDevTasks(signal?: AbortSignal): Promise<JiraDevTaskView[]> {
  const response = await fetch('/api/agent-runtimes/jira-dev/tasks', { signal });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || '读取 Jira 研发任务失败');
  return Array.isArray(data.tasks) ? data.tasks : [];
}

export function jiraDevTaskDeliveryId(task: JiraDevTaskView): string {
  return task.launch?.groupRoomId || task.taskId;
}

export function jiraDevTaskIssue(task: JiraDevTaskView): { key: string; url: string; summary: string } | undefined {
  const issue = task.plan?.developmentIssue || task.plan?.sourceIssue;
  if (issue?.key) return { key: issue.key, url: issue.url || '', summary: issue.summary || task.title };
  const match = /\b([A-Z][A-Z0-9_]*-\d+)\b/.exec(task.title);
  if (!match) return undefined;
  const key = match[1]!;
  const summary = task.title.replace(/^(?:需求开发|Jira 修复)\s*·\s*/, '').replace(new RegExp(`^${key}\\s*·\\s*`), '').trim();
  return { key, url: '', summary: summary || task.title };
}

export function jiraDevTaskProjects(task: JiraDevTaskView): { path: string; workspacePath: string; branchName: string; baseBranch: string }[] {
  const sourceProjects = task.launch?.projects?.length ? task.launch.projects : task.projects?.length ? task.projects : [
    { path: task.projectPath, baseBranch: task.baseBranch, branchName: task.branchName, workspacePath: task.launch?.workspacePath || task.projectPath },
  ];
  return sourceProjects.map((project, index) => ({
    path: project.path,
    workspacePath: project.workspacePath || (index === 0 ? task.launch?.workspacePath || project.path : project.path),
    branchName: project.branchName,
    baseBranch: project.baseBranch,
  }));
}

export function jiraDevTaskWorkspacePaths(task?: JiraDevTaskView): string[] {
  if (!task) return [];
  return [...new Set(jiraDevTaskProjects(task).map(project => project.workspacePath || project.path).filter(Boolean))];
}

function taskIssueKeys(task: JiraDevTaskView): string[] {
  const keys = new Set<string>();
  const issue = jiraDevTaskIssue(task);
  if (issue?.key) keys.add(issue.key.toUpperCase());
  if (task.plan?.sourceIssue?.key) keys.add(task.plan.sourceIssue.key.toUpperCase());
  if (task.plan?.developmentIssue?.key) keys.add(task.plan.developmentIssue.key.toUpperCase());
  for (const item of task.plan?.items || []) {
    if (item.key?.trim()) keys.add(item.key.trim().toUpperCase());
  }
  return [...keys];
}

export function matchConversationJiraDevTask(conversation: AgentConversation | undefined, tasks: JiraDevTaskView[]): JiraDevTaskView | undefined {
  if (!conversation || !tasks.length) return undefined;
  const runIds = new Set(conversation.runs.map(run => run.id));
  const sourceIds = new Set(conversation.runs.map(run => run.task?.sourceId).filter((id): id is string => !!id));
  const teamTaskIds = new Set(conversation.runs.map(run => run.team?.taskId).filter((id): id is string => !!id));

  // 1. 直接关联的 taskId / runId / conversationId / teamTaskId
  for (const task of tasks) {
    if (sourceIds.has(`requirement:${task.taskId}`) || sourceIds.has(`jira-fix:${task.taskId}`)) return task;
    if (task.launch?.runId && runIds.has(task.launch.runId)) return task;
    if (task.launch?.conversationId && task.launch.conversationId === conversation.id) return task;
    if (task.launch?.teamTaskId && teamTaskIds.has(task.launch.teamTaskId)) return task;
    if (conversation.runs.some(run => run.objective.includes(`JIRA_DEV_TASK_ID: ${task.taskId}`))) return task;
  }

  // 2. 独立任务 worktree 路径匹配
  const runWorkspaces = new Set(conversation.runs.map(run => run.workspacePath).filter(Boolean));
  for (const task of tasks) {
    const projects = jiraDevTaskProjects(task);
    if (projects.some(project => project.workspacePath && project.workspacePath !== project.path && runWorkspaces.has(project.workspacePath))) {
      return task;
    }
  }

  // 3. 项目目录 + 任务分支匹配
  const projectPath = agentConversationProjectPath(conversation);
  const branches = new Set(conversation.runs.flatMap(run => [run.branch, run.baseBranch]).filter(Boolean));
  if (projectPath && branches.size) {
    for (const task of tasks) {
      const projects = jiraDevTaskProjects(task);
      if (projects.some(project => (project.path === projectPath || project.workspacePath === projectPath) && branches.has(project.branchName))) {
        return task;
      }
    }
  }

  // 4. 会话标题或消息正文包含任务的 Jira 事项 Key
  const haystack = [conversation.title, ...conversation.runs.slice(-6).map(run => run.objective)].join('\n');
  for (const task of tasks) {
    for (const key of taskIssueKeys(task)) {
      const pattern = new RegExp(`(?:^|[^A-Z0-9_-])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^A-Z0-9_-])`, 'i');
      if (pattern.test(haystack)) return task;
    }
  }

  return undefined;
}
