import { computed, onMounted, onBeforeUnmount } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import type { NavigationPreferences } from '../../../shared/workspace-navigation';
import type { CustomPluginInfo } from '../../../shared/custom-plugins';

export async function pluginRequest<T = any>(action = '', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/custom-plugins${action ? '/' + action : ''}`, body === undefined ? { signal } : {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || '插件请求失败');
  return data as T;
}

const lifecycleSubscribers = new Set<() => void>();
let lifecycleStream: EventSource | undefined;
export const customPluginsQueryKey = ['custom-plugins'];
export function useCustomPlugins() {
  const query = useQuery({ queryKey: customPluginsQueryKey,
    queryFn: ({ signal }) => pluginRequest<{ plugins: CustomPluginInfo[]; navigation: NavigationPreferences }>('', undefined, signal),
    staleTime: 5000, refetchInterval: 15_000, refetchIntervalInBackground: false, retry: false,
  });
  const refresh = () => { void query.refetch(); };
  onMounted(() => {
    lifecycleSubscribers.add(refresh);
    if (!lifecycleStream) { lifecycleStream = new EventSource('/api/custom-plugins/events'); lifecycleStream.onmessage = () => { for (const callback of lifecycleSubscribers) callback(); }; }
  });
  onBeforeUnmount(() => { lifecycleSubscribers.delete(refresh); if (!lifecycleSubscribers.size) { lifecycleStream?.close(); lifecycleStream = undefined; } });
  const plugins = computed(() => query.data.value?.plugins || []);
  const navigation = computed(() => query.data.value?.navigation || { order: [], icons: {} });
  return { query, plugins, navigation };
}
