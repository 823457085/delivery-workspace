import { shallowRef } from 'vue';
import { ElMessage } from 'element-plus';
import { useQueryClient } from '@tanstack/vue-query';
import type { AgentRun } from '../../../shared/agent-runtime';

export function useAgentRecovery() {
  const runs = shallowRef<AgentRun[]>([]);
  const loading = shallowRef(false);
  const client = useQueryClient();
  async function load(reconcile = false) {
    if (loading.value) return;
    loading.value = true;
    try {
      const response = await fetch('/api/agent-runtimes/recovery', reconcile ? {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: '{}',
      } : { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || '中断任务读取失败');
      runs.value = result.runs;
      if (reconcile) await client.invalidateQueries({ queryKey: ['agent-runtimes'] });
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); }
    finally { loading.value = false; }
  }
  return { runs, loading, load };
}
