import { computed, getCurrentInstance, h, onScopeDispose, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ElButton, ElMessage, ElNotification } from 'element-plus';
import { isWorkspaceVersion, workspaceVersionState, type WorkspaceBuild } from '../../../shared/workspace-version';
import { consumeUserInitiatedRestart, isWorkspaceRestartPending, useWorkspaceRestart } from './useWorkspaceRestart';
import WorkspaceRestartButton from './WorkspaceRestartButton.vue';

declare const __DELIVERY_BUILD__: WorkspaceBuild;
export const loadedWorkspaceBuild = __DELIVERY_BUILD__;

function hasUnsavedComposerDraft(): boolean {
  if (typeof document === 'undefined') return false;
  const fields = document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>('textarea, input[type="text"]');
  for (const field of fields) {
    if (field.disabled || field.readOnly) continue;
    const text = field.value?.trim();
    if (!text) continue;
    const placeholder = field.getAttribute('placeholder') || '';
    if (placeholder.includes('搜索') || placeholder.includes('筛选') || placeholder.includes('过滤')) continue;
    if (field.offsetParent !== null) return true;
  }
  return false;
}

export function reloadWorkspacePage() {
  window.location.reload();
}

export function useWorkspaceVersion() {
  const query = useQuery({
    queryKey: ['workspace-version'],
    queryFn: async ({ signal }) => {
      const response = await fetch('/api/health', { signal, cache: 'no-store' });
      if (!response.ok) throw new Error('版本信息暂时无法读取');
      const value = await response.json();
      if (!isWorkspaceVersion(value.version)) throw new Error('当前服务尚未提供版本信息');
      return value.version;
    },
    staleTime: 20_000,
    refetchInterval: 45_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const state = computed(() => workspaceVersionState(loadedWorkspaceBuild, query.error.value ? undefined : query.data.value));
  return { query, state, loaded: loadedWorkspaceBuild };
}

// 仅 App 挂载通知；所有页面共用查询缓存，草稿未保存时绝不强制丢失输入内容。
export function useWorkspaceVersionNotice() {
  const { query, state } = useWorkspaceVersion();
  const { query: restartQuery } = useWorkspaceRestart();
  const appContext = getCurrentInstance()?.appContext;
  let notification: ReturnType<typeof ElNotification> | undefined;
  let notified = '';
  watch(restartQuery.data, async (current, previous) => {
    if (current?.status === 'failed' && (previous?.status !== 'failed' || previous.message !== current.message)) {
      ElMessage.error(current.message);
    }
    if (current?.status !== 'idle' || !isWorkspaceRestartPending(previous)) return;
    const initiatedHere = consumeUserInitiatedRestart();
    if (current.startedAt === previous?.startedAt) {
      const result = await query.refetch();
      if (initiatedHere && result.data?.frontend && loadedWorkspaceBuild.id !== result.data.frontend.id && !hasUnsavedComposerDraft()) {
        ElMessage.success('页面构建已完成，正在自动加载新版界面…');
        setTimeout(() => window.location.reload(), 180);
        return;
      }
      if (current.message) ElMessage.success(current.message);
      return;
    }
    const result = await query.refetch();
    if (result.error || !result.data?.frontend) {
      ElMessage.warning('后端已重新启动，版本信息正在同步，请稍候。');
      return;
    }
    if (result.data.buildError) {
      ElMessage.error(result.data.buildError);
    } else if (result.data.backend.sourceHash === result.data.frontend.backendSourceHash) {
      if (loadedWorkspaceBuild.id === result.data.frontend.id) {
        notification?.close();
        ElMessage.success('后端已完成快速重启，无需刷新页面即可继续使用。');
      } else if (initiatedHere && !hasUnsavedComposerDraft()) {
        notification?.close();
        ElMessage.success('服务重启完成，正在自动加载新版工作台…');
        setTimeout(() => window.location.reload(), 180);
      } else {
        ElMessage.success('重启已完成；检测到输入框有草稿，发送后点击「立即刷新」即可。');
      }
    } else if (result.data.backend.diskSourceHash === result.data.backend.sourceHash) {
      ElMessage.warning('页面版本尚未更新，可再次点击更新工作台。');
    } else {
      ElMessage.warning('后端已重新启动，运行版本仍待更新，请检查服务启动配置。');
    }
  });
  watch([state, query.data, restartQuery.data], ([current, version, restart]) => {
    const hosted = restart?.supervisor === 'systemd';
    const key = `${current.status}:${version?.frontend?.id || ''}:${hosted}`;
    if (!current.refreshRequired && !current.restartRequired && !current.buildRequired) {
      notification?.close();
      notified = '';
      return;
    }
    if (key === notified) return;
    notified = key;
    notification?.close();
    const hintText = version?.buildError
      || (current.restartRequired && !current.buildRequired
        ? '页面产物已是最新（无需重新打包），点击即可保存会话状态并快速重启后端。'
        : '将增量校验构建并平滑同步后端，当前会话与任务会在重启后自动恢复。');
    const hostedBuildRequired = hosted && current.buildRequired;
    const message = hostedBuildRequired
      ? (version?.buildError || '当前服务器需要发布与源码匹配的页面产物。')
      : current.restartRequired || current.buildRequired
      ? h('div', [h('p', { style: 'margin: 0 0 8px; line-height: 1.5;' }, hintText), h(WorkspaceRestartButton)])
      : h(ElButton, { size: 'small', type: 'primary', onClick: reloadWorkspacePage }, () => '立即刷新页面');
    notification = ElNotification({ title: hostedBuildRequired ? '服务器页面待发布' : current.label, message, type: 'warning', duration: 0, position: 'bottom-right', offset: 48 }, appContext);
  }, { immediate: true });
  onScopeDispose(() => notification?.close());
}
