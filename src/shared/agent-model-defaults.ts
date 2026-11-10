/**
 * 设计说明：设置页与会话、分叉、日报和联调入口共用浏览器模型偏好；不改 CLI 配置或已提交的任务。
 * 应用版本使一次统一切换覆盖旧会话偏好，随后仍允许单会话改选；沿用本地偏好存储，不新增后端配置服务。
 */
import { readonly, shallowRef } from 'vue';
import { agentProviderLabels, codexWorkbenchDefaults, type AgentModelDefaults, type AgentRuntimeHealth } from '../../shared/agent-runtime';

export const agentModelDefaultsKey = 'agent-model-defaults:v1';
export interface SavedAgentModelDefaults extends AgentModelDefaults { revision: string }
const initial: SavedAgentModelDefaults = { model: codexWorkbenchDefaults.model, reasoningEffort: codexWorkbenchDefaults.reasoningEffort, revision: '' };

export function readAgentModelDefaults(storage: Pick<Storage, 'getItem'>): SavedAgentModelDefaults {
  try {
    const value = JSON.parse(storage.getItem(agentModelDefaultsKey) || 'null');
    if (value && typeof value.model === 'string' && typeof value.revision === 'string'
      && (value.provider === undefined || Object.hasOwn(agentProviderLabels, value.provider))
      && ['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value.reasoningEffort)) return value;
  } catch { /* 无效或不可用的存储沿用工作台初始值。 */ }
  return { ...initial };
}

function readBrowserDefaults() {
  try { return readAgentModelDefaults(window.localStorage); }
  catch { return { ...initial }; }
}
const defaults = shallowRef(readBrowserDefaults());
export const agentModelDefaults = readonly(defaults);
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key === agentModelDefaultsKey || event.key === null) defaults.value = readBrowserDefaults();
});

export function applyAgentModelDefaults(selection: AgentModelDefaults, runtime: AgentRuntimeHealth | undefined,
  storage: Pick<Storage, 'setItem'> = window.localStorage) {
  const model = runtime?.provider === (selection.provider || 'codex') && runtime.models.find(item => item.id === selection.model);
  if (!model || (model.efforts?.length
    ? !model.efforts.includes(selection.reasoningEffort as Exclude<AgentModelDefaults['reasoningEffort'], ''>)
    : selection.reasoningEffort !== '')) throw new Error('请选择当前模型支持的推理强度');
  const next: SavedAgentModelDefaults = { ...(selection.provider ? { provider: selection.provider } : {}), model: selection.model, reasoningEffort: selection.reasoningEffort,
    revision: `${Date.now()}-${Math.random().toString(36).slice(2)}` };
  try { storage.setItem(agentModelDefaultsKey, JSON.stringify(next)); }
  catch { throw new Error('浏览器存储不可用，模型配置尚未保存'); }
  defaults.value = next;
}
