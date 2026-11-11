import { integrationCatalog } from '../../shared/integration-plugins';
export const navigation = [
  { group: '工作空间', items: [
    { path: '/workbench', title: '我的工作台', icon: 'workbench' },
    { path: '/overview', title: '工作总览', icon: 'overview' },
    { path: '/projects', title: '本地项目与 Git', icon: 'projects' },
    { path: '/systems', title: '系统导航', icon: 'projects' },
    { path: '/ports', title: '端口检测', icon: 'ports' },
    { path: '/go-studio', title: 'Go 实训工坊', icon: 'code' },
  ] },
  { group: 'AI 自动交付', items: [
    { path: '/agent', title: 'Agent 工作台', icon: 'bot' },
    { path: '/design', title: '需求开发', icon: 'design' },
    { path: '/delivery/queue', title: '执行中心', icon: 'queue' },
  ] },
  { group: '协作与配置', items: [
    { path: '/settings', title: '交付与连接设置', icon: 'settings' },
  ] },
];
export function registeredNavigation(activeIds: string[]) { return [...navigation, ...integrationCatalog.filter(plugin => activeIds.includes(plugin.id) && plugin.views.length).map(plugin => ({group: plugin.name, items: plugin.views.map(view => ({path: view.path, title: view.label, icon: 'code'}))}))]; }
export const allNavigation = registeredNavigation(integrationCatalog.map(plugin => plugin.id)).flatMap(group => group.items);
