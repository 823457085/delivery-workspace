import { z } from 'zod';
import { agentProviderLabels, type AgentProvider, type AgentRun } from './agent-runtime.js';
import type { TeamProfileConfig, TeamProfileId, TeamTask } from './agent-team.js';

export const groupCapabilitySchema = z.enum(['read', 'write', 'verify', 'review']);
export const groupCapabilityLabels = { read: '分析整理', write: '代码实现', verify: '隔离验证', review: '代码审查' } as const;
const memberId = z.string().min(1).max(120).regex(/^[a-zA-Z0-9_-]+$/);
export const groupBindingSchema = z.object({
  provider: z.enum(Object.keys(agentProviderLabels) as [AgentProvider, ...AgentProvider[]]), model: z.string().trim().max(100),
  reasoningEffort: z.enum(['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']).default(''),
  catalogAlias: z.object({ id: z.string(), label: z.string() }).strict().optional(),
}).strict();
export const groupRoleSchema = z.object({ id: memberId, name: z.string().trim().min(1).max(100),
  instructions: z.string().trim().min(1).max(12000).transform(value => value === '独立只读检查需求覆盖、代码改动和验证证据。问题需给出可定位依据，不能仅凭实现者说明认定通过。'
    ? '独立检查需求覆盖、代码改动和验证证据。问题需给出可定位依据，不能仅凭实现者说明认定通过。' : value), allowedActions: z.string().trim().max(12000).optional(), capability: groupCapabilitySchema,
  enabled: z.boolean().default(true),
}).strict();
export const groupMemberSchema = groupRoleSchema.extend({ binding: groupBindingSchema.optional(), fallbackBinding: groupBindingSchema.nullable().optional() }).strict();
export const groupConfigSchema = z.object({ revision: z.number().int().positive(), name: z.string().trim().min(1).max(100), members: z.array(groupMemberSchema) }).strict()
  .refine(value => new Set(value.members.map(member => member.id)).size === value.members.length, { message: '成员标识不能重复', path: ['members'] });
export const groupTemplateSchema = z.object({ type: z.literal('delivery-team-template'), version: z.literal(1), name: z.string().trim().min(1).max(100),
  members: z.array(groupRoleSchema),
}).strict().refine(value => new Set(value.members.map(member => member.id)).size === value.members.length, { message: '成员标识不能重复', path: ['members'] });
export type GroupMember = z.infer<typeof groupMemberSchema>;
export type GroupBinding = z.infer<typeof groupBindingSchema>;
export type GroupConfig = z.infer<typeof groupConfigSchema>;
export type GroupTemplate = z.infer<typeof groupTemplateSchema>;
export function exportGroupTemplate(config: GroupConfig): GroupTemplate {
  return groupTemplateSchema.parse({ type: 'delivery-team-template', version: 1, name: config.name,
    members: config.members.map(({ binding: _binding, fallbackBinding: _fallback, ...role }) => role) });
}
/** 只取用户已保存的团队模型；派发前再次核验健康、权限与额度。null 表示关闭备用。 */
export function groupFallbackChoices(member: GroupMember, profiles: TeamProfileConfig): GroupBinding[] {
  if (!member.binding || member.fallbackBinding === null) return [];
  const own = profiles.profiles.find(profile => profile.id === member.id);
  const byId = (id: TeamProfileId) => profiles.profiles.find(profile => profile.id === id);
  const route = profiles.reviewRouting[member.binding.provider as keyof typeof profiles.reviewRouting];
  const candidates = [member.fallbackBinding, ...(member.capability === 'review' ? [route, byId('architect')] : [own?.escalation, byId('engineer')]),
    byId('architect'), byId('leader'), byId('reviewer'), byId('frontend')];
  const used = new Set([JSON.stringify([member.binding.provider, member.binding.model])]);
  return candidates.flatMap(choice => {
    if (!choice) return [];
    const key = JSON.stringify([choice.provider, choice.model]); if (used.has(key)) return []; used.add(key);
    return [{ provider: choice.provider, model: choice.model, reasoningEffort: choice.reasoningEffort, ...(choice.catalogAlias ? { catalogAlias: choice.catalogAlias } : {}) }];
  });
}
/** 允许导入本次交互原型的角色；原型未声明岗位类型，导入时按分析岗位准备。 */
export function importGroupTemplate(value: unknown): GroupTemplate {
  const old = z.object({ type: z.literal('rd-team-template'), version: z.union([z.literal(1), z.literal(2)]), name: z.string(),
    roles: z.array(z.object({ id: memberId, name: z.string(), duty: z.string() })) }).safeParse(value);
  return groupTemplateSchema.parse(old.success ? { type: 'delivery-team-template', version: 1, name: old.data.name,
    members: old.data.roles.map(role => ({ id: role.id, name: role.name, instructions: role.duty, capability: 'read', enabled: true })) } : value);
}
export const groupPresetIds = ['frontend-delivery', 'fullstack-delivery', 'codebase-improve'] as const;
export type GroupPresetId = typeof groupPresetIds[number];
export interface GroupPresetOption {
  id: GroupPresetId;
  label: string;
  teamName: string;
  summary: string;
  roles: [TeamProfileId, string, GroupMember['capability'], string][];
}
export const groupPresetTemplates: Record<GroupPresetId, GroupPresetOption> = {
  'frontend-delivery': {
    id: 'frontend-delivery',
    label: '前端研发团队',
    teamName: '前端研发团队',
    summary: '自包含方案交接 + STOP 熔断 + 隔离验证与防假测审查',
    roles: [
      ['leader', '技术负责人', 'read', '核对需求、项目规范文档（AGENTS.md/ADR/DESIGN.md）和现有实现；需执行改动时提供自包含交接摘要（关键 file:line 依据、仓库示范文件、允许改动与禁改边界、可执行验证命令及 STOP 熔断条件）。普通讨论直接回答，不自行发起开发，不输出密钥明文。'],
      ['frontend', '前端开发', 'write', '按已确认方案与允许范围实现页面、组件、交互和接口接入，对齐示范文件约定，保留无关改动。若遇目标代码与前序摘录严重漂移、单步验证连续两次失败或必须修改范围外文件，立即停止（STOP）并如实报告阻塞，不硬凑绕过。用户仅讨论时不修改代码。'],
      ['verifier', '测试验证', 'verify', '在隔离副本运行真实构建与检查命令，核对退出码与实际输出，区分代码缺陷与环境阻塞，明确通过、失败与未执行项，不修改源码或测试凑通过，不把副本修改合回项目。'],
      ['reviewer', '代码审查', 'review', '独立阅读 diff、相关代码与新增测试断言，核对需求覆盖与范围合规；重点识别空断言/仅测 Mock 等形式化测试及静默越界改动，尊重文档已记录的刻意折中（by-design），问题须给出可定位 file:line 依据，不能仅凭实现者说明认定通过。'],
      ['reporter', '交付整理', 'read', '依据真实结果整理改动摘要、验证证据、残余风险与待处理事项（含已评估暂不处理项及理由，避免后续重复排查），输出中文交接草稿；外部发布由用户明确授权。'],
    ],
  },
  'fullstack-delivery': {
    id: 'fullstack-delivery',
    label: '全栈研发团队',
    teamName: '全栈研发团队',
    summary: '前后端明确文件归属，带基线漂移核对与独立验证审查',
    roles: [
      ['leader', '技术负责人', 'read', '核对需求、接口契约、项目规范文档与现有实现，明确工程与前端各自允许路径及共享契约负责人，给出含 file:line 依据、示范文件、验证门禁和 STOP 熔断条件的自包含交接方案。普通讨论直接回答，不自行发起开发。'],
      ['engineer', '工程实现', 'write', '在允许路径内完成服务端/共享契约实现与必要单测，保持既有工程风格。遇到基线漂移、验证连挂两次或需跨界修改时立即 STOP 汇报阻塞，不硬改范围外文件。'],
      ['frontend', '前端开发', 'write', '按已确认契约与页面规范完成前端实现和联调接入，保留无关改动；遇接口契约冲突或需触碰非归属文件时立即 STOP 汇报阻塞。'],
      ['verifier', '测试验证', 'verify', '在隔离副本执行端到端构建、类型检查与测试门禁，核对前后端契约一致性与真实结果，不把副本修改合回项目。'],
      ['reviewer', '代码审查', 'review', '独立检查需求覆盖、DTO/接口链路、新增测试真实断言与范围合规，拦截空壳测试与未声明偏离，问题附精确 file:line 依据。'],
      ['reporter', '交付整理', 'read', '依据真实证据汇总前后端改动、验证情况、风险与回滚说明，输出中文交接草稿；外部发布由用户明确授权。'],
    ],
  },
  'codebase-improve': {
    id: 'codebase-improve',
    label: '代码体检与重构',
    teamName: '代码体检与重构团队',
    summary: 'Recon 摸底 → 多维证据排查 → Vet 二次复核排优 → 最小重构闭环',
    roles: [
      ['analyst', '代码库摸底', 'read', '先读取 README、AGENTS.md、ADR/DESIGN.md 与构建测试脚本建立验证基线，扫描正确性、安全、性能（N+1/复杂度）、测试缺口与高变动技术债；每条线索须附 file:line 证据，严禁输出任何密钥明文，不修改源码。'],
      ['leader', '顾问复核与排优', 'read', '亲自打开源码核验每条线索（Vet），剔除平台惯例与文档已记录的刻意折中（by-design），按杠杆率（收益÷工时×置信度）排序；用户选定修复项后，输出带现状片段、示范文件、禁改边界、验证门禁与 STOP 熔断条件的自包含改造计划。'],
      ['engineer', '重构执行', 'write', '严格按已确认的自包含计划做最小必要重构并补齐对应单测，每步执行验证命令；遇到代码漂移、验证连败两次或需触碰范围外文件时立即 STOP 汇报，绝不顺手扩改无关模块。用户仅要求体检出报告时不改代码。'],
      ['verifier', '测试验证', 'verify', '在隔离副本完整运行类型检查、测试套件与构建门禁，核对重构前后行为一致性与回归结果，不把副本修改合回项目。'],
      ['reviewer', '代码审查', 'review', '独立审查重构 diff 与新增特征/回归测试的实质断言，拦截范围越界、行为静默改变或形式化测试，附精确 file:line 依据。'],
      ['reporter', '台账与交接整理', 'read', '汇总本次体检结论、已落地重构证据，以及“已评估暂不修改（considered-and-rejected）”清单与一句话理由，输出可复用的中文技术债台账草稿。'],
    ],
  },
};
function profileBinding(profiles: TeamProfileConfig | undefined, id: TeamProfileId): GroupBinding | undefined {
  const profile = profiles?.profiles.find(item => item.id === id);
  return profile ? { provider: profile.provider, model: profile.model, reasoningEffort: profile.reasoningEffort,
    ...(profile.catalogAlias ? { catalogAlias: profile.catalogAlias } : {}) } : undefined;
}
/** 套用内置团队预设时保留成员已配置的个人主模型与备用模型绑定。 */
export function applyGroupPreset(current: Pick<GroupConfig, 'revision' | 'members'>, presetId: GroupPresetId,
  profiles?: TeamProfileConfig, defaultBinding?: GroupBinding): GroupConfig {
  const preset = groupPresetTemplates[presetId];
  const anyExisting = current.members.find(member => member.binding);
  return groupConfigSchema.parse({
    revision: current.revision,
    name: preset.teamName,
    members: preset.roles.map(([id, name, capability, instructions]) => {
      const exact = current.members.find(member => member.id === id);
      const sameCap = current.members.find(member => member.capability === capability && member.binding);
      const binding = exact?.binding || profileBinding(profiles, id) || sameCap?.binding || anyExisting?.binding || defaultBinding;
      const fallbackBinding = exact?.fallbackBinding !== undefined ? exact.fallbackBinding : sameCap?.fallbackBinding;
      return {
        id, name, capability, instructions, enabled: true,
        ...(binding ? { binding: structuredClone(binding) } : {}),
        ...(fallbackBinding !== undefined ? { fallbackBinding: structuredClone(fallbackBinding) } : {}),
      };
    }),
  });
}
export function defaultGroupConfig(profiles: TeamProfileConfig): GroupConfig {
  return applyGroupPreset({ revision: 1, members: [] }, 'frontend-delivery', profiles);
}
const turnSchema = z.object({ id: z.string().uuid(), member: groupMemberSchema, attempt: z.number().int().positive(), runId: z.string().uuid(),
  status: z.enum(['pending', 'queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled']), result: z.string().default(''), error: z.string().default(''),
  workspacePath: z.string().optional(), workspacePaths: z.array(z.string()).optional(), updatedAt: z.string(),
  executionBinding: groupBindingSchema.optional(),
  fallbacks: z.array(z.object({ from: groupBindingSchema, to: groupBindingSchema, reason: z.string().max(12000), runId: z.string(), at: z.string() }).strict()).max(10).optional(),
}).strict();
const automaticInputSchema = z.object({ requestId: z.string(), requestHash: z.string(), text: z.string(), attachmentIds: z.array(z.string()),
  accessMode: z.enum(['workspace', 'full']), processed: z.boolean().default(false) }).strict();
export const groupLoginRequestSchema = z.object({
  reason: z.enum(['login_required', 'session_expired']),
  url: z.url({ protocol: /^https?$/ }).max(500).refine(value => {
    const url = new URL(value);
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !!url.port
      && !url.username && !url.password && !url.search && !url.hash;
  }).optional(),
}).strict();
const roundSchema = z.object({ id: z.string().uuid(), requestId: z.string(), requestHash: z.string(), text: z.string(),
  revisesMessageId: z.string().uuid().optional(),
  rerunsRoundId: z.string().uuid().optional(),
  taskPrompt: z.string().optional(),
  loginHandoff: groupLoginRequestSchema.extend({ turnId: z.uuid(), runId: z.uuid(), answered: z.boolean(), accessMode: z.enum(['workspace', 'full']).optional() }).optional(),
  automatic: z.object({ config: groupConfigSchema, taskId: z.string().uuid().optional(), previousTaskId: z.string().uuid().optional(), error: z.string().optional(), inputs: z.array(automaticInputSchema) }).strict().optional(),
  attachmentIds: z.array(z.string()).default([]), accessMode: z.enum(['workspace', 'full']), configRevision: z.number().int().positive().optional(),
  state: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']), turns: z.array(turnSchema), createdAt: z.string(), updatedAt: z.string(),
}).strict();
export const groupJiraSourceSchema = z.object({ taskId: z.uuid(), workflow: z.enum(['jira', 'requirement']), title: z.string().max(300),
  issueKey: z.string().max(100), issueUrl: z.string().max(2000), requirementPreparation: z.literal(true).optional(),
  requirementTasks: z.array(z.object({
    role: z.enum(['parent', 'design', 'implementation']), key: z.string().max(100), url: z.string().max(2000),
    summary: z.string().max(500), startDate: z.string().max(30), endDate: z.string().max(30),
  }).strict()).max(100).optional(),
  projects: z.array(z.object({ path: z.string().min(1), workspacePath: z.string().min(1), baseBranch: z.string().min(1), branchName: z.string().min(1), baseSha: z.string().min(1) }).strict()).min(1),
}).strict();
export type GroupJiraSource = z.infer<typeof groupJiraSourceSchema>;
export const groupRoomSchema = z.object({ id: z.string().uuid(), title: z.string(), workspacePath: z.string(), workspacePaths: z.array(z.string()).optional(), executionPath: z.string(),
  orchestration: z.literal('automatic').optional(), source: groupJiraSourceSchema.optional(), paused: z.boolean().default(false), cursorTrustPaths: z.array(z.string()).default([]), rounds: z.array(roundSchema), createdAt: z.string(), updatedAt: z.string(),
}).strict();
export const groupStateSchema = z.object({ version: z.literal(1), config: groupConfigSchema, rooms: z.array(groupRoomSchema) }).strict();
export type GroupState = z.infer<typeof groupStateSchema>;
export type GroupRoom = z.infer<typeof groupRoomSchema>;
export type GroupRound = GroupRoom['rounds'][number];
export type GroupTurn = GroupRound['turns'][number];
export interface GroupExecutionProgress {
  roomId: string; state: 'queued' | 'running' | 'paused' | 'failed' | 'completed' | 'cancelled';
  completed: number; total: number; activeMember: string; error: string; waitingForLogin?: true;
}
export interface GroupJiraExecution { groupRoomId: string; groupProgress: GroupExecutionProgress; runId: string; run?: AgentRun; runs: AgentRun[] }
export function groupRunStatus(value: GroupExecutionProgress): AgentRun['status'] { return value.state === 'paused' ? 'interrupted' : value.state; }
export function groupExecutionProgress(room: GroupRoom, runs: AgentRun[]): GroupExecutionProgress {
  const round = room.rounds.find(item => !['completed', 'cancelled'].includes(item.state)) || room.rounds.at(-1);
  const status = (turn: GroupTurn) => { const run = runs.find(run => run.id === turn.runId); return run?.status === 'completed' && run.resultReady === false ? 'running' : run?.status || turn.status; };
  const waitingForLogin = !!round?.loginHandoff && !round.loginHandoff.answered && !['completed', 'cancelled'].includes(round.state);
  const failed = round?.turns.find(turn => ['failed', 'interrupted'].includes(status(turn)));
  const current = (waitingForLogin ? round?.turns.find(turn => turn.id === round.loginHandoff?.turnId) : undefined) || failed || round?.turns.find(turn => ['queued', 'running'].includes(status(turn))) || round?.turns.find(turn => status(turn) === 'pending');
  return { roomId: room.id, ...(waitingForLogin ? { waitingForLogin: true as const } : {}),
    state: round?.state === 'cancelled' ? 'cancelled' : waitingForLogin ? 'paused' : failed || round?.state === 'failed' ? 'failed' : room.paused && round && !['completed', 'cancelled'].includes(round.state) ? 'paused'
    : current ? status(current) === 'running' ? 'running' : 'queued' : round?.state || 'queued',
    completed: round?.turns.filter(turn => status(turn) === 'completed' && (!waitingForLogin || turn.id !== round.loginHandoff?.turnId)).length || 0, total: round?.turns.length || 0, activeMember: current?.member.name || '',
    error: failed ? runs.find(run => run.id === failed.runId)?.error || failed.error : '' };
}
export function groupProgressText(value: GroupExecutionProgress): string {
  const prefix = `${value.completed}/${value.total} 位成员已完成`;
  return value.waitingForLogin ? `${prefix} · 等待你登录测试环境` : value.state === 'completed' ? `${prefix} · 团队本轮已结束，待核验交付结果`
    : value.state === 'failed' ? `${prefix} · ${value.activeMember || '前序成员'}执行失败，处理后继续`
    : value.state === 'paused' ? `${prefix} · 已暂停`
    : value.state === 'cancelled' ? `${prefix} · 已取消`
    : value.state === 'queued' ? `${prefix} · ${value.activeMember || '成员'}等待启动`
    : `${prefix} · ${value.activeMember ? `${value.activeMember}正在处理` : '正在准备执行'}`;
}
export interface GroupRoomDetail { room: GroupRoom; runs: AgentRun[]; collaboration?: { task: TeamTask; runs: AgentRun[] }; collaborations?: { task: TeamTask; runs: AgentRun[] }[] }
export type GroupRoomSummary = Pick<GroupRoom, 'id' | 'title' | 'workspacePath' | 'workspacePaths' | 'paused' | 'createdAt' | 'updatedAt'> & { state: GroupRound['state'] | 'idle'; activeMember?: string; waitingForLogin?: true };
export interface GroupChatDashboard { config: GroupConfig; rooms: GroupRoomSummary[]; fallbackChoices?: Record<string, GroupBinding[]> }
export const groupSendSchema = z.object({ roomId: z.string().uuid().optional(), requestId: z.string().min(1).max(150),
  title: z.string().trim().min(1).max(300).optional(),
  text: z.string().trim().min(1).max(200000), expectedConfigRevision: z.number().int().positive().optional(), memberIds: z.array(memberId).optional(), workspacePath: z.string().max(2000).optional(), workspacePaths: z.array(z.string().max(2000)).max(10).optional(),
  cursorTrustPath: z.string().max(2000).optional(), attachmentIds: z.array(z.string().max(100)).max(6).default([]), accessMode: z.enum(['workspace', 'full']).default('full'),
}).strict();
export type GroupSendInput = z.input<typeof groupSendSchema>;
export const groupRerunSchema = z.object({ requestId: z.string().min(1).max(150), roundId: z.string().uuid(), accessMode: z.enum(['workspace', 'full']).optional() }).strict();
export type GroupRerunInput = z.infer<typeof groupRerunSchema>;
export const groupActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['pause', 'cancel']) }).strict(),
  z.object({ action: z.literal('continue'), accessMode: z.enum(['workspace', 'full']).optional() }).strict(),
  groupRerunSchema.extend({ action: z.literal('rerun') }).strict(),
]);
export type GroupActionInput = z.infer<typeof groupActionSchema>;
export const groupReviseSchema = z.object({ requestId: z.string().min(1).max(150), text: z.string().trim().min(1).max(200000), accessMode: z.enum(['workspace', 'full']).optional() }).strict();
export type GroupReviseInput = z.infer<typeof groupReviseSchema>;
export const groupSteerSchema = z.object({ messageId: z.string().uuid().optional(), requestId: z.string().min(1).max(150).optional(), accessMode: z.enum(['workspace', 'full']).optional() }).strict()
  .refine(input => Number(input.messageId !== undefined) + Number(input.requestId !== undefined) === 1, '请指定一条待处理消息');
export type GroupSteerInput = z.infer<typeof groupSteerSchema>;

/** 自动协作将固定阶段映射到本轮已启用成员；缺岗在派发时准确阻塞。 */
export function groupTeamMembers(config: GroupConfig): Partial<Record<TeamProfileId, GroupMember>> {
  const enabled = config.members.filter(member => member.enabled);
  const result: Partial<Record<TeamProfileId, GroupMember>> = {};
  const capabilities: Record<TeamProfileId, GroupMember['capability']> = { leader: 'read', analyst: 'read', architect: 'read',
    engineer: 'write', frontend: 'write', batch: 'write', verifier: 'verify', reviewer: 'review', reporter: 'read', second_opinion: 'review' };
  for (const [role, capability] of Object.entries(capabilities) as [TeamProfileId, GroupMember['capability']][]) {
    const member = enabled.find(member => member.id === role && member.capability === capability)
      || (role === 'frontend' ? enabled.filter(member => member.capability === capability)[1] : undefined)
      || enabled.find(member => member.capability === capability);
    if (member) result[role] = groupMemberSchema.parse(member);
  }
  return result;
}

/** 按字符预算从尾部逆序保留完整数组元素，确保截断后始终是合法 JSON 数组，避免截断引号或转义符。 */
export function packJsonTail<T>(items: readonly T[], maxChars: number, compactItem?: (item: T, maxItemChars: number) => T): string {
  if (!items.length || maxChars <= 2) return '[]';
  const full = JSON.stringify(items);
  if (full.length <= maxChars) return full;
  const kept: string[] = [];
  let used = 2;
  const softItemBudget = Math.max(256, Math.floor((maxChars - 2) * 0.5));
  for (let index = items.length - 1; index >= 0; index--) {
    const raw = items[index]!;
    let serialized = JSON.stringify(raw);
    if (compactItem && (serialized.length > softItemBudget || used + serialized.length + (kept.length ? 1 : 0) > maxChars)) {
      const remaining = Math.max(64, maxChars - used - (kept.length ? 1 : 0));
      serialized = JSON.stringify(compactItem(raw, remaining));
    }
    const added = serialized.length + (kept.length ? 1 : 0);
    if (used + added <= maxChars) {
      kept.push(serialized);
      used += added;
    } else {
      break;
    }
  }
  return `[${kept.reverse().join(',')}]`;
}
