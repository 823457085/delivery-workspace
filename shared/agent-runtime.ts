import type { AgentUsage } from './agent-usage.js';
/**
 * 设计说明：该契约把工作台任务与具体 CLI 解耦；访问权限按轮明确选择，
 * 默认仅允许写入所选工作区，只有 Agent 模式可主动切换为完全访问。
 */
export type AgentProvider = 'codex' | 'cursor' | 'claude' | 'kiro' | 'antigravity' | 'api' | 'deepseek' | 'workbuddy' | 'grok';
export type AgentApiProvider = Extract<AgentProvider, 'api' | 'deepseek' | 'grok'>;
export const agentProviderLabels: Record<AgentProvider, string> = { codex: 'Codex CLI', cursor: 'Cursor CLI', claude: 'Claude Code', kiro: 'Kiro CLI', antigravity: 'Antigravity CLI', api: '模型 API', deepseek: 'DeepSeek', workbuddy: '腾讯 WorkBuddy', grok: 'Grok（xAI）' };
export type AgentRunMode = 'agent' | 'plan' | 'ask';
export type AgentAccessMode = 'workspace' | 'full';
export type AgentQueuePlacement = 'append' | 'next';
export type AgentRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
export type AgentReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type AgentServiceTier = 'default' | 'priority';
export type AgentTaskRole = 'main' | 'worker' | 'verifier' | 'reviewer';
export type AgentTaskSource = 'manual' | 'workflow' | 'automation';

export const agentReasoningEfforts: AgentReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const maxAgentAttachmentBytes = 100 * 1024 * 1024;

export interface AgentModelOption {
  id: string;
  label: string;
  efforts?: AgentReasoningEffort[];
  defaultEffort?: AgentReasoningEffort;
  serviceTiers?: { id: string; name: string; description: string }[];
  defaultServiceTier?: string;
  customId?: string;
  api?: { baseUrl: string; hasApiKey: boolean };
}

export interface AgentCustomModelInput {
  provider: AgentProvider;
  modelId: string;
  label: string;
  api?: { baseUrl: string; apiKey?: string };
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
  accessModes?: AgentAccessMode[];
  models: AgentModelOption[];
  defaultModel: string;
  configuredModel?: string;
  /** undefined 表示未读取到配置；null 表示 CLI 未显式指定，使用模型默认档位。 */
  configuredServiceTier?: string | null;
  writable: boolean;
  checkedAt: string;
}

/** 工作台默认使用 GPT-6.1-Sol、最高推理强度和普通速度；用户仍可按会话改选。 */
export const codexWorkbenchDefaults = { model: 'gpt-6.1-sol', reasoningEffort: 'ultra', serviceTier: 'default' } as const;
export interface AgentModelDefaults { provider?: AgentProvider; model: string; reasoningEffort: AgentReasoningEffort | '' }
export function workbenchRuntime(runtime: AgentRuntimeHealth, defaults: AgentModelDefaults = codexWorkbenchDefaults): AgentRuntimeHealth {
  if (runtime.provider !== (defaults.provider || 'codex')) return runtime;
  return { ...runtime, defaultModel: defaults.model,
    models: runtime.models.map(model => model.id === defaults.model
      && defaults.reasoningEffort && model.efforts?.includes(defaults.reasoningEffort)
      ? { ...model, defaultEffort: defaults.reasoningEffort } : model) };
}

export interface AgentUsageWindow {
  usedPercent: number;
  remainingPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface AgentUsageCredits {
  hasCredits: boolean;
  unlimited?: boolean;
  balance: number | null;
}

export interface AgentUsageLimits {
  available: boolean;
  checkedAt: string;
  /** Last successful observation retained after a failed refresh, not current quota. */
  stale?: boolean;
  lastSuccessAt?: string;
  retryAt?: string;
  errorKind?: 'authentication' | 'timeout' | 'network' | 'unavailable';
  planType?: string;
  /** Display-only account/source label; never credentials or an execution-account override. */
  sourceLabel?: string;
  primary?: AgentUsageWindow;
  secondary?: AgentUsageWindow;
  credits?: AgentUsageCredits;
  message?: string;
}

export interface AntigravityUsageBucket {
  id: string;
  name: string;
  description?: string;
  window: string;
  remainingPercent: number;
  resetsAt: number | null;
  disabled?: boolean;
}

export interface AntigravityUsageGroup {
  name: string;
  description?: string;
  buckets: AntigravityUsageBucket[];
}

export interface AntigravityUsageLimits {
  available: boolean;
  checkedAt: string;
  groups: AntigravityUsageGroup[];
  message?: string;
  stale?: boolean;
  lastSuccessAt?: string;
  retryAt?: string;
  errorKind?: 'authentication' | 'timeout' | 'network' | 'unavailable';
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

export type AgentProfileId = 'engineer' | 'frontend' | 'verifier' | 'reviewer';
export type AgentTeamTemplateId = 'engineering' | 'frontend';
export type AgentWorkflowStage = 'implement' | 'verify' | 'review';

/** 团队流程中的一步；step 单调递增，同一步的续接或重试共享 step，调度器按 step 幂等派发。 */
export interface AgentTaskWorkflowLink {
  id: string;
  templateId: AgentTeamTemplateId;
  stage: AgentWorkflowStage;
  round: number;
  step: number;
}

export interface AgentTaskLink {
  parentConversationId: string;
  dependsOnConversationIds: string[];
  role: AgentTaskRole;
  title: string;
  source: AgentTaskSource;
  sourceId?: string;
  profileId?: AgentProfileId;
  workflow?: AgentTaskWorkflowLink;
}

/** 工作台计算的代码版本标识；模型自报的哈希不采信。 */
export interface AgentWorkspaceVersion {
  kind: 'git-tree' | 'changed-files';
  value: string;
  head?: string;
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
  recoveryOfRunId?: string;
  /** 重启只核对原轮次；恢复记录不代表业务验收，也不自动重派任务。 */
  recovery?: {
    previousStatus: 'running' | 'queued' | 'interrupted';
    previousPid: number | null;
    state: 'pending' | 'active' | 'needs-review' | 'completed' | 'resumed';
    checkedAt: string;
    message: string;
    resumedRunId?: string;
    /** 桌面观察中断只重新读取既有轮次，不能因此重发任务。 */
    nativeObservation?: 'codex-desktop';
    /** 已请求停止但原生轮次尚未确认退出；继续观察，不得按取消成功重派。 */
    stopRequested?: boolean;
    workspaceBefore?: { headSha: string; files: Record<string, { status: AgentChangedFile['status']; fingerprint: string }> };
  };
  /** 暂停当前会话队列，等待用户编辑后显式继续；不回滚已执行的副作用。 */
  pausedForEdit?: boolean;
  /** 工作台确认立即重启后，由服务启动流程自动续跑；普通暂停不会设置。 */
  resumeAfterWorkspaceRestart?: boolean;
  /** 该轮已由工作台重启流程自动续跑；用于团队编排区分暂时取消与真实失败。 */
  workspaceRestartResumedAt?: string;
  /** 已在同一工作台轮次内续跑；旧事件仍保留在执行记录。 */
  continuedAt?: string;
  revisesRunId?: string;
  /** 调整方向续接的展示轮次来源；不改变运行身份与调度。 */
  roundContinuationOfRunId?: string;
  liveInputReady?: boolean;
  supplements?: { id: string; objective: string; attachments: AgentAttachment[]; createdAt: string; knowledgeContext?: string }[];
  knowledgeContext?: string;
  /** 跨执行器的内部交接资料；用户消息与会话标题只使用 objective。 */
  providerSwitch?: { from: AgentProvider; context: string };
  /** 权限变化时新建原生会话，保留工作台聊天背景，不继承旧会话的工具限制。 */
  accessTransition?: { fromMode: AgentRunMode; fromAccessMode: AgentAccessMode; context: string };
  /** 宿主已使用本机工具配置启动完全访问；缺省的旧受限 full 会话只迁移一次。 */
  nativeConfiguredTools?: true;
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
  /** Bound by the host to a specific API configuration; never chosen by model output. */
  customModelId?: string;
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
  /** 由目录与 Git worktree 归属派生的项目分组路径；不改变执行目录或隔离元数据。 */
  readonly projectWorkspacePath?: string;
  baseBranch?: string;
  isolatedWorkspace?: boolean;
  branch: string;
  headSha: string;
  status: AgentRunStatus;
  sessionId: string;
  pid: number | null;
  result: string;
  /** 仅派生于已持久化的当前结果版本；运行结束但尚在落盘时仍为 false，不写入账本。 */
  readonly resultReady?: boolean;
  /** 运行时在结果落盘前读取的 Jira 研发工作区内容指纹，按验证项目顺序记录。 */
  jiraDevVerification?: string[];
  error: string;
  events: AgentRunEvent[];
  /** 本轮已观察到工具调用；独立于会截断的事件列表，历史缺省表示未知。 */
  toolExecutionStarted?: boolean;
  changedFiles?: AgentChangedFile[];
  task?: AgentTaskLink;
  /** 团队流程在启动时生成的岗位上下文；仅用于提示词与审计。 */
  workflowContext?: string;
  /** 高级团队节点关联，与 V1 固定流程独立；stageKey 用于跨账本恢复去重。 */
  team?: { taskId: string; nodeId: string; stageKey: string; profileId: string; profileRevision: number; interactionMode?: 'chat' | 'group'; artifactDirectories?: string[]; workspacePaths?: string[] };
  teamContext?: string;
  usage?: AgentUsage;
  /** 实现结束、验证副本创建时由工作台计算的版本标识。 */
  workflowSnapshot?: AgentWorkspaceVersion;
  createdAt: string;
  updatedAt: string;
}

export function canContinueStoppedCodexRun(run: AgentRun) {
  return run.provider === 'codex' && run.status === 'cancelled' && !!run.sessionId
    && !!(run.codexTurnId || run.continuedAt) && !run.recovery && !run.requiresIsolation && !run.continuation
    && !run.team && (!run.task || run.task.role === 'main' && !run.task.workflow);
}

export interface CodexSessionSummary {
  id: string;
  title: string;
  preview: string;
  workspacePath: string;
  readonly projectWorkspacePath?: string;
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

export interface AgentConversationDeleteTarget {
  id: string;
  source: 'workspace' | 'codex';
}

export interface AgentConversationDeleteResult {
  removed: AgentConversationDeleteTarget[];
  failures: (AgentConversationDeleteTarget & { message: string })[];
}

export interface AgentRuntimeDashboard {
  runtimeStatusVersion?: number;
  projectlessFork?: boolean;
  revision: number;
  runtimes: AgentRuntimeHealth[];
  runs: AgentRun[];
  codexSessions: CodexSessionSummary[];
  conversationTitles: Record<string, string>;
  codexSync: CodexSyncState;
  codexUsage?: AgentUsageLimits;
  apiUsage?: AgentUsageLimits;
  cursorUsage?: AgentUsageLimits;
  claudeUsage?: AgentUsageLimits;
  antigravityUsage?: AntigravityUsageLimits;
  activeWorkspaceLocks: { workspacePath: string; runId: string; provider: AgentProvider }[];
  workflows?: AgentWorkflowSummary[];
}

export interface AgentProviderFallback { from: 'claude'; to: 'codex'; reason: string; at: string }

export type AgentWorkflowState = 'implementing' | 'verifying' | 'reviewing' | 'reworking' | 'awaiting_acceptance'
  | 'needs_decision' | 'blocked' | 'cancelled' | 'taken_over';
export type AgentWorkflowAction = 'extend' | 'escalate' | 'retry' | 'takeover' | 'cancel';

export interface AgentWorkflowStepSummary {
  step: number;
  stage: AgentWorkflowStage;
  round: number;
  runId: string;
  conversationId: string;
  profileId: AgentProfileId;
  provider: AgentProvider;
  model: string;
  reasoningEffort: AgentReasoningEffort | '';
  status: AgentRunStatus;
  outcome: 'pending' | 'passed' | 'failed' | 'blocked';
  reason: string;
}

export interface AgentWorkflowSummary {
  id: string;
  templateId: AgentTeamTemplateId;
  parentConversationId: string;
  objective: string;
  acceptanceCriteria: { id: string; text: string }[];
  allowedPaths: string[];
  state: AgentWorkflowState;
  stage: AgentWorkflowStage;
  round: number;
  maxRounds: number | null;
  escalated: boolean;
  reason: string;
  nextStep: string;
  actions: AgentWorkflowAction[];
  steps: AgentWorkflowStepSummary[];
  implementationConversationId: string;
  snapshot?: AgentWorkspaceVersion;
  /** Claude 不可用时流程已改用 Codex 继续；之后的 Claude 岗位都由 Codex 承担。 */
  providerFallback?: AgentProviderFallback;
  createdAt: string;
  updatedAt: string;
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
  /** 在已有工作台对话中切换执行器，CLI 创建自己的原生会话。 */
  continueConversationId?: string;
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

export type AgentTaskWorkflowTemplateId = 'implement-review' | AgentTeamTemplateId;

export interface StartAgentTaskWorkflowInput {
  templateId: AgentTaskWorkflowTemplateId;
  objective: string;
  /** 团队模板：每行一条验收标准，可以为空。 */
  acceptanceCriteria?: string[];
  /** 团队模板：允许修改的路径 glob；为空表示只记录不检查。 */
  allowedPaths?: string[];
  model?: string;
  reasoningEffort?: AgentReasoningEffort | '';
  serviceTier?: AgentServiceTier;
  accessMode?: AgentAccessMode;
  attachmentIds?: string[];
}
