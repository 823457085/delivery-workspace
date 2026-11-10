/**
 * 设计说明：额度通过官方 app-server 查询；执行器查询使用当前登录，套餐展示可选择账号管理中已保存的账号。
 * 已保存账号由 Python bridge 在短暂隔离环境中查询，保持执行器认证文件不变。
 * 模块边界是将 app-server 协议结果收敛为面板需要的百分比和重置时间；不向浏览器暴露账户 ID 或积分明细。
 * 不直接读取 JSONL 会话文件，因为那只是某次运行的快照，不能代表当前额度。
 */
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { AgentUsageCredits, AgentUsageLimits, AgentUsageWindow } from '../shared/agent-runtime.js';
import { cliBinary, codexChildEnvironment } from './cli-runtime.js';

interface RateLimitWindowPayload {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
}

interface CreditStatusDetailsPayload {
  hasCredits?: unknown;
  unlimited?: unknown;
  balance?: unknown;
}

interface RateLimitSnapshotPayload {
  planType?: unknown;
  primary?: RateLimitWindowPayload | null;
  secondary?: RateLimitWindowPayload | null;
  credits?: CreditStatusDetailsPayload | null;
  spendControlReached?: unknown;
  rateLimitReachedType?: unknown;
}

interface RateLimitsResponsePayload {
  rateLimits?: RateLimitSnapshotPayload;
  rateLimitsByLimitId?: Record<string, RateLimitSnapshotPayload> | null;
}

export interface CodexUsageSnapshot extends AgentUsageLimits {
  /** Codex app-server 在同一响应中返回的 API 额度窗口。 */
  apiUsage?: AgentUsageLimits;
}

type FailureKind = 'authentication' | 'timeout' | 'network' | 'unavailable';
interface ReaderOptions {
  now?: () => number;
  failureTtlMs?: number;
  staleMs?: number;
}

/** Only classified failures cross the HTTP boundary; CLI diagnostics can contain account data. */
function usageFailure(error: unknown, checkedAt: string): CodexUsageSnapshot {
  const detail = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const diagnostic = [detail.message, detail.code, typeof error === 'string' ? error : ''].filter(value => typeof value === 'string').join(' ');
  const kind: FailureKind = /\b(?:401|403|UNAUTHENTICATED|AUTH_REQUIRED)\b|invalid_grant|(?:expired|revoked|invalid) (?:refresh )?(?:token|credentials)/i.test(diagnostic)
    ? 'authentication' : detail.killed || /超时|ETIMEDOUT|timed? out|timeout|deadline exceeded/i.test(diagnostic) ? 'timeout'
      : /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|fetch failed|连接失败/i.test(diagnostic) ? 'network'
        : /unauthori[sz]ed|authentication (?:failed|required)|not logged in|登录已失效/i.test(diagnostic) ? 'authentication' : 'unavailable';
  const messages: Record<FailureKind, string> = {
    authentication: 'Codex 登录已失效，请重新登录后刷新',
    timeout: '额度读取超时，请刷新重试',
    network: '额度服务连接失败，请刷新重试',
    unavailable: '额度读取失败，请刷新重试',
  };
  return { available: false, checkedAt, errorKind: kind, message: messages[kind] };
}

/** Display source only: a saved ChatGPT account must not gate API-key execution. */
export async function requestSavedCodexUsage(binary: string, account: string): Promise<CodexUsageSnapshot> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(account)) throw new Error('额度查询账号无效');
  const { stdout } = await promisify(execFile)('/usr/bin/python3', [
    fileURLToPath(new URL('../scripts/ai-accounts/codex_usage.py', import.meta.url)), account,
  ], { env: { ...codexChildEnvironment(), DELIVERY_CODEX_BIN: binary }, timeout: 15_000, maxBuffer: 100_000 });
  const payload = JSON.parse(stdout) as RateLimitsResponsePayload & { error?: string };
  if (payload.error) throw new Error('已保存账号额度读取失败');
  return { ...normalizeCodexUsage(payload), sourceLabel: `ChatGPT · ${account}` };
}

export function createCodexPlanUsageReader(account = process.env.DELIVERY_CODEX_USAGE_ACCOUNT,
  read = requestSavedCodexUsage, options: ReaderOptions = {}) {
  if (!account) return undefined;
  const reader = createCodexUsageReader(cliBinary, 30_000, binary => read(binary, account), options);
  return async (force = false, contextKey = '') => ({ ...await reader(force, contextKey), sourceLabel: `ChatGPT · ${account}` });
}

function asFiniteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asCreditBalance(value: unknown) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

const creditBlockingLimitTypes = new Set([
  'workspace_owner_credits_depleted',
  'workspace_member_credits_depleted',
  'workspace_owner_usage_limit_reached',
  'workspace_member_usage_limit_reached',
]);

function normalizeCredits(snapshot: RateLimitSnapshotPayload | null | undefined): AgentUsageCredits | undefined {
  const raw = snapshot?.credits;
  if (!raw || typeof raw !== 'object') return undefined;
  const blocked = snapshot?.spendControlReached === true
    || (typeof snapshot?.rateLimitReachedType === 'string' && creditBlockingLimitTypes.has(snapshot.rateLimitReachedType));
  const unlimited = !blocked && raw.unlimited === true;
  const balance = asCreditBalance(raw.balance);
  const hasCredits = !blocked && (unlimited || (raw.hasCredits === true && (balance === null || balance > 0)));
  if (!hasCredits && !unlimited && (balance === null || balance <= 0)) return undefined;
  return {
    hasCredits,
    ...(unlimited ? { unlimited: true } : {}),
    balance,
  };
}

function normalizeWindow(value: RateLimitWindowPayload | null | undefined): AgentUsageWindow | undefined {
  if (!value) return undefined;
  const usedPercent = asFiniteNumber(value.usedPercent);
  if (usedPercent === null) return undefined;
  const boundedUsed = Math.min(100, Math.max(0, usedPercent));
  return {
    usedPercent: boundedUsed,
    remainingPercent: 100 - boundedUsed,
    windowDurationMins: asFiniteNumber(value.windowDurationMins),
    resetsAt: asFiniteNumber(value.resetsAt),
  };
}

function normalizeSnapshot(snapshot: RateLimitSnapshotPayload | null | undefined, checkedAt: string): AgentUsageLimits {
  const primary = normalizeWindow(snapshot?.primary);
  const secondary = normalizeWindow(snapshot?.secondary);
  const credits = normalizeCredits(snapshot);
  if (!snapshot || (!primary && !secondary && !credits)) return { available: false, checkedAt, message: '额度暂不可用' };
  return {
    available: true,
    checkedAt,
    planType: typeof snapshot.planType === 'string' ? snapshot.planType : undefined,
    primary,
    secondary,
    ...(credits ? { credits } : {}),
  };
}

export function normalizeCodexUsage(value: RateLimitsResponsePayload, checkedAt = new Date().toISOString()): CodexUsageSnapshot {
  const byId = value.rateLimitsByLimitId;
  // 不把 API 窗口误展示成 Codex 套餐窗口；未知 limit id 仍沿用旧的兼容回退。
  const codexEntry = byId
    ? Object.entries(byId).find(([key]) => key.toLowerCase() === 'codex')
      || Object.entries(byId).find(([key]) => key.toLowerCase() !== 'api')
    : undefined;
  const snapshot = codexEntry?.[1] || value.rateLimits;
  const result = normalizeSnapshot(snapshot, checkedAt) as CodexUsageSnapshot;
  const apiEntry = byId && Object.entries(byId).find(([key]) => key.toLowerCase() === 'api');
  if (apiEntry) result.apiUsage = normalizeSnapshot(apiEntry[1], checkedAt);
  return result;
}

export async function requestCodexUsage(binary: string, timeoutMs = 15_000): Promise<CodexUsageSnapshot> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env: codexChildEnvironment(),
    });
    let buffer = '';
    let outputSize = 0;
    let settled = false;
    let childClosed = false;
    const finish = (error?: Error, value?: AgentUsageLimits) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const settle = () => { if (error) reject(error); else resolve(value!); };
      if (childClosed) { settle(); return; }
      // A retry starts only after this process releases its connection and account state.
      child.once('close', settle);
      child.stdin.end();
      child.kill();
      const forceKill = setTimeout(() => child.kill('SIGKILL'), 1000);
      forceKill.unref();
      child.once('close', () => clearTimeout(forceKill));
    };
    const timer = setTimeout(() => finish(new Error('Codex 额度读取超时')), timeoutMs);

    child.once('error', (error) => finish(error));
    child.stdin.on('error', (error) => finish(error));
    child.once('close', (code) => {
      childClosed = true;
      if (!settled) finish(new Error(`Codex 额度读取进程退出（${code ?? '未知'}）`));
    });
    child.stderr.on('data', () => { /* app-server 诊断不返回到前端 */ });
    child.stdout.on('data', (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > 1_000_000) { finish(new Error('Codex 额度返回过大')); return; }
      buffer += chunk.toString();
      let lineBreak = buffer.indexOf('\n');
      while (lineBreak >= 0) {
        const line = buffer.slice(0, lineBreak).trim();
        buffer = buffer.slice(lineBreak + 1);
        lineBreak = buffer.indexOf('\n');
        if (!line) continue;
        let message: { id?: number; result?: RateLimitsResponsePayload & { account?: { type?: string } | null }; error?: { message?: string } };
        try { message = JSON.parse(line) as typeof message; }
        catch { continue; }
        if (message.id === 1) {
          if (message.error) { finish(new Error('Codex 额度连接初始化失败')); continue; }
          child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
          child.stdin.write(`${JSON.stringify({ id: 2, method: 'account/read', params: { refreshToken: false } })}\n`);
        }
        if (message.id === 2) {
          if (message.error) { finish(new Error(message.error.message || 'Codex 登录状态读取失败')); continue; }
          const accountType = message.result?.account?.type;
          if (accountType !== 'chatgpt') {
            finish(undefined, { available: false, checkedAt: new Date().toISOString(), errorKind: accountType === 'apiKey' ? 'unavailable' : 'authentication', message: accountType === 'apiKey'
              ? '当前 CLI 使用 API 密钥，不提供 ChatGPT 套餐额度' : '当前 CLI 未使用 ChatGPT 登录，无法读取套餐额度' });
            continue;
          }
          child.stdin.write(`${JSON.stringify({ id: 3, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } })}\n`);
        }
        if (message.id === 3) {
          if (message.error) finish(new Error(message.error.message || 'Codex 额度读取失败'));
          else finish(undefined, normalizeCodexUsage(message.result || {}));
        }
      }
    });
    child.stdin.write(`${JSON.stringify({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'delivery-workspace', title: 'Delivery Workspace', version: '0.1.0' }, capabilities: {} },
    })}\n`);
  });
}

export function createCodexUsageReader(binary = cliBinary, ttlMs = 30_000, read: (binary: string) => Promise<CodexUsageSnapshot> = requestCodexUsage,
  options: ReaderOptions = {}) {
  const clock = options.now || Date.now;
  const failureTtlMs = options.failureTtlMs ?? 5_000, staleMs = options.staleMs ?? 5 * 60_000;
  let cached: { expiresAt: number; value: CodexUsageSnapshot } | undefined;
  let pending: Promise<CodexUsageSnapshot> | undefined;
  let lastSuccess: { at: number; value: CodexUsageSnapshot } | undefined;
  let context = '', generation = 0;
  return (force = false, contextKey = ''): Promise<CodexUsageSnapshot> => {
    // Account changes invalidate both cached data and in-flight writes from the old account.
    if (contextKey !== context) { context = contextKey; generation++; cached = undefined; lastSuccess = undefined; pending = undefined; }
    if (pending) return pending;
    if (!force && cached && cached.expiresAt > clock()) return Promise.resolve(cached.value);
    const requestedGeneration = generation;
    const transient = (value: CodexUsageSnapshot) => !value.available && ['timeout', 'network'].includes(value.errorKind || '');
    const request = () => Promise.resolve().then(() => read(binary))
      .catch(error => usageFailure(error, new Date(clock()).toISOString()));
    pending = (async () => {
      let value = await request();
      if (transient(value) && generation === requestedGeneration) value = await request();
      if (generation !== requestedGeneration) return value;
      const at = clock();
      if (value.available && !value.stale) {
        value = { ...value, lastSuccessAt: value.checkedAt };
        lastSuccess = { at, value };
      } else {
        // Logout, API-key mode, and unknown failures cannot borrow a previous account's quota.
        if (!transient(value)) lastSuccess = undefined;
        const retryAt = new Date(at + failureTtlMs).toISOString();
        if (lastSuccess && at - lastSuccess.at < staleMs) {
          const { checkedAt, errorKind, message } = value;
          value = { ...lastSuccess.value, checkedAt, stale: true, lastSuccessAt: lastSuccess.value.checkedAt, errorKind, message, retryAt,
            ...(lastSuccess.value.apiUsage?.available ? { apiUsage: { ...lastSuccess.value.apiUsage, checkedAt, stale: true,
              lastSuccessAt: lastSuccess.value.apiUsage.checkedAt, errorKind, message, retryAt } } : {}) };
        } else value = { ...value, retryAt };
      }
      cached = { value, expiresAt: Math.min(at + (value.available && !value.stale ? ttlMs : failureTtlMs),
        value.stale && lastSuccess ? lastSuccess.at + staleMs : Infinity) };
      return value;
    })().finally(() => { if (generation === requestedGeneration) pending = undefined; });
    return pending;
  };
}
