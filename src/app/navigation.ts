export const navigation = [
  { group: '工作空间', items: [
    { path: '/workbench', title: '我的工作台', icon: 'workbench' },
    { path: '/overview', title: '工作总览', icon: 'overview' },
    { path: '/tasks/calendar', title: '任务日历', icon: 'calendar', prefix: '/tasks' },
    { path: '/projects', title: '本地项目与 Git', icon: 'projects' },
    { path: '/systems', title: '系统导航', icon: 'projects' },
    { path: '/ports', title: '端口检测', icon: 'ports' },
  ] },
  { group: 'AI 自动交付', items: [
    { path: '/agent', title: 'Agent 工作台', icon: 'bot' },
    { path: '/design', title: '需求开发', icon: 'design' },
    { path: '/agent?view=jira-fix', title: 'Jira 缺陷修复', icon: 'code' },
    { path: '/delivery/queue', title: '执行中心', icon: 'queue' },
  ] },
  { group: '协作与配置', items: [
    { path: '/settings', title: '交付与连接设置', icon: 'settings' },
  ] },
];
export const allNavigation = navigation.flatMap((group) => group.items);
