/**
 * 设计说明：额度只通过本机已登录 Codex app-server 读取，不触碰认证文件，也不从历史会话推测。
 * 模块边界是将 app-server 协议结果收敛为面板需要的百分比和重置时间；不向浏览器暴露账户 ID 或积分明细。
 * 不直接读取 JSONL 会话文件，因为那只是某次运行的快照，不能代表当前额度。
 */
import { spawn } from 'node:child_process';
import type { AgentUsageLimits, AgentUsageWindow } from '../shared/agent-runtime.js';
import { cliBinary, codexChildEnvironment } from './cli-runtime.js';

interface RateLimitWindowPayload {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
}

interface RateLimitSnapshotPayload {
  planType?: unknown;
  primary?: RateLimitWindowPayload | null;
  secondary?: RateLimitWindowPayload | null;
}

interface RateLimitsResponsePayload {
  rateLimits?: RateLimitSnapshotPayload;
  rateLimitsByLimitId?: Record<string, RateLimitSnapshotPayload> | null;
}

function asFiniteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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

export function normalizeCodexUsage(value: RateLimitsResponsePayload, checkedAt = new Date().toISOString()): AgentUsageLimits {
  const byId = value.rateLimitsByLimitId;
  const snapshot = byId?.codex || (byId ? Object.values(byId)[0] : undefined) || value.rateLimits;
  const primary = normalizeWindow(snapshot?.primary);
  const secondary = normalizeWindow(snapshot?.secondary);
  if (!snapshot || (!primary && !secondary)) return { available: false, checkedAt, message: '额度暂不可用' };
  return {
    available: true,
    checkedAt,
    planType: typeof snapshot.planType === 'string' ? snapshot.planType : undefined,
    primary,
    secondary,
  };
}

async function requestCodexUsage(binary: string): Promise<AgentUsageLimits> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env: codexChildEnvironment(),
    });
    let buffer = '';
    let outputSize = 0;
    let settled = false;
    const finish = (error?: Error, value?: AgentUsageLimits) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error('Codex 额度读取超时')), 8_000);

    child.once('error', (error) => finish(error));
    child.once('exit', (code) => {
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
        let message: { id?: number; result?: RateLimitsResponsePayload; error?: { message?: string } };
        try { message = JSON.parse(line) as typeof message; }
        catch { continue; }
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
          child.stdin.write(`${JSON.stringify({ id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } })}\n`);
        }
        if (message.id === 2) {
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

export function createCodexUsageReader(binary = cliBinary, ttlMs = 30_000) {
  let cached: { expiresAt: number; value: AgentUsageLimits } | undefined;
  let pending: Promise<AgentUsageLimits> | undefined;
  return async () => {
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (pending) return pending;
    pending = requestCodexUsage(binary)
      .catch((): AgentUsageLimits => ({ available: false, checkedAt: new Date().toISOString(), message: '额度暂不可用' }))
      .then((value) => {
        cached = { expiresAt: Date.now() + ttlMs, value };
        return value;
      })
      .finally(() => { pending = undefined; });
    return pending;
  };
}
