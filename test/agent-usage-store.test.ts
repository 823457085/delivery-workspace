import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractAgentUsage, createAgentUsageStore, emptyAgentUsage, evaluateUsageGate } from '../server/agent-usage.js';
import { usageTokenCount } from '../shared/agent-usage.js';

test('三类 CLI 的真实字段归一化，未知为 null，Claude 费用只标自报', () => {
  const codex = extractAgentUsage('codex', { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20 } })!;
  assert.equal(usageTokenCount(codex), 120, '缓存不重复加到输入');
  assert.equal(codex.reasoningTokens, null);
  assert.equal(codex.costUsd, null);
  const rpc = extractAgentUsage('codex', { method: 'thread/tokenUsage/updated', params: { tokenUsage: {
    total: { inputTokens: 900, outputTokens: 100 }, last: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 10, reasoningOutputTokens: 4 } } } })!;
  assert.deepEqual([rpc.inputTokens, rpc.cachedInputTokens, rpc.outputTokens, rpc.reasoningTokens], [100, 50, 10, 4]);
  const breakdown = extractAgentUsage('codex', { method: 'thread/tokenUsage/updated', params: { tokenUsage: {
    total: { inputTokens: 9000 }, last: { breakdown: { inputTokens: 12, outputTokens: 3 } } } } })!;
  assert.equal(usageTokenCount(breakdown), 15);
  assert.equal(extractAgentUsage('codex', { method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { inputTokens: 900 } } } }), undefined,
    '没有last时不把会话累计当作本轮');
  const claude = extractAgentUsage('claude', { type: 'result', total_cost_usd: 0.012,
    usage: { input_tokens: 5, cache_read_input_tokens: 10, cache_creation_input_tokens: 3, output_tokens: 7 },
    modelUsage: { 'claude-opus-5-5': { inputTokens: 5, cacheReadInputTokens: 10, cacheCreationInputTokens: 3, outputTokens: 7, costUSD: 0.012 } } })!;
  assert.deepEqual([claude.inputTokens, claude.cachedInputTokens, claude.outputTokens, claude.costUsd], [18, 10, 7, 0.012]);
  assert.equal(claude.costSource, 'claude_code_self_reported');
  assert.equal(claude.models![0].inputTokens, 18);
  const cursor = extractAgentUsage('cursor', { type: 'result', usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 8 } })!;
  assert.deepEqual([cursor.inputTokens, cursor.cachedInputTokens, cursor.outputTokens], [10, 8, 4]);
  assert.equal(extractAgentUsage('cursor', { type: 'message' }), undefined);
  assert.deepEqual(emptyAgentUsage('codex').inputTokens, null);
});

test('用量按 runId 幂等持久汇总，裁剪运行历史不会丢每日/岗位/模型统计', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-usage-'));
  const record = { runId: 'run-1', workflowId: 'flow-1', profileId: 'engineer', provider: 'codex' as const, model: 'gpt-6.1-sol',
    createdAt: '2026-10-26T01:00:00.000Z', usage: { ...emptyAgentUsage('codex'), inputTokens: 10, outputTokens: 3 } };
  const now = new Date('2026-10-26T10:00:00.000Z');
  try {
    const store = await createAgentUsageStore(directory);
    await Promise.all([store.upsert(record), store.upsert(record)]);
    await store.upsert({ ...record, runId: 'unknown', usage: emptyAgentUsage('codex') });
    assert.equal(store.summary({ now }).total.runs, 2);
    assert.equal(store.summary({ now }).total.inputTokens, 10);
    assert.equal(store.summary({ now }).total.unknownRuns, 1);
    assert.equal(store.summary({ now }).byWorkflow[0].key, 'flow-1');
    await store.close();
    // 运行记录文件已不存在也不影响独立的用量账本。
    const reopened = await createAgentUsageStore(directory);
    assert.equal(reopened.summary({ now }).byDate[0].runs, 2);
    assert.equal(reopened.summary({ now }).byProfile[0].inputTokens, 10);
    assert.equal(reopened.summary({ now }).byModel[0].key, 'codex:gpt-6.1-sol');
    const state = JSON.parse(await fs.readFile(path.join(directory, 'agent-usage-daily.json'), 'utf8'));
    assert.equal(state.daily[0].runs, 2);
    await reopened.close();
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('派发仅按服务实际耗尽额度阻塞，不按本地token、升级次数或10%阈值停止', () => {
  const limits = { available: true, checkedAt: new Date().toISOString(), primary: { usedPercent: 92, remainingPercent: 8, resetsAt: null, windowDurationMins: 300 } };
  assert.equal(evaluateUsageGate({ provider: 'claude', usageLimits: limits }).allowed, true);
  assert.equal(evaluateUsageGate({ provider: 'codex', usageLimits: limits }).allowed, true);
  assert.equal(evaluateUsageGate({ provider: 'codex' }).state, 'unknown');
  assert.equal(evaluateUsageGate({ provider: 'codex', workflowTokens: 1000, usageLimit: 100 }).allowed, true);
  assert.equal(evaluateUsageGate({ provider: 'codex', workflowTokens: null, usageLimit: 100 }).allowed, true);
  assert.equal(evaluateUsageGate({ provider: 'codex', upgrades: 200, requestingUpgrade: true }).allowed, true);
  const exhausted = { ...limits, primary: { ...limits.primary, usedPercent: 100, remainingPercent: 0 } };
  assert.equal(evaluateUsageGate({ provider: 'codex', usageLimits: exhausted }).allowed, false);
  assert.equal(evaluateUsageGate({ provider: 'claude', usageLimits: exhausted }).fallbackProvider, 'codex');
  const codexWithCredits = { ...exhausted, credits: { hasCredits: true, balance: 34648.47 } };
  assert.equal(evaluateUsageGate({ provider: 'codex', usageLimits: codexWithCredits }).allowed, true);
  assert.equal(evaluateUsageGate({ provider: 'codex', usageLimits: codexWithCredits }).state, 'ready');
});
