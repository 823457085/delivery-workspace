/**
 * 设计说明：打开会话从当前布局的默认页签开始，只在当前打开期间保留手动选择。
 * 仅监听会话标识，避免实时数据刷新抢走页签；不恢复旧的持久化选择。
 */
import { shallowRef, watch } from 'vue';

export type AgentSidePanelTab = 'result' | 'execution' | 'context' | 'knowledge' | 'workflow' | 'delivery';

export function useAgentSidePanelTab(conversationId: () => string | undefined, defaultTab: () => AgentSidePanelTab = () => 'execution') {
  const active = shallowRef<AgentSidePanelTab>(defaultTab());
  watch([conversationId, defaultTab], () => { active.value = defaultTab(); });
  return active;
}
