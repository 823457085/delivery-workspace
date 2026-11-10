/** 只读取 CLI 初始化返回的模型目录，不发送用户消息或创建持久会话。 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentModelOption, AgentReasoningEffort } from '../shared/agent-runtime.js';
import { claudeBinary, claudeChildEnvironment } from './cli-runtime.js';

export const claudeDefaultModel: AgentModelOption = { id: '', label: 'Claude Code 默认' };
const claudeEfforts: AgentReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function normalizeClaudeModels(data: unknown): AgentModelOption[] {
  if (!Array.isArray(data)) throw new Error('Claude 模型响应无效');
  const models = new Map<string, AgentModelOption>();
  for (const item of data) {
    if (!item || typeof item.value !== 'string' || !item.value.trim()
      || typeof item.displayName !== 'string' || !item.displayName.trim()) continue;
    const efforts = item.supportsEffort === true && Array.isArray(item.supportedEffortLevels)
      ? [...new Set<AgentReasoningEffort>(item.supportedEffortLevels.filter((effort: unknown): effort is AgentReasoningEffort =>
        claudeEfforts.includes(effort as AgentReasoningEffort)))] : [];
    models.set(item.value, { id: item.value, label: item.displayName, ...(efforts.length ? { efforts } : {}) });
  }
  if (!models.size) throw new Error('Claude 未返回可用模型');
  // 空值沿用当前配置；CLI 的 default 选项有自己的 ID，不能与当前配置混为一项。
  return [claudeDefaultModel, ...models.values()];
}

export function requestClaudeModels(binary = claudeBinary, timeoutMs = 8000): Promise<AgentModelOption[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--settings', '{"disableAllHooks":true}', '--tools', '', '--no-chrome', '--permission-prompts', 'none'],
    { stdio: ['pipe', 'pipe', 'pipe'], env: claudeChildEnvironment(), shell: false });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    let bytes = 0;
    const finish = (error?: Error, models?: AgentModelOption[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      child.kill();
      const forceKill = setTimeout(() => child.kill('SIGKILL'), 1000);
      forceKill.unref();
      child.once('close', () => clearTimeout(forceKill));
      if (error) reject(error); else resolve(models!);
    };
    const timer = setTimeout(() => finish(new Error('Claude 模型读取超时')), timeoutMs);
    child.on('error', () => finish(new Error('Claude 模型连接失败')));
    child.on('close', () => finish(new Error('Claude 模型连接提前结束')));
    child.stdin.on('error', () => finish(new Error('Claude 模型连接已关闭')));
    child.stderr.on('data', () => { /* 不向前端暴露账户或环境诊断。 */ });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2_000_000) finish(new Error('Claude 模型返回过大'));
    });
    lines.on('line', line => {
      if (settled) return;
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message?.type !== 'control_response' || message.response?.request_id !== 'models') return;
      if (message.response.subtype !== 'success') { finish(new Error('Claude 模型查询失败')); return; }
      try { finish(undefined, normalizeClaudeModels(message.response.response?.models)); }
      catch (error) { finish(error as Error); }
    });
    child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'models', request: { subtype: 'initialize', hooks: {} } })}\n`);
  });
}
