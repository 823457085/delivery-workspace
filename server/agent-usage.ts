import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentProvider } from '../shared/agent-runtime.js';
import { emptyAgentUsage, usageTokenCount, type AgentUsage, type AgentUsageRunRecord,
  type AgentModelUsage, type AgentUsageGroup, type AgentUsageSummary } from '../shared/agent-usage.js';
export { emptyAgentUsage, evaluateUsageGate } from '../shared/agent-usage.js';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const first = (...values: unknown[]) => values.map(number).find(value => value !== null) ?? null;
const sum = (values: (number | null)[]) => values.some(value => value !== null) ? values.reduce<number>((total, value) => total + (value ?? 0), 0) : null;

function tokenFields(raw: unknown) {
  const value = object(raw), input = object(value.input_tokens_details || value.inputTokensDetails), output = object(value.output_tokens_details || value.outputTokensDetails);
  return { inputTokens: first(value.input_tokens, value.inputTokens),
    cachedInputTokens: first(value.cached_input_tokens, value.cachedInputTokens, value.cacheReadTokens,
      value.cacheReadInputTokens, value.cache_read_input_tokens, input.cached_tokens, input.cachedTokens),
    outputTokens: first(value.output_tokens, value.outputTokens),
    reasoningTokens: first(value.reasoning_output_tokens, value.reasoningOutputTokens, value.reasoningTokens,
      output.reasoning_tokens, output.reasoningTokens), costUsd: first(value.costUSD, value.costUsd, value.cost_usd) };
}

/** 支持 exec JSON 与当前 app-server JSON-RPC；只读取已知字段，不保存原始事件或账户信息。 */
export function extractAgentUsage(provider: AgentProvider, event: unknown): AgentUsage | undefined {
  const item = object(event), params = object(item.params);
  if (provider === 'codex') {
    let usage: Record<string, unknown>;
    if (item.method === 'thread/tokenUsage/updated') {
      const tokenUsage = object(params.tokenUsage || params.token_usage);
      // total 包含原生会话之前轮次；本轮只采 last。无 last 时不把会话累计冒充本轮用量。
      const last = object(tokenUsage.last);
      const breakdown = object(last.breakdown || tokenUsage.breakdown);
      usage = Object.keys(last).length ? { ...breakdown, ...last } : {};
    } else if (item.type === 'turn.completed' || item.method === 'turn/completed') {
      usage = object(item.usage || object(params.turn).usage || params.usage);
    } else return undefined;
    if (!Object.keys(usage).length) return undefined;
    return { ...emptyAgentUsage(provider), ...tokenFields(usage), source: String(item.method || item.type) };
  }
  if (provider === 'claude') {
    if (item.type !== 'result' && !item.modelUsage && !item.usage) return undefined;
    const modelUsage = object(item.modelUsage);
    const models: AgentModelUsage[] = Object.entries(modelUsage).map(([model, raw]) => {
      const fields = tokenFields(raw), value = object(raw);
      return { model, ...fields, inputTokens: fields.inputTokens === null ? null : fields.inputTokens + (fields.cachedInputTokens ?? 0)
        + (first(value.cacheCreationInputTokens, value.cache_creation_input_tokens) ?? 0) };
    });
    const raw = object(item.usage);
    const fields = tokenFields(raw);
    const cacheRead = first(raw.cache_read_input_tokens, raw.cacheReadInputTokens, fields.cachedInputTokens);
    const baseInput = first(raw.input_tokens, raw.inputTokens);
    const cacheCreation = first(raw.cache_creation_input_tokens, raw.cacheCreationInputTokens);
    // Claude 的 input_tokens 不含缓存读/写；仅在这些字段实际提供时按其定义合并。
    const inputTokens = baseInput === null ? sum(models.map(model => model.inputTokens))
      : baseInput + (cacheRead ?? 0) + (cacheCreation ?? 0);
    const costUsd = first(item.total_cost_usd, item.totalCostUsd, sum(models.map(model => model.costUsd)));
    return { ...emptyAgentUsage(provider), ...fields, inputTokens,
      cachedInputTokens: cacheRead ?? sum(models.map(model => model.cachedInputTokens)),
      outputTokens: fields.outputTokens ?? sum(models.map(model => model.outputTokens)),
      reasoningTokens: fields.reasoningTokens ?? sum(models.map(model => model.reasoningTokens)), costUsd,
      costSource: costUsd === null ? null : 'claude_code_self_reported', models: models.length ? models : null, source: 'claude.result' };
  }
  // 尚未核对单轮 token 语义的执行器保留未知，不能记成 Cursor 用量或冒用会话累计值。
  if (['kiro', 'antigravity', 'workbuddy'].includes(provider)) return undefined;
  const raw = object(item.usage || object(item.result).usage);
  if (!Object.keys(raw).length) return undefined;
  return { ...emptyAgentUsage(provider), ...tokenFields(raw), source: provider === 'api' ? 'api.usage' : provider === 'grok' ? 'grok.responses' : provider === 'deepseek' ? 'deepseek.responses' : 'cursor.usage' };
}

const fields = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens', 'costUsd'] as const;
function group(key: string, records: AgentUsageRunRecord[]): AgentUsageGroup {
  const known = records.map(record => usageTokenCount(record.usage)).filter((value): value is number => value !== null);
  return { key, runs: records.length, unknownRuns: records.length - known.length,
    ...Object.fromEntries(fields.map(field => [field, sum(records.map(record => record.usage[field]))])) as Pick<AgentUsageGroup, typeof fields[number]>,
    averageTokens: known.length ? known.reduce((total, value) => total + value, 0) / known.length : null,
    averageRounds: records.length ? records.reduce((total, record) => total + (record.round || 0), 0) / records.length : 0 };
}
function groups(records: AgentUsageRunRecord[], key: (record: AgentUsageRunRecord) => string) {
  const grouped = new Map<string, AgentUsageRunRecord[]>();
  for (const record of records) { const value = key(record); grouped.set(value, [...(grouped.get(value) || []), record]); }
  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => group(key, values));
}
export function summarizeAgentUsage(records: AgentUsageRunRecord[], options: { days?: number; now?: Date } = {}): AgentUsageSummary {
  const days = Math.min(3650, Math.max(1, Math.floor(options.days || 30))), now = options.now || new Date();
  const from = new Date(now); from.setUTCDate(from.getUTCDate() - days + 1); from.setUTCHours(0, 0, 0, 0);
  const selected = records.filter(record => Date.parse(record.createdAt) >= +from && Date.parse(record.createdAt) <= +now);
  return { days, from: from.toISOString(), to: now.toISOString(), total: group('all', selected),
    byDate: groups(selected, record => record.createdAt.slice(0, 10)), byWorkflow: groups(selected, record => record.workflowId || 'manual'),
    byProfile: groups(selected, record => record.profileId || 'manual'), byProvider: groups(selected, record => record.provider),
    byModel: groups(selected, record => `${record.provider}:${record.model}`) };
}

export async function createAgentUsageStore(directory: string, options: { writeJson?: (relative: string, value: unknown) => Promise<void> } = {}) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'agent-usage-daily.json');
  let records: AgentUsageRunRecord[] = [];
  try {
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    if (saved.version !== 1 || !Array.isArray(saved.records)) throw new Error('用量记录格式无效');
    records = saved.records;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let writing: Promise<unknown> = Promise.resolve();
  async function upsert(record: AgentUsageRunRecord) {
    if (!record.runId || !['codex', 'claude', 'cursor', 'kiro', 'antigravity', 'api', 'deepseek', 'workbuddy', 'grok'].includes(record.provider) || !Number.isFinite(Date.parse(record.createdAt))
      || fields.some(field => record.usage[field] !== null && number(record.usage[field]) === null)) throw new Error('用量记录无效');
    const update = writing.then(async () => {
      const next = [...records.filter(item => item.runId !== record.runId), structuredClone(record)];
      const saved = { version: 1, records: next, daily: groups(next, item => item.createdAt.slice(0, 10)) };
      if (options.writeJson) await options.writeJson('agent-runtimes/agent-usage-daily.json', saved);
      else { await fs.writeFile(`${file}.tmp`, JSON.stringify(saved), { mode: 0o600 }); await fs.rename(`${file}.tmp`, file); }
      records = next;
      return structuredClone(record);
    });
    writing = update.catch(() => undefined);
    return update;
  }
  return { upsert, list: () => structuredClone(records), summary: (options?: { days?: number; now?: Date }) => summarizeAgentUsage(records, options), close: () => writing };
}
