/** 统一工作入口；旧地址跳转到同一面板，不再挂载另一套导航。 */
export const workspaceSections = [
  { id: 'today', label: '今日工作', items: [{ id: 'today', label: '我的工作台', path: '/workbench' }, { id: 'overview', label: '工作总览', path: '/overview' }] },
  { id: 'tasks', label: 'Jira 任务', items: [{ id: 'tasks', label: '任务列表', path: '/tasks/list', mode: 'list' }, { id: 'calendar', label: '任务日历', path: '/tasks/calendar', mode: 'calendar' }, { id: 'stats', label: '任务统计', path: '/tasks/stats', mode: 'stats' }] },
  { id: 'projects', label: '项目与 Git', items: [{ id: 'projects', label: '本地项目与 Git', path: '/projects' }, { id: 'systems', label: '系统导航', path: '/systems' }, { id: 'ports', label: '端口检测', path: '/ports' }, { id: 'deployments', label: '项目部署', path: '/deployments' }] },
  { id: 'execution', label: 'AI 交付', items: [{ id: 'design', label: '需求开发', path: '/design' }, { id: 'requirements', label: '需求管理', path: '/requirements' }, { id: 'integration-execution', label: '重构管理', path: '/refactor/control' }, { id: 'jira-fix', label: 'Jira 修复', path: '/agent?view=jira-fix' }, { id: 'queue', label: '执行中心', path: '/delivery/queue', mode: 'queue' }] },
  { id: 'integration', label: '接口联调', items: [{ id: 'interfaces', label: '接口联调中心', path: '/interfaces' }] },
  { id: 'automation', label: '自动化 / 设置', items: [{ id: 'settings', label: '连接与策略设置', path: '/settings' }, { id: 'automation', label: '自动化与报告', path: '/agent?view=automation' }, { id: 'messages', label: '手动群消息', path: '/messages' }] },
] as const;
export const workspaceViews = workspaceSections.flatMap(section => [...section.items]);
export const legacyExecutionPaths = { '/delivery/plan': 'plan', '/delivery/runs': 'runs' } as const;
export function workspaceView(value: unknown) {
  const id = value === 'plan' || value === 'runs' ? 'queue' : value;
  return typeof id === 'string' ? workspaceViews.find(item => item.id === id) : undefined;
}
export function workspaceLocation(path: string, query: Record<string, unknown> = {}) {
  if (Object.hasOwn(legacyExecutionPaths, path)) return {
    path: '/agent', query: { ...query, view: 'queue', executionTab: legacyExecutionPaths[path as keyof typeof legacyExecutionPaths] },
  };
  const item = workspaceViews.find(view => view.path === path);
  return item ? { path: '/agent', query: { ...query, view: item.id } } : undefined;
}
