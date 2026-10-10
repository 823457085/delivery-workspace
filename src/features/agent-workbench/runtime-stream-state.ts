/**
 * SSE 只合并发生变化的运行，HTTP 仍负责完整快照和元数据。
 * 保留快照请求期间收到的更新，防止慢请求覆盖新正文；刷新串行合并，不反复取消请求。
 */
import type { AgentRun, AgentRuntimeDashboard } from '../../../shared/agent-runtime';

export function createRuntimeStreamState() {
  const updates = new Map<string, { revision: number; run: AgentRun }>();
  function merge(snapshot: AgentRuntimeDashboard) {
    const fresh = [...updates.values()].filter(item => item.revision > (snapshot.revision || 0));
    if (!fresh.length) return snapshot;
    const runs = new Map(snapshot.runs.map(run => [run.id, run]));
    const locks = new Map(snapshot.activeWorkspaceLocks.map(lock => [lock.runId, lock]));
    for (const { run } of fresh) {
      runs.set(run.id, run);
      if (run.status === 'running') locks.set(run.id, { runId: run.id, workspacePath: run.workspacePath, provider: run.provider });
      else locks.delete(run.id);
    }
    return { ...snapshot, revision: Math.max(snapshot.revision || 0, ...fresh.map(item => item.revision)),
      runs: [...runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50),
      activeWorkspaceLocks: [...locks.values()] };
  }
  return {
    receive(revision: number, runs: AgentRun[], snapshot?: AgentRuntimeDashboard) {
      for (const run of runs) {
        if (revision > (updates.get(run.id)?.revision || 0)) updates.set(run.id, { revision, run });
      }
      return snapshot ? merge(snapshot) : undefined;
    },
    snapshot(value: AgentRuntimeDashboard) {
      for (const [id, item] of updates) if (item.revision <= (value.revision || 0)) updates.delete(id);
      return merge(value);
    },
  };
}

export function createRuntimeRefresh(refresh: () => Promise<unknown>, delayMs = 120) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let requested = false;
  let closed = false;
  function request() {
    if (closed) return;
    requested = true;
    if (running || timer) return;
    timer = setTimeout(async () => {
      timer = undefined;
      requested = false;
      running = true;
      try { await refresh(); } catch { /* 查询层持有错误，保留已显示内容。 */ }
      finally { running = false; if (requested) request(); }
    }, delayMs);
  }
  return { request, close() { closed = true; if (timer) clearTimeout(timer); } };
}
