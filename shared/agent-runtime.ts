/**
 * 设计说明：该契约把工作台任务与具体 CLI 解耦；访问权限按轮明确选择，
 * 默认仅允许写入所选工作区，只有 Agent 模式可主动切换为完全访问。
 */
export type AgentProvider = 'codex' | 'cursor';
export type AgentRunMode = 'agent' | 'plan' | 'ask';
export type AgentAccessMode = 'workspace' | 'full';
export type AgentQueuePlacement = 'append' | 'next';
export type AgentRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
export type AgentReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type AgentServiceTier = 'default' | 'priority';
export type AgentTaskRole = 'main' | 'worker' | 'reviewer';
export type AgentTaskSource = 'manual' | 'workflow' | 'automation';

export const agentReasoningEfforts: AgentReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export interface AgentModelOption {
  id: string;
  label: string;
  efforts?: AgentReasoningEffort[];
  defaultEffort?: AgentReasoningEffort;
  serviceTiers?: { id: string; name: string; description: string }[];
  defaultServiceTier?: string;
  customId?: string;
}

export interface AgentCustomModelInput {
  provider: AgentProvider;
  modelId: string;
  label: string;
}

export interface AgentRuntimeHealth {
  provider: AgentProvider;
  label: string;
  binary: string;
  version: string;
  authenticated: boolean;
  ready: boolean;
  message: string;
  modes: AgentRunMode[];
  models: AgentModelOption[];
  defaultModel: string;
  configuredModel?: string;
  /** undefined 表示未读取到配置；null 表示 CLI 未显式指定，使用模型默认档位。 */
  configuredServiceTier?: string | null;
  writable: boolean;
  checkedAt: string;
}

/** 工作台统一使用已授权的模型与强度；保留 CLI 原始目录，不向不可用模型降级。 */
export const codexWorkbenchDefaults = { model: 'gpt-6.1-sol', reasoningEffort: 'max' } as const;
export function workbenchRuntime(runtime: AgentRuntimeHealth): AgentRuntimeHealth {
  if (runtime.provider !== 'codex') return runtime;
  return { ...runtime, defaultModel: codexWorkbenchDefaults.model,
    models: runtime.models.filter(model => model.id === codexWorkbenchDefaults.model
      && model.efforts?.includes(codexWorkbenchDefaults.reasoningEffort))
      .map(model => ({ ...model, efforts: [codexWorkbenchDefaults.reasoningEffort], defaultEffort: codexWorkbenchDefaults.reasoningEffort })) };
}

export interface AgentUsageWindow {
  usedPercent: number;
  remainingPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface AgentUsageLimits {
  available: boolean;
  checkedAt: string;
  planType?: string;
  primary?: AgentUsageWindow;
  secondary?: AgentUsageWindow;
  message?: string;
}

export interface AgentRunEvent {
  id: string;
  type: 'session' | 'message' | 'tool' | 'diagnostic' | 'lifecycle';
  message: string;
  createdAt: string;
}

export interface AgentChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'generated';
}

export interface AgentTaskLink {
  parentConversationId: string;
  dependsOnConversationIds: string[];
  role: AgentTaskRole;
  title: string;
  source: AgentTaskSource;
  sourceId?: string;
}

export type AgentImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
export function isAgentImageAttachment(attachment: { mimeType: string }) {
  return ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(attachment.mimeType);
}

export interface AgentAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
}

export interface AgentContinuation {
  sessionId: string;
  workspacePath: string;
  branch: string;
  headSha: string;
  sourceWorkspacePath: string;
  baseBranch: string;
  isolatedWorkspace: true;
  /** Historical run whose completed turn was used as the fork boundary. */
  forkSourceRunId?: string;
  forkSourceTurnId?: string;
}

export interface AgentRun {
  /** 暂停当前会话队列，等待用户编辑后显式继续；不回滚已执行的副作用。 */
  pausedForEdit?: boolean;
  revisesRunId?: string;
  liveInputReady?: boolean;
  supplements?: { id: string; objective: string; attachments: AgentAttachment[]; createdAt: string; knowledgeContext?: string }[];
  knowledgeContext?: string;
  id: string;
  parentRunId?: string;
  /** Stable UI conversation identity; a precise fork may keep this while changing Codex threads. */
  conversationId?: string;
  /** 同一会话的稳定队列根；旧运行在读取时补齐，避免历史截断后改变队列。 */
  queueRootId?: string;
  originSessionId?: string;
  /** Codex app-server turn ID for this run, used as an exact fork boundary. */
  codexTurnId?: string;
  /** This historical physical thread mixed multiple UI conversations and must be precisely forked before reuse. */
  requiresIsolation?: boolean;
  /** A prepared thread/worktree for the next turn; historical run metadata stays unchanged. */
  continuation?: AgentContinuation;
  provider: AgentProvider;
  mode: AgentRunMode;
  accessMode: AgentAccessMode;
  model: string;
  reasoningEffort: AgentReasoningEffort | '';
  /** 缺省的历史运行继续使用 Codex CLI 配置；显式选择由后续轮次继承。 */
  serviceTier?: AgentServiceTier;
  objective: string;
  attachments?: AgentAttachment[];
  workspacePath: string;
  /** 用户显式确认的 Cursor 目录；仅用于本轮，不能继承给其他工作区。 */
  cursorTrustPath?: string;
  sourceWorkspacePath?: string;
  baseBranch?: string;
  isolatedWorkspace?: boolean;
  branch: string;
  headSha: string;
  status: AgentRunStatus;
  sessionId: string;
  pid: number | null;
  result: string;
  error: string;
  events: AgentRunEvent[];
  changedFiles?: AgentChangedFile[];
  task?: AgentTaskLink;
  createdAt: string;
  updatedAt: string;
}

export interface CodexSessionSummary {
  id: string;
  title: string;
  preview: string;
  workspacePath: string;
  branch: string;
  headSha: string;
  model: string;
  reasoningEffort: AgentReasoningEffort | '';
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CodexSessionTurn {
  id: string;
  userMessage: string;
  agentMessage: string;
  createdAt: string;
  updatedAt: string;
  /** Codex-native completion time; null while unfinished, absent in older cached details. */
  completedAt?: string | null;
}

export interface CodexSessionDetail extends CodexSessionSummary {
  turns: CodexSessionTurn[];
}

export interface CodexSyncState {
  syncedAt: string;
  total: number;
  hidden: number;
}

export interface AgentRuntimeDashboard {
  revision: number;
  runtimes: AgentRuntimeHealth[];
  runs: AgentRun[];
  codexSessions: CodexSessionSummary[];
  conversationTitles: Record<string, string>;
  codexSync: CodexSyncState;
  codexUsage?: AgentUsageLimits;
  activeWorkspaceLocks: { workspacePath: string; runId: string; provider: AgentProvider }[];
}

export interface AgentWorkspaceBranches {
  workspacePath: string;
  current: string;
  branches: string[];
}

export interface AgentSkillOption {
  name: string;
  invocation: string;
  description: string;
  source: 'project' | 'personal' | 'system' | 'plugin';
  sourceLabel: string;
}

export interface AgentKnowledgeMatch {
  path: string;
  line: number;
  excerpt: string;
}

export interface AgentKnowledgeScope {
  workspacePath: string;
  branch: string;
  headSha: string;
}

export interface StartAgentRunInput {
  provider: AgentProvider;
  mode: AgentRunMode;
  accessMode?: AgentAccessMode;
  model: string;
  reasoningEffort?: AgentReasoningEffort | '';
  serviceTier?: AgentServiceTier;
  objective: string;
  attachmentIds?: string[];
  workspacePath: string;
  branch?: string;
  isolateWorkspace?: boolean;
  cursorTrustPath?: string;
}

export interface SpawnAgentTaskInput {
  title: string;
  objective: string;
  role: Exclude<AgentTaskRole, 'main'>;
  dependsOnConversationIds: string[];
}

export type AgentTaskWorkflowTemplateId = 'implement-review';

export interface StartAgentTaskWorkflowInput {
  templateId: AgentTaskWorkflowTemplateId;
  objective: string;
  model?: string;
  reasoningEffort?: AgentReasoningEffort | '';
  serviceTier?: AgentServiceTier;
  accessMode?: AgentAccessMode;
  attachmentIds?: string[];
}
