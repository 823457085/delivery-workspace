/** 通知与版本弹层共享更新请求及进度。 */
import { computed } from 'vue';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import type { WorkspaceRestartState } from '../../../shared/workspace-restart';

const restartKey = ['workspace-restart'];
const progressLabels: Record<string, string> = {
  building: '构建页面中', waiting: '等待安全重启', restarting: '后端重启中',
};

export function isWorkspaceRestartPending(state?: WorkspaceRestartState) {
  return !!state && Object.hasOwn(progressLabels, state.status);
}

async function restartResponse(response: Response): Promise<WorkspaceRestartState> {
  if (response.status === 404) throw new Error('当前后端不支持一键重启，请先更新后端服务。');
  const value = await response.json();
  if (!response.ok) throw new Error(value.message || `重启请求失败 (${response.status})`);
  return value;
}

export function useWorkspaceRestart() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: restartKey, queryFn: async ({ signal }) => restartResponse(await fetch('/api/workspace/restart', { signal, cache: 'no-store' })),
    staleTime: 10_000, retry: false, refetchOnWindowFocus: true,
    refetchInterval: current => isWorkspaceRestartPending(current.state.data) ? 1500 : current.state.error ? 3000 : false,
    refetchIntervalInBackground: true,
  });
  const pendingRequests = useIsMutating({ mutationKey: restartKey });
  const mutation = useMutation({ mutationKey: restartKey, mutationFn: async () => restartResponse(await fetch('/api/workspace/restart', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: '{}',
  })), retry: false, onSuccess: state => { client.setQueryData(restartKey, state); },
  onError: error => { ElMessage.error(error.message); },
  onSettled: () => client.invalidateQueries({ queryKey: restartKey }),
  });
  const busy = computed(() => pendingRequests.value > 0 || isWorkspaceRestartPending(query.data.value));
  const label = computed(() => {
    const status = query.data.value?.status;
    return status && progressLabels[status] || (pendingRequests.value > 0 ? '正在提交更新' : '更新工作台');
  });
  const progress = computed(() => isWorkspaceRestartPending(query.data.value) ? query.data.value?.message : '');
  function restart() { if (!busy.value) mutation.mutate(); }
  return { query, busy, label, progress, restart };
}
