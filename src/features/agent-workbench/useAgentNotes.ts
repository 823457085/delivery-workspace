/** 笔记请求与缓存独立于工作区；配置变化使搜索失效，避免展示旧库内容。 */
import { computed, shallowRef, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import type { AgentNote, AgentVaultConfig } from '../../../shared/agent-notes';

export async function noteRequest<T>(endpoint: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/agent-runtimes/obsidian/${endpoint}`, {
    signal, ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || '笔记操作失败');
  return data as T;
}

export function useAgentNotes() {
  const client = useQueryClient();
  const search = shallowRef('');
  const query = shallowRef('');
  watch(search, (value, _old, onCleanup) => {
    const timer = setTimeout(() => { query.value = value.trim(); }, 180);
    onCleanup(() => clearTimeout(timer));
  });
  const config = useQuery({ queryKey: ['agent-vault'], queryFn: ({ signal }) => noteRequest<AgentVaultConfig>('config', undefined, signal) });
  const notes = useQuery({ queryKey: computed(() => ['agent-notes', config.data.value?.id, query.value]),
    enabled: computed(() => !!config.data.value?.id),
    queryFn: ({ signal }) => noteRequest<{ notes: AgentNote[]; truncated: boolean }>(`notes?q=${encodeURIComponent(query.value)}`, undefined, signal) });

  async function configure(path: string) {
    const value = await noteRequest<AgentVaultConfig>('config', { path });
    client.setQueryData(['agent-vault'], value);
    await client.invalidateQueries({ queryKey: ['agent-notes'] });
  }
  async function saved() { await client.invalidateQueries({ queryKey: ['agent-notes'] }); }
  return { search, config, notes, configure, saved };
}
