/**
 * 运行正文直接推送，避免每个 token 都触发全量状态/CLI 健康检查。
 * 短窗口合并同一运行的更新；元数据变化仍使用 refresh，旧客户端保持原协议。
 */
import type { AgentRun } from '../shared/agent-runtime.js';

export function createAgentRuntimeStream(write: (frame: string) => void, incremental: boolean) {
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
    send('runs', latestRevision, { runs: [...pending.values()] });
    pending.clear();
  };
  return {
    update(revision: number, run?: AgentRun) {
      if (!incremental || !run) { flush(); send('refresh', revision, {}); return; }
      latestRevision = revision;
      pending.set(run.id, run);
      if (!timer) timer = setTimeout(flush, 100);
    },
    close() { if (timer) clearTimeout(timer); pending.clear(); },
  };
}
