import { computed, onScopeDispose, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ElNotification } from 'element-plus';
import { isWorkspaceVersion, workspaceVersionState, type WorkspaceBuild } from '../../../shared/workspace-version';

declare const __DELIVERY_BUILD__: WorkspaceBuild;
export const loadedWorkspaceBuild = __DELIVERY_BUILD__;

export function useWorkspaceVersion() {
  const query = useQuery({ queryKey: ['workspace-version'], queryFn: async ({ signal }) => {
    const response = await fetch('/api/health', { signal, cache: 'no-store' });
    if (!response.ok) throw new Error('版本信息暂时无法读取');
    const value = await response.json();
    if (!isWorkspaceVersion(value.version)) throw new Error('当前服务尚未提供版本信息');
    return value.version;
  }, staleTime: 30_000, refetchInterval: 60_000, refetchIntervalInBackground: false, refetchOnWindowFocus: true, retry: false });
  const state = computed(() => workspaceVersionState(loadedWorkspaceBuild, query.error.value ? undefined : query.data.value));
  return { query, state, loaded: loadedWorkspaceBuild };
}

// 仅 App 挂载通知；所有页面共用查询缓存，升级不会触发刷新或覆盖输入内容。
export function useWorkspaceVersionNotice() {
  const { query, state, loaded } = useWorkspaceVersion();
  let notification: ReturnType<typeof ElNotification> | undefined;
  let notified = '';
  watch([state, query.data], ([current, version]) => {
    const key = `${current.status}:${version?.frontend?.id || ''}`;
    if (!current.refreshRequired && !current.restartRequired) { notification?.close(); return; }
    if (key === notified) return;
    notified = key;
    notification?.close();
    const message = current.restartRequired
      ? '页面构建与正在运行的后端版本不同。请在当前任务结束后更新后端服务；刷新页面不能替代服务重启。'
      : `当前页面 ${loaded.id.slice(0, 8)}，最新构建 ${version!.frontend!.id.slice(0, 8)}。请先保存草稿，再手动刷新页面。`;
    notification = ElNotification({ title: current.label, message, type: 'warning', duration: 0 });
  }, { immediate: true });
  onScopeDispose(() => notification?.close());
}
