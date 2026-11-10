/** xAI Responses adapter; endpoint and supported options are fixed by the host. */
import { createResponsesModelAdapter, normalizeResponsesBaseUrl, type ResponsesModelOptions } from './responses-model-runtime.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentRuntimeAdapter } from './agent-runtime.js';
export const normalizeGrokBaseUrl = (value: string) => normalizeResponsesBaseUrl('grok', value);
export function createGrokAdapter(options: ResponsesModelOptions & { buildBinary?: string }): AgentRuntimeAdapter {
  const api = createResponsesModelAdapter('grok', options);
  return {
    id: 'grok',
    async health() {
      if (options.models().length) return api.health();
      const candidate = options.buildBinary || process.env.DELIVERY_GROK_BIN || path.resolve('.local/provider-tools/grok/grok');
      const installed = await fs.stat(candidate).then(info => info.isFile(), () => false);
      return { provider: 'grok', label: 'Grok Build（免费额度）', binary: installed ? candidate : '', version: '',
        authenticated: false, ready: false, writable: false, modes: ['agent', 'ask', 'plan'], accessModes: ['workspace'],
        models: [], defaultModel: '', checkedAt: new Date().toISOString(),
        message: installed ? '已发现 Grok Build CLI；登录、免费额度、配置隔离及本机工具边界尚未验收，执行保持禁用'
          : '未找到工作区内 Grok Build CLI；免费通道尚未通过执行准入，未使用付费 API 兜底' };
    },
    async execute(context) {
      if (!options.models().length) throw new Error('Grok Build 免费通道的认证、配置隔离与工具边界尚未验收，未启动原生工具');
      return api.execute(context);
    },
  };
}
