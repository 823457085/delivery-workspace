/**
 * 本地优先（Local-First）会话遥测、Prompt 缓存命中率与工具动作画像引擎（纯函数，无 Node I/O 依赖）。
 *
 * 设计借鉴自 GitHub 开源项目：
 * - `tobilg/ai-observer`：面向本地 CLI Agent（Claude Code / Codex / Cursor）的 Token 消耗、Prompt Cache 命中率与成本透明化观测
 * - `lmnr-ai/lmnr`（Laminar）：按会话与单轮拆解工具调用结构（读文件 / 改代码 / 跑命令 / 搜索 / 失败动作）与活跃耗时画像
 */
import { agentProviderLabels, type AgentProvider, type AgentRun } from './agent-runtime.js';

export type CacheEfficiencyGrade = 'high' | 'moderate' | 'low' | 'unknown';

export interface ToolActionBreakdown {
  fileReads: number;
  fileEdits: number;
  shellCommands: number;
  searches: number;
  otherTools: number;
  failedActions: number;
  totalActions: number;
}

export interface RunTelemetrySummary {
  runId: string;
  provider: AgentProvider;
  providerLabel: string;
  model: string;
  durationMs: number;
  durationLabel: string;
  usageKnown: boolean;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  uncachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  /** 0-100 整数百分比；当 CLI 未上报 inputTokens 或 cachedInputTokens 时为 null */
  cacheHitPercent: number | null;
  cacheGrade: CacheEfficiencyGrade;
  costUsd: number | null;
  changedFileCount: number;
  tools: ToolActionBreakdown;
}

export interface ProviderTelemetryShare {
  provider: AgentProvider;
  label: string;
  runs: number;
  totalTokens: number | null;
}

export interface ConversationTelemetrySummary {
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  activeRuns: number;
  usageReportedRuns: number;
  totalDurationMs: number;
  totalDurationLabel: string;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  cacheHitPercent: number | null;
  cacheGrade: CacheEfficiencyGrade;
  costUsd: number | null;
  uniqueChangedFiles: number;
  tools: ToolActionBreakdown;
  providers: ProviderTelemetryShare[];
}

export function formatCompactTokens(tokens: number | null | undefined): string {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) return '—';
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 1_000_000) {
    const k = tokens / 1000;
    return `${k >= 100 ? Math.round(k) : Number(k.toFixed(1))}k`;
  }
  const m = tokens / 1_000_000;
  return `${Number(m.toFixed(2))}M`;
}

export function formatTelemetryDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '<1s';
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

export function formatUsdCost(costUsd: number | null | undefined): string {
  if (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd < 0) return '';
  if (costUsd === 0) return 'US$0.00';
  if (costUsd < 0.01) return `US$${costUsd.toFixed(4)}`;
  return `US$${costUsd.toFixed(2)}`;
}

function computeCacheGrade(cacheHitPercent: number | null): CacheEfficiencyGrade {
  if (cacheHitPercent === null) return 'unknown';
  if (cacheHitPercent >= 60) return 'high';
  if (cacheHitPercent >= 25) return 'moderate';
  return 'low';
}

function classifyToolEvents(run: Pick<AgentRun, 'events'>): ToolActionBreakdown {
  const breakdown: ToolActionBreakdown = {
    fileReads: 0,
    fileEdits: 0,
    shellCommands: 0,
    searches: 0,
    otherTools: 0,
    failedActions: 0,
    totalActions: 0,
  };

  const seenKeys = new Set<string>();
  for (const event of run.events || []) {
    if (event.type !== 'tool') continue;
    const raw = (event.message || '').trim();
    if (!raw) continue;

    const isFailed = /^(?:执行失败|执行未通过|失败)[:：]|(?:工作区命令|只读检查)未通过/.test(raw);
    if (isFailed) breakdown.failedActions += 1;

    // 同一工具调用常经历“正在执行: X”与“执行完成: X”，按去前缀 payload 归并计数避免翻倍
    const normalizedPayload = raw.replace(/^(?:正在执行|执行完成|执行失败|执行未通过|开始|完成|失败)[:：]\s*/, '').trim();
    if (!normalizedPayload || seenKeys.has(normalizedPayload)) continue;
    seenKeys.add(normalizedPayload);

    if (/^(?:read_file|view_file|读取文件|cat\b|head\b|tail\b)/.test(normalizedPayload)) {
      breakdown.fileReads += 1;
    } else if (/^(?:apply_patch|edit_file|write_file|replace_in_file|修改文件|写入文件)/.test(normalizedPayload)) {
      breakdown.fileEdits += 1;
    } else if (/^(?:search_files|grep_search|list_files|搜索代码|搜索文本|浏览目录|rg\b|grep\b|find\b)/.test(normalizedPayload)) {
      breakdown.searches += 1;
    } else if (/^(?:run_command|bash|shell|执行命令)/.test(normalizedPayload) || /(?:工作区命令|只读检查)/.test(normalizedPayload)) {
      breakdown.shellCommands += 1;
    } else {
      breakdown.otherTools += 1;
    }
    breakdown.totalActions += 1;
  }

  return breakdown;
}

export function summarizeRunTelemetry(
  run: Pick<AgentRun, 'id' | 'provider' | 'model' | 'status' | 'createdAt' | 'updatedAt' | 'usage' | 'events' | 'changedFiles'>,
  nowMs = Date.now(),
): RunTelemetrySummary {
  const startMs = Date.parse(run.createdAt);
  const endMs = run.status === 'running' ? nowMs : Date.parse(run.updatedAt);
  const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0;

  const usage = run.usage;
  const inputTokens = typeof usage?.inputTokens === 'number' && Number.isFinite(usage.inputTokens) ? usage.inputTokens : null;
  const cachedInputTokens = typeof usage?.cachedInputTokens === 'number' && Number.isFinite(usage.cachedInputTokens)
    ? Math.max(0, Math.min(inputTokens ?? usage.cachedInputTokens, usage.cachedInputTokens))
    : null;
  const uncachedInputTokens = inputTokens !== null && cachedInputTokens !== null
    ? Math.max(0, inputTokens - cachedInputTokens)
    : inputTokens;
  const outputTokens = typeof usage?.outputTokens === 'number' && Number.isFinite(usage.outputTokens) ? usage.outputTokens : null;
  const reasoningTokens = typeof usage?.reasoningTokens === 'number' && Number.isFinite(usage.reasoningTokens) ? usage.reasoningTokens : null;
  const totalTokens = inputTokens !== null && outputTokens !== null
    ? inputTokens + outputTokens
    : inputTokens !== null
      ? inputTokens
      : outputTokens;

  const cacheHitPercent = inputTokens !== null && inputTokens > 0 && cachedInputTokens !== null
    ? Math.max(0, Math.min(100, Math.round((cachedInputTokens / inputTokens) * 100)))
    : null;
  const costUsd = typeof usage?.costUsd === 'number' && Number.isFinite(usage.costUsd) ? usage.costUsd : null;

  return {
    runId: run.id,
    provider: run.provider,
    providerLabel: agentProviderLabels[run.provider] || run.provider,
    model: run.model || 'CLI 默认',
    durationMs,
    durationLabel: formatTelemetryDuration(durationMs),
    usageKnown: totalTokens !== null,
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    cacheHitPercent,
    cacheGrade: computeCacheGrade(cacheHitPercent),
    costUsd,
    changedFileCount: run.changedFiles?.length || 0,
    tools: classifyToolEvents(run),
  };
}

export function summarizeConversationTelemetry(
  runs: readonly Pick<AgentRun, 'id' | 'provider' | 'model' | 'status' | 'createdAt' | 'updatedAt' | 'usage' | 'events' | 'changedFiles'>[],
  nowMs = Date.now(),
): ConversationTelemetrySummary {
  let completedRuns = 0;
  let failedRuns = 0;
  let activeRuns = 0;
  let usageReportedRuns = 0;
  let totalDurationMs = 0;

  let sumInput = 0;
  let hasInput = false;
  let sumCached = 0;
  let hasCached = false;
  let sumOutput = 0;
  let hasOutput = false;
  let sumReasoning = 0;
  let hasReasoning = false;
  let sumCost = 0;
  let hasCost = false;

  const tools: ToolActionBreakdown = {
    fileReads: 0,
    fileEdits: 0,
    shellCommands: 0,
    searches: 0,
    otherTools: 0,
    failedActions: 0,
    totalActions: 0,
  };
  const changedPaths = new Set<string>();
  const providerMap = new Map<AgentProvider, { runs: number; tokens: number; hasTokens: boolean }>();

  for (const run of runs) {
    if (run.status === 'completed') completedRuns += 1;
    else if (run.status === 'failed' || run.status === 'interrupted') failedRuns += 1;
    else if (run.status === 'running' || run.status === 'queued') activeRuns += 1;

    const item = summarizeRunTelemetry(run, nowMs);
    totalDurationMs += item.durationMs;

    if (item.usageKnown) usageReportedRuns += 1;
    if (item.inputTokens !== null) { sumInput += item.inputTokens; hasInput = true; }
    if (item.cachedInputTokens !== null) { sumCached += item.cachedInputTokens; hasCached = true; }
    if (item.outputTokens !== null) { sumOutput += item.outputTokens; hasOutput = true; }
    if (item.reasoningTokens !== null) { sumReasoning += item.reasoningTokens; hasReasoning = true; }
    if (item.costUsd !== null) { sumCost += item.costUsd; hasCost = true; }

    tools.fileReads += item.tools.fileReads;
    tools.fileEdits += item.tools.fileEdits;
    tools.shellCommands += item.tools.shellCommands;
    tools.searches += item.tools.searches;
    tools.otherTools += item.tools.otherTools;
    tools.failedActions += item.tools.failedActions;
    tools.totalActions += item.tools.totalActions;

    for (const file of run.changedFiles || []) {
      if (file.path) changedPaths.add(file.path);
    }

    const prev = providerMap.get(run.provider) || { runs: 0, tokens: 0, hasTokens: false };
    prev.runs += 1;
    if (item.totalTokens !== null) {
      prev.tokens += item.totalTokens;
      prev.hasTokens = true;
    }
    providerMap.set(run.provider, prev);
  }

  const inputTokens = hasInput ? sumInput : null;
  const cachedInputTokens = hasCached ? Math.min(sumInput || sumCached, sumCached) : null;
  const outputTokens = hasOutput ? sumOutput : null;
  const reasoningTokens = hasReasoning ? sumReasoning : null;
  const totalTokens = hasInput || hasOutput ? (sumInput + sumOutput) : null;
  const cacheHitPercent = inputTokens !== null && inputTokens > 0 && cachedInputTokens !== null
    ? Math.max(0, Math.min(100, Math.round((cachedInputTokens / inputTokens) * 100)))
    : null;

  const providers: ProviderTelemetryShare[] = [...providerMap.entries()].map(([provider, stats]) => ({
    provider,
    label: agentProviderLabels[provider] || provider,
    runs: stats.runs,
    totalTokens: stats.hasTokens ? stats.tokens : null,
  }));

  return {
    totalRuns: runs.length,
    completedRuns,
    failedRuns,
    activeRuns,
    usageReportedRuns,
    totalDurationMs,
    totalDurationLabel: formatTelemetryDuration(totalDurationMs),
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    cacheHitPercent,
    cacheGrade: computeCacheGrade(cacheHitPercent),
    costUsd: hasCost ? sumCost : null,
    uniqueChangedFiles: changedPaths.size,
    tools,
    providers,
  };
}
