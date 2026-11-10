import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCursorUsage, parseCursorKeychainPassword } from '../server/cursor-usage.js';

const checkedAt = '2026-10-22T00:00:00.000Z';

test('Cursor 额度转换为账单周期剩余百分比且不暴露消费金额', () => {
  const result = normalizeCursorUsage({
    enabled: true,
    billingCycleStart: '1761000000000',
    billingCycleEnd: '1763592000000',
    planUsage: { totalPercentUsed: 42.2, limit: 2000, remaining: 1156, totalSpend: 844 },
    spendLimitUsage: { individualLimit: 5000, individualUsed: 1000, individualRemaining: 4000, limitType: 'user' },
    displayMessage: 'user@example.com',
  }, {
    planInfo: { planName: 'Pro', includedUsagePeriod: 'MONTHLY' },
  }, checkedAt);

  assert.deepEqual(result, {
    available: true,
    checkedAt,
    planType: 'Pro',
    primary: { usedPercent: 42.2, remainingPercent: 57.8, windowDurationMins: 30 * 24 * 60, resetsAt: 1_763_592_000 },
    secondary: { usedPercent: 20, remainingPercent: 80, windowDurationMins: 30 * 24 * 60, resetsAt: 1_763_592_000 },
  });
  assert.equal(JSON.stringify(result).includes('844'), false);
  assert.equal(JSON.stringify(result).includes('example.com'), false);
});

test('Cursor 缺少已用百分比时按剩余额度换算', () => {
  const result = normalizeCursorUsage({
    plan_usage: { limit: 80, remaining: 20 },
    billing_cycle_end: 1_800_000_000,
    billing_cycle_start: 1_800_000_000 - 7 * 24 * 60 * 60,
  }, { plan_info: { plan_name: 'Team', included_usage_period: 'WEEKLY' } }, checkedAt);
  assert.equal(result.available, true);
  assert.equal(result.planType, 'Team');
  assert.equal(result.primary?.usedPercent, 75);
  assert.equal(result.primary?.remainingPercent, 25);
  assert.equal(result.primary?.windowDurationMins, 7 * 24 * 60);
  assert.equal(result.secondary, undefined);
});

test('Cursor 额度缺失或关闭时不当作零额度', () => {
  assert.deepEqual(normalizeCursorUsage({}, undefined, checkedAt), {
    available: false, checkedAt, message: '额度暂不可用',
  });
  assert.equal(normalizeCursorUsage({ enabled: false, planUsage: { totalPercentUsed: 0 } }, undefined, checkedAt).available, false);
  assert.equal(normalizeCursorUsage({ planUsage: { limit: 0, remaining: 0 } }, undefined, checkedAt).available, false);
});

test('Cursor 使用百分比越界时会被收敛', () => {
  const result = normalizeCursorUsage({ planUsage: { totalPercentUsed: 140, limit: 10, remaining: 0 } });
  assert.equal(result.primary?.usedPercent, 100);
  assert.equal(result.primary?.remainingPercent, 0);
});

test('钥匙串密码行只解析口令本身', () => {
  assert.equal(parseCursorKeychainPassword('password: "cursor-token"\nkeychain: "login"'), 'cursor-token');
  assert.equal(parseCursorKeychainPassword(`password: 0x${Buffer.from('cursor-token').toString('hex')}`), 'cursor-token');
  assert.equal(parseCursorKeychainPassword('keychain: "login"'), null);
});
