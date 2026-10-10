/** Vue Query 统一缓存原数据；所有写操作集中在显式确认后，不把刷新变成派发。 */
import { computed, shallowRef, toValue, type MaybeRefOrGetter } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { ElMessage, ElMessageBox } from 'element-plus';
import { createSourceActionExecutor } from './source-action';

export function sourceUrl(key: string, params: Record<string, string> = {}) {
  const query = new URLSearchParams(params).toString();
  return `/api/source/${key}${query ? `?${query}` : ''}`;
}
export async function readSource<T>(key: string, params: Record<string, string> = {}, signal?: AbortSignal, requireOnline = false): Promise<T> {
  const response = await fetch(sourceUrl(key, params), { signal });
  if (requireOnline && response.headers.get('X-Delivery-Source') === 'Delivery-Offline') throw new Error('交付后端不可用，无法确认当前任务与交付状态');
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.details || data.message || data.error || `读取失败 (${response.status})`);
  return data;
}
export function useSource<T>(key: string, params: MaybeRefOrGetter<Record<string, string>> = {}, requireOnline = false) {
  return useQuery({ queryKey: computed(() => ['source', key, toValue(params), ...(requireOnline ? ['online'] : [])]),
    queryFn: ({ signal }) => readSource<T>(key, toValue(params), signal, requireOnline),
    staleTime: key === 'projects' ? 180_000 : 20_000, retry: false,
    refetchOnWindowFocus: key === 'issues',
    refetchInterval: key === 'issues' ? 30_000 : ['catchup', 'merge', 'automation'].includes(key) ? 15_000 : false,
    refetchIntervalInBackground: false,
  });
}
export function useSourceActions() {
  const client = useQueryClient();
  const pending = shallowRef(false);
  const execute = createSourceActionExecutor({
    confirm: async (title, impact) => {
      try { await ElMessageBox.confirm(impact, title, { confirmButtonText: '确认执行', cancelButtonText: '取消', type: 'warning', closeOnClickModal: false }); return true; }
      catch { return false; }
    },
    send: (key, body) => fetch(sourceUrl(key), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body }),
    refresh: () => client.invalidateQueries({ queryKey: ['source'] }, { throwOnError: true }),
    success: (message) => { ElMessage.success(message); }, error: (message) => { ElMessage.error(message); },
    pending: (value) => { pending.value = value; },
  });
  return { execute, pending };
}
