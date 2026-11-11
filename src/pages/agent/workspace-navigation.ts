import type { NavigationPreferences } from '../../../shared/workspace-navigation';
import type { CustomPluginInfo } from '../../../shared/custom-plugins';
import { integrationCatalog } from '../../../shared/integration-plugins';
export interface WorkspaceView { id: string; label: string; path: string; mode?: string; pluginId?: string; component?: string; customPluginId?: string }
export interface WorkspaceSection { id: string; label: string; shortLabel?: string; icon?: string; items: WorkspaceView[] }
/** 统一工作入口；旧地址跳转到同一面板，不再挂载另一套导航。 */
export const workspaceSections: WorkspaceSection[] = [
  { id: 'today', label: '今日工作', items: [{ id: 'today', label: '我的工作台', path: '/workbench' }, { id: 'overview', label: '工作总览', path: '/overview' }] },
  { id: 'projects', label: '项目与 Git', items: [{ id: 'projects', label: '本地项目与 Git', path: '/projects' }, { id: 'systems', label: '系统导航', path: '/systems' }, { id: 'ports', label: '端口检测', path: '/ports' }, { id: 'deployments', label: '项目部署', path: '/deployments' }] },
  { id: 'execution', label: 'AI 交付', items: [{ id: 'design', label: '需求开发', path: '/design' }, { id: 'requirements', label: '需求管理', path: '/requirements' }, { id: 'integration-execution', label: '重构管理', path: '/refactor/control' }, { id: 'queue', label: '执行中心', path: '/delivery/queue', mode: 'queue' }] },
  { id: 'integration', label: '接口联调', items: [{ id: 'interfaces', label: '接口联调中心', path: '/interfaces' }] },
  { id: 'learning', label: 'Go 实训', items: [{ id: 'go-studio', label: 'Go 实训工坊', path: '/go-studio' }] },
  { id: 'automation', label: '自动化 / 设置', items: [{ id: 'settings', label: '连接与策略设置', path: '/settings' }, { id: 'plugins', label: '功能插件', path: '/agent?view=plugins' }, { id: 'automation', label: '自动化与报告', path: '/agent?view=automation' }, { id: 'messages', label: '手动群消息', path: '/messages' }] },
];
export const pluginViews: WorkspaceView[] = integrationCatalog.flatMap(plugin => plugin.views.map(view => ({...view, pluginId: plugin.id})));
// All declared URLs remain resolvable even while a provider is disabled. Rendering is gated separately.
export const workspaceViews = [...workspaceSections.flatMap(section => section.items), ...pluginViews];
function customPluginPage(plugin: CustomPluginInfo): WorkspaceView {
 return {
  id: `custom:${plugin.manifest.id}`, label: plugin.manifest.name, customPluginId: plugin.manifest.id,
  path: `/agent?view=plugins&plugin=${encodeURIComponent(plugin.manifest.id)}`,
 };
}
export function customPluginViews(plugins: CustomPluginInfo[]): WorkspaceView[] {
 return plugins.filter(plugin => plugin.enabled && plugin.showInMenu && !plugin.error).map(customPluginPage);
}
export function registeredWorkspaceSections(activeIds: string[], customPlugins: CustomPluginInfo[] = [], navigation: NavigationPreferences = { order: [], icons: {} }) {
 const sections = workspaceSections.map(section => ({...section, items: [...section.items]}));
 for (const plugin of integrationCatalog.filter(item => activeIds.includes(item.id))) {
  if (plugin.section && !sections.some(section => section.id === plugin.section!.id)) sections.splice(1, 0, {...plugin.section, items: []});
  for (const view of plugin.views) sections.find(section => section.id === view.section)?.items.push(pluginViews.find(item => item.id === view.id)!);
 }
 for (const view of customPluginViews(customPlugins)) sections.splice(sections.length - 1, 0, { id: view.id, label: view.label, icon: 'plugins', items: [view] });
 return applyNavigationPreferences(sections.filter(section => section.items.length), navigation);
}
export function applyNavigationPreferences(sections: WorkspaceSection[], preferences: NavigationPreferences) {
 const rank = new Map(preferences.order.map((id, index) => [id, index]));
 return sections.map(section => ({ ...section, icon: preferences.icons[section.id] || section.icon }))
  .sort((a, b) => (rank.get(a.id) ?? preferences.order.length) - (rank.get(b.id) ?? preferences.order.length));
}
export const legacyExecutionPaths = { '/delivery/plan': 'plan', '/delivery/runs': 'runs' } as const;
export function workspaceView(value: unknown, customPlugins: CustomPluginInfo[] = [], selectedPlugin?: unknown) {
  if (value === 'plugins' && typeof selectedPlugin === 'string') {
    // Menu visibility is presentation only: keep the page identity (and unsaved edits) stable.
    const plugin = customPlugins.find(plugin => plugin.manifest.id === selectedPlugin && plugin.enabled && !plugin.error);
    if (plugin) return customPluginPage(plugin);
  }
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

export function navigationPreferencesForSave(preferences: NavigationPreferences, orderedIds: string[], reordered: boolean): NavigationPreferences {
 return { order: reordered ? [...orderedIds, ...preferences.order.filter(id => !orderedIds.includes(id))] : [...preferences.order], icons: { ...preferences.icons } };
}
