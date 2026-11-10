/** 管理台只发起明确范围的任务；后台保存队列，页面关闭不影响执行。 */
import { watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import type { RefactorConfig, RefactorDashboard, RefactorLaunch, RefactorPreview } from '../../../shared/refactor-control';

const base = '/api/agent-runtimes/refactor-control';
export const refactorWorkspaceQueryKey = ['refactor-workspace'];
export const refactorWorkspaceBase = `${base}/workspace`;
export function refactorWorkspaceRequest<T>(suffix = '', body?: unknown, signal?: AbortSignal): Promise<T> {
  return refactorRequest<T>(`/workspace${suffix}`, body, signal);
}
export async function refactorRequest<T>(suffix = '', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(base + suffix, { signal, cache: 'no-store', ...(body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: JSON.stringify(body),
  }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || '重构任务操作失败');
  return data as T;
}
export function useRefactorControl() {
  const client = useQueryClient();
  const key = ['refactor-control'];
  const dashboard = useQuery({ queryKey: key, queryFn: ({ signal }) => refactorRequest<RefactorDashboard>('', undefined, signal), refetchInterval: 5000, retry: false });
  watch(() => dashboard.error.value?.message || dashboard.data.value?.sourceError, error => { if (error) ElMessage.error(error); });
  async function configure(config: RefactorConfig, revision: string) {
    const data = await refactorRequest<RefactorDashboard>('/config', { config, revision });
    client.setQueryData(key, data);
  }
  async function start(launch: RefactorLaunch, preview: RefactorPreview, requestId: string) {
    const result = await refactorRequest<{ jobIds: string[]; reused: boolean }>('/start', { launch, scopeHash: preview.scopeHash, requestId });
    await dashboard.refetch(); return result;
  }
  async function stop(id: string) {
    const data = await refactorRequest<RefactorDashboard>(`/jobs/${id}/stop`, {}); client.setQueryData(key, data);
  }
  async function refresh() {
    await Promise.all([dashboard.refetch(), client.invalidateQueries({ queryKey: refactorWorkspaceQueryKey }), client.invalidateQueries({ queryKey: ['refactor-projects'] })]);
  }
  return { dashboard, configure, start, stop, refresh };
}
export function refactorArtifactUrl(jobId: string, relative: string) {
  return `${base}/artifacts/${jobId}/${relative.split('/').map(encodeURIComponent).join('/')}`;
}
export function exportRefactorResults(format: 'md' | 'json', moduleIds: string[]) {
  const link = document.createElement('a');
  link.href = `${base}/export?${new URLSearchParams({ format, modules: moduleIds.join(',') })}`;
  link.download = `重构交付结果.${format}`; link.click();
}
