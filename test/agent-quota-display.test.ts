import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentUsageLimits, AntigravityUsageLimits } from '../shared/agent-runtime.js';
import { agentQuotaState, evaluateUsageGate } from '../shared/agent-usage.js';
import { antigravityMemberQuotaLabel, antigravityModelGroup, antigravityModelQuota, antigravityUnavailableLabel, antigravityUsageNote, antigravityWindowSummary, quotaCreditsLabel, quotaDisplayState, quotaLabel, quotaPercent, quotaWindow, quotaReset } from '../src/features/agent-workbench/usage-quota.js';
const limits = (remaining: number): AgentUsageLimits => ({ available: true, planType: 'fixture', checkedAt: new Date().toISOString(),
  primary: { remainingPercent: remaining, usedPercent: 100 - remaining, windowDurationMins: 10080, resetsAt: null } });
test('额度未知与零明确区分，并按所有窗口中最紧的额度判断', () => {
  assert.equal(quotaLabel(), '额度未知'); assert.equal(agentQuotaState({ ...limits(0), available: false }).state, 'unknown');
  assert.equal(quotaLabel(limits(0)), '额度已用尽');
  assert.equal(evaluateUsageGate({ provider: 'codex', usageLimits: limits(0) }).allowed, false);
  assert.equal(evaluateUsageGate({ provider: 'codex' }).allowed, true);
  const multi = { ...limits(50), secondary: limits(0).primary };
  assert.equal(agentQuotaState(multi).state, 'exhausted');
  const withCredits: AgentUsageLimits = { ...limits(0), credits: { hasCredits: true, balance: 34648.4717715 } };
  assert.equal(agentQuotaState(withCredits).state, 'available');
  assert.equal(agentQuotaState(withCredits).usingCredits, true);
  assert.equal(quotaCreditsLabel(withCredits), '额度 34,649');
  assert.equal(quotaLabel(withCredits), '额度 34,649');
  assert.equal(evaluateUsageGate({ provider: 'codex', usageLimits: withCredits }).allowed, true);
  const exhaustedCredits: AgentUsageLimits = { ...limits(0), credits: { hasCredits: false, balance: 0 } };
  assert.equal(agentQuotaState(exhaustedCredits).state, 'exhausted');
  assert.equal(quotaLabel(exhaustedCredits), '额度已用尽');
  assert.equal(evaluateUsageGate({ provider: 'codex', usageLimits: exhaustedCredits }).allowed, false);
  assert.equal(quotaLabel({ ...limits(50), secondary: limits(20).primary }), '剩余 20%');
  assert.equal(quotaLabel({ ...limits(NaN), secondary: undefined }), '额度未知');
});
test('极少量剩余额度不被四舍五入成零，窗口和重置时间不猜测', () => {
  assert.equal(quotaPercent(.04), '<0.1%'); assert.equal(quotaLabel(limits(.04)), '剩余 <0.1%');
  assert.equal(quotaPercent(98.956), '99%'); assert.equal(quotaWindow(10080), '7 天窗口');
  assert.equal(quotaWindow(300), '5 小时窗口'); assert.equal(quotaWindow(null), '当前窗口');
  assert.equal(quotaReset(null), '未提供');
});

test('Codex 历史额度明确标注上次，旧零值不拦截派发或冒充当前余额', () => {
  const stale: AgentUsageLimits = { ...limits(0), stale: true, errorKind: 'timeout',
    credits: { hasCredits: true, balance: 1234.5 } };
  assert.equal(quotaLabel(stale), '上次剩余 0%');
  assert.equal(quotaCreditsLabel(stale), '上次额度 1,235');
  assert.equal(quotaDisplayState(stale), 'unknown');
  assert.equal(agentQuotaState(stale).state, 'unknown');
  assert.equal(evaluateUsageGate({ provider: 'codex', usageLimits: stale }).allowed, true);
  assert.equal(quotaLabel({ ...stale, primary: undefined }), '上次额度 1,235');
  assert.equal(quotaLabel({ available: false, checkedAt: '', errorKind: 'timeout' }), '读取超时');
  assert.equal(quotaLabel({ available: false, checkedAt: '', errorKind: 'authentication' }), '登录待确认');
  assert.equal(quotaLabel({ ...stale, stale: false, credits: undefined }), '额度已用尽');
  assert.equal(evaluateUsageGate({ provider: 'codex', usageLimits: { ...stale, stale: false, credits: undefined } }).allowed, false);
});

test('额度摘要按已知时间窗口说明，未知窗口与接口原文保持不变', () => {
  const bucket = { id: 'fixture', name: 'L_WINDOW', window: 'weekly', description: 'Original L_123 message', remainingPercent: 12, resetsAt: null };
  assert.equal(antigravityWindowSummary(bucket), '每周额度');
  assert.equal(antigravityWindowSummary({ ...bucket, window: '5h' }), '5 小时额度');
  assert.equal(antigravityWindowSummary({ ...bucket, window: 'future' }), 'L_WINDOW');
  assert.equal(bucket.name, 'L_WINDOW');
  assert.equal(bucket.description, 'Original L_123 message');
});

test('Antigravity 成员按模型组展示最紧的有效额度，未知模型不借用别组额度', () => {
  const usage: AntigravityUsageLimits = { available: true, checkedAt: '2026-11-03T00:00:00Z', groups: [
    { name: 'Gemini Models', buckets: [
      { id: 'g-weekly', name: 'L_WEEKLY', window: 'weekly', remainingPercent: 70.6, resetsAt: 1794000000 },
      { id: 'g-5h', name: 'L_5H', window: '5h', remainingPercent: 100, resetsAt: null },
    ] },
    { name: 'Claude and GPT models', buckets: [
      { id: 'c-weekly', name: 'Weekly', window: 'weekly', remainingPercent: 0, resetsAt: null },
      { id: 'c-5h', name: 'Five Hour', window: '5h', remainingPercent: 100, resetsAt: null, disabled: true },
    ] },
  ] };
  assert.equal(quotaLabel(antigravityModelQuota(usage, 'gemini-4-argon-high')), '剩余 70.6%');
  assert.equal(antigravityModelGroup(usage, 'gemini-4-argon-high')?.buckets[0]?.name, 'L_WEEKLY');
  for (const model of ['claude-opus-5-5-high', 'gpt-oss-120b']) assert.equal(quotaLabel(antigravityModelQuota(usage, model)), '额度已用尽');
  assert.equal(quotaLabel(antigravityModelQuota(usage, 'custom-model')), '额度未知');
  assert.equal(quotaLabel(antigravityModelQuota({ ...usage, available: false }, 'gemini-4-argon-high')), '额度未知');
  usage.groups[0]!.buckets.forEach(bucket => bucket.disabled = true);
  assert.equal(quotaLabel(antigravityModelQuota(usage, 'gemini-4-argon-high')), '额度未知');
});

test('Antigravity 保留的历史值标为上次，不把旧零额度或重置时间当作当前状态', () => {
  const usage: AntigravityUsageLimits = { available: true, stale: true, checkedAt: '2026-11-06T03:00:00Z',
    lastSuccessAt: '2026-11-06T03:00:00Z', errorKind: 'timeout', message: 'Antigravity 额度读取超时，正在重试。', groups: [
      { name: 'Gemini Models', buckets: [{ id: 'g-weekly', name: 'L_WEEKLY', window: 'weekly', remainingPercent: 72, resetsAt: 1794000000 }] },
    ] };
  assert.equal(antigravityMemberQuotaLabel(usage, 'gemini-4-argon-high'), '上次剩余 72%');
  assert.equal(antigravityModelQuota(usage, 'gemini-4-argon-high')?.message, usage.message);
  assert.match(antigravityUsageNote(usage), /Antigravity 额度读取超时，正在重试。；上次成功读取：/);
  usage.groups[0]!.buckets[0]!.remainingPercent = 0;
  assert.equal(antigravityMemberQuotaLabel(usage, 'gemini-4-argon-high'), '上次剩余 0%');
  assert.equal(quotaDisplayState(antigravityModelQuota(usage, 'gemini-4-argon-high')), 'unknown');
  const fresh = { ...usage, stale: false, errorKind: undefined, message: undefined };
  assert.equal(antigravityMemberQuotaLabel(fresh, 'gemini-4-argon-high'), '额度已用尽');
  assert.equal(quotaDisplayState(antigravityModelQuota(fresh, 'gemini-4-argon-high')), 'exhausted');
  assert.equal(antigravityUsageNote(fresh), '');
});

test('Antigravity 无历史额度时区分登录、超时和连接错误，不捏造百分比', () => {
  for (const [errorKind, label] of [['authentication', '登录待确认'], ['timeout', '读取超时'], ['network', '连接暂不可用'], ['unavailable', '额度暂不可用']] as const) {
    const usage: AntigravityUsageLimits = { available: false, checkedAt: '2026-11-06T03:00:00Z', errorKind, groups: [], message: '原始失败说明' };
    assert.equal(antigravityUnavailableLabel(usage), label);
    assert.equal(antigravityMemberQuotaLabel(usage, 'gemini-4-argon-high'), label);
    assert.equal(antigravityModelQuota(usage, 'gemini-4-argon-high'), undefined);
  }
  assert.equal(antigravityUnavailableLabel(), '额度未知');
});
