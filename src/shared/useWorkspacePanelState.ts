/** 只保留面板的本地筛选状态；离开即卸载查询，不用 KeepAlive 留住后台轮询。独立页面仍使用本地状态。 */
import { inject, onBeforeUnmount, reactive, toRaw, toRefs } from 'vue';
import { agentWorkspaceContext } from './agent-workspace-context';

export function useWorkspacePanelState<T extends object>(key: string, initial: () => T) {
  const workspace = inject(agentWorkspaceContext, undefined);
  const state = reactive((workspace?.readState(key) as T | undefined) ?? initial());
  onBeforeUnmount(() => workspace?.saveState(key, toRaw(state)));
  return toRefs(state);
}
