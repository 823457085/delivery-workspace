/**
 * 设计说明：Cursor CLI 没有额度子命令。读取与 CLI 相同的本机登录，只向官方 Dashboard 查询当前周期，
 * 再收敛成面板上的剩余百分比和重置时间。令牌、消费金额和账户标识不进入响应或日志。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentUsageLimits, AgentUsageWindow } from '../shared/agent-runtime.js';

const execFileAsync = promisify(execFile);
const dashboardOrigin = 'https://api2.cursor.sh';

interface JsonRecord { [key: string]: unknown }

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function field(source: JsonRecord | undefined, ...keys: string[]) {
  if (!source) return undefined;
  for (const key of keys) if (key in source) return source[key];
  return undefined;
}

function asFiniteNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function clampPercent(value: number) {
  return Math.min(100, Math.max(0, value));
}

function unixSeconds(value: unknown) {
  if (typeof value === 'string' && value.includes('-')) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
  }
  const numeric = asFiniteNumber(value);
  if (numeric === null || numeric <= 0) return null;
  return Math.floor(numeric > 10_000_000_000 ? numeric / 1000 : numeric);
}

function windowMinutes(start: unknown, end: unknown, period: unknown) {
  const startSeconds = unixSeconds(start);
  const endSeconds = unixSeconds(end);
  if (startSeconds && endSeconds && endSeconds > startSeconds) return Math.round((endSeconds - startSeconds) / 60);
  if (period === 2 || period === 'WEEKLY') return 7 * 24 * 60;
  if (period === 1 || period === 'MONTHLY') return 30 * 24 * 60;
  return null;
}

function percentUsed(explicit: unknown, limit: unknown, remaining: unknown, used?: unknown) {
  const explicitPercent = asFiniteNumber(explicit);
  if (explicitPercent !== null) return clampPercent(explicitPercent);
  const limitValue = asFiniteNumber(limit);
  if (limitValue === null || limitValue <= 0) return null;
  const usedValue = asFiniteNumber(used);
  if (usedValue !== null) return clampPercent(usedValue / limitValue * 100);
  const remainingValue = asFiniteNumber(remaining);
  if (remainingValue === null) return null;
  return clampPercent((limitValue - remainingValue) / limitValue * 100);
}

function usageWindow(usedPercent: number | null, durationMins: number | null, resetsAt: number | null): AgentUsageWindow | undefined {
  if (usedPercent === null) return undefined;
  return { usedPercent, remainingPercent: 100 - usedPercent, windowDurationMins: durationMins, resetsAt };
}

export function parseCursorKeychainPassword(stderr: string) {
  const line = stderr.split('\n').find((item) => item.startsWith('password:'));
  if (!line) return null;
  const hex = line.match(/^password: 0x([0-9a-fA-F]+)$/);
  if (hex) return Buffer.from(hex[1], 'hex').toString('utf8');
  const quoted = line.match(/^password: "(.*)"$/);
  return quoted?.[1] || null;
}

function authFilePath() {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'Cursor', 'auth.json');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), '.cursor', 'auth.json');
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'cursor', 'auth.json');
}

async function readAuthFileToken() {
  try {
    const data = asRecord(JSON.parse(await fs.readFile(authFilePath(), 'utf8')));
    const token = data?.accessToken;
    return typeof token === 'string' && token ? token : null;
  } catch { return null; }
}

async function readKeychainToken() {
  try {
    const { stderr } = await execFileAsync('/usr/bin/security',
      ['find-generic-password', '-a', 'cursor-user', '-s', 'cursor-access-token', '-g'],
      { timeout: 8_000, maxBuffer: 64_000, encoding: 'utf8' });
    return parseCursorKeychainPassword(stderr);
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '';
    return parseCursorKeychainPassword(stderr);
  }
}

export async function readCursorAccessToken() {
  const store = process.env.AGENT_CLI_CREDENTIAL_STORE;
  if (store === 'memory') return null;
  if (store !== 'file' && process.platform === 'darwin') return readKeychainToken();
  return readAuthFileToken();
}

async function readActiveTeamId() {
  try {
    const directory = process.env.CURSOR_CONFIG_DIR?.trim() || path.join(os.homedir(), '.cursor');
    const data = asRecord(JSON.parse(await fs.readFile(path.join(directory, 'cli-config.json'), 'utf8')));
    const authInfo = asRecord(data?.authInfo);
    const teamId = asFiniteNumber(authInfo?.activeTeamId ?? authInfo?.teamId);
    return teamId !== null && Number.isInteger(teamId) && teamId > 0 ? teamId : undefined;
  } catch { return undefined; }
}

export function normalizeCursorUsage(periodValue: unknown, planValue?: unknown, checkedAt = new Date().toISOString()): AgentUsageLimits {
  const unavailable = (): AgentUsageLimits => ({ available: false, checkedAt, message: '额度暂不可用' });
  const period = asRecord(periodValue);
  if (!period || field(period, 'enabled') === false) return unavailable();
  const plan = asRecord(asRecord(planValue)?.planInfo ?? asRecord(planValue)?.plan_info);
  const cycleStart = field(period, 'billingCycleStart', 'billing_cycle_start');
  const cycleEnd = field(period, 'billingCycleEnd', 'billing_cycle_end') ?? field(plan, 'billingCycleEnd', 'billing_cycle_end', 'includedUsageResetsAt', 'included_usage_resets_at');
  const durationMins = windowMinutes(cycleStart, cycleEnd, field(plan, 'includedUsagePeriod', 'included_usage_period'));
  const resetsAt = unixSeconds(cycleEnd);
  const planUsage = asRecord(field(period, 'planUsage', 'plan_usage'));
  const primary = usageWindow(percentUsed(
    field(planUsage, 'totalPercentUsed', 'total_percent_used') ?? field(planUsage, 'apiPercentUsed', 'api_percent_used') ?? field(planUsage, 'autoPercentUsed', 'auto_percent_used'),
    field(planUsage, 'limit'),
    field(planUsage, 'remaining'),
  ), durationMins, resetsAt);
  const spend = asRecord(field(period, 'spendLimitUsage', 'spend_limit_usage'));
  const secondary = usageWindow(percentUsed(
    undefined,
    field(spend, 'individualLimit', 'individual_limit') ?? field(spend, 'overallLimit', 'overall_limit') ?? field(spend, 'pooledLimit', 'pooled_limit'),
    field(spend, 'individualRemaining', 'individual_remaining') ?? field(spend, 'overallRemaining', 'overall_remaining') ?? field(spend, 'pooledRemaining', 'pooled_remaining'),
    field(spend, 'individualUsed', 'individual_used') ?? field(spend, 'overallUsed', 'overall_used') ?? field(spend, 'pooledUsed', 'pooled_used'),
  ), durationMins, resetsAt);
  if (!primary && !secondary) return unavailable();
  const planName = field(plan, 'planName', 'plan_name');
  return {
    available: true,
    checkedAt,
    planType: typeof planName === 'string' && planName ? planName : undefined,
    primary: primary ?? secondary,
    secondary: primary ? secondary : undefined,
  };
}

async function postDashboard(token: string, method: string, body: JsonRecord) {
  const response = await fetch(`${dashboardOrigin}/aiserver.v1.DashboardService/${method}`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(8_000),
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      'x-cursor-client-type': 'cli',
      ...(typeof body.teamId === 'number' ? { 'x-cursor-team-id': String(body.teamId) } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok || text.length > 1_000_000) throw new Error('Cursor 额度查询失败');
  return text ? JSON.parse(text) as unknown : {};
}

async function requestCursorUsage(readToken: () => Promise<string | null>) {
  const token = await readToken();
  if (!token) return { available: false, checkedAt: new Date().toISOString(), message: '额度暂不可用' };
  const teamId = await readActiveTeamId();
  const body = { includePooledUsage: true, ...(teamId ? { teamId } : {}) };
  const [period, plan] = await Promise.allSettled([
    postDashboard(token, 'GetCurrentPeriodUsage', body),
    postDashboard(token, 'GetPlanInfo', teamId ? { teamId } : {}),
  ]);
  if (period.status === 'rejected') throw period.reason;
  return normalizeCursorUsage(period.value, plan.status === 'fulfilled' ? plan.value : undefined);
}

export function createCursorUsageReader(readToken: () => Promise<string | null> = readCursorAccessToken, ttlMs = 60_000) {
  let cached: { expiresAt: number; value: AgentUsageLimits } | undefined;
  let pending: Promise<AgentUsageLimits> | undefined;
  return async (force = false) => {
    if (!force && cached && cached.expiresAt > Date.now()) return cached.value;
    if (pending) return pending;
    pending = requestCursorUsage(readToken)
      .catch((): AgentUsageLimits => ({ available: false, checkedAt: new Date().toISOString(), message: '额度暂不可用' }))
      .then((value) => {
        cached = { expiresAt: Date.now() + ttlMs, value };
        return value;
      })
      .finally(() => { pending = undefined; });
    return pending;
  };
}
