/** 插件模块为纯 JS；这里只声明工作台实际使用的接口，字段形状以插件原实现为准。 */
export interface JiraDevIssue {
  key: string; url: string; summary: string; description?: unknown; status?: string; assignee?: string;
  statusId?: string; statusCategory?: string; assigneeId?: string;
  subtasks?: Pick<JiraDevIssue, 'key' | 'url' | 'summary'>[];
  startDate?: string | null; endDate?: string | null; project?: { id: string; key: string; name: string };
  issueType?: { id: string; name: string; subtask: boolean }; fixVersions?: { id: string; name: string }[];
  materialStatus?: string; materialWarning?: string; [key: string]: unknown;
}
export interface JiraDevPlanItem {
  id?: string; workdays?: number;
  role: 'parent' | 'design' | 'implementation'; action: 'create' | 'reuse'; summary: string; description?: unknown;
  key?: string; url?: string; parentRole?: string; state?: string; error?: string; issue?: JiraDevIssue;
  schedule?: { startDate: string; endDate: string; previousStartDate?: string; previousEndDate?: string; changed: boolean };
}
export interface JiraDevDesignDestination { site: string; spaceKey: string; parentId: string; title: string; url: string }
export interface JiraDevPlan {
  taskId: string; sourceKind: 'product' | 'frontend' | 'defect'; status: 'ready' | 'local' | 'applied' | 'unknown' | 'error';
  repairMode?: 'create' | 'reuse';
  items: JiraDevPlanItem[]; sourceIssue?: JiraDevIssue; developmentIssue?: JiraDevIssue; businessModule?: string;
  developmentCandidates?: Pick<JiraDevIssue, 'key' | 'url' | 'summary'>[];
  designDestination?: JiraDevDesignDestination | null; designPublicationAuthorized?: boolean;
  requiresConfirmation?: boolean; needsReconfirmation?: boolean; needsTitleReview?: boolean; needsScheduleReview?: boolean; warning?: string;
  targetProject?: { key: string }; assignee?: unknown; fixVersions?: { id?: string; name?: string }[]; [key: string]: unknown;
}
export interface JiraDevTaskRecord {
  taskId: string; workflow: 'jira' | 'requirement'; key: string; issueUrl: string; issueSnapshot?: JiraDevIssue; sourceIssue?: JiraDevIssue;
  source: string; details: string; designSource?: string; useI18n?: boolean; sourceProjectPath: string; branchName: string; baseBranch: string;
  projectPath: string; baseSha?: string; repairPlan?: JiraDevPlan; requirementPlan?: JiraDevPlan; automationPreview?: boolean;
  projects?: { path: string; baseBranch: string; branchName: string; workspacePath?: string; baseSha?: string }[];
  technicalDesign?: { status: string; [key: string]: unknown };
}
export interface JiraDevWorkspace { sourcePath: string; workspacePath: string; baseRef?: string; baseSha: string; branchName: string }
export interface JiraDevClient {
  readIssue(source: string): Promise<JiraDevIssue>;
  readTransitions?(source: string): Promise<{ issue: JiraDevIssue; transitions: {
    id: string; to: { id: string; name: string }; requiredFields: { id: string; name: string }[];
  }[] }>;
  transitionIssue?(input: { source: string; transitionId: string; expectedStatusId: string; targetStatusId: string;
    expectedAssigneeId: string; confirmed: true }): Promise<{ issue: JiraDevIssue; verified: boolean }>;
  connection(): Promise<{ site: string; account: { id: string; name: string } }>;
  readRequirementContext(source: string, options?: { projectKey?: string }): Promise<{
    issue: JiraDevIssue; project?: { key: string };
    issueTypes: { fields?: { fixVersions?: { allowedValues?: { id?: unknown; name?: unknown }[] } } }[];
  }>;
  sourceIdentity?(source: string): Promise<{ key: string; url: string }>;
  [method: string]: unknown;
}
export function createConnectionSettings(options: { dataDirectory: string }): {
  read(): Promise<{ source: { mode: string; path?: string }; site: string; authentication: { configured: boolean; method: string }; warning?: string }>;
  client(): Promise<JiraDevClient>;
  sourceIdentity(source: string): Promise<{ key: string; url: string }>;
};
export function createRequirementStore(options: { jira: unknown; dataDirectory: string }): {
  lookupFrontend(issue: JiraDevIssue): Promise<{ sourceIssue: JiraDevIssue; items: JiraDevPlanItem[]; developmentIssue: JiraDevIssue }>;
  lookupFrontendCandidates(issue: JiraDevIssue): Promise<Pick<JiraDevIssue, 'key' | 'url' | 'summary'>[]>;
  prepare(input: Record<string, unknown>): Promise<JiraDevPlan>;
  bindExistingForAutomation(input: { taskId: string; issueKey: string; issueUrl: string }): Promise<JiraDevPlan>;
  apply(input: { taskId: string; confirmed: true }): Promise<JiraDevPlan>;
  get(input: { taskId: string; refreshFrontend?: boolean; developmentKey?: string }): Promise<JiraDevPlan>;
};
export interface JiraDevPreferences {
  projectPath: string; scopeId: string; revision: string; updatedAt: string;
  settings: { baseBranch: string; designMode: 'default' | 'custom' | 'local'; designDestination?: JiraDevDesignDestination };
  designDestination: JiraDevDesignDestination | null;
}
export function createProjectPreferences(options: { dataDirectory: string }): {
  get(input: { projectPath: string }): Promise<JiraDevPreferences>;
  set(input: { projectPath: string; scopeId: string; expectedRevision: string; settings: unknown }): Promise<JiraDevPreferences>;
};
export function readBranchOptions(input: { projectPath: string }): Promise<{ branches: string[]; truncated: boolean }>;
export function scanProjects(input?: { roots?: string[]; preferredProjectPath?: string }): Promise<{
  projects: { name: string; path: string; checkouts?: { path: string }[] }[]; truncated?: boolean; warnings?: string[]; preferredProjectPath?: string;
}>;
export function readProjectStatus(input: { projectPath: string }): Promise<Record<string, unknown>>;
export function repositoryIdentity(remote: string): { repositoryId: string; name: string } | null;
export function groupRepositories(projects: { name: string; path: string; markers: string[] }[]): Promise<{ projects: { repositoryId: string; name: string }[] }>;
export function createTaskRecords(options: { dataDirectory: string }): {
  list(): Promise<JiraDevTaskRecord[]>;
  get(taskId: string): Promise<JiraDevTaskRecord | undefined>;
  create(record: JiraDevTaskRecord): Promise<JiraDevTaskRecord>;
  requirement(taskId: string, plan: JiraDevPlan): Promise<JiraDevTaskRecord>;
  repair(taskId: string, plan: JiraDevPlan): Promise<JiraDevTaskRecord>;
  technicalDesign(taskId: string, input: { body: string; evidence: string; source?: unknown; publication?: unknown }): Promise<unknown>;
  workspace(taskId: string, workspace: JiraDevWorkspace, projectIndex?: number): Promise<JiraDevTaskRecord>;
};
export function createTaskWorkspace(input: { projectPath: string; baseBranch: string; branchName: string; taskName?: string }): Promise<JiraDevWorkspace>;
export function inspectTaskWorkspace(input: { projectPath: string; sourceProjectPath: string; branchName: string; baseSha: string }): Promise<JiraDevWorkspace>;
export function prepareTask(input: Record<string, unknown>): Promise<{ projectPath: string; baseBranch: string; branchName: string; title: string; warning?: string;
  projects?: { path: string; baseBranch: string; branchName: string }[] }>;
export function readTaskIssue(jira: unknown, source: string, options?: { details?: string; cachedIssue?: JiraDevIssue }): Promise<JiraDevIssue>;
export function sourceIdentity(source: string, site?: string): { key: string; url: string };

/** 执行提示使用去重材料；不更改完整任务计划与 Jira 写入字段。 */
export function createTaskMaterialContext(input?: { sourceIssue?: JiraDevIssue; details?: string }): {
  issue(issue?: JiraDevIssue, reference?: string): unknown;
  plan(plan?: JiraDevPlan): unknown;
};
