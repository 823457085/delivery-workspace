/**
 * 设计说明：额度只通过本机已登录 Claude Code CLI 的 get_usage 控制请求读取，不读取钥匙串或认证文件。
 * 模块边界是将 5 小时与 7 天窗口收敛为与 Codex 相同的百分比结构；不向浏览器暴露消费明细或使用建议。
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentUsageLimits, AgentUsageWindow } from '../shared/agent-runtime.js';
import { claudeBinary, claudeChildEnvironment } from './cli-runtime.js';

interface ClaudeRateLimitPayload {
  utilization?: unknown;
  resets_at?: unknown;
}

interface ClaudeUsagePayload {
  subscription_type?: unknown;
  rate_limits_available?: unknown;
  rate_limits?: { five_hour?: ClaudeRateLimitPayload | null; seven_day?: ClaudeRateLimitPayload | null } | null;
}

function normalizeWindow(value: ClaudeRateLimitPayload | null | undefined, windowDurationMins: number): AgentUsageWindow | undefined {
  if (!value || typeof value.utilization !== 'number' || !Number.isFinite(value.utilization)) return undefined;
  const usedPercent = Math.min(100, Math.max(0, value.utilization));
  const resetsAtMs = typeof value.resets_at === 'string' ? Date.parse(value.resets_at) : Number.NaN;
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    windowDurationMins,
    resetsAt: Number.isFinite(resetsAtMs) ? Math.floor(resetsAtMs / 1_000) : null,
  };
}

export function normalizeClaudeUsage(value: ClaudeUsagePayload, checkedAt = new Date().toISOString()): AgentUsageLimits {
  const primary = normalizeWindow(value.rate_limits?.five_hour, 300);
  const secondary = normalizeWindow(value.rate_limits?.seven_day, 10_080);
  if (value.rate_limits_available === false || (!primary && !secondary)) return { available: false, checkedAt, message: '额度暂不可用' };
  return {
    available: true,
    checkedAt,
    planType: typeof value.subscription_type === 'string' ? value.subscription_type : undefined,
    primary,
    secondary,
  };
}

function requestClaudeUsage(binary: string, timeoutMs = 10_000): Promise<AgentUsageLimits> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--settings', '{"disableAllHooks":true}', '--tools', '', '--no-chrome', '--permission-prompts', 'none'],
    { stdio: ['pipe', 'pipe', 'pipe'], env: claudeChildEnvironment(), shell: false });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    let bytes = 0;
    const finish = (error?: Error, value?: AgentUsageLimits) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      child.kill();
      const forceKill = setTimeout(() => child.kill('SIGKILL'), 1000);
      forceKill.unref();
      child.once('close', () => clearTimeout(forceKill));
      if (error) reject(error); else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error('Claude 额度读取超时')), timeoutMs);
    child.on('error', () => finish(new Error('Claude 额度连接失败')));
    child.on('close', () => finish(new Error('Claude 额度连接提前结束')));
    child.stdin.on('error', () => finish(new Error('Claude 额度连接已关闭')));
    child.stderr.on('data', () => { /* 不向前端暴露账户或环境诊断。 */ });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2_000_000) finish(new Error('Claude 额度返回过大'));
    });
    lines.on('line', line => {
      if (settled) return;
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message?.type !== 'control_response') return;
      if (message.response?.request_id === 'init') {
        child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'usage', request: { subtype: 'get_usage' } })}\n`);
        return;
      }
      if (message.response?.request_id !== 'usage') return;
      if (message.response.subtype !== 'success') { finish(new Error('Claude 额度查询失败')); return; }
      finish(undefined, normalizeClaudeUsage(message.response.response || {}));
    });
    child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'init', request: { subtype: 'initialize', hooks: {} } })}\n`);
  });
}

export function createClaudeUsageReader(binary = claudeBinary, ttlMs = 60_000) {
  let cached: { expiresAt: number; value: AgentUsageLimits } | undefined;
  let pending: Promise<AgentUsageLimits> | undefined;
  return async (force = false) => {
    if (!force && cached && cached.expiresAt > Date.now()) return cached.value;
    if (pending) return pending;
    pending = requestClaudeUsage(binary)
      .catch((): AgentUsageLimits => ({ available: false, checkedAt: new Date().toISOString(), message: '额度暂不可用' }))
      .then((value) => {
        cached = { expiresAt: Date.now() + ttlMs, value };
        return value;
      })
      .finally(() => { pending = undefined; });
    return pending;
  };
}
