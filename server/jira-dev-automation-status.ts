import type { JiraDevClient, JiraDevIssue } from './jira-dev/index.mjs';

export type JiraDevStatusPhase = 'start' | 'complete';
export interface JiraDevStatusResult {
  status: 'updated' | 'skipped';
  currentStatus: string;
  reason?: string;
}

/** 自动流转只使用已授权的目标状态，使用研发任务绑定的 Jira 连接及事项链接核对身份。 */
export async function advanceJiraDevStatus(
  client: JiraDevClient,
  binding: Pick<JiraDevIssue, 'key' | 'url'>,
  targetStatus: string,
  phase: JiraDevStatusPhase,
  beforeWrite?: () => Promise<void>,
): Promise<JiraDevStatusResult> {
  if (!binding.key || !binding.url || !targetStatus) throw new Error('缺少已绑定的 Jira 事项或目标状态。');
  if (!client.readTransitions || !client.transitionIssue) throw new Error('当前 Jira 连接不支持自动状态流转。');
  const { issue, transitions } = await client.readTransitions(binding.url);
  if (issue.key !== binding.key || issue.url !== binding.url) throw new Error('Jira 回读事项与任务绑定不一致。');
  if (!issue.status || !issue.statusId || typeof issue.assigneeId !== 'string') throw new Error('Jira 事项状态或经办人信息不完整。');
  if (issue.status === targetStatus) return { status: 'skipped', currentStatus: issue.status, reason: '已是目标状态。' };
  const category = issue.statusCategory;
  if (category !== 'new' && category !== 'indeterminate' && category !== 'done') throw new Error('Jira 未返回可核对的状态类别。');
  if (category === 'done' || (phase === 'start' && category !== 'new')) {
    return { status: 'skipped', currentStatus: issue.status, reason: '已进入后续状态，保留当前状态。' };
  }

  const candidates = transitions.filter(transition => transition.to.name === targetStatus);
  const [selected] = candidates;
  if (!selected || candidates.length !== 1) throw new Error(`当前 Jira 工作流没有唯一的直接流转目标“${targetStatus}”，请核对工作流或权限。`);
  if (selected.requiredFields.length) throw new Error(`流转至“${targetStatus}”需在 Jira 补齐必填字段。`);
  if (phase === 'complete') {
    for (const child of issue.subtasks || []) {
      const saved = await client.readIssue(child.url);
      if (saved.key !== child.key || saved.url !== child.url || saved.statusCategory !== 'done') {
        throw new Error(`子任务 ${child.key} 尚未确认完成，已保留父任务状态。`);
      }
    }
  }
  await beforeWrite?.();
  const result = await client.transitionIssue({
    source: binding.url, transitionId: selected.id, expectedStatusId: issue.statusId,
    targetStatusId: selected.to.id, expectedAssigneeId: issue.assigneeId, confirmed: true,
  });
  if (!result.verified || result.issue.key !== binding.key || result.issue.url !== binding.url
    || result.issue.statusId !== selected.to.id || result.issue.status !== targetStatus) {
    throw Object.assign(new Error('Jira 状态写入未能回读核对，请在 Jira 中确认结果。'), { uncertain: true });
  }
  return { status: 'updated', currentStatus: targetStatus };
}
