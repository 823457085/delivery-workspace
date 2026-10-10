/** 看板保存授权；执行由 Codex 会话领取，轮询不会启动模型或写外部系统。 */
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { shallowRef } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { DesignExecution, DesignExecutionInput, ExecutionDashboard } from '../../../shared/design-execution';

export function useDesignExecutor() {
  const client = useQueryClient();
  const pending = shallowRef(false);
  const query = useQuery({ queryKey: ['design-executor'], queryFn: async ({ signal }): Promise<ExecutionDashboard> => {
    const response = await fetch('/api/design-executor', { signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '自动执行器读取失败');
    return data;
  }, retry: false, refetchOnWindowFocus: true, refetchInterval: (q) => q.state.data?.runs.some((run) => ['queued', 'running'].includes(run.status)) ? 2000 : 15_000 });
  async function command(endpoint: string, payload: unknown, title: string, impact: string) {
    if (pending.value) return false;
    pending.value = true;
    let sent = false;
    let accepted = false;
    let rejected = false;
    try {
      try { await ElMessageBox.confirm(impact, title, { type: 'warning', confirmButtonText: '确认执行', cancelButtonText: '取消', closeOnClickModal: false }); }
      catch { return false; }
      sent = true;
      const response = await fetch(`/api/design-executor/runs${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (!response.ok) { rejected = true; throw new Error(result.message || '自动执行命令失败'); }
      accepted = true;
      await client.invalidateQueries({ queryKey: ['design-executor'] });
      ElMessage.success('任务状态已保存；待执行阶段需由 Codex 会话领取');
      return true;
    } catch (error) {
      if (accepted) { ElMessage.warning('后台已接受命令，但刷新失败；请重新读取状态，不要重复提交'); return true; }
      ElMessage.error(sent && !rejected ? '未能确认后台是否已接受命令，请先刷新核对已有运行，不要直接重复提交' : error instanceof Error ? error.message : '自动执行命令失败');
      return false;
    }
    finally { pending.value = false; }
  }
  function start(input: DesignExecutionInput) {
    return command('', { input: { ...input }, authorization: 'publish-confluence-and-create-jira' }, '创建 Codex 技术方案任务',
      `创建后等待 Codex 会话领取，不启动 CLI。Codex 将处理 ${input.issueKey}：读取 ${input.workspacePath} 的代码，生成方案，在 ${input.confluenceParentUrl} 发布文档，并在 Jira 项目 ${input.project || '（从原需求读取）'} 创建或复用 DEV 父任务与方案、实现子任务，写入计划日期 ${input.jiraStartDate} 至 ${input.jiraEndDate}，最后回读核验。执行时消耗 Codex 用量。不会修改产品代码、提交推送、流转 Jira 状态或签署 G2a。`);
  }
  function resume(run: DesignExecution, clarification: string) {
    return command(`/${run.id}/resume`, { revision: run.revision, clarification: [run.clarification, clarification.trim()].filter(Boolean).join('\n\n'), authorization: 'publish-confluence-and-create-jira' }, '准备 Codex 续跑',
      `继续 ${run.input.issueKey} 的原任务与会话，保留已通过阶段。后续仍可能发布 Confluence 和创建 / 更新 Jira；此前结果不确定的外部操作将先查重和回读，不从头重复建单。`);
  }
  function stop(run: DesignExecution) {
    return command(`/${run.id}/stop`, { revision: run.revision }, '停止领取与回写', '使本轮领取失效，拒绝后续回写。不会中断 Codex 会话，请同时在 Codex 中停止执行；无法撤销已发送的远端请求，已有文档和 Jira 会保留。');
  }
  return { query, pending, start, resume, stop };
}
