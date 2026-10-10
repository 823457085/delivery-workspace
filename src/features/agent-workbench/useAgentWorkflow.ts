/**
 * 设计说明：该 composable 只编排现有 Mastra 演示流程 API，并以 Vue Query 作为服务端事实来源。
 * 它不执行 Git、Jira 或发布动作；所有变更都局限于本机流程快照。
 */
import { onBeforeUnmount, onMounted, shallowRef } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import type { Dashboard, Scenario } from '../../../shared/types';
import type { WorkflowRunContext } from '../../../shared/types';

async function workflowApi<T>(url: string, payload?: unknown): Promise<T> {
  const response = await fetch(url, payload === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const data = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(data.message || `流程请求失败 (${response.status})`);
  return data;
}

export function useAgentWorkflow() {
  const client = useQueryClient();
  const error = shallowRef('');
  const streamConnected = shallowRef(false);
  const streamStatus = shallowRef<'connecting' | 'connected' | 'reconnecting'>('connecting');
  const query = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => workflowApi<Dashboard>('/api/dashboard'),
    retry: false,
    refetchInterval: () => streamConnected.value ? false : 15_000,
  });
  let eventSource: EventSource | undefined;
  onMounted(() => {
    eventSource = new EventSource('/api/workflow/events');
    eventSource.addEventListener('open', () => { streamConnected.value = true; streamStatus.value = 'connected'; });
    eventSource.addEventListener('error', () => { streamConnected.value = false; streamStatus.value = 'reconnecting'; });
    eventSource.addEventListener('refresh', () => { void client.invalidateQueries({ queryKey: ['dashboard'] }); });
  });
  onBeforeUnmount(() => eventSource?.close());
  const mutation = useMutation({
    mutationFn: (input: { url: string; payload?: unknown }) => workflowApi<{ runId?: string }>(input.url, input.payload),
    onMutate: () => { error.value = ''; },
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ['dashboard'] }); },
    onError: (reason) => { error.value = reason instanceof Error ? reason.message : String(reason); },
  });
  async function act(url: string, payload?: unknown) {
    await mutation.mutateAsync({ url, payload }).catch(() => undefined);
  }
  return {
    query,
    error,
    streamStatus,
    busy: mutation.isPending,
    start: (requirementId: string, scenario: Scenario, context: WorkflowRunContext) => act('/api/runs', { requirementId, scenario, context }),
    resume: (runId: string, action: 'approve' | 'retest') => act(`/api/runs/${runId}/resume`, { action }),
    rework: (runId: string) => act(`/api/runs/${runId}/rework`, {}),
  };
}
