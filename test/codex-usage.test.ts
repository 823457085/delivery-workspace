import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCodexPlanUsageReader, createCodexUsageReader, normalizeCodexUsage, requestCodexUsage } from '../server/codex-usage.js';

test('套餐查询独立选择已保存账号，保留刷新语义且不改变执行器额度来源', async () => {
  let reads = 0;
  const plan = createCodexPlanUsageReader('saved-plan', async (_binary, account) => {
    assert.equal(account, 'saved-plan'); reads++;
    return normalizeCodexUsage({rateLimits:{primary:{usedPercent:reads * 10}}});
  })!;
  const execution = createCodexUsageReader('fixture', 0, async () => ({available:false, checkedAt:'fixture', message:'API 密钥'}));
  assert.equal((await plan()).primary?.remainingPercent, 90);
  assert.equal((await plan()).sourceLabel, 'ChatGPT · saved-plan');
  assert.equal(reads, 1);
  assert.equal((await plan(true)).primary?.remainingPercent, 80);
  assert.equal((await execution()).available, false);
  const failed = createCodexPlanUsageReader('saved-plan', async () => {throw new Error('credential diagnostic');})!;
  assert.equal((await failed()).sourceLabel, 'ChatGPT · saved-plan');
  assert.equal((await failed()).message, '额度读取失败，请刷新重试');
  assert.equal(createCodexPlanUsageReader(''), undefined);
});

test('先核对 CLI 登录方式，API 密钥不查询 ChatGPT 额度，ChatGPT 登录读取真实额度', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-quota-auth-'));
  try {
    for (const type of ['apiKey', 'chatgpt', null]) {
      const binary = path.join(directory, `cli-${type}.mjs`), log = `${binary}.log`;
      await fs.writeFile(binary, `#!/usr/bin/env node
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
for await (const line of createInterface({input:process.stdin})) {
  const request=JSON.parse(line); if (!request.id) continue;
  appendFileSync(${JSON.stringify(log)}, JSON.stringify(request)+'\\n');
  const result=request.method==='account/read' ? {account:${type ? JSON.stringify({type}) : 'null'}}
    : request.method==='account/rateLimits/read' ? {rateLimits:{primary:{usedPercent:36,windowDurationMins:10080}}} : {};
  console.log(JSON.stringify({id:request.id,result}));
}
`, { mode: 0o700 });
      const result = await requestCodexUsage(binary);
      const calls = (await fs.readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(calls[1].params, { refreshToken: false });
      assert.equal(calls.some(call => call.method === 'account/rateLimits/read'), type === 'chatgpt');
      assert.equal(result.available, type === 'chatgpt');
      if (type === 'apiKey') assert.match(result.message!, /API 密钥/);
      if (type === 'chatgpt') assert.equal(result.primary?.remainingPercent, 64);
      if (!type) assert.match(result.message!, /未使用 ChatGPT 登录/);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('手动刷新绕过额度缓存，并发刷新合并；错误不泄露原始诊断', async () => {
  let reads = 0;
  const reader = createCodexUsageReader('fixture', 30000, async () => {
    reads++; return normalizeCodexUsage({rateLimits:{primary:{usedPercent:reads}}});
  });
  await reader(); await reader(); assert.equal(reads, 1);
  const refreshed = await Promise.all([reader(true), reader(true)]);
  assert.equal(reads, 2); assert.equal(refreshed[0].primary?.usedPercent, 2);
  const failed = createCodexUsageReader('fixture', 0, async () => { throw new Error('private diagnostic'); });
  assert.equal((await failed()).message, '额度读取失败，请刷新重试');
});

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

test('同一份 Codex 响应分别保留套餐与 API 额度窗口', () => {
  const result = normalizeCodexUsage({
    rateLimitsByLimitId: {
      codex: { planType: 'pro', primary: { usedPercent: 25, windowDurationMins: 300 } },
      api: { planType: 'payg', primary: { usedPercent: 60, windowDurationMins: 1_440 } },
    },
  });
  assert.equal(result.primary?.remainingPercent, 75);
  assert.equal(result.apiUsage?.planType, 'payg');
  assert.equal(result.apiUsage?.primary?.remainingPercent, 40);
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

test('Codex 窗口用尽但存在可用 Credits 时保留额度状态并处理花费限制', () => {
  const withCredits = normalizeCodexUsage({
    rateLimits: {
      planType: 'prolite',
      primary: { usedPercent: 100, windowDurationMins: 10_080, resetsAt: 1_794_188_389 },
      credits: { hasCredits: true, unlimited: false, balance: '34648.4717715000' },
      spendControlReached: false,
      rateLimitReachedType: 'rate_limit_reached',
    },
  }, '2026-11-04T10:55:00.000Z');
  assert.deepEqual(withCredits.credits, {
    hasCredits: true,
    balance: 34648.4717715,
  });

  const spendBlocked = normalizeCodexUsage({
    rateLimits: {
      planType: 'prolite',
      primary: { usedPercent: 100, windowDurationMins: 10_080, resetsAt: 1_794_188_389 },
      credits: { hasCredits: true, unlimited: false, balance: '34648.47' },
      spendControlReached: true,
    },
  });
  assert.deepEqual(spendBlocked.credits, {
    hasCredits: false,
    balance: 34648.47,
  });
});

test('瞬时超时和网络失败只重试一次，成功后返回真实额度', async () => {
  for (const diagnostic of ['workspace routing discovery timed out', 'ECONNRESET private-account-detail']) {
    let calls = 0;
    const reader = createCodexUsageReader('fixture', 30000, async () => {
      if (++calls === 1) throw new Error(diagnostic);
      return normalizeCodexUsage({ rateLimits: { primary: { usedPercent: 62 } } }, '2026-11-08T15:44:00Z');
    });
    const [first, second] = await Promise.all([reader(true), reader(true)]);
    assert.equal(calls, 2);
    assert.equal(first.primary?.remainingPercent, 38);
    assert.equal(first.stale, undefined);
    assert.equal(first.lastSuccessAt, '2026-11-08T15:44:00Z');
    assert.equal(second, first);
    assert.doesNotMatch(JSON.stringify(first), /private-account-detail|ECONNRESET|routing/);
  }
});

test('连续瞬时失败保留短期历史并明确标旧值，短失败缓存和过期边界均会重查', async () => {
  let now = 1000, calls = 0;
  const successAt = new Date(now).toISOString();
  const reader = createCodexUsageReader('fixture', 30000, async () => {
    if (++calls > 1) throw new Error('Codex 额度读取超时 sensitive-diagnostic');
    return normalizeCodexUsage({ rateLimitsByLimitId: {
      codex: { primary: { usedPercent: 100 }, credits: { hasCredits: true, balance: '28' } },
      api: { primary: { usedPercent: 44 } },
    } }, successAt);
  }, { now: () => now, failureTtlMs: 5000, staleMs: 12000 });
  await reader();
  now += 1000;
  const stale = await reader(true);
  assert.equal(calls, 3, 'only one retry after the first failed read');
  assert.equal(stale.available, true);
  assert.equal(stale.stale, true);
  assert.equal(stale.errorKind, 'timeout');
  assert.equal(stale.checkedAt, new Date(now).toISOString());
  assert.equal(stale.lastSuccessAt, successAt);
  assert.equal(stale.primary?.remainingPercent, 0);
  assert.equal(stale.credits?.balance, 28);
  assert.equal(stale.apiUsage?.stale, true);
  assert.equal(stale.apiUsage?.lastSuccessAt, successAt);
  assert.equal(stale.retryAt, new Date(now + 5000).toISOString());
  assert.doesNotMatch(JSON.stringify(stale), /sensitive-diagnostic/);
  assert.equal(await reader(), stale);
  assert.equal(calls, 3);
  now += 5000;
  await reader();
  assert.equal(calls, 5, 'failure cache expires before the normal 30-second TTL');
  now = 12500;
  await reader();
  assert.equal(calls, 7);
  now = 13000;
  const expired = await reader();
  assert.equal(calls, 9, 'stale cache cannot outlive its observation deadline');
  assert.equal(expired.available, false);
  assert.equal(expired.stale, undefined);
  assert.equal(expired.primary, undefined);
  assert.equal(expired.apiUsage, undefined);
});

test('认证失效或切成 API 登录不重试、不保留先前账号额度', async () => {
  for (const explicitFailure of ['401 Unauthorized private-account', 'apiKey']) {
    let calls = 0;
    const reader = createCodexUsageReader('fixture', 30000, async () => {
      calls++;
      if (calls === 1) return normalizeCodexUsage({ rateLimits: { primary: { usedPercent: 20 } } });
      if (calls === 2) {
        if (explicitFailure !== 'apiKey') throw new Error(explicitFailure);
        return { available: false, checkedAt: new Date().toISOString(), errorKind: 'unavailable', message: '当前 CLI 使用 API 密钥，不提供 ChatGPT 套餐额度' };
      }
      throw new Error('ETIMEDOUT');
    });
    await reader();
    const failed = await reader(true);
    assert.equal(calls, 2);
    assert.equal(failed.available, false);
    assert.equal(failed.primary, undefined);
    assert.equal(failed.errorKind, explicitFailure === 'apiKey' ? 'unavailable' : 'authentication');
    const networkFailure = await reader(true);
    assert.equal(calls, 4);
    assert.equal(networkFailure.available, false);
    assert.equal(networkFailure.primary, undefined);
    assert.doesNotMatch(JSON.stringify(failed), /private-account/);
  }
});

test('账号上下文切换后旧的在途查询不能覆盖新额度或清除新查询', async () => {
  const pending: ((value: ReturnType<typeof normalizeCodexUsage>) => void)[] = [];
  const reader = createCodexUsageReader('fixture', 30000, () => new Promise(resolve => pending.push(resolve)));
  const old = reader(false, 'account-version-1');
  await Promise.resolve();
  const current = reader(false, 'account-version-2');
  await Promise.resolve();
  assert.equal(pending.length, 2);
  pending[0]!(normalizeCodexUsage({ rateLimits: { primary: { usedPercent: 5 } } }));
  await old;
  assert.equal(reader(false, 'account-version-2'), current);
  pending[1]!(normalizeCodexUsage({ rateLimits: { primary: { usedPercent: 75 } } }));
  const fresh = await current;
  assert.equal(fresh.primary?.remainingPercent, 25);
  assert.equal(await reader(false, 'account-version-2'), fresh);
  assert.equal(pending.length, 2);
});

test('账号上下文变化后首次失败不借用旧账号的最近成功值，已保存账号同样失效缓存', async () => {
  let calls = 0;
  const reader = createCodexUsageReader('fixture', 30000, async () => {
    if (++calls > 1) throw new Error('network unavailable');
    return normalizeCodexUsage({ rateLimits: { primary: { usedPercent: 10 } } });
  });
  await reader(false, 'old-account');
  const next = await reader(false, 'new-account');
  assert.equal(calls, 3);
  assert.equal(next.available, false);
  assert.equal(next.primary, undefined);
  assert.equal(next.lastSuccessAt, undefined);
  let savedCalls = 0;
  const saved = createCodexPlanUsageReader('saved-plan', async () => {
    savedCalls++;
    return normalizeCodexUsage({ rateLimits: { primary: { usedPercent: savedCalls * 10 } } });
  })!;
  await saved(false, 'v1'); await saved(false, 'v1');
  assert.equal(savedCalls, 1);
  const changed = await saved(false, 'v2');
  assert.equal(savedCalls, 2);
  assert.equal(changed.primary?.remainingPercent, 80);
});

test('额度 RPC 允许冷启动等待，但超出单次预算会结束进程', { timeout: 5000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-quota-deadline-'));
  const binary = path.join(directory, 'cli.mjs');
  try {
    await fs.writeFile(binary, `#!/usr/bin/env node
import {createInterface} from 'node:readline';
for await (const line of createInterface({input:process.stdin})) {
  const request=JSON.parse(line); if (!request.id) continue;
  if(request.method==='initialize') await new Promise(resolve=>setTimeout(resolve, 100));
  const result=request.method==='account/read' ? {account:{type:'chatgpt'}}
    : request.method==='account/rateLimits/read' ? {rateLimits:{primary:{usedPercent:62}}} : {};
  console.log(JSON.stringify({id:request.id,result}));
}
`, { mode: 0o700 });
    assert.equal((await requestCodexUsage(binary, 2000)).primary?.remainingPercent, 38);
    await assert.rejects(requestCodexUsage(binary, 20), /额度读取超时/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('额度查询超时后等待进程结束，忽略终止信号也不会留下后台查询', { timeout: 5000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-quota-cleanup-'));
  const binary = path.join(directory, 'cli.mjs'), pidFile = path.join(directory, 'pid');
  try {
    await fs.writeFile(binary, `#!/usr/bin/env node
import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on('SIGTERM', ()=>{});
setInterval(()=>{},1000);
`, { mode: 0o700 });
    await assert.rejects(requestCodexUsage(binary, 1500), /额度读取超时/);
    const pid = Number(await fs.readFile(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
