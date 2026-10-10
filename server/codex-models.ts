/**
 * 模型与推理档位以已登录 CLI 的 model/list 为准，不维护版本白名单。
 * 独立只读连接不接触运行中的会话；短缓存合并并发查询，失败保留最后成功结果。
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { agentReasoningEfforts, type AgentModelOption, type AgentReasoningEffort } from '../shared/agent-runtime.js';
import { cliBinary, codexChildEnvironment } from './cli-runtime.js';

type JsonObject = Record<string, unknown>;
export interface CodexModelCatalog {
  models: AgentModelOption[]; defaultModel: string; message?: string;
  configuredModel?: string; configuredServiceTier?: string | null;
}
const cliDefault: AgentModelOption = { id: '', label: 'CLI 默认（当前配置）' };
const object = (value: unknown): JsonObject => value && typeof value === 'object' ? value as JsonObject : {};
const effort = (value: unknown): value is AgentReasoningEffort => agentReasoningEfforts.includes(value as AgentReasoningEffort);

export function normalizeCodexModels(data: unknown[], config?: JsonObject): CodexModelCatalog {
  const models = new Map<string, AgentModelOption>();
  let defaultModel = '';
  for (const value of data) {
    const item = object(value);
    if (item.hidden === true || typeof item.model !== 'string' || !item.model.trim()) continue;
    const id = item.model.trim();
    const efforts = [...new Set((Array.isArray(item.supportedReasoningEfforts) ? item.supportedReasoningEfforts : [])
      .map(option => object(option).reasoningEffort).filter(effort))];
    const defaultEffort = effort(item.defaultReasoningEffort) && efforts.includes(item.defaultReasoningEffort)
      ? item.defaultReasoningEffort : efforts[0];
    const serviceTiers = (Array.isArray(item.serviceTiers) ? item.serviceTiers : []).map(object)
      .filter((tier): tier is { id: string; name: string; description: string } => typeof tier.id === 'string' && !!tier.id
        && typeof tier.name === 'string' && !!tier.name && typeof tier.description === 'string')
      .map(({ id, name, description }) => ({ id, name, description }));
    models.set(id, { id, label: typeof item.displayName === 'string' && item.displayName ? item.displayName : id,
      efforts, ...(defaultEffort ? { defaultEffort } : {}), ...(serviceTiers.length ? { serviceTiers } : {}),
      ...(typeof item.defaultServiceTier === 'string' && item.defaultServiceTier ? { defaultServiceTier: item.defaultServiceTier } : {}) });
    if (item.isDefault === true) defaultModel = id;
  }
  if (!models.size) throw new Error('Codex 未返回可用模型');
  // CLI 默认由本机配置决定，不把目录推荐模型的推理能力误套到配置中的其他模型。
  return { models: [cliDefault, ...models.values()], defaultModel,
    ...(typeof config?.model === 'string' ? { configuredModel: config.model } : {}),
    ...(config && 'service_tier' in config && (config.service_tier === null || typeof config.service_tier === 'string')
      ? { configuredServiceTier: config.service_tier ?? null } : {}) };
}

export function requestCodexModels(binary = cliBinary, args = ['app-server', '--stdio'], timeoutMs = 8000): Promise<CodexModelCatalog> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], env: codexChildEnvironment(), shell: false });
    const lines = createInterface({ input: child.stdout });
    const items: unknown[] = [];
    const cursors = new Set<string>();
    let requestId = 1;
    let readingConfig = false;
    let settled = false;
    let bytes = 0;
    const finish = (error?: Error, value?: CodexModelCatalog) => {
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
    const timer = setTimeout(() => finish(new Error('Codex 模型读取超时')), timeoutMs);
    const write = (message: JsonObject) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.on('error', () => finish(new Error('Codex 模型连接失败')));
    child.on('close', () => finish(new Error('Codex 模型连接提前结束')));
    child.stdin.on('error', () => finish(new Error('Codex 模型连接已关闭')));
    child.stderr.on('data', () => { /* 不向前端暴露账户或环境诊断。 */ });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2_000_000) finish(new Error('Codex 模型返回过大'));
    });
    lines.on('line', line => {
      if (settled) return;
      let message: JsonObject;
      try { message = object(JSON.parse(line)); } catch { return; }
      if (message.id !== requestId || message.method) return;
      if (readingConfig) {
        try { finish(undefined, normalizeCodexModels(items, message.error ? undefined : object(object(message.result).config))); }
        catch (error) { finish(error as Error); }
        return;
      }
      if (message.error) { finish(new Error('Codex 模型查询失败')); return; }
      if (requestId === 1) {
        write({ method: 'initialized' });
        write({ id: ++requestId, method: 'model/list', params: { limit: 100, includeHidden: false } });
        return;
      }
      const result = object(message.result);
      if (!Array.isArray(result.data)) { finish(new Error('Codex 模型响应无效')); return; }
      items.push(...result.data);
      const cursor = result.nextCursor;
      if (typeof cursor === 'string' && cursor) {
        if (cursors.has(cursor) || cursors.size >= 20) { finish(new Error('Codex 模型分页异常')); return; }
        cursors.add(cursor);
        write({ id: ++requestId, method: 'model/list', params: { limit: 100, includeHidden: false, cursor } });
      } else {
        // 只投影模型和速度配置，认证、工具配置及其他本地设置不进入前端响应。
        readingConfig = true;
        write({ id: ++requestId, method: 'config/read', params: { includeLayers: false } });
      }
    });
    write({ id: 1, method: 'initialize', params: { clientInfo: { name: 'delivery_models', version: '1.0.0' }, capabilities: {} } });
  });
}

export function createCodexModelReader(read = () => requestCodexModels(), ttlMs = 30_000) {
  let cached: CodexModelCatalog | undefined;
  let expiresAt = 0;
  let pending: Promise<CodexModelCatalog> | undefined;
  return async (): Promise<CodexModelCatalog> => {
    if (cached && Date.now() < expiresAt) return cached;
    if (pending) return pending;
    pending = read().then(value => { cached = value; return value; }).catch(() => {
      cached = { ...(cached || { models: [cliDefault], defaultModel: '' }),
        message: cached ? '模型同步失败，暂用上次模型列表' : '模型暂不可用，可使用 CLI 默认或自定义模型' };
      return cached;
    }).finally(() => { expiresAt = Date.now() + ttlMs; pending = undefined; });
    return pending;
  };
}
