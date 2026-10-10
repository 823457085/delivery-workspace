export const navigation = [
  { group: '工作空间', items: [
    { path: '/workbench', title: '我的工作台', icon: 'workbench' },
    { path: '/overview', title: '工作总览', icon: 'overview' },
    { path: '/tasks/calendar', title: '任务日历', icon: 'calendar', prefix: '/tasks' },
    { path: '/projects', title: '本地项目', icon: 'projects' },
  ] },
  { group: 'AI 自动交付', items: [
    { path: '/agent', title: 'Agent 工作台', icon: 'bot' },
    { path: '/design', title: '需求开发', icon: 'design' },
    { path: '/delivery/plan', title: '执行计划', icon: 'plan' },
    { path: '/delivery/queue', title: 'Codex 队列', icon: 'queue' },
    { path: '/delivery/runs', title: '运行记录', icon: 'runs' },
  ] },
  { group: 'APEX 重构追平', items: [
    { path: '/refactor/api-integration', title: 'APEX 接口联调', icon: 'plan' },
    { path: '/catchup/execution', title: '执行看板', icon: 'board' },
    { path: '/catchup/merge', title: '分支合入', icon: 'merge' },
    { path: '/catchup/codex', title: '追平 Codex 队列', icon: 'code' },
  ] },
  { group: '协作与配置', items: [
    { path: '/settings', title: '交付设置', icon: 'settings' },
  ] },
];
export const allNavigation = navigation.flatMap((group) => group.items);
