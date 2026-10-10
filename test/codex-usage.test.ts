import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCodexUsage } from '../server/codex-usage.js';

test('Codex 额度转换为剩余百分比且不暴露账户信息', () => {
  const result = normalizeCodexUsage({
    rateLimitsByLimitId: {
      codex: {
        planType: 'pro',
        primary: { usedPercent: 70, windowDurationMins: 10_080, resetsAt: 1_789_953_076 },
        secondary: null,
      },
    },
  }, '2026-09-17T00:00:00.000Z');

  assert.deepEqual(result, {
    available: true,
    checkedAt: '2026-09-17T00:00:00.000Z',
    planType: 'pro',
    primary: { usedPercent: 70, remainingPercent: 30, windowDurationMins: 10_080, resetsAt: 1_789_953_076 },
    secondary: undefined,
  });
  assert.equal('accountId' in result, false);
});

test('Codex 额度缺失时不当作零额度', () => {
  assert.deepEqual(normalizeCodexUsage({}, '2026-09-17T00:00:00.000Z'), {
    available: false,
    checkedAt: '2026-09-17T00:00:00.000Z',
    message: '额度暂不可用',
  });
});

test('Codex 使用百分比越界时会被收敛', () => {
  const result = normalizeCodexUsage({ rateLimits: { primary: { usedPercent: 140, windowDurationMins: 300, resetsAt: null } } });
  assert.equal(result.primary?.usedPercent, 100);
  assert.equal(result.primary?.remainingPercent, 0);
});
