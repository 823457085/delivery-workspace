/** CLI 自报用量；未知值保留 null，缓存 token 已包含在输入中，不重复相加。 */
import type { AgentProvider, AgentUsageCredits, AgentUsageLimits } from './agent-runtime.js';

export interface AgentModelUsage {
  model: string;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
}
export interface AgentUsage {
  source: string;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
  costSource: 'claude_code_self_reported' | null;
  models: AgentModelUsage[] | null;
}
export interface AgentUsageRunRecord {
  runId: string; workflowId?: string; profileId?: string;
  provider: AgentProvider; model: string; createdAt: string; completedAt?: string;
  round?: number; usage: AgentUsage;
}
export interface AgentUsageGroup {
  key: string; runs: number; unknownRuns: number;
  inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null;
  reasoningTokens: number | null; costUsd: number | null;
  averageTokens: number | null; averageRounds: number;
}
export interface AgentUsageSummary {
  days: number; from: string; to: string; total: AgentUsageGroup;
  byDate: AgentUsageGroup[]; byWorkflow: AgentUsageGroup[];
  byProfile: AgentUsageGroup[]; byProvider: AgentUsageGroup[]; byModel: AgentUsageGroup[];
}
export function emptyAgentUsage(provider: AgentProvider): AgentUsage {
  return { source: provider, inputTokens: null, cachedInputTokens: null, outputTokens: null,
    reasoningTokens: null, costUsd: null, costSource: null, models: null };
}
export function usageTokenCount(usage: AgentUsage): number | null {
  return usage.inputTokens === null || usage.outputTokens === null ? null : usage.inputTokens + usage.outputTokens;
}
export interface AgentUsageGate {
  allowed: boolean; state: 'ready' | 'unknown' | 'token_limit' | 'quota_low' | 'upgrade_limit';
  reason: string; fallbackProvider?: 'codex';
}
/** 套餐窗口耗尽但账户仍有可用 Credits（额度）时，允许自动切到额度继续使用。 */
export function hasAvailableUsageCredits(usage?: AgentUsageLimits): boolean {
  const credits: AgentUsageCredits | undefined = usage?.available ? usage.credits : undefined;
  if (!credits) return false;
  if (credits.unlimited) return true;
  if (!credits.hasCredits) return false;
  return credits.balance === null || (Number.isFinite(credits.balance) && credits.balance > 0);
}
export function usageCreditsCount(usage?: AgentUsageLimits): number | null {
  const balance = usage?.credits?.balance;
  if (typeof balance !== 'number' || !Number.isFinite(balance) || balance < 0) return null;
  return Math.max(0, Math.ceil(balance));
}
/** 多个窗口同时约束额度，按最紧的窗口展示；窗口用尽但仍有可用 Credits 时自动切到额度，读取不到时保留未知。 */
export function agentQuotaState(usage?: AgentUsageLimits) {
  if (usage?.stale) return { state: 'unknown' as const, remainingPercent: null };
  const windows = [usage?.primary, usage?.secondary].filter(window => !!window && Number.isFinite(window.remainingPercent));
  const creditsAvailable = hasAvailableUsageCredits(usage);
  if (!usage?.available || (!windows.length && !creditsAvailable)) return { state: 'unknown' as const, remainingPercent: null };
  if (!windows.length) return { state: 'available' as const, remainingPercent: null, usingCredits: true as const };
  const exhausted = windows.some(window => window!.remainingPercent <= 0 || window!.usedPercent >= 100);
  const remainingPercent = Math.min(...windows.map(window => window!.remainingPercent));
  if (exhausted && creditsAvailable) return { state: 'available' as const, remainingPercent, usingCredits: true as const };
  return { state: exhausted ? 'exhausted' as const : 'available' as const, remainingPercent };
}
/** 只限制下一次派发，不中断已运行任务。Claude 不足时显式提示调用方可按授权切 Codex。 */
export function evaluateUsageGate(input: {
  provider: AgentProvider; usageLimit?: number | null; workflowTokens?: number | null;
  usageLimits?: AgentUsageLimits; upgrades?: number; requestingUpgrade?: boolean;
}): AgentUsageGate {
  const quota = agentQuotaState(input.usageLimits);
  if (quota.state === 'exhausted') return {
    allowed: false, state: 'quota_low', reason: '模型服务额度已用尽，等待额度恢复或切换可用服务',
    ...(input.provider === 'claude' ? { fallbackProvider: 'codex' as const } : {}) };
  if (quota.state === 'unknown') return {
    allowed: true, state: 'unknown', reason: '额度或用量未知，未据此阻止派发' };
  return { allowed: true, state: 'ready', reason: '' };
}
