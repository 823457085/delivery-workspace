/** 模型上下文只携带执行所需资料；完整预览和写入参数仍保留在原计划中。 */
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));

export function summarizeIssue(issue) {
  if (!issue) return undefined;
  return pick(issue, ['key', 'summary', 'url', 'status', 'priority', 'assignee', 'project', 'issueType', 'fixVersions', 'components', 'labels', 'parent', 'startDate', 'endDate', 'dueDate', 'materialStatus', 'materialWarning']);
}

export function summarizeTaskPlan(plan) {
  if (!plan) return undefined;
  return {
    ...pick(plan, ['taskId', 'status', 'sourceKind', 'businessModule', 'repositoryName', 'requiresConfirmation', 'needsReconfirmation', 'needsTitleReview', 'warning', 'error', 'designDestination', 'designPublicationAuthorized']),
    sourceIssue: summarizeIssue(plan.sourceIssue),
    developmentIssue: summarizeIssue(plan.developmentIssue),
    items: (plan.items || []).map(item => ({
      ...pick(item, ['id', 'role', 'action', 'state', 'key', 'url', 'summary', 'parentRole', 'schedule', 'workdays', 'requiredFields', 'error']),
      ...(item.issue?.status ? { status: item.issue.status } : {}),
      ...(item.dateUpdate ? { dateUpdate: pick(item.dateUpdate, ['state', 'error']) } : {}),
    })),
    ...(plan.sourceLink ? { sourceLink: pick(plan.sourceLink, ['action', 'state', 'error']) } : {}),
  };
}

/** 仅替换逐字相同的正文；不截断需求，不把 ADF 对象转换成丢失信息的文本。 */
export function createTaskMaterialContext({ sourceIssue, details = '' } = {}) {
  const descriptions = new Map();
  const sourceDescription = sourceIssue?.description;
  const sourceReference = sourceIssue?.key || '来源需求';
  const describe = (description, reference) => {
    if (description === undefined || description === null || description === '') return {};
    if (typeof description === 'string' && description === details) return { descriptionRef: '用户补充的任务说明' };
    const identity = JSON.stringify(description);
    if (descriptions.has(identity)) return { descriptionRef: descriptions.get(identity) };
    descriptions.set(identity, reference);
    if (typeof description !== 'string') return { description };
    let text = description;
    if (typeof sourceDescription === 'string' && sourceDescription.length >= 40 && description !== sourceDescription) {
      text = text.replaceAll(sourceDescription, `[正文同 ${sourceReference}，见来源资料]`);
    }
    if (details.length >= 40 && text !== details) text = text.replaceAll(details, '[见用户补充的任务说明]');
    return { description: text };
  };
  return {
    issue: (issue, reference) => issue && ({
      ...summarizeIssue(issue),
      ...describe(issue.description, reference || issue.key || '来源需求'),
      ...(issue.links?.length ? { links: issue.links.map(link => pick(link, ['key', 'url', 'summary', 'direction'])) } : {}),
      ...(issue.subtasks?.length ? { subtasks: issue.subtasks.map(summarizeIssue) } : {}),
    }),
    plan: plan => {
      if (!plan) return undefined;
      const summary = summarizeTaskPlan(plan);
      return { ...summary, items: summary.items.map((item, index) => ({
        ...item, ...describe(plan.items[index].issue?.description ?? plan.items[index].description, item.key || item.id || item.role),
      })) };
    },
  };
}
