/** 只投影原系统状态：执行与合入是独立任务，Git 包含关系不提升为自测通过。 */
import type { CatchupData, MergeData, MergeItem, Screenshot } from '../../../shared/hub';
export type MergeListScope = 'pending' | 'completed' | 'excluded' | 'all';
/** 合入列表不重复列出 Git 已包含的需求；只分组，保留原审核状态与范围复核原因。 */
export function mergeItemGroup(item: Pick<MergeItem, 'status' | 'gitStatus'>): Exclude<MergeListScope, 'all'> {
  if (item.status === 'HOLD' || item.gitStatus === 'HOLD') return 'excluded';
  if (item.gitStatus === 'MERGED' || ['APPROVED', 'EXCEPTION_MERGED'].includes(item.status)) return 'completed';
  return 'pending';
}
export interface QueueEntry { key: string; requirementId: string; title: string; stage: string; status: string; workspace: string; branch: string; threadId: string; updatedAt: string; kind: 'execution' | 'merge'; order: number }
export function catchupQueue(board?: CatchupData, merge?: MergeData): QueueEntry[] {
  const entries: QueueEntry[] = [];
  for (const item of board?.requirements || []) {
    if (item.execution.exclusionReason || !['queued', 'dispatching', 'dispatched', 'running', 'paused'].includes(item.session.status)) continue;
    entries.push({ key: `execution:${item.id}`, requirementId: item.id, title: item.title, stage: '功能还原', status: item.session.status, workspace: item.session.workspacePath, branch: item.session.branch, threadId: item.session.threadId || item.session.clientThreadId || '', updatedAt: item.session.updatedAt, kind: 'execution', order: Number.MAX_SAFE_INTEGER });
  }
  for (const item of merge?.items || []) {
    if (!['PENDING', 'QUEUED', 'DISPATCHING', 'RUNNING'].includes(item.status)) continue;
    const delivery = item.pipeline.phase === 'delivery';
    entries.push({ key: `merge:${item.requirementId}`, requirementId: item.requirementId, title: item.title, stage: delivery ? 'Git 交付' : '合入自测', status: item.status === 'PENDING' ? 'queued' : item.status.toLowerCase(), workspace: delivery ? '统一目标 worktree' : item.deliveryWorkspacePath || item.sessionWorkspacePath, branch: delivery ? merge!.target.branch : item.sourceBranch, threadId: item.pipeline.threadId || item.pipeline.clientThreadId || '', updatedAt: item.pipeline.updatedAt, kind: 'merge', order: item.order ?? Number.MAX_SAFE_INTEGER });
  }
  const rank: Record<string, number> = { running: 0, dispatched: 1, dispatching: 1, queued: 2, paused: 3 };
  return entries.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || a.order - b.order || a.requirementId.localeCompare(b.requirementId));
}
export function screenshotGroups(item: MergeItem) {
  const submitted = item.pipeline.evidence?.screenshots || [];
  const invalid = new Set(item.reviewGate.invalidScreenshotNames || []);
  const isInvalid = (shot: Screenshot) => shot.isAuthentication || invalid.has(shot.filename);
  const names = new Set(submitted.map((shot) => shot.filename));
  return { submitted: submitted.filter((shot) => !isInvalid(shot)),
    supplementary: (item.executionScreenshots || []).filter((shot) => !names.has(shot.filename) && !isInvalid(shot)),
    excluded: [...submitted, ...(item.executionScreenshots || []).filter((shot) => !names.has(shot.filename))].filter(isInvalid) };
}
/** 例外原因是审计数据，不能用空白或控制字符代替；与后端 10–1000 字约束一致。 */
export function directMergeReasonError(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().length >= 10 && value.length <= 1000
    ? true : '请填写 10–1000 字的具体环境限制及例外合入原因';
}
