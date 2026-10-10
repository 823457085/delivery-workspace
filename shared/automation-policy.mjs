/**
 * 自动派发与待处理展示共享子任务边界，避免只隐藏列表却仍派发旧队列。
 * 仅识别 Jira 关系和类型，不改动历史记录或 Jira 排期状态。
 */
export function isJiraSubtask(issue) {
  return Boolean(issue?.parent?.key || issue?.parentKey
    || /^(子任务|sub[- ]?task)$/i.test(String(issue?.issueType || "").trim()));
}

export function automationSubtaskKeys(plan = []) {
  const keys = new Set();
  for (const { issue } of plan) {
    if (isJiraSubtask(issue)) keys.add(issue.key);
    for (const child of issue.subtasks || []) keys.add(child.key);
  }
  return keys;
}

export function isAutomationSubtaskJob(job, subtaskKeys) {
  return isJiraSubtask(job) || subtaskKeys.has(job.issueKey);
}
