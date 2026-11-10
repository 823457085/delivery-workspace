/** 调度只读取运行器提供的事实，不再保存第二份 active/queue 状态。路径应由运行器先规范化。 */
import fs from 'node:fs/promises';
import path from 'node:path';

export interface SchedulerJob {
  id: string;
  provider: string;
  workspacePath: string;
  workspacePaths?: string[];
  writer: boolean;
  manual: boolean;
  createdAt?: string;
}
export interface SchedulerLimits { global?: number; perProvider?: number }
export type ScheduleReason = 'global_limit' | 'provider_limit' | 'workspace_busy' | 'manual_priority';

function overlaps(first: string, second: string) {
  const left = path.resolve(first), right = path.resolve(second);
  return left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);
}
function admission(job: SchedulerJob, active: SchedulerJob[], limits: SchedulerLimits): { allowed: boolean; reason?: ScheduleReason } {
  // 未显式配置时不限制全局或单执行器并发；工作区写入互斥仍然有效。
  if (limits.global !== undefined && active.length >= limits.global) return { allowed: false, reason: 'global_limit' };
  if (limits.perProvider !== undefined && active.filter(item => item.provider === job.provider).length >= limits.perProvider) {
    return { allowed: false, reason: 'provider_limit' };
  }
  if (job.writer && active.some(item => item.writer && [item.workspacePath, ...(item.workspacePaths || [])].some(left =>
    [job.workspacePath, ...(job.workspacePaths || [])].some(right => overlaps(left, right))))) {
    return { allowed: false, reason: 'workspace_busy' };
  }
  return { allowed: true };
}
export function canSchedule(job: SchedulerJob, active: SchedulerJob[], queued: SchedulerJob[] = [], limits: SchedulerLimits = {}) {
  const result = admission(job, active, limits);
  if (!result.allowed) return result;
  if (!job.manual && queued.some(item => item.id !== job.id && item.manual && admission(item, active, limits).allowed)) {
    return { allowed: false, reason: 'manual_priority' as const };
  }
  return result;
}
export async function canonicalSchedulerJob(job: SchedulerJob): Promise<SchedulerJob> {
  return { ...job, workspacePath: await fs.realpath(job.workspacePath) };
}
export function selectScheduledJobs(queue: SchedulerJob[], active: SchedulerJob[], limits: SchedulerLimits = {}) {
  const selected: SchedulerJob[] = [];
  const ordered = [...queue].sort((left, right) => Number(right.manual) - Number(left.manual)
    || (Date.parse(left.createdAt || '') || 0) - (Date.parse(right.createdAt || '') || 0));
  for (const job of ordered) if (canSchedule(job, [...active, ...selected], [], limits).allowed) selected.push(job);
  return selected;
}
