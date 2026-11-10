import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeClaudeUsage } from '../server/claude-usage.js';

test('Claude 额度转换为 5 小时与 7 天剩余百分比且不暴露消费明细', () => {
  const result = normalizeClaudeUsage({
    subscription_type: 'pro',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 24, resets_at: '2026-10-22T10:39:59.962112+00:00' },
      seven_day: { utilization: 3, resets_at: '2026-10-25T01:59:59.962131+00:00' },
    },
  }, '2026-10-22T00:00:00.000Z');

  assert.deepEqual(result, {
    available: true,
    checkedAt: '2026-10-22T00:00:00.000Z',
    planType: 'pro',
    primary: { usedPercent: 24, remainingPercent: 76, windowDurationMins: 300, resetsAt: Math.floor(Date.parse('2026-10-22T10:39:59.962Z') / 1_000) },
    secondary: { usedPercent: 3, remainingPercent: 97, windowDurationMins: 10_080, resetsAt: Math.floor(Date.parse('2026-10-25T01:59:59.962Z') / 1_000) },
  });
});

test('Claude 额度不可用时不当作零额度', () => {
  assert.deepEqual(normalizeClaudeUsage({ rate_limits_available: false, rate_limits: null }, '2026-10-22T00:00:00.000Z'), {
    available: false,
    checkedAt: '2026-10-22T00:00:00.000Z',
    message: '额度暂不可用',
  });
});
