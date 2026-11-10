/** Explicit online channels; credentials and native dsh sessions are never transferred. */
import { createResponsesModelAdapter, normalizeResponsesBaseUrl, type ResponsesModelOptions } from './responses-model-runtime.js';
import type { AgentRuntimeAdapter } from './agent-runtime.js';
export { nvidiaDeepseekModelId } from './responses-model-runtime.js';
export const nvidiaDeepseekBaseUrl = 'https://integrate.api.nvidia.com/v1';
export const deepseekBoundaryBlocker = 'dsh 原生工具未通过隔离准入，保持禁用；DeepSeek 使用独立官方 API 配置';
export const normalizeDeepseekBaseUrl = (value: string) => normalizeResponsesBaseUrl(
  value.trim().replace(/\/+$/, '') === nvidiaDeepseekBaseUrl ? 'nvidia' : 'deepseek', value);
export function createDeepseekAdapter(options: ResponsesModelOptions): AgentRuntimeAdapter {
  const official = createResponsesModelAdapter('deepseek', { ...options,
    models: () => options.models().filter(model => model.api?.baseUrl !== nvidiaDeepseekBaseUrl) });
  const nvidia = createResponsesModelAdapter('deepseek', { ...options,
    models: () => options.models().filter(model => model.api?.baseUrl === nvidiaDeepseekBaseUrl) }, 'nvidia');
  return {
    id: 'deepseek',
    async health() {
      if (!options.models().some(model => model.api?.baseUrl === nvidiaDeepseekBaseUrl)) return official.health();
      const free = await nvidia.health();
      if (!options.models().some(model => model.api?.baseUrl !== nvidiaDeepseekBaseUrl)) return free;
      const paid = await official.health();
      return { ...free, label: 'DeepSeek', models: [...free.models, ...paid.models], ready: free.ready || paid.ready,
        writable: free.writable || paid.writable, authenticated: free.authenticated || paid.authenticated,
        message: `${free.message}；${paid.message}` };
    },
    execute(context) {
      const model = options.models().find(item => item.id === context.run.customModelId && item.modelId === context.run.model);
      return (model?.api?.baseUrl === nvidiaDeepseekBaseUrl ? nvidia : official).execute(context);
    },
  };
}
