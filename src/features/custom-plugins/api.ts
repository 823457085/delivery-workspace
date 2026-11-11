import { computed } from 'vue';
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

export const customPluginsQueryKey = ['custom-plugins'];
export function useCustomPlugins() {
  const query = useQuery({ queryKey: customPluginsQueryKey,
    queryFn: ({ signal }) => pluginRequest<{ plugins: CustomPluginInfo[]; navigation: NavigationPreferences }>('', undefined, signal),
    staleTime: 5000, refetchInterval: 10000, retry: false,
  });
  const plugins = computed(() => query.data.value?.plugins || []);
  const navigation = computed(() => query.data.value?.navigation || { order: [], icons: {} });
  return { query, plugins, navigation };
}
