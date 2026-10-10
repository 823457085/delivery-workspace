/** Vue Query 读取管理记录并在保存成功后更新共享缓存，页面只处理筛选和编辑，不把管理动作交给执行队列。 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import type { IntegrationState, IntegrationUpdate } from '../../../shared/api-integration';

async function request(init?: RequestInit): Promise<IntegrationState> {
  const response = await fetch('/api/refactor-integration', init);
  const data = await response.json();
  if (!response.ok) throw new Error(data.message);
  return data;
}
export function useIntegration() {
  const client = useQueryClient();
  const key = ['refactor-integration'];
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) => request({ signal }), retry: false });
  const save = useMutation({ mutationFn: (update: IntegrationUpdate) => request({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(update) }),
    onSuccess: async data => { await client.cancelQueries({ queryKey: key }); client.setQueryData(key, data); },
  });
  return { query, save };
}
