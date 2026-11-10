/** 高级团队使用独立 DAG 契约，不改变现有 V1 固定流水线的历史记录。 */
import { z } from 'zod';
import type { AgentAccessMode, AgentChangedFile, AgentProvider, AgentRun, AgentRunStatus, AgentWorkspaceVersion } from './agent-runtime.js';
import type { AgentTaskFinding } from './agent-task-result.js';
import type { AgentTaskPlan, BatchResult, DiagnosisResult, RequirementBrief, TeamTemplateId, TechnicalDesign } from './agent-task-plan.js';

export const teamProfileIds = ['leader', 'analyst', 'architect', 'engineer', 'frontend', 'verifier', 'reviewer', 'batch', 'reporter', 'second_opinion'] as const;
export type TeamProfileId = typeof teamProfileIds[number];

/** 兼容旧岗位权限；只迁移固定职责元数据，保留用户选择的模型、路由和任务级访问范围。 */
export function normalizeTeamAccessModes(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.profiles)) return value;
  return { ...record, profiles: record.profiles.map((profile) => {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return profile;
    const item = profile as Record<string, unknown>;
    if (!teamProfileIds.includes(item.id as TeamProfileId) || !['agent', 'ask'].includes(String(item.mode))) return item;
    const legacyDescriptions: Partial<Record<TeamProfileId, string>> = {
      reviewer: '独立只读审查需求覆盖、代码和验证证据。',
      reporter: '只依据已验收证据整理草稿；不发布外部系统。',
      second_opinion: '按用户触发提供只读第二意见，不改变流程结论。',
    };
    const id = item.id as TeamProfileId;
    return { ...item, mode: 'agent', accessMode: 'full',
      ...(item.description === legacyDescriptions[id] ? { description: teamRoleMetadata[id].description } : {}) };
  }) };
}

export const teamModelChoiceSchema = z.object({ provider: z.enum(['codex', 'claude', 'cursor', 'kiro', 'antigravity']), model: z.string().trim().min(1).max(100),
  reasoningEffort: z.enum(['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  catalogAlias: z.object({ id: z.string().min(1).max(100), label: z.string().min(1).max(100) }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.provider === 'codex' && !value.reasoningEffort) context.addIssue({ code: 'custom', path: ['reasoningEffort'], message: 'Codex 岗位必须明确选择推理强度，不能继承本机默认值' });
  if (value.provider === 'cursor' && value.reasoningEffort) context.addIssue({ code: 'custom', path: ['reasoningEffort'], message: 'Cursor 模型不支持推理强度参数' });
});
export type TeamModelChoice = z.infer<typeof teamModelChoiceSchema>;
export const teamRoleMetadata: Record<TeamProfileId, { label: string; mode: 'agent' | 'ask'; taskRole: 'worker' | 'reviewer' | 'verifier'; description: string }> = {
  leader: { label: '总协调', mode: 'agent', taskRole: 'worker', description: '理解目标，提出带来源的计划与验收标准；派发和确认由工作台与用户控制。' },
  analyst: { label: '需求研究', mode: 'agent', taskRole: 'worker', description: '整理事实、推断与缺口；不创造未经确认的产品规则。' },
  architect: { label: '架构', mode: 'agent', taskRole: 'worker', description: '复杂契约、状态机和任务拆分；明确共享文件负责人。' },
  engineer: { label: '工程实现', mode: 'agent', taskRole: 'worker', description: '在允许范围完成工程代码与必要自测。' },
  frontend: { label: '前端实现', mode: 'agent', taskRole: 'worker', description: '根据已确认的页面、字段与交互完成实现。' },
  verifier: { label: '验证', mode: 'agent', taskRole: 'verifier', description: '在一次性副本运行检查；不将副本修改合回候选。' },
  reviewer: { label: '审查', mode: 'agent', taskRole: 'reviewer', description: '独立审查需求覆盖、代码和验证证据，按任务授权完成必要核验。' },
  batch: { label: '批量编码', mode: 'agent', taskRole: 'worker', description: '按确认规则批量变换并报告例外。' },
  reporter: { label: '交付整理', mode: 'agent', taskRole: 'worker', description: '依据已验收证据整理交付内容；外部发布按用户明确授权执行。' },
  second_opinion: { label: '第二意见', mode: 'agent', taskRole: 'reviewer', description: '按用户触发提供第二意见和必要核验，不自行改变流程结论。' },
};
export const teamProfileSchema = z.object({ id: z.enum(teamProfileIds), label: z.string().min(1).max(100),
  description: z.string().min(1).max(1000), taskRole: z.enum(['worker', 'verifier', 'reviewer']), mode: z.enum(['agent', 'ask']),
  accessMode: z.enum(['workspace', 'full']), provider: z.enum(['codex', 'claude', 'cursor', 'kiro', 'antigravity']), model: z.string().trim().min(1).max(100),
  reasoningEffort: z.enum(['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  catalogAlias: z.object({ id: z.string().min(1).max(100), label: z.string().min(1).max(100) }).strict().optional(),
  escalation: teamModelChoiceSchema.optional(),
}).strict().superRefine((value, context) => {
  const fixed = teamRoleMetadata[value.id];
  for (const key of ['label', 'description', 'taskRole', 'mode'] as const) if (value[key] !== fixed[key]) {
    context.addIssue({ code: 'custom', path: [key], message: '岗位职责和权限由岗位类型固定，不能修改' });
  }
  const expectedAccessMode = fixed.mode === 'agent' ? 'full' : 'workspace';
  if (value.accessMode !== expectedAccessMode) {
    context.addIssue({ code: 'custom', path: ['accessMode'], message: `${fixed.mode === 'agent' ? 'Agent' : '只读'}岗位固定使用${expectedAccessMode === 'full' ? '完全' : '工作区'}访问` });
  }
  if (value.provider === 'codex' && !value.reasoningEffort) context.addIssue({ code: 'custom', path: ['reasoningEffort'], message: 'Codex 岗位必须明确选择推理强度，不能继承本机默认值' });
  if (value.provider === 'cursor' && value.reasoningEffort) context.addIssue({ code: 'custom', path: ['reasoningEffort'], message: 'Cursor 模型不支持推理强度参数' });
});
export type TeamRoleProfile = z.infer<typeof teamProfileSchema>;
export const profileConfigSchema = z.object({ revision: z.number().int().positive(), profiles: z.array(teamProfileSchema).length(teamProfileIds.length),
  reviewRouting: z.object({ codex: teamModelChoiceSchema, claude: teamModelChoiceSchema, cursor: teamModelChoiceSchema,
    kiro: teamModelChoiceSchema.default({ provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high' }),
    antigravity: teamModelChoiceSchema.default({ provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high' }) }).strict(),
  options: z.object({ autoStartLowRisk: z.boolean().default(false),
    tokenLimits: z.record(z.string(), z.number().int().positive().nullable()).default({}),
    lowQuotaPercent: z.number().min(0).max(100).default(0), maxEscalations: z.number().int().min(0).nullable().default(null),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (new Set(value.profiles.map(item => item.id)).size !== teamProfileIds.length) context.addIssue({ code: 'custom', path: ['profiles'], message: '每个岗位必须且只能出现一次' });
  for (const provider of ['claude', 'cursor', 'kiro', 'antigravity'] as const) if (value.reviewRouting[provider].provider === provider) {
    context.addIssue({ code: 'custom', path: ['reviewRouting', provider], message: '审查路由必须跨执行器' });
  }
  const reviewer = value.profiles.find(item => item.id === 'reviewer');
  if (reviewer && ['provider', 'model', 'reasoningEffort'].some(key => reviewer[key as keyof TeamRoleProfile] !== value.reviewRouting.codex[key as keyof TeamModelChoice])) {
    context.addIssue({ code: 'custom', path: ['reviewRouting', 'codex'], message: '默认审查岗位必须与 Codex 作者的审查路由一致' });
  }
  for (const key of Object.keys(value.options.tokenLimits)) if (!['engineering', 'frontend', 'diagnosis', 'research_design', 'complex_delivery', 'complex_delivery_parallel', 'batch'].includes(key)) {
    context.addIssue({ code: 'custom', path: ['options', 'tokenLimits', key], message: '未知流程模板' });
  }
}).transform(value => ({ ...value, options: { ...value.options, tokenLimits: {} as Record<string, number | null>, lowQuotaPercent: 0, maxEscalations: null as number | null } }));
export type TeamProfileConfig = z.infer<typeof profileConfigSchema>;
const sol: TeamModelChoice = { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high' };
const astra: TeamModelChoice = { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high' };
const sonnet: TeamModelChoice = { provider: 'claude', model: 'claude-sonnet-5-5', reasoningEffort: 'high', catalogAlias: { id: 'sonnet', label: 'Sonnet 5.5' } };
const opus: TeamModelChoice = { provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'high', catalogAlias: { id: 'opus', label: 'Opus 5.5' } };
export function defaultTeamProfileConfig(): TeamProfileConfig {
  const choices: Record<TeamProfileId, TeamModelChoice & { escalation?: TeamModelChoice }> = {
    leader: sol, analyst: { ...sonnet, escalation: opus }, architect: astra, engineer: { ...sol, escalation: astra },
    frontend: { ...sonnet, escalation: opus }, verifier: { ...sol, reasoningEffort: 'medium' }, reviewer: opus,
    batch: { provider: 'cursor', model: 'composer-2.5', reasoningEffort: '' }, reporter: { provider: 'codex', model: 'gpt-6-luna', reasoningEffort: 'low' },
    second_opinion: { provider: 'claude', model: 'claude-fable-5-1', reasoningEffort: 'high', catalogAlias: { id: 'fable', label: 'Fable 5.1' } },
  };
  return profileConfigSchema.parse({ revision: 1, profiles: teamProfileIds.map(id => ({ id, ...teamRoleMetadata[id], accessMode: teamRoleMetadata[id].mode === 'agent' ? 'full' : 'workspace', ...choices[id] })),
    reviewRouting: { codex: opus, claude: astra, cursor: opus, kiro: astra, antigravity: astra }, options: { autoStartLowRisk: false, tokenLimits: {}, lowQuotaPercent: 0, maxEscalations: null } });
}
export function teamProfile(config: TeamProfileConfig, id: TeamProfileId): TeamRoleProfile {
  const value = config.profiles.find(item => item.id === id);
  if (!value) throw new Error(`缺少岗位配置：${id}`);
  return value;
}

export type TeamTaskState = 'planning' | 'awaiting_plan' | 'running' | 'waiting_input' | 'blocked' | 'needs_decision'
  | 'needs_reconciliation' | 'awaiting_acceptance' | 'accepted' | 'rejected' | 'cancelled' | 'taken_over' | 'completed';
export type TeamNodeStage = 'plan' | 'analyst' | 'architect' | 'implement' | 'diagnose' | 'integrate' | 'verify' | 'review' | 'report' | 'second_opinion';
export type TeamNodeStatus = 'pending' | AgentRunStatus | 'blocked' | 'waiting_input' | 'needs_reconciliation' | 'skipped';
export interface TeamArtifact { id: string; kind: string; path: string; hash: string; createdAt: string; nodeId: string }
export interface TeamReviewUnit { id: string; authorProfileId: TeamProfileId; authorProvider: AgentProvider; files: string[]; artifactHashes?: string[];
  snapshot?: AgentWorkspaceVersion; verdict?: 'approved' | 'changes_requested' | 'blocked'; findings?: AgentTaskFinding[]; approvedAt?: string }
export interface TeamNode {
  chatInputId?: string;
  id: string; stage: TeamNodeStage; profileId: TeamProfileId; status: TeamNodeStatus; dependencies: string[];
  attempt: number; round: number; runId?: string; workspacePath?: string; snapshot?: AgentWorkspaceVersion; result?: string;
  artifactHash?: string; artifactIds?: string[]; reviewUnit?: TeamReviewUnit; changedFiles?: AgentChangedFile[];
  error?: string; reason?: string; reworkReason?: string; startedAt?: string; finishedAt?: string; createdAt: string; updatedAt: string;
}
export function canRetryTeamReviewWithCodex(task: Pick<TeamTask, 'state' | 'round' | 'nodes'> | undefined, node?: TeamNode) {
  return !!task && ['blocked', 'needs_reconciliation', 'needs_decision', 'awaiting_plan', 'waiting_input'].includes(task.state)
    && !task.nodes.some(item => ['pending', 'queued', 'running'].includes(item.status))
    && (node ? [node] : task.nodes).some(item => item.stage === 'review' && item.round <= task.round
      && !task.nodes.some(later => later.stage === 'review' && later.round > item.round && later.status !== 'skipped')
      && ['blocked', 'needs_reconciliation'].includes(item.status));
}
export interface TeamChatMessage {
  id: string; role: 'user' | 'assistant'; text: string; createdAt: string;
  replyTo?: string; requestId?: string;
  profileId?: TeamProfileId; nodeId?: string; attachmentIds?: string[]; kind?: 'message' | 'progress' | 'handoff' | 'question' | 'collaboration' | 'delivery';
  provider?: AgentProvider; model?: string;
  hostGenerated?: boolean;
}
/** 使用消息发送者当时的运行身份，不能把交接目标或后续重试的模型当作发送者。 */
export function teamChatMessageIdentity(message: TeamChatMessage,
  task: { id: string; nodes: (TeamNode & { effectiveChoice?: TeamModelChoice })[] }, runs: AgentRun[]) {
  if (message.role === 'user' || message.kind === 'delivery' || message.hostGenerated) return undefined;
  if (message.provider) return { provider: message.provider, model: message.model || '' };
  const profileId = message.profileId || 'leader', at = Date.parse(message.createdAt);
  const node = task.nodes.find(node => node.id === message.nodeId && node.profileId === profileId);
  const run = runs.filter(run => run.team?.taskId === task.id && run.team.profileId === profileId
    && (!node || run.team.nodeId === node.id) && Date.parse(run.createdAt) <= at)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  if (run) return { provider: run.provider, model: run.model };
  const author = node || task.nodes.filter(node => node.profileId === profileId && Date.parse(node.startedAt || node.createdAt) <= at)
    .sort((a, b) => Date.parse(b.startedAt || b.createdAt) - Date.parse(a.startedAt || a.createdAt))[0];
  if (author?.attempt === 1 && Date.parse(author.startedAt || author.createdAt) <= at && author.effectiveChoice) return { provider: author.effectiveChoice.provider, model: author.effectiveChoice.model };
  return undefined;
}
export interface TeamChatInput { id: string; text: string; attachmentIds: string[]; createdAt: string; requestId?: string; workspacePath?: string; attachmentsApplied?: boolean }
export interface TeamChatState {
  messages: TeamChatMessage[]; workspaceBound: boolean; pendingInputs: TeamChatInput[]; lastInputId?: string; statusKey?: string;
  paused?: boolean; resumeRequested?: boolean; parentContext?: string; projectWorkspacePath?: string; autoRecoveryAttempts?: number; autoRecoveryKeys?: string[]; recoveryEligibleNodeId?: string;
  steering?: { inputId: string; requestId?: string; accessMode?: AgentAccessMode; phase: 'stopping' | 'processing' };
  coordination?: { phase: 'reviewing' | 'queued' | 'delivered' | 'stopping' | 'paused' | 'needs_input';
    inputId?: string; text: string; targetNodeId?: string; autoRecoveryAttempts?: number };
}
export interface TeamMessage {
  id: string; workflowId: string; nodeId?: string; type: 'ask' | 'back' | 'handoff' | 'cancel' | 'progress';
  from: { kind: 'profile'; profileId: string } | { kind: 'user' }; to: { kind: 'profile'; profileId: string } | { kind: 'user' };
  correlationId: string; causationId: string; sequence: number; dedupeKey: string; body: { text: string; refs: string[] };
  blocking: boolean; forwarded: number; answerTo?: string; delivery: 'queued' | 'delivered' | 'acknowledged';
  processing: 'pending' | 'processing' | 'answered' | 'failed' | 'expired'; createdAt: string; updatedAt: string;
}
export interface CandidateManifest {
  id: string; workflowId: string; round: number; base: { head: string; tree: string };
  sources: { runId: string; profileId: string; snapshot: string; patchHash: string; files: string[]; fencingToken?: number }[];
  integration: { worktree: string; appliedOrder: string[]; conflicts: { path: string; owner: string; resolvedByRunId?: string }[] };
  final: { tree: string }; supersedes?: string;
}
export interface TeamTask {
  /** 群聊创建的自动流程只使用该轮冻结的已启用成员。 */
  groupRoomId?: string; groupMembers?: Partial<Record<TeamProfileId, import('./agent-group-chat.js').GroupMember>>;
  groupCursorTrustPaths?: string[];
  interactionMode?: 'chat'; chat?: TeamChatState;
  /** 自动团队聊天下一轮 Agent 岗位使用的权限；旧任务缺省为完全访问。 */
  accessMode?: AgentAccessMode;
  id: string; parentConversationId: string; sourceWorkspacePath: string; objective: string; attachmentIds: string[];
  profileConfig: TeamProfileConfig; plan?: AgentTaskPlan; planRevision: number; confirmedAt?: string; confirmedBy?: 'user' | 'auto';
  nodes: TeamNode[]; state: TeamTaskState; round: number; maxRounds: number | null; createdAt: string; updatedAt: string;
  requestedTemplateId?: TeamTemplateId; planHistory?: { revision: number; plan: AgentTaskPlan; createdAt: string }[];
  planAnswers?: { questionId: string; text: string; at: string }[]; replanCount?: number; reason?: string;
  workspacePath?: string; baseSnapshot?: AgentWorkspaceVersion; candidate?: CandidateManifest; candidateHistory?: CandidateManifest[];
  artifacts?: TeamArtifact[]; requirementBrief?: RequirementBrief; technicalDesign?: TechnicalDesign; diagnosis?: DiagnosisResult; batchResult?: BatchResult;
  providerFallback?: { from: 'claude'; to: 'codex'; reason: string; at: string }; escalations?: number;
  decisions?: { requestId: string; action: string; at: string; nodeId?: string }[];
  acceptance?: { revision: number; snapshot: AgentWorkspaceVersion; decision: 'accepted' | 'rejected'; summary: string; at: string; confirmedBy: 'user' };
  report?: { nodeId: string; draft: string; evidenceHashes: string[]; createdAt: string; jiraHandoffUrl?: string };
}
export const teamTemplateLabels: Record<TeamTemplateId, string> = { engineering: '工程修复', frontend: '前端页面', verification: '只读验证', diagnosis: '只读诊断',
  research_design: '调研方案', complex_delivery: '复杂交付（串行）', complex_delivery_parallel: '复杂交付（并行）', batch: '批量变换' };
export const teamTemplateBudgets: Record<TeamTemplateId, { maxRuns: number | null; timeoutMinutes: number | null }> = {
  engineering: { maxRuns: null, timeoutMinutes: null }, frontend: { maxRuns: null, timeoutMinutes: null }, verification: { maxRuns: null, timeoutMinutes: null }, diagnosis: { maxRuns: null, timeoutMinutes: null },
  research_design: { maxRuns: null, timeoutMinutes: null }, complex_delivery: { maxRuns: null, timeoutMinutes: null },
  complex_delivery_parallel: { maxRuns: null, timeoutMinutes: null }, batch: { maxRuns: null, timeoutMinutes: null },
};
