import { computed, getCurrentInstance, h, onScopeDispose, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ElButton, ElMessage, ElMessageBox, ElNotification } from 'element-plus';
import { isWorkspaceVersion, workspaceVersionState, type WorkspaceBuild } from '../../../shared/workspace-version';
import { isWorkspaceRestartPending, useWorkspaceRestart } from './useWorkspaceRestart';
import WorkspaceRestartButton from './WorkspaceRestartButton.vue';

declare const __DELIVERY_BUILD__: WorkspaceBuild;
export const loadedWorkspaceBuild = __DELIVERY_BUILD__;

export async function reloadWorkspacePage() {
  try {
    await ElMessageBox.confirm('请先保存未发送内容。确认重新加载页面以使用最新构建？', '刷新工作台', {
      confirmButtonText: '重新加载', cancelButtonText: '暂不刷新', type: 'warning', closeOnClickModal: false,
    });
    window.location.reload();
  } catch { /* 取消时保留当前页面和草稿。 */ }
}

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
  const { query, state } = useWorkspaceVersion();
  const { query: restartQuery } = useWorkspaceRestart();
  const appContext = getCurrentInstance()?.appContext;
  let notification: ReturnType<typeof ElNotification> | undefined;
  let notified = '';
  watch(restartQuery.data, async (current, previous) => {
    if (current?.status === 'failed' && (previous?.status !== 'failed' || previous.message !== current.message)) ElMessage.error(current.message);
    if (current?.status !== 'idle' || !isWorkspaceRestartPending(previous)) return;
    if (current.startedAt === previous?.startedAt) {
      await query.refetch();
      if (current.message) ElMessage.success(current.message);
      return;
    }
    const result = await query.refetch();
    if (result.error || !result.data?.frontend) { ElMessage.warning('后端已重新启动，版本信息暂时无法核验，请稍后检查版本。'); return; }
    if (result.data.buildError) ElMessage.error(result.data.buildError);
    else if (result.data.backend.sourceHash === result.data.frontend.backendSourceHash) ElMessage.success('重启和页面构建已完成，保存草稿后刷新即可使用新版。');
    else if (result.data.backend.diskSourceHash === result.data.backend.sourceHash) ElMessage.warning('页面版本尚未更新，可再次点击更新工作台。');
    else ElMessage.warning('后端已重新启动，运行版本仍待更新，请检查服务启动配置。');
  });
  watch([state, query.data], ([current, version]) => {
    const key = `${current.status}:${version?.frontend?.id || ''}`;
    if (!current.refreshRequired && !current.restartRequired && !current.buildRequired) { notification?.close(); return; }
    if (key === notified) return;
    notified = key;
    notification?.close();
    const message = current.restartRequired || current.buildRequired
      ? h('div', [h('p', version?.buildError || '更新会先构建页面。后端需要重启时，工作台会保存任务并在重启后继续。'), h(WorkspaceRestartButton)])
      : h(ElButton, { size: 'small', type: 'primary', onClick: reloadWorkspacePage }, () => '保存草稿后刷新');
    notification = ElNotification({ title: current.label, message, type: 'warning', duration: 0 }, appContext);
  }, { immediate: true });
  onScopeDispose(() => notification?.close());
}
