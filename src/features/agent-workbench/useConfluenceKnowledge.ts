/** 文档查询随工作区切换取消；只在选择后读取正文，发送时再取最新版本。 */
import { computed, shallowRef, watch, toValue, type MaybeRefOrGetter } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import type { ConfluenceConfig, ConfluencePage, ConfluenceScope } from '../../../shared/confluence-knowledge';

export async function confluenceRequest<T>(endpoint: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/agent-runtimes/confluence/${endpoint}`, { signal,
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || 'Confluence 文档读取失败');
  return data as T;
}

export function useConfluenceKnowledge(workspace: MaybeRefOrGetter<string>, relatedText: MaybeRefOrGetter<string>) {
  const client = useQueryClient();
  const search = shallowRef('');
  const query = shallowRef('');
  const start = shallowRef(0);
  const field = shallowRef<'title' | 'text'>('title');
  watch(field, () => { start.value = 0; });
  watch(search, (value, _old, onCleanup) => {
    const timer = setTimeout(() => { query.value = value.trim(); start.value = 0; }, 250);
    onCleanup(() => clearTimeout(timer));
  });
  watch(() => toValue(workspace), () => { start.value = 0; search.value = ''; query.value = ''; });
  const config = useQuery({ queryKey: computed(() => ['confluence-config', toValue(workspace)]),
    queryFn: ({ signal }) => confluenceRequest<ConfluenceConfig>(`config?workspacePath=${encodeURIComponent(toValue(workspace))}`, undefined, signal) });
  const pages = useQuery({ queryKey: computed(() => ['confluence-search', toValue(workspace), config.data.value?.scope, query.value, start.value, field.value]),
    enabled: computed(() => !!config.data.value), retry: false,
    queryFn: ({ signal }) => confluenceRequest<{ pages: ConfluencePage[]; hasMore: boolean }>(`search?${new URLSearchParams({ workspacePath: toValue(workspace), q: query.value, start: String(start.value), field: field.value })}`, undefined, signal) });
  const related = useQuery({ queryKey: computed(() => ['confluence-related', toValue(workspace), toValue(relatedText)]),
    enabled: computed(() => !!toValue(relatedText).trim()), retry: false,
    queryFn: ({ signal }) => confluenceRequest<{ pages: ConfluencePage[]; unavailable: number }>('related', { text: toValue(relatedText).slice(0, 100000) }, signal) });
  async function configure(scope: ConfluenceScope) {
    const workspacePath = toValue(workspace);
    const value = await confluenceRequest<ConfluenceConfig>('config', { workspacePath, scope });
    client.setQueryData(['confluence-config', workspacePath], value);
    start.value = 0;
    await client.invalidateQueries({ queryKey: ['confluence-search', workspacePath] });
  }
  return { search, start, field, config, pages, related, configure };
}
