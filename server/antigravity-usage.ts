/** Native /usage metadata only: no model turn, credential reads, or credit-overage changes. */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AntigravityUsageBucket, AntigravityUsageGroup, AntigravityUsageLimits } from '../shared/agent-runtime.js';
import { antigravityBinary } from './cli-runtime.js';

const exec = promisify(execFile);
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const text = (value: unknown, maxLength = 200) => typeof value === 'string' && value.trim() && value.length <= maxLength ? value : undefined;
type FailureKind = 'authentication' | 'timeout' | 'network' | 'unavailable';
const failureMessages: Record<FailureKind, string> = {
  authentication: 'Antigravity 登录已失效，请运行 agy 完成登录后刷新。',
  timeout: 'Antigravity 登录或额度读取超时，请检查网络连接；稍后会自动重试。',
  network: 'Antigravity 额度服务连接失败，请检查网络连接；稍后会自动重试。',
  unavailable: 'Antigravity 未返回有效额度，请稍后刷新。',
};
const unavailable = (checkedAt = new Date().toISOString(), errorKind: FailureKind = 'unavailable'): AntigravityUsageLimits => ({
  available: false, checkedAt, groups: [], errorKind, message: failureMessages[errorKind],
});

/** Never forward CLI output: it can contain account identifiers or credentials. */
export function antigravityUsageFailure(error: unknown): AntigravityUsageLimits {
  const detail = record(error);
  let native: Record<string, unknown> = {};
  try { native = record(JSON.parse(typeof detail.stdout === 'string' ? detail.stdout : '')); } catch { /* No raw diagnostics. */ }
  const diagnostic = [native.error, detail.stderr, detail.message, detail.code].filter(value => typeof value === 'string').join(' ');
  // The CLI says "authentication failed or timed out" for a failed token refresh.
  // This is not proof that the account was logged out or its refresh token revoked.
  const kind: FailureKind = /UNAUTHENTICATED|AUTH_REQUIRED|invalid_grant|(?:expired|revoked|invalid) (?:refresh )?(?:token|credentials)/i.test(diagnostic) ? 'authentication'
    : detail.killed || /ETIMEDOUT|timed? out|timeout|deadline exceeded/i.test(diagnostic) ? 'timeout'
    : /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|fetch failed/i.test(diagnostic) ? 'network'
      : /UNAUTHENTICATED|AUTH_REQUIRED|authentication (?:failed|required)|not logged in|invalid_grant|(?:expired|revoked|invalid) (?:refresh )?(?:token|credentials)/i.test(diagnostic)
        ? 'authentication' : 'unavailable';
  return unavailable(new Date().toISOString(), kind);
}

export function normalizeAntigravityUsage(value: unknown, checkedAt = new Date().toISOString()): AntigravityUsageLimits {
  const result = record(value), command = record(result.command), data = record(command.data);
  // Never mistake a model-generated response or cumulative conversation tokens for subscription quota.
  if (result.status !== 'SUCCESS' || result.num_turns !== 0 || command.name !== 'usage' || !Array.isArray(data.groups)) return unavailable(checkedAt);
  const groups: AntigravityUsageGroup[] = [];
  for (const rawGroup of data.groups) {
    const group = record(rawGroup), name = text(group.name);
    if (!name || !Array.isArray(group.buckets) || groups.some(item => item.name === name)) continue;
    const buckets: AntigravityUsageBucket[] = [];
    for (const rawBucket of group.buckets) {
      const bucket = record(rawBucket), id = text(bucket.id), label = text(bucket.name), window = text(bucket.window);
      const fraction = bucket.remaining_fraction;
      if (!id || !label || !window || typeof fraction !== 'number' || !Number.isFinite(fraction)
        || fraction < 0 || fraction > 1 || buckets.some(item => item.id === id)) continue;
      const reset = typeof bucket.reset_time === 'string' ? Date.parse(bucket.reset_time) : Number.NaN;
      buckets.push({ id, name: label, description: text(bucket.description, 1000), window,
        remainingPercent: fraction * 100, resetsAt: Number.isFinite(reset) ? Math.floor(reset / 1000) : null,
        ...(bucket.disabled === true ? { disabled: true } : {}) });
    }
    if (buckets.length) groups.push({ name, description: text(group.description, 1000), buckets });
  }
  return groups.length ? { available: true, checkedAt, groups } : unavailable(checkedAt);
}

async function requestAntigravityUsage(binary: string, timeoutMs: number) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-antigravity-usage-'));
  try {
    const { stdout } = await exec(binary, ['-p', '/usage', '--output-format', 'json', '--settings',
      JSON.stringify({ disableSlashCommands: false, useG1Credits: false })],
    { cwd: directory, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1_000_000 });
    const raw = JSON.parse(stdout);
    return raw?.status === 'ERROR' ? antigravityUsageFailure({ stdout }) : normalizeAntigravityUsage(raw);
  } catch (error) { return antigravityUsageFailure(error);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

interface ReaderOptions {
  now?: () => number;
  request?: () => Promise<AntigravityUsageLimits>;
  failureTtlMs?: number;
  staleMs?: number;
}
export function createAntigravityUsageReader(binary = antigravityBinary, ttlMs = 60_000, timeoutMs = 20_000, options: ReaderOptions = {}) {
  const clock = options.now || Date.now;
  const request = options.request || (() => requestAntigravityUsage(binary, timeoutMs));
  const failureTtlMs = options.failureTtlMs ?? 5_000, staleMs = options.staleMs ?? 5 * 60_000;
  let cached: { expiresAt: number; value: AntigravityUsageLimits } | undefined;
  let pending: Promise<AntigravityUsageLimits> | undefined;
  let lastSuccess: { at: number; value: AntigravityUsageLimits } | undefined;
  let context = '', generation = 0;
  return (force = false, contextKey = ''): Promise<AntigravityUsageLimits> => {
    // Account maintenance advances the host version; neither old data nor an old
    // in-flight response may become the new account's cached quota.
    if (contextKey !== context) { context = contextKey; generation++; cached = undefined; lastSuccess = undefined; pending = undefined; }
    if (pending) return pending;
    if (!force && cached && cached.expiresAt > clock()) return Promise.resolve(cached.value);
    const requestedGeneration = generation;
    pending = (async () => {
      let value = await request().catch(antigravityUsageFailure);
      if (!value.available && ['timeout', 'network'].includes(value.errorKind || '') && generation === requestedGeneration) {
        value = await request().catch(antigravityUsageFailure);
      }
      if (generation !== requestedGeneration) return value;
      const at = clock();
      if (value.available && !value.stale) {
        value = { ...value, lastSuccessAt: value.checkedAt };
        lastSuccess = { at, value };
      } else {
        // Explicit logout/revocation must not keep another account's old quota.
        if (value.errorKind === 'authentication') lastSuccess = undefined;
        if (lastSuccess && at - lastSuccess.at < staleMs) {
          value = { ...lastSuccess.value, stale: true, lastSuccessAt: lastSuccess.value.checkedAt,
            errorKind: value.errorKind, message: value.message, retryAt: new Date(at + failureTtlMs).toISOString() };
        } else value = { ...value, retryAt: new Date(at + failureTtlMs).toISOString() };
      }
      cached = { value, expiresAt: Math.min(at + (value.available && !value.stale ? ttlMs : failureTtlMs),
        value.stale && lastSuccess ? lastSuccess.at + staleMs : Infinity) };
      return value;
    })().finally(() => { if (generation === requestedGeneration) pending = undefined; });
    return pending;
  };
}
