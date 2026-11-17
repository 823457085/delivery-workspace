/** Vue Query 统一缓存原数据；所有写操作集中在显式确认后，不把刷新变成派发。 */
import { computed, shallowRef, toValue, type MaybeRefOrGetter } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useIntegrationPlugins } from '../plugins/runtime';
import { sourceOwner } from '../../shared/integration-plugins';
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
export interface SourceQueryOptions {
  active?: MaybeRefOrGetter<boolean>;
  staleTime?: number;
  refetchInterval?: number | false;
  refetchOnWindowFocus?: boolean;
}

export function useSource<T>(key: string, params: MaybeRefOrGetter<Record<string, string>> = {}, requireOnline = false, options: SourceQueryOptions = {}) {
  const plugins = useIntegrationPlugins(), owner = sourceOwner(key);
  const enabled = computed(() => !owner || plugins.available(owner.id));
  const isActive = computed(() => options.active === undefined ? true : toValue(options.active));
  const defaultInterval = key === 'issues' ? 30_000 : ['catchup', 'merge', 'automation'].includes(key) ? 15_000 : false;
  const query = useQuery({ enabled, queryKey: computed(() => ['source', key, toValue(params), ...(requireOnline ? ['online'] : [])]),
    queryFn: ({ signal }) => readSource<T>(key, toValue(params), signal, requireOnline),
    staleTime: options.staleTime ?? (key === 'projects' ? 180_000 : 20_000), retry: false,
    refetchOnWindowFocus: computed(() => isActive.value && (options.refetchOnWindowFocus ?? (key === 'issues'))),
    refetchInterval: computed(() => isActive.value ? (options.refetchInterval ?? defaultInterval) : false),
    refetchIntervalInBackground: false,
  });
  return { ...query, data: computed(() => enabled.value ? query.data.value : undefined), isPending: computed(() => enabled.value && query.isPending.value), refetch: (refetchOptions?: Parameters<typeof query.refetch>[0]) => enabled.value ? query.refetch(refetchOptions) : Promise.resolve(undefined) };
}
export function useSourceActions() {
  const client = useQueryClient();
  const pending = shallowRef(false);
  const execute = createSourceActionExecutor({
    confirm: async (title, impact, key) => {
      // 修改本地项目别名已在输入框完成确认；在 Finder 打开目录不改文件。
      if (key === 'project-label' || key === 'project-open') return true;
      try { await ElMessageBox.confirm(impact, title, { confirmButtonText: '确认执行', cancelButtonText: '取消', type: 'warning', closeOnClickModal: false }); return true; }
      catch { return false; }
    },
    send: (key, body) => fetch(sourceUrl(key), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body }),
    accepted: (key, result) => {
      // 保存接口返回服务端实际配置；后续回读失败时也不能恢复成保存前的缓存。
      const dashboard = key === 'settings' ? result : key === 'weekly-report' ? result.dashboard : undefined;
      if (dashboard && typeof dashboard === 'object' && 'settings' in dashboard
        && 'jobs' in dashboard && Array.isArray(dashboard.jobs) && 'runs' in dashboard && Array.isArray(dashboard.runs)) {
        client.setQueriesData({ queryKey: ['source', 'automation'] }, dashboard);
      }
    },
    refresh: () => client.invalidateQueries({ queryKey: ['source'] }, { throwOnError: true }),
    success: (message) => { ElMessage.success(message); }, error: (message) => { ElMessage.error(message); },
    pending: (value) => { pending.value = value; },
  });
  return { execute, pending };
}
