/**
 * 运行正文直接推送，避免每个 token 都触发全量状态/CLI 健康检查。
 * 短窗口合并同一运行的更新；元数据变化仍使用 refresh，旧客户端保持原协议。
 */
import type { AgentRun } from '../shared/agent-runtime.js';

/** 团队岗位提示与 TaskFlow 材料快照由服务端传给执行器。 */
export function browserAgentRun(run: AgentRun): AgentRun {
  const taskFlow = run.task?.sourceId?.startsWith('taskflow:');
  if (run.teamContext === undefined && !taskFlow) return run;
  const { teamContext: _teamContext, ...visible } = run;
  if (taskFlow) delete visible.workflowContext;
  return visible;
}

export function createAgentRuntimeStream(write: (frame: string) => void, incremental: boolean,
  summarize?: (run: AgentRun) => AgentRun) {
  const pending = new Map<string, AgentRun>();
  let latestRevision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const send = (event: string, revision: number, data: object) => {
    write(`id: ${revision}\nevent: ${event}\ndata: ${JSON.stringify({ revision, ...data })}\n\n`);
  };
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!pending.size) return;
    const runs = [...pending.values()].map(summarize || browserAgentRun);
    send('runs', latestRevision, { runs,
      ...(summarize ? { conversationIds: [...new Set(runs.map(run => run.conversationId || run.id))] } : {}) });
    pending.clear();
  };
  return {
    update(revision: number, run?: AgentRun) {
      if (!incremental || !run) { flush(); send('refresh', revision, {}); return; }
      latestRevision = revision;
      pending.set(run.id, run);
      if (!timer) timer = setTimeout(flush, 32);
    },
    close() { if (timer) clearTimeout(timer); pending.clear(); },
  };
}
