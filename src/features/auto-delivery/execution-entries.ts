/** 同一运行链只展示当前轮次；自动化记录仅按正式会话 ID 关联，绝不按同目录合并任务。 */
import type { AgentRun } from '../../../shared/agent-runtime';
import type { Job } from '../../../shared/hub';

export type ExecutionScope = 'active' | 'attention' | 'history' | 'all';
export interface ExecutionEntry {
  id: string; title: string; status: string; workspacePath: string; branch: string; updatedAt: string;
  source: string; summary: string; run?: AgentRun; job?: Job;
}
export function executionScope(status: string): Exclude<ExecutionScope, 'all'> {
  if (['queued', 'pending', 'waiting', 'dispatching', 'dispatched', 'running'].includes(status)) return 'active';
  if (['completed', 'cancelled', 'interrupted', 'done'].includes(status)) return 'history';
  return 'attention';
}
export function executionEntries(runs: AgentRun[], jobs: Job[]): ExecutionEntry[] {
  const byId = new Map(runs.map(run => [run.id, run]));
  const groups = new Map<string, AgentRun[]>();
  for (const run of runs) {
    let root = run;
    const seen = new Set([run.id]);
    while (root.parentRunId && byId.has(root.parentRunId) && !seen.has(root.parentRunId)) {
      root = byId.get(root.parentRunId)!;
      seen.add(root.id);
    }
    const key = root.id;
    groups.set(key, [...(groups.get(key) || []), run]);
  }
  const linkedJobs = new Set<string>();
  const entries: ExecutionEntry[] = [];
  for (const [id, chain] of groups) {
    const ordered = [...chain].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    // 新消息排队时，当前正在运行的轮次仍需显示，不能被最新排队消息掩盖。
    const run = ordered.find(item => item.status === 'running') || ordered.find(item => item.status === 'queued') || ordered[0]!;
    const job = jobs.find(item => !linkedJobs.has(item.id) && !!item.threadId
      && !(executionScope(item.status) === 'active' && executionScope(run.status) !== 'active' && Date.parse(item.updatedAt) > Date.parse(run.updatedAt))
      && chain.some(run => run.sessionId === item.threadId || run.originSessionId === item.threadId));
    if (job) linkedJobs.add(job.id);
    entries.push({ id: `agent:${id}`, title: run.objective, status: run.status, workspacePath: run.workspacePath,
      branch: run.branch, updatedAt: run.updatedAt, source: run.provider === 'cursor' ? 'Cursor Agent' : 'Codex Agent',
      summary: run.error || run.result, run, job });
  }
  for (const job of jobs) {
    if (linkedJobs.has(job.id)) continue;
    entries.push({ id: `job:${job.id}`, title: job.title, status: job.status, workspacePath: job.workspacePath,
      branch: job.branch, updatedAt: job.updatedAt, source: '自动化任务', summary: job.error || job.result || '', job });
  }
  return entries.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}
