/** 业务面板只观察控制面已有缓存，不创建执行器或第二条 SSE；旧页面单独访问时才轮询。 */
import { inject } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import type { AgentRuntimeDashboard } from '../../shared/agent-runtime';
import { agentWorkspaceContext } from './agent-workspace-context';

export function useAgentRuntimeSnapshot() {
  const client = useQueryClient();
  const workspace = inject(agentWorkspaceContext, undefined);
  return useQuery<AgentRuntimeDashboard>({ queryKey: ['agent-runtimes'], staleTime: 15_000,
    enabled: !workspace, refetchInterval: workspace ? false : 15_000, retry: false,
    queryFn: async ({ signal }) => {
      // 手动刷新业务面板时也使用快速快照，连接与额度由控制面单独探测。
      const response = await fetch(workspace ? '/api/agent-runtimes?status=0' : '/api/agent-runtimes', { signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Agent 状态读取失败');
      const current = client.getQueryData<AgentRuntimeDashboard>(['agent-runtimes']);
      return current && current.revision > data.revision ? current : data;
    },
  });
}
