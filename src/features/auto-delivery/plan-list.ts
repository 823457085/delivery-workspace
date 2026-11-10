/** 巡检计划仅按已记录的事实筛选，不将未派发等同于阻塞。 */
import type { AutomationProjectRouting, PlanItem } from '../../../shared/hub';
import { isDone, searchMatches } from '../../shared/format';

export type PlanFilter = 'all' | 'open' | 'eligible' | 'dependencies' | 'blocked' | 'unmatched';
export function projectRoutingLabel(routing?: AutomationProjectRouting): string {
  if (!routing) return '未记录项目匹配';
  if (routing.status === 'incomplete') return `${routing.profile?.name || '项目'} · 配置待完善`;
  return routing.status === 'matched' && routing.profile ? routing.profile.name : '待选择项目';
}

export function planItems(items: PlanItem[], search: string, filter: PlanFilter): PlanItem[] {
  const issues = new Map(items.map(item => [item.issue.key, item.issue]));
  const hasDependencies = (item: PlanItem) => item.dependencyKeys.length > 0 || item.childKeys.some(key => {
    const child = issues.get(key) || item.issue.subtasks.find(child => child.key === key);
    return !!child && !isDone(child);
  });
  const targetDate = (item: PlanItem) => item.issue.endDate || item.issue.dueDate || item.issue.startDate || '9999-12-31';
  return items.filter(item => {
    if (!searchMatches([item.issue.key, item.issue.summary, item.action, item.workspace?.path, item.workspace?.displayPath,
      item.workspace?.branch, item.targetBranch, item.dependencyKeys, item.childKeys, item.issue.parent?.key,
      item.issue.project, item.issue.projectName, item.projectRouting?.profile?.name, item.projectRouting?.profile?.repositoryUrl,
      item.projectRouting?.reason, item.projectRouting?.candidates.map(profile => profile.name)], search)) return false;
    if (filter === 'all') return true;
    if (isDone(item.issue)) return false;
    if (filter === 'eligible') return item.dispatchable;
    if (filter === 'dependencies') return hasDependencies(item);
    if (filter === 'blocked') return item.jobStatus === 'blocked';
    if (filter === 'unmatched') return !item.workspace?.path || !!item.projectRouting && item.projectRouting.status !== 'matched';
    return true;
  }).sort((left, right) => Number(isDone(left.issue)) - Number(isDone(right.issue))
    || targetDate(left).localeCompare(targetDate(right)) || left.issue.key.localeCompare(right.issue.key));
}
