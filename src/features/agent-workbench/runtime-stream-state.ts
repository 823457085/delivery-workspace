/**
 * SSE 只合并发生变化的运行，HTTP 仍负责完整快照和元数据。
 * 保留快照请求期间收到的更新，防止慢请求覆盖新正文；刷新串行合并，不反复取消请求。
 */
import type { AgentRun, AgentRuntimeDashboard } from '../../../shared/agent-runtime';

export function createRuntimeStreamState() {
  const updates = new Map<string, { revision: number; run: AgentRun }>();
  // POST 只确认一条运行，不能把整个列表的 SSE 水位推进到响应版本。
  const accepted = new Map<string, { revision: number; run: AgentRun }>();
  let snapshotRevision = 0;
  function merge(snapshot: AgentRuntimeDashboard) {
    const fresh = [...updates.values()].filter(item => item.revision > (snapshot.revision || 0));
    const acknowledged = [...accepted.values()];
    if (!fresh.length && !acknowledged.length) return snapshot;
    let runs = new Map(snapshot.runs.map(run => [run.id, run]));
    const locks = new Map(snapshot.activeWorkspaceLocks.map(lock => [lock.runId, lock]));
    for (const { run } of [...fresh, ...acknowledged]) {
      // 同毫秒的新运行保持后端的新到旧顺序；正文更新不改变已有运行的位置。
      if (runs.has(run.id)) runs.set(run.id, run);
      else runs = new Map([[run.id, run], ...runs]);
      if (run.status === 'running') locks.set(run.id, { runId: run.id, workspacePath: run.workspacePath, provider: run.provider });
      else locks.delete(run.id);
    }
    return { ...snapshot, revision: Math.max(snapshot.revision || 0, ...fresh.map(item => item.revision)),
      // HTTP 快照已限制历史数量，并额外保留每个会话的最新运行；SSE 不能再次截掉这些记录。
      runs: [...runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      activeWorkspaceLocks: [...locks.values()] };
  }
  return {
    receive(revision: number, runs: AgentRun[], snapshot?: AgentRuntimeDashboard) {
      for (const run of runs) {
        if (revision >= (accepted.get(run.id)?.revision ?? Infinity)) accepted.delete(run.id);
        if (revision > (updates.get(run.id)?.revision || 0)) updates.set(run.id, { revision, run });
      }
      return snapshot ? merge(snapshot) : undefined;
    },
    accept(revision: number, run: AgentRun, snapshot?: AgentRuntimeDashboard) {
      if (revision > snapshotRevision && revision > (updates.get(run.id)?.revision || 0)
        && revision > (accepted.get(run.id)?.revision || 0)) accepted.set(run.id, { revision, run });
      return snapshot ? merge(snapshot) : undefined;
    },
    snapshot(value: AgentRuntimeDashboard) {
      snapshotRevision = value.revision || 0;
      for (const [id, item] of accepted) if (item.revision <= snapshotRevision) accepted.delete(id);
      for (const [id, item] of updates) if (item.revision <= (value.revision || 0)) updates.delete(id);
      return merge(value);
    },
  };
}

export function createRuntimeRefresh(refresh: () => Promise<unknown>, delayMs = 40) {
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
