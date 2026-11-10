/**
 * 设计说明：Jira 修复 / 需求开发沿用 Jira 研发助手插件的表单、预览与确认流程；
 * 确认后不新建 Codex 聊天，而是在工作台按所选 CLI 与模型启动会话，并登记为原有修复 / 需求记录。
 */
import { z } from 'zod';
import type { AgentAccessMode, AgentProvider, AgentReasoningEffort, AgentRunStatus } from './agent-runtime.js';
import type { GroupExecutionProgress } from './agent-group-chat.js';

export type JiraDevWorkflow = 'jira' | 'requirement';
export interface JiraDevRequirementContext {
  id: string; source: string; details: string; useI18n: boolean; taskId?: string;
}
export const jiraDevWorkflowLabels: Record<JiraDevWorkflow, string> = { jira: 'Jira 修复', requirement: '需求开发' };

const path = z.string().trim().min(1).max(1000);
const developmentKey = z.string().trim().regex(/^[A-Z][A-Z0-9_]*-\d+$/).max(100);
const scheduleDate = z.union([z.iso.date(), z.literal('')]);
const schedule = z.object({ startDate: scheduleDate.optional(), endDate: scheduleDate.optional() }).strict();
export const jiraDevSchedulesSchema = z.object({ parent: schedule.optional(), design: schedule.optional(), implementation: schedule.optional() }).strict();
export const jiraDevProjectSelectionSchema = z.object({ path,
  baseBranch: z.string().trim().min(1).max(200), branchName: z.string().trim().min(1).max(200),
}).strict();
export interface JiraDevProjectSelection {
  path: string; baseBranch: string; branchName: string; workspacePath?: string; baseSha?: string;
}

/** 与插件 prepare_jira_dev_task 的参数保持一致，便于后续继续同步插件规则。 */
export const jiraDevPrepareSchema = z.object({
  workflow: z.enum(['jira', 'requirement']),
  projectPath: path,
  source: z.string().max(1000).default(''),
  details: z.string().max(20000).default(''),
  baseBranch: z.string().trim().min(1).max(200),
  branchName: z.string().trim().min(1).max(200),
  projects: z.array(jiraDevProjectSelectionSchema).min(1).max(10).optional(),
  useI18n: z.boolean().optional(),
  repairMode: z.enum(['direct', 'create', 'reuse']).optional(),
  repairSource: z.string().max(1000).optional(),
  repairProject: z.string().regex(/^(?:[A-Z][A-Z0-9_]*)?$/, '请填写有效的目标 Jira 项目 Key').max(100).optional(),
  repairSummary: z.string().max(250).optional(),
  repairVersion: z.string().max(200).optional(),
  repairStartDate: scheduleDate.optional(),
  repairEndDate: scheduleDate.optional(),
  sourceKind: z.enum(['product', 'frontend']).default('product'),
  developmentKey: developmentKey.optional(),
  businessModule: z.string().max(100).default(''),
  designSource: z.string().max(2000).default(''),
  schedules: jiraDevSchedulesSchema.optional(),
}).strict().refine(value => value.workflow === 'requirement' || !value.projects?.length,
  { message: '多个项目选择仅适用于需求开发流程。', path: ['projects'] })
  .refine(value => !value.developmentKey || value.workflow === 'requirement' && value.sourceKind === 'frontend',
    { message: '开发主任务选择仅适用于复用已有前端任务。', path: ['developmentKey'] });
export type JiraDevPrepareInput = z.input<typeof jiraDevPrepareSchema>;

export const jiraDevRuntimeSchema = z.object({
  provider: z.enum(['codex', 'cursor', 'claude', 'kiro', 'antigravity']),
  model: z.string().trim().max(100),
  reasoningEffort: z.enum(['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']).default(''),
  accessMode: z.enum(['workspace', 'full']),
  collaborationMode: z.enum(['manual', 'automatic', 'group']).optional(),
  groupConfigRevision: z.number().int().positive().optional(),
}).strict();
export interface JiraDevRuntimeSelection {
  provider: AgentProvider; model: string; reasoningEffort: AgentReasoningEffort | ''; accessMode: AgentAccessMode;
  collaborationMode?: 'manual' | 'automatic' | 'group'; groupConfigRevision?: number;
}

const taskId = z.uuid();
export const jiraDevTaskSchema = z.object({ taskId }).strict();
export const jiraDevCheckSchema = jiraDevTaskSchema.extend({ developmentKey: developmentKey.optional() });
export const jiraDevApplySchema = z.object({ taskId, confirmed: z.literal(true), group: z.boolean().optional() }).strict();
export const jiraDevRequirementPhaseSchema = z.enum(['review', 'design']);
export type JiraDevRequirementPhase = z.infer<typeof jiraDevRequirementPhaseSchema>;
export const jiraDevRequirementPhaseStartSchema = z.object({ taskId, phase: jiraDevRequirementPhaseSchema, runtime: jiraDevRuntimeSchema }).strict();
export const jiraDevRequirementDocumentSchema = z.object({
  status: z.enum(['ready', 'blocked']), summary: z.string().trim().min(1).max(1000), markdown: z.string().trim().min(1).max(24000),
}).strict();
export interface JiraDevRequirementDocument {
  status: 'running' | 'ready' | 'blocked' | 'failed'; summary: string; markdown?: string; runId?: string;
}
export const jiraDevRequirementLabels = { review: '需求评审', design: '前端技术方案' } as const;
export const jiraDevRequirementDocumentUrl = (taskId: string, phase: JiraDevRequirementPhase) =>
  `/api/agent-runtimes/jira-dev/requirement-document/${taskId}/${phase}`;
export const jiraDevStartSchema = z.object({ taskId, runtime: jiraDevRuntimeSchema, confirmed: z.literal(true) }).strict();
export const jiraDevProjectSchema = z.object({ projectPath: path }).strict();
export const jiraDevScanSchema = z.object({ roots: z.array(path).min(1).max(5).optional() }).strict();
export const jiraDevSourceSchema = z.object({ source: z.string().trim().min(1).max(1000),
  includeDevelopmentCandidates: z.literal(true).optional() }).strict();
export const jiraDevVersionSchema = z.object({ source: z.string().trim().min(1).max(1000),
  projectKey: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional() }).strict();
export const jiraDevPreferenceSaveSchema = z.object({
  projectPath: path, scopeId: z.string().regex(/^[a-f0-9]{64}$/), expectedRevision: z.string().min(1).max(100),
  settings: z.object({ baseBranch: z.string().max(200), designMode: z.enum(['default', 'custom', 'local']),
    designDestination: z.object({ site: z.string().max(2000), spaceKey: z.string().max(100), parentId: z.string().max(32), title: z.string().max(500) }).strict().optional() }).strict(),
}).strict();

export interface JiraDevIssueView {
  key: string; url: string; summary: string; description?: unknown; status?: string; startDate?: string | null; endDate?: string | null;
  project?: { key: string; name: string }; fixVersions?: { id: string; name: string }[]; materialStatus?: string; materialWarning?: string;
}
export type JiraDevDevelopmentCandidate = Pick<JiraDevIssueView, 'key' | 'url' | 'summary'>;
export interface JiraDevIssueReadResult {
  issue: JiraDevIssueView; connection?: { site: string; account: { id: string; name: string } };
  developmentCandidates?: JiraDevDevelopmentCandidate[]; developmentCandidateError?: string;
}
export interface JiraDevPlanItemView {
  id?: string; workdays?: number;
  role: 'parent' | 'design' | 'implementation'; action: 'create' | 'reuse'; summary: string; description?: unknown;
  key?: string; url?: string; parentRole?: string; error?: string;
  schedule?: { startDate: string; endDate: string; previousStartDate?: string; previousEndDate?: string; changed: boolean };
}
export interface JiraDevPlanView {
  taskId: string; sourceKind: 'product' | 'frontend' | 'defect'; status: 'ready' | 'local' | 'applied' | 'unknown' | 'error';
  items: JiraDevPlanItemView[]; sourceIssue?: JiraDevIssueView; developmentIssue?: JiraDevIssueView; businessModule?: string;
  developmentCandidates?: JiraDevDevelopmentCandidate[];
  designDestination?: { site: string; spaceKey: string; parentId: string; title: string; url: string } | null;
  designPublicationAuthorized?: boolean; requiresConfirmation?: boolean; needsReconfirmation?: boolean; needsTitleReview?: boolean; needsScheduleReview?: boolean;
  warning?: string; targetProject?: { key: string }; assignee?: unknown; fixVersions?: { id?: string; name?: string }[];
  reuseRuleVersion?: number;
  sourceLink?: { action: 'create' | 'reuse' };
}
export type JiraDevLaunchStatus = 'preparing' | 'starting' | 'started' | 'failed' | 'uncertain';
export interface JiraDevLaunch {
  status: JiraDevLaunchStatus; runtime: JiraDevRuntimeSelection; workspacePath: string; baseSha: string;
  runId: string; error: string; startedAt: string;
  teamTaskId?: string; conversationId?: string; projects?: JiraDevProjectSelection[];
  groupRoomId?: string; groupProgress?: GroupExecutionProgress; adoptedRunId?: string;
}
export interface JiraDevAutomationStep {
  status: 'running' | 'completed' | 'blocked' | 'uncertain';
  message: string;
  url?: string;
}
export interface JiraDevAutomationResult {
  start?: JiraDevAutomationStep;
  verification?: JiraDevAutomationStep;
  mergeRequest?: JiraDevAutomationStep;
  complete?: JiraDevAutomationStep;
}
/** 任务预览：plan 为空时是“使用当前 Jira 直接修复”，不写 Jira。 */
export interface JiraDevTaskView {
  taskId: string; workflow: JiraDevWorkflow; title: string; prompt: string; warning?: string; useI18n?: boolean;
  projectPath: string; baseBranch: string; branchName: string; repairMode?: 'direct' | 'create' | 'reuse';
  projects?: JiraDevProjectSelection[];
  plan?: JiraDevPlanView; launch?: JiraDevLaunch & { runStatus?: AgentRunStatus; conversationMissing?: boolean };
  preparation?: Partial<Record<JiraDevRequirementPhase, JiraDevRequirementDocument>>;
  automationDelivery?: JiraDevAutomationResult;
}

/** 计划确认后才可启动；与插件面板的按钮状态一致。 */
export function jiraDevStartBlocker(task: Pick<JiraDevTaskView, 'workflow' | 'plan' | 'repairMode'>): string {
  const plan = task.plan;
  if (task.workflow === 'jira' && task.repairMode !== 'create' && task.repairMode !== 'reuse') return '';
  if (!plan) return '任务计划缺失，请重新生成预览';
  if (plan.status === 'ready' && ['frontend', 'defect'].includes(plan.sourceKind) && !plan.reuseRuleVersion) return 'Jira 复用规则已更新，请重新生成预览';
  if (plan.needsTitleReview) return '请核对标题与项目范围后重新生成预览';
  if (plan.needsScheduleReview) return '请按主任务日期重新生成预览';
  if (plan.status === 'unknown') return 'Jira 任务写入结果待核对，不能重复创建或启动';
  if (plan.sourceKind === 'frontend' && plan.status === 'local') return plan.developmentCandidates?.length
    ? '请先选择并核对开发主任务' : '尚未核对到可复用的开发任务，请调整后重新预览';
  if (task.workflow === 'jira' && plan.status === 'local') return '修复任务无法在 Jira 登记，请调整后重新生成预览';
  return '';
}
export function jiraDevNeedsApply(task: Pick<JiraDevTaskView, 'workflow' | 'plan' | 'repairMode'>) {
  const plan = task.plan;
  if (!plan || (task.workflow === 'jira' && task.repairMode !== 'create' && task.repairMode !== 'reuse')) return false;
  if (plan.status === 'applied') return false;
  if (plan.status === 'local') return !!plan.designDestination && plan.designPublicationAuthorized !== true;
  return ['ready', 'error'].includes(plan.status);
}
