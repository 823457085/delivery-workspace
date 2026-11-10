/**
 * 设计说明：团队流程的岗位、模型与审查路由集中在此处，执行器、模型、权限与岗位职责分开配置。
 * 所有岗位使用 Agent 完全访问；审查按既有独立路由执行，权限与岗位分工分开。
 * 依据见 docs/multi-agent-roadmap-20261026.md §3（含 2026-10-26 完整模型 ID 实测）。
 */
import type { AgentProfileId, AgentProvider, AgentReasoningEffort, AgentRunMode, AgentTaskRole, AgentTeamTemplateId } from './agent-runtime.js';

export interface AgentModelChoice {
  provider: AgentProvider;
  model: string;
  reasoningEffort: AgentReasoningEffort;
  /** 运行器目录只列出别名时，按别名与标签核对后仍以完整 ID 调用。 */
  catalogAlias?: { id: string; label: string };
}

export interface AgentRoleProfile extends AgentModelChoice {
  id: AgentProfileId;
  label: string;
  taskRole: Exclude<AgentTaskRole, 'main'>;
  mode: AgentRunMode;
  escalation?: AgentModelChoice;
}

const opus: AgentModelChoice = { provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'high',
  catalogAlias: { id: 'opus', label: 'Opus 5.5' } };
const astra: AgentModelChoice = { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high' };

export const agentRoleProfiles: Record<AgentProfileId, AgentRoleProfile> = {
  engineer: { id: 'engineer', label: '工程实现', taskRole: 'worker', mode: 'agent',
    provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high', escalation: astra },
  frontend: { id: 'frontend', label: '前端实现', taskRole: 'worker', mode: 'agent',
    provider: 'claude', model: 'claude-sonnet-5-5', reasoningEffort: 'high', catalogAlias: { id: 'sonnet', label: 'Sonnet 5.5' },
    escalation: opus },
  verifier: { id: 'verifier', label: '验证', taskRole: 'verifier', mode: 'agent',
    provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'medium' },
  // 审查的执行器和模型由实现者决定，见 reviewChoiceFor；此处为 Codex 实现时的默认值。
  reviewer: { id: 'reviewer', label: '审查', taskRole: 'reviewer', mode: 'agent', ...opus },
};

/** 实现者执行器 → 审查模型；同家族自审不被允许。 */
export const agentReviewRouting: Record<AgentProvider, AgentModelChoice> = { codex: opus, cursor: opus, claude: astra, kiro: astra, antigravity: astra, api: astra, deepseek: astra, workbuddy: astra, grok: astra };

export function reviewChoiceFor(authorProvider: AgentProvider): AgentModelChoice {
  const choice = agentReviewRouting[authorProvider];
  if (!choice || choice.provider === authorProvider) throw new Error('审查路由不能与实现者使用同一执行器');
  return choice;
}

/**
 * Claude 不可用（未就绪或额度用尽）时，团队流程改用 Codex 继续。
 * 审查此时与 Codex 实现同属一家，至少换用与实现者不同的模型，并在流程中标明“同家族审查”。
 */
export const claudeFallbackModels: Record<string, string> = { 'claude-sonnet-5-5': 'gpt-6.1-sol', 'claude-opus-5-5': 'gpt-6-astra' };

export function codexFallbackFor(choice: AgentModelChoice, avoidModels: string[] = []): AgentModelChoice {
  const preferred = claudeFallbackModels[choice.model] || 'gpt-6.1-sol';
  const model = [preferred, 'gpt-6-astra', 'gpt-6.1-sol'].find(item => !avoidModels.includes(item));
  if (!model) throw new Error('没有可用的 Codex 审查模型能避开实现模型，请调整岗位配置后重试');
  return { provider: 'codex', model, reasoningEffort: 'high' };
}

export interface AgentTeamTemplate {
  id: AgentTeamTemplateId;
  label: string;
  implementer: Extract<AgentProfileId, 'engineer' | 'frontend'>;
  defaultMaxRounds: number | null;
}

export const agentTeamTemplates: Record<AgentTeamTemplateId, AgentTeamTemplate> = {
  engineering: { id: 'engineering', label: '工程修复', implementer: 'engineer', defaultMaxRounds: null },
  frontend: { id: 'frontend', label: '前端页面', implementer: 'frontend', defaultMaxRounds: null },
};

export function agentModelLabel(choice: Pick<AgentModelChoice, 'provider' | 'model' | 'reasoningEffort'>) {
  const provider = choice.provider === 'codex' ? 'Codex' : choice.provider === 'claude' ? 'Claude' : choice.provider === 'kiro' ? 'Kiro' : choice.provider === 'antigravity' ? 'Antigravity' : 'Cursor';
  return `${provider} · ${choice.model}${choice.reasoningEffort ? ` · ${choice.reasoningEffort}` : ''}`;
}

/** 启动面板展示的本流程岗位与模型，不随输入框模型选择变化。 */
export function teamTemplateLineup(templateId: AgentTeamTemplateId) {
  const implementer = agentRoleProfiles[agentTeamTemplates[templateId].implementer];
  const reviewer = reviewChoiceFor(implementer.provider);
  return [
    { label: implementer.label, choice: implementer },
    { label: agentRoleProfiles.verifier.label, choice: agentRoleProfiles.verifier },
    { label: agentRoleProfiles.reviewer.label, choice: reviewer },
  ];
}
