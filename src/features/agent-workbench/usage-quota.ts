import type { AgentUsageLimits, AntigravityUsageBucket, AntigravityUsageLimits } from '../../../shared/agent-runtime';
import { agentQuotaState, hasAvailableUsageCredits, usageCreditsCount } from '../../../shared/agent-usage';

export function quotaPercent(value: number) { return value > 0 && value < .1 ? '<0.1%' : `${Number(value.toFixed(1))}%`; }
export function quotaWindow(minutes: number | null) {
  return !minutes ? '当前窗口' : minutes % 1440 === 0 ? `${minutes / 1440} 天窗口` : minutes % 60 === 0 ? `${minutes / 60} 小时窗口` : `${minutes} 分钟窗口`;
}
export function quotaReset(timestamp: number | null) {
  const date = timestamp ? new Date(timestamp * 1000) : undefined;
  return date && Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date) : '未提供';
}
export function quotaCreditsLabel(usage?: AgentUsageLimits) {
  if (!hasAvailableUsageCredits(usage)) return '';
  const prefix = usage?.stale ? '上次额度' : '额度';
  if (usage?.credits?.unlimited) return `${prefix}不限`;
  const count = usageCreditsCount(usage);
  return count !== null ? `${prefix} ${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(count)}` : `${prefix}可用`;
}
export function quotaLabel(usage?: AgentUsageLimits) {
  if (usage?.stale) {
    const windows = [usage.primary, usage.secondary].filter(window => !!window && Number.isFinite(window.remainingPercent));
    if (windows.length) return `上次剩余 ${quotaPercent(Math.min(...windows.map(window => window!.remainingPercent)))}`;
    return quotaCreditsLabel(usage) || '额度未知';
  }
  const value = agentQuotaState(usage);
  if (value.state === 'unknown') return usage?.errorKind ? { authentication: '登录待确认', timeout: '读取超时', network: '连接暂不可用', unavailable: '额度暂不可用' }[usage.errorKind] : '额度未知';
  if (value.state === 'exhausted') return '额度已用尽';
  if (value.usingCredits) return quotaCreditsLabel(usage) || '额度可用';
  return `剩余 ${quotaPercent(value.remainingPercent!)}`;
}
// Historical quota is not evidence that the current account is exhausted.
export function quotaDisplayState(usage?: AgentUsageLimits) {
  return usage?.stale ? 'unknown' : agentQuotaState(usage).state;
}

export function quotaUsageNote(usage?: AgentUsageLimits) {
  if (!usage?.stale) return usage?.message || '';
  const successAt = Date.parse(usage.lastSuccessAt || usage.checkedAt);
  return [usage.message, Number.isFinite(successAt) ? `上次成功读取：${quotaReset(successAt / 1000)}` : '当前显示上次读取结果'].filter(Boolean).join('；');
}

/** 本地额度摘要；接口原始名称和说明仍由详情逐字展示。未知窗口保留原名。 */
export function antigravityWindowSummary(bucket: AntigravityUsageBucket) {
  return bucket.window === 'weekly' ? '每周额度' : bucket.window === '5h' ? '5 小时额度' : bucket.name;
}

export function antigravityUnavailableLabel(usage?: AntigravityUsageLimits) {
  return usage?.errorKind ? { authentication: '登录待确认', timeout: '读取超时', network: '连接暂不可用', unavailable: '额度暂不可用' }[usage.errorKind] : '额度未知';
}

export function antigravityUsageNote(usage?: AntigravityUsageLimits) {
  if (!usage?.stale) return '';
  const successAt = Date.parse(usage.lastSuccessAt || usage.checkedAt);
  return [usage.message, Number.isFinite(successAt) ? `上次成功读取：${quotaReset(successAt / 1000)}` : '当前显示上次读取结果'].filter(Boolean).join('；');
}

export function antigravityMemberQuotaLabel(usage: AntigravityUsageLimits | undefined, model: string) {
  const quota = antigravityModelQuota(usage, model);
  return quota ? quotaLabel(quota) : antigravityUnavailableLabel(usage);
}

export function antigravityModelGroup(usage: AntigravityUsageLimits | undefined, model: string) {
  if (!usage?.available) return undefined;
  const name = /^gemini(?:-|$)/i.test(model) ? 'Gemini Models'
    : /^(?:claude|gpt)(?:-|$)/i.test(model) ? 'Claude and GPT models' : undefined;
  return usage.groups.find(group => group.name === name);
}

/** 成员摘要只取所属模型组最紧的有效窗口，不混用其他模型组或停用窗口。 */
export function antigravityModelQuota(usage: AntigravityUsageLimits | undefined, model: string): AgentUsageLimits | undefined {
  const group = antigravityModelGroup(usage, model);
  const bucket = group?.buckets.filter(item => !item.disabled && Number.isFinite(item.remainingPercent))
    .reduce<(typeof group.buckets)[number] | undefined>((lowest, item) => !lowest || item.remainingPercent < lowest.remainingPercent ? item : lowest, undefined);
  if (!usage || !group || !bucket) return undefined;
  return { available: true, checkedAt: usage.checkedAt, sourceLabel: group.name, stale: usage.stale, message: usage.message,
    primary: { remainingPercent: bucket.remainingPercent, usedPercent: 100 - bucket.remainingPercent,
      windowDurationMins: bucket.window === 'weekly' ? 10080 : bucket.window === '5h' ? 300 : null, resetsAt: bucket.resetsAt } };
}
