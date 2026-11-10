import type { AgentProvider, AgentReasoningEffort, AgentRuntimeHealth } from '../../../shared/agent-runtime';
import { defaultTeamProfileConfig, type TeamModelChoice, type TeamProfileConfig, type TeamProfileId, type TeamRoleProfile } from '../../../shared/agent-team';
import { modelSelectionChoice, modelSelectionEffort } from './model-selection';

export type TeamProvider = TeamModelChoice['provider'];

export interface TeamRoleSettingGuide {
  id: TeamProfileId;
  group: 'core' | 'extended';
  stageTag: string;
  permissionTag: string;
  summary: string;
  supportsEscalation: boolean;
}

export const teamEffortLabels: Record<Exclude<TeamModelChoice['reasoningEffort'], ''>, string> = {
  low: '低 (low)',
  medium: '中 (medium)',
  high: '高 (high)',
  xhigh: '极高 (xhigh)',
  max: '极高 (max)',
  ultra: '最高 (ultra)',
};

/** 简洁模式下的推理强度短标签。 */
export const teamEffortShortLabels: Record<AgentReasoningEffort, string> = {
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '极高',
  ultra: '最高',
};

/** 团队各角色简明职责说明。 */
export const teamRoleShortHints: Record<TeamProfileId, string> = {
  leader: '任务拆解 · 制定计划与验收标准',
  engineer: '后端及通用工程实现 · 单元自测',
  frontend: '前端界面 · 组件与交互开发',
  verifier: '隔离副本运行构建与测试',
  reviewer: '独立审查代码与验收标准',
  analyst: '复杂需求梳理 · 事实与产品缺口',
  architect: '模块划分 · 契约与任务拆解',
  batch: '规则批量变换与文件替换',
  reporter: '验收后汇总证据生成交付文稿',
  second_opinion: '独立第二意见 · 不改变流程结论',
};

/** 简洁模式「参与的 AI」：每家擅长什么，组队时据此分工。 */
export const teamProviderStrengths: { provider: TeamProvider; hint: string }[] = [
  { provider: 'codex', hint: '计划 · 后端 · 验证 · 架构' },
  { provider: 'cursor', hint: '独立审查 · 批量' },
  { provider: 'antigravity', hint: '前端 · 需求研究 · 交付整理 · 第二意见' },
  { provider: 'kiro', hint: '备用（仅有中级模型）' },
  { provider: 'claude', hint: '备用' },
];

export const teamProviderLabels: Record<AgentProvider, string> & Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude',
  cursor: 'Cursor',
  kiro: 'Kiro',
  antigravity: 'Antigravity',
  api: 'API',
  deepseek: 'DeepSeek',
  workbuddy: 'WorkBuddy',
  grok: 'Grok',
};

export const teamRoleSettingGuides: Record<TeamProfileId, TeamRoleSettingGuide> = {
  leader: {
    id: 'leader',
    group: 'core',
    stageTag: '主流程 · 拆解计划',
    permissionTag: '完全访问',
    summary: '制定任务计划、拆解实施步骤、生成独立验收条目，并协调各岗位执行。',
    supportsEscalation: false,
  },
  analyst: {
    id: 'analyst',
    group: 'extended',
    stageTag: '按需 · 需求研究',
    permissionTag: '完全访问',
    summary: '在计划前梳理已有事实、上下文边界与用户诉求，供 Leader 参考。',
    supportsEscalation: true,
  },
  architect: {
    id: 'architect',
    group: 'extended',
    stageTag: '按需 · 架构设计',
    permissionTag: '完全访问',
    summary: '高风险或跨模块任务中梳理依赖契约与模块边界，避免实现推倒重来。',
    supportsEscalation: false,
  },
  engineer: {
    id: 'engineer',
    group: 'core',
    stageTag: '主流程 · 通用/后端实现',
    permissionTag: '完全访问',
    summary: '负责后端逻辑、接口、基础设施与通用业务代码编写，自测通过后提交验证。',
    supportsEscalation: true,
  },
  frontend: {
    id: 'frontend',
    group: 'core',
    stageTag: '主流程 · 前端实现',
    permissionTag: '完全访问',
    summary: '专注界面组件、样式、交互及前端工程改造，保持视觉与用户体验一致。',
    supportsEscalation: true,
  },
  verifier: {
    id: 'verifier',
    group: 'core',
    stageTag: '主流程 · 独立验证',
    permissionTag: '完全访问',
    summary: '在完全隔离的工作区副本运行构建、类型检查与单测，不受实现者上下文污染。',
    supportsEscalation: false,
  },
  reviewer: {
    id: 'reviewer',
    group: 'core',
    stageTag: '主流程 · 独立审查',
    permissionTag: '完全访问',
    summary: '核对代码差异与验收标准，执行跨执行器独立复核，发现死角与潜在退化。',
    supportsEscalation: false,
  },
  batch: {
    id: 'batch',
    group: 'extended',
    stageTag: '按需 · 批量处理',
    permissionTag: '完全访问',
    summary: '处理大批量机械替换、规则性迁移与样式刷库，提高并发吞吐。',
    supportsEscalation: false,
  },
  reporter: {
    id: 'reporter',
    group: 'extended',
    stageTag: '按需 · 交付报告',
    permissionTag: '完全访问',
    summary: '任务完成后自动汇总改动日志、验证证据与验收条目，生成交付文稿。',
    supportsEscalation: false,
  },
  second_opinion: {
    id: 'second_opinion',
    group: 'extended',
    stageTag: '按需 · 第二意见',
    permissionTag: '完全访问',
    summary: '用户随时可主动发起的第三方独立评估，提供外部视角且不改变流程状态。',
    supportsEscalation: false,
  },
};

export const coreTeamProfileIds: TeamProfileId[] = ['leader', 'engineer', 'frontend', 'verifier', 'reviewer'];
export const extendedTeamProfileIds: TeamProfileId[] = ['analyst', 'architect', 'batch', 'reporter', 'second_opinion'];
export const reviewRouteTargets: { provider: Exclude<TeamProvider, 'codex'>; label: string }[] = [
  { provider: 'cursor', label: 'Cursor 产出的代码' },
  { provider: 'claude', label: 'Claude 产出的代码' },
  { provider: 'kiro', label: 'Kiro 产出的代码' },
  { provider: 'antigravity', label: 'Antigravity 产出的代码' },
];

const claudeAliases: Record<string, { id: string; label: string }> = {
  'claude-sonnet-5-5': { id: 'sonnet', label: 'Sonnet 5.5' },
  'claude-opus-5-5': { id: 'opus', label: 'Opus 5.5' },
  'claude-haiku-5-5': { id: 'haiku', label: 'Haiku 5.5' },
  'claude-fable-5-1': { id: 'fable', label: 'Fable 5.1' },
};

export function allowedEffortsForModel(
  runtimes: AgentRuntimeHealth[],
  provider: AgentProvider | TeamProvider,
  model: string,
): Exclude<TeamModelChoice['reasoningEffort'], ''>[] {
  if (provider === 'cursor' || (provider as string) === 'api') return [];
  const runtime = runtimes.find(item => item.provider === provider);
  const option = runtime?.models.find(item => item.id === model);
  const known = defaultTeamProfileConfig().profiles.find(item => item.provider === provider && item.model === model)?.catalogAlias
    || (provider === 'claude' ? claudeAliases[model] : undefined);
  const actual = option || (known ? runtime?.models.find(item => item.id === known.id && item.label === known.label) : undefined);
  const list = actual?.efforts || [];
  if (actual) return list;
  if (provider === 'codex') return ['low', 'medium', 'high', 'xhigh'];
  if (provider === 'claude') return ['low', 'medium', 'high'];
  return [];
}

/** 岗位保存原始模型 ID，配置页与只读名单共用模型、强度的展示投影。 */
export function teamModelPresentation(runtimes: AgentRuntimeHealth[], choice: TeamModelChoice) {
  const runtime = runtimes.find(item => item.provider === choice.provider);
  const alias = choice.catalogAlias;
  const model = !runtime?.models.some(item => item.id === choice.model)
    && alias && runtime?.models.some(item => item.id === alias.id && item.label === alias.label) ? alias.id : choice.model;
  const selection = modelSelectionChoice(runtime, model);
  return { runtime, model, id: selection?.id || model, label: selection?.label || alias?.label || model,
    effort: modelSelectionEffort(runtime, model, choice.reasoningEffort),
    efforts: selection?.embedded ? selection.efforts : allowedEffortsForModel(runtimes, choice.provider, choice.model),
    embedded: !!selection?.embedded, allowDefaultEffort: !!selection?.embedded && selection.variants.some(item => !item.effort) };
}

export function buildModelChoice(
  runtimes: AgentRuntimeHealth[],
  provider: AgentProvider | TeamProvider,
  preferredModel?: string,
  preferredEffort?: TeamModelChoice['reasoningEffort'],
): TeamModelChoice {
  const safeProvider: TeamProvider = ((provider as string) === 'api' ? 'codex' : provider) as TeamProvider;
  const runtime = runtimes.find(item => item.provider === safeProvider);
  const catalog = (runtime?.models || []).filter(item => item.id);
  const defaults = defaultTeamProfileConfig().profiles.filter(item => item.provider === safeProvider);
  let model = preferredModel && (catalog.some(item => item.id === preferredModel) || defaults.some(item => item.model === preferredModel))
    ? preferredModel
    : catalog[0]?.id || defaults[0]?.model || (safeProvider === 'codex' ? 'gpt-6.1-sol' : safeProvider === 'cursor' ? 'composer-2.5' : 'claude-sonnet-5-5');
  const alias = defaults.find(item => item.model === model)?.catalogAlias || (safeProvider === 'claude' ? claudeAliases[model] : undefined);
  if (safeProvider === 'claude' && alias && catalog.some(item => item.id === alias.id && item.label === alias.label)) {
    // Keep canonical model name with catalogAlias when runtime exposes short alias
  } else if (catalog.length && !catalog.some(item => item.id === model)) {
    model = catalog[0].id;
  }
  const allowed = allowedEffortsForModel(runtimes, safeProvider, model);
  const reasoningEffort: TeamModelChoice['reasoningEffort'] = safeProvider === 'cursor' || !allowed.length
    ? ''
    : preferredEffort && allowed.includes(preferredEffort)
      ? preferredEffort
      : allowed.includes('high')
        ? 'high'
        : allowed[0];
  return {
    provider: safeProvider,
    model,
    reasoningEffort,
    ...(alias && catalog.some(item => item.id === alias.id && item.label === alias.label) ? { catalogAlias: { ...alias } } : {}),
  };
}

export type TeamProfilePresetId = 'codex_cursor' | 'default_balanced' | 'auto_ready';

type Effort = TeamModelChoice['reasoningEffort'];
type ModelTier = 'primary' | 'strong' | 'light' | 'research';
type RoleSlot = [TeamProvider, ModelTier, Effort?];

/** 各执行器按档位的候选模型（按顺序取本机目录中第一个存在的）。 */
const providerModelTiers: Record<TeamProvider, Partial<Record<ModelTier, string[]>>> = {
  codex: { primary: ['gpt-6.1-sol', 'gpt-6-sol'], strong: ['gpt-6-astra', 'gpt-6.1-sol'], light: ['gpt-6.1-sol', 'gpt-6-sol'] },
  cursor: { primary: ['claude-opus-5-5-high', 'gpt-5.6-sol-high', 'composer-2.5'], strong: ['claude-opus-5-5-high', 'gpt-5.6-sol-high', 'composer-2.5'], research: ['claude-opus-5-5-high', 'grok-4.7-high'] },
  antigravity: { primary: ['gemini-4-argon-high'], strong: ['gemini-4-argon-high'], light: ['gemini-4-argon-high'] },
  kiro: { primary: ['claude-sonnet-4.5', 'auto'], light: ['claude-sonnet-4.5', 'auto'] },
  claude: { primary: ['opus', 'sonnet', 'default'], strong: ['opus', 'sonnet', 'default'], light: ['opus', 'sonnet', 'default'] },
};

/** 指定模型的岗位候选：[执行器, 模型 ID, 推理强度]。 */
type ModelSlot = [TeamProvider, string, Effort];

/** 推荐组合筛选使用的中级与轻量模型标记；用户可在岗位设置中自行选择。 */
export function isMediumTierModel(model: { id: string; label?: string }) {
  return /-(?:medium|low)(?:-fast)?$/i.test(model.id)
    || /\((?:medium|low)\)/i.test(model.label || '')
    || /(?:^|-)(?:haiku|flash|luna)(?:-|$)/i.test(model.id)
    || /^(?:composer-|claude-sonnet-4|gpt-5\.[23]|gpt-oss|minimax|glm|qwen|deepseek)/i.test(model.id);
}

const codexSol: ModelSlot = ['codex', 'gpt-6.1-sol', 'high'];
const codexAstra: ModelSlot = ['codex', 'gpt-6-astra', 'high'];
const cursorOpus: ModelSlot = ['cursor', 'claude-opus-5-5-high', ''];
const argonHigh: ModelSlot = ['antigravity', 'gemini-4-argon-high', ''];

/**
 * 推荐分工：每个岗位按顺序取第一个「已勾选且本机目录中存在」的模型。
 * 只使用旗舰档模型（Codex Sol/Astra、Cursor Claude Opus 5.5、Antigravity Gemini 4 Argon High），推理强度统一为 high；
 * 不使用中级或轻量模型（composer-2.5、Kiro 的 Sonnet/Haiku 4.5、Luna、Flash、各类 Medium/Low 变体）。
 * 依据 2026-11-02 本机额度与 277 次历史运行：
 * - Codex（ProLite 周额度剩 67%，完成率 97%）：只承担最核心的总协调、工程实现、验证、架构（4 岗）；
 * - Antigravity（Google AI Ultra，Gemini 周额度剩 82% / 5 小时剩 92%，Argon High 19/21 完成且 0 失败）：
 *   承担前端实现、需求研究、交付整理、第二意见（4 岗）；注意 Antigravity 内的第三方 Claude/GPT 周额度已为 0%，故绝不选用 agy 的 Claude；
 * - Cursor（Team 月额度剩 99%）：用 Claude Opus 5.5 High 承担独立审查与批量编码（2 岗），并作为前端与需求研究的返工升级模型；
 * - Kiro 只有中级模型、Claude Code 订阅被组织禁用，均不进入推荐。
 */
const recommendedRolePlan: Record<TeamProfileId, ModelSlot[]> = {
  leader: [codexSol, cursorOpus, argonHigh],
  analyst: [argonHigh, cursorOpus, codexSol],
  architect: [codexAstra, cursorOpus, argonHigh],
  engineer: [codexSol, cursorOpus, argonHigh],
  frontend: [argonHigh, cursorOpus, codexSol],
  verifier: [codexSol, cursorOpus, argonHigh],
  reviewer: [cursorOpus, codexAstra, argonHigh],
  batch: [cursorOpus, codexSol, argonHigh],
  reporter: [argonHigh, cursorOpus, codexSol],
  second_opinion: [argonHigh, cursorOpus, codexAstra],
};
/** 返工升级：取第一个可用且与岗位当前模型不同的候选。 */
const recommendedEscalation: Partial<Record<TeamProfileId, ModelSlot[]>> = {
  engineer: [codexAstra, cursorOpus],
  frontend: [cursorOpus, codexAstra],
  analyst: [cursorOpus, codexAstra],
};
/** 审查者所在执行器自己产出的代码，改由这里第一个可用的其他执行器审查（与 syncReviewer 的顺序一致）。 */
const crossReviewFallback: ModelSlot[] = [codexAstra, cursorOpus, argonHigh];

function pickTierChoice(runtimes: AgentRuntimeHealth[], [provider, tier, effort = 'high']: RoleSlot): TeamModelChoice {
  const tiers = providerModelTiers[provider];
  const candidates = tiers[tier] || tiers.primary || [];
  const catalog = (runtimes.find(item => item.provider === provider)?.models || []).filter(item => item.id);
  const model = candidates.find(id => catalog.some(item => item.id === id)) || catalog[0]?.id || candidates[0];
  if (catalog.some(item => item.id === model)) return buildModelChoice(runtimes, provider, model, effort);
  return { provider, model, reasoningEffort: provider === 'codex' ? effort || 'high' : provider === 'claude' ? effort : '' };
}

function catalogOf(runtimes: AgentRuntimeHealth[], provider: TeamProvider) {
  return (runtimes.find(item => item.provider === provider)?.models || []).filter(item => item.id);
}

/** 目录未加载时只看是否勾选；目录已加载时还要求模型存在。 */
function slotAvailable(runtimes: AgentRuntimeHealth[], selected: Set<TeamProvider>, [provider, model]: ModelSlot) {
  if (!selected.has(provider)) return false;
  const catalog = catalogOf(runtimes, provider);
  return !catalog.length || catalog.some(item => item.id === model);
}

function slotChoice(runtimes: AgentRuntimeHealth[], [provider, model, effort]: ModelSlot): TeamModelChoice {
  if (catalogOf(runtimes, provider).some(item => item.id === model)) return buildModelChoice(runtimes, provider, model, effort);
  return { provider, model, reasoningEffort: provider === 'codex' ? effort || 'high' : provider === 'cursor' ? '' : effort };
}

/** 当前配置里实际用到的执行器（只看岗位，不看审查兜底路由）。 */
export function teamProvidersInUse(config: TeamProfileConfig): TeamProvider[] {
  const used = new Set(config.profiles.map(item => item.provider));
  return (Object.keys(teamProviderLabels) as TeamProvider[]).filter(provider => used.has(provider));
}

/** 用勾选的几个 AI 组队：每个岗位按推荐顺序取可用模型，审查者自家产出的代码交给另一家审查。 */
export function composeMixedTeam(current: TeamProfileConfig, providers: (TeamProvider | AgentProvider)[], runtimes: AgentRuntimeHealth[]): TeamProfileConfig {
  const base = defaultTeamProfileConfig();
  base.revision = current.revision;
  base.options = JSON.parse(JSON.stringify(current.options));
  const cleanProviders = providers.filter((p): p is TeamProvider => (p as string) !== 'api');
  const selected = new Set<TeamProvider>(cleanProviders.length ? cleanProviders : ['codex']);
  const same = (a: TeamModelChoice, b: TeamModelChoice) => a.provider === b.provider && a.model === b.model;
  const pick = (slots: ModelSlot[], differentFrom?: TeamModelChoice) => {
    for (const slot of slots) {
      if (!slotAvailable(runtimes, selected, slot)) continue;
      const choice = slotChoice(runtimes, slot);
      if (!differentFrom || !same(choice, differentFrom)) return choice;
    }
    return undefined;
  };
  const fallbackProvider = [...selected][0];
  for (const profile of base.profiles) {
    // 推荐列表里没有任何已勾选的执行器时，退回该执行器的主力档位。
    const choice = pick(recommendedRolePlan[profile.id]) || pickTierChoice(runtimes, [fallbackProvider,
      profile.id === 'architect' || profile.id === 'reviewer' ? 'strong' : 'primary', 'high']);
    profile.provider = choice.provider;
    profile.model = choice.model;
    profile.reasoningEffort = choice.reasoningEffort;
    if (choice.catalogAlias) profile.catalogAlias = { ...choice.catalogAlias };
    else delete profile.catalogAlias;
    delete profile.escalation;
    const escalation = recommendedEscalation[profile.id];
    const upgrade = escalation ? pick(escalation, choice) : undefined;
    if (upgrade) profile.escalation = upgrade;
  }
  const reviewer = base.profiles.find(item => item.id === 'reviewer')!;
  const reviewerChoice: TeamModelChoice = { provider: reviewer.provider, model: reviewer.model, reasoningEffort: reviewer.reasoningEffort,
    ...(reviewer.catalogAlias ? { catalogAlias: { ...reviewer.catalogAlias } } : {}) };
  const otherSlots = crossReviewFallback.filter(slot => slot[0] !== reviewer.provider);
  const readySet = new Set(runtimes.filter(item => item.ready).map(item => item.provider));
  const crossChoice = pick(otherSlots)
    || slotChoice(runtimes, otherSlots.find(slot => readySet.has(slot[0])) || otherSlots[0]);
  const route = (author: TeamProvider) => (reviewer.provider === author ? crossChoice : reviewerChoice);
  base.reviewRouting = {
    codex: reviewerChoice,
    cursor: route('cursor'),
    claude: route('claude'),
    kiro: route('kiro'),
    antigravity: route('antigravity'),
  };
  return base;
}

export function applyTeamProfilePreset(
  presetOrConfig: TeamProfilePresetId | TeamProfileConfig,
  configOrPreset: TeamProfileConfig | TeamProfilePresetId,
  runtimes: AgentRuntimeHealth[],
): TeamProfileConfig {
  const preset: TeamProfilePresetId = typeof presetOrConfig === 'string' ? presetOrConfig : configOrPreset as TeamProfilePresetId;
  const current: TeamProfileConfig = typeof presetOrConfig === 'string' ? configOrPreset as TeamProfileConfig : presetOrConfig;

  if (preset === 'default_balanced') {
    const base = defaultTeamProfileConfig();
    return { ...base, revision: current.revision, options: JSON.parse(JSON.stringify(current.options)) };
  }

  if (preset === 'codex_cursor') {
    return composeMixedTeam(current, ['codex', 'cursor'], runtimes);
  }

  if (preset === 'auto_ready') {
    const ready = runtimes.filter(item => item.ready).map(item => item.provider).filter((provider): provider is TeamProvider => (provider as string) !== 'api');
    return composeMixedTeam(current, ready, runtimes);
  }

  return current;
}
