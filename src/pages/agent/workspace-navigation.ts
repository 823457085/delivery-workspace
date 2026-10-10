/** 只描述导航，不复制业务状态；旧地址保留，Agent 内映射到宽面板。 */
export const workspaceSections = [
  { id: 'today', label: '今日工作', items: [{ id: 'today', label: '我的工作台', path: '/workbench' }, { id: 'overview', label: '工作总览', path: '/overview' }] },
  { id: 'tasks', label: '任务', items: [{ id: 'tasks', label: '任务列表', path: '/tasks/list', mode: 'list' }, { id: 'calendar', label: '任务日历', path: '/tasks/calendar', mode: 'calendar' }, { id: 'stats', label: '任务统计', path: '/tasks/stats', mode: 'stats' }] },
  { id: 'projects', label: '项目', items: [{ id: 'projects', label: '本地项目', path: '/projects' }] },
  { id: 'execution', label: '执行', items: [{ id: 'queue', label: '当前执行', path: '/delivery/queue', mode: 'queue' }, { id: 'design', label: '需求开发', path: '/design' }, { id: 'jira-fix', label: 'Jira 修复', path: '/agent?view=jira-fix' }, { id: 'plan', label: '执行计划', path: '/delivery/plan', mode: 'plan' }, { id: 'runs', label: '巡检记录', path: '/delivery/runs', mode: 'runs' }, { id: 'codex', label: '追平队列', path: '/catchup/codex', mode: 'codex' }] },
  { id: 'delivery', label: '交付', items: [{ id: 'integration', label: '接口联调', path: '/refactor/api-integration' }, { id: 'integration-execution', label: '联调执行', path: '/agent?view=integration-execution' }, { id: 'catchup', label: '追平看板', path: '/catchup/execution', mode: 'execution' }, { id: 'merge', label: '分支合入', path: '/catchup/merge', mode: 'merge' }] },
  { id: 'automation', label: '自动化 / 设置', items: [{ id: 'automation', label: '自动化与报告', path: '/agent?view=automation' }, { id: 'settings', label: '策略设置', path: '/settings' }] },
] as const;
export const workspaceViews = workspaceSections.flatMap(section => [...section.items]);
export function workspaceView(value: unknown) {
  return typeof value === 'string' ? workspaceViews.find(item => item.id === value) : undefined;
}
export function workspaceLocation(path: string, query: Record<string, unknown> = {}) {
  const item = workspaceViews.find(view => view.path === path);
  return item ? { path: '/agent', query: { ...query, view: item.id } } : undefined;
}
