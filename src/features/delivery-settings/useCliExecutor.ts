/** 执行器状态独立轮询；启停必须显式确认，读取和进入页面绝不触发任务领取。 */
import { shallowRef } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { CliExecutionState } from '../../../shared/cli-execution';

export function useCliExecutor() {
  const client = useQueryClient(), changing = shallowRef(false);
  const query = useQuery({ queryKey: ['cli-executor'], refetchInterval: 5000, retry: false,
    queryFn: async ({ signal }): Promise<CliExecutionState> => {
      const response = await fetch('/api/cli-executor', { signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || '执行器状态读取失败');
      return data;
    },
  });
  async function change(action: 'start' | 'pause') {
    if (changing.value) return;
    changing.value = true;
    try {
      try { await ElMessageBox.confirm(action === 'start'
        ? '将通过本机 Codex CLI 执行已授权的 Jira、追平和合入队列。既有会话会续接；未经审核或例外授权的需求不会自动合入。'
        : '停止领取新任务；已领取和正在运行的任务继续完成。此操作不暂停技术方案中的独立执行记录。',
      action === 'start' ? '启动 CLI 队列' : '暂停新任务领取', { type: 'warning', confirmButtonText: '确认', cancelButtonText: '取消', closeOnClickModal: false }); }
      catch { return; }
      const response = await fetch(`/api/cli-executor/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: '{}' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || '执行器操作失败');
      ElMessage.success(data.message || '执行器操作已受理');
      await Promise.all([query.refetch(), client.invalidateQueries({ queryKey: ['source'] })]);
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); }
    finally { changing.value = false; }
  }
  return { query, changing, change };
}
