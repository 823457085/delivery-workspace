/** 通知与版本弹层共享更新请求及进度，并在重启窗口主动释放浏览器 SSE 连接槽位。 */
import { computed, shallowRef } from 'vue';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import type { WorkspaceRestartState } from '../../../shared/workspace-restart';
import { resumeSharedEventSources, suspendSharedEventSources } from '../sse/sharedEventSource';

const restartKey = ['workspace-restart'];
const progressLabels: Record<string, string> = {
  building: '增量构建中',
  waiting: '保存状态中',
  restarting: '快速重启中',
};

const watchingRestart = shallowRef(false);
const reconnecting = shallowRef(false);
const userInitiatedRestart = shallowRef(false);
let baselineStartedAt = '';
let watchStartedAtMs = 0;
const WATCH_TIMEOUT_MS = 45_000;

export function isWorkspaceRestartPending(state?: WorkspaceRestartState) {
  return !!state && Object.hasOwn(progressLabels, state.status);
}

export function consumeUserInitiatedRestart(): boolean {
  const value = userInitiatedRestart.value;
  userInitiatedRestart.value = false;
  return value;
}

async function restartResponse(response: Response): Promise<WorkspaceRestartState> {
  if (response.status === 404) throw new Error('当前后端不支持一键重启，请先更新后端服务。');
  const value = await response.json();
  if (!response.ok) throw new Error(value.message || `重启请求失败 (${response.status})`);
  return value;
}

function trackRestartWindow(state: WorkspaceRestartState) {
  if (isWorkspaceRestartPending(state)) {
    if (!watchingRestart.value) {
      watchingRestart.value = true;
      watchStartedAtMs = Date.now();
    }
    if (!baselineStartedAt && state.startedAt) baselineStartedAt = state.startedAt;
    if (state.status === 'restarting') suspendSharedEventSources(12_000);
    reconnecting.value = false;
    return;
  }
  reconnecting.value = false;
  if (watchingRestart.value && (state.status === 'idle' || state.status === 'failed' || state.status === 'unavailable')) {
    watchingRestart.value = false;
    baselineStartedAt = state.startedAt || '';
    resumeSharedEventSources();
  }
}

export function useWorkspaceRestart() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: restartKey,
    queryFn: async ({ signal }): Promise<WorkspaceRestartState> => {
      const timeout = AbortSignal.timeout(watchingRestart.value ? 1500 : 4000);
      const combined = AbortSignal.any ? AbortSignal.any([signal, timeout]) : signal;
      try {
        const state = await restartResponse(await fetch('/api/workspace/restart', { signal: combined, cache: 'no-store' }));
        trackRestartWindow(state);
        return state;
      } catch (error) {
        if (watchingRestart.value && Date.now() - watchStartedAtMs < WATCH_TIMEOUT_MS) {
          reconnecting.value = true;
          const previous = client.getQueryData<WorkspaceRestartState>(restartKey);
          return {
            status: 'restarting',
            message: '新后端正在接管端口，即将恢复连接…',
            startedAt: previous?.startedAt || baselineStartedAt || new Date().toISOString(),
            supervisor: previous?.supervisor,
          };
        }
        watchingRestart.value = false;
        reconnecting.value = false;
        resumeSharedEventSources();
        throw error;
      }
    },
    staleTime: 5_000,
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: current => {
      if (watchingRestart.value || reconnecting.value) return 300;
      if (isWorkspaceRestartPending(current.state.data)) return 350;
      return current.state.error ? 2500 : false;
    },
    refetchIntervalInBackground: true,
  });

  const pendingRequests = useIsMutating({ mutationKey: restartKey });
  const mutation = useMutation({
    mutationKey: restartKey,
    mutationFn: async () => {
      // 先释放全部标签页的 SSE 长连接，杜绝 Chrome 同源 6 连接池排队卡死在“正在提交更新”
      suspendSharedEventSources(15_000);
      const currentStartedAt = query.data.value?.startedAt || '';
      baselineStartedAt = currentStartedAt;
      watchingRestart.value = true;
      watchStartedAtMs = Date.now();
      userInitiatedRestart.value = true;
      const response = await fetch('/api/workspace/restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' },
        body: '{}',
        cache: 'no-store',
        signal: AbortSignal.timeout(6000),
      });
      return restartResponse(response);
    },
    retry: false,
    onSuccess: state => {
      trackRestartWindow(state);
      client.setQueryData(restartKey, state);
    },
    onError: error => {
      watchingRestart.value = false;
      reconnecting.value = false;
      userInitiatedRestart.value = false;
      resumeSharedEventSources();
      ElMessage.error(error.message || '提交重启请求失败，请重试');
    },
    onSettled: () => client.invalidateQueries({ queryKey: restartKey }),
  });

  const busy = computed(() => pendingRequests.value > 0 || watchingRestart.value || isWorkspaceRestartPending(query.data.value));
  const label = computed(() => {
    if (reconnecting.value) return '服务秒级重连中';
    const state = query.data.value;
    const status = state?.status;
    if (state?.supervisor === 'systemd') {
      return status === 'waiting' ? '等待任务结束'
        : (status && progressLabels[status]) || (pendingRequests.value > 0 ? '正在安排重启' : '重启服务器工作台');
    }
    return (status && progressLabels[status]) || (pendingRequests.value > 0 ? '正在发起快速重启' : '立即更新并重启');
  });
  const progress = computed(() => {
    if (reconnecting.value) return '新后端正在接管端口，即将恢复连接…';
    return isWorkspaceRestartPending(query.data.value) ? query.data.value?.message : '';
  });
  function restart() {
    if (!busy.value) mutation.mutate();
  }
  return { query, busy, label, progress, restart };
}
