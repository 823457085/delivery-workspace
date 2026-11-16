import type { NavigationPreferences } from '../../../shared/workspace-navigation';
import type { CustomPluginInfo } from '../../../shared/custom-plugins';
import { integrationCatalog } from '../../../shared/integration-plugins';
import customApplicationMenuReplacements from '../../plugins/custom-application-menu-replacements.json';
export interface WorkspaceView { id: string; label: string; path: string; mode?: string; embedded?: boolean; pluginId?: string; component?: string; customPluginId?: string }
export interface WorkspaceSection { id: string; label: string; shortLabel?: string; icon?: string; items: WorkspaceView[] }
/** 统一工作入口；核心底座仅保留高频宿主骨架，外围研发工具与业务连接全部走插件按需挂载。 */
export const workspaceSections: WorkspaceSection[] = [
  { id: 'today', label: '今日工作', items: [{ id: 'today', label: '我的工作台', path: '/workbench' }, { id: 'overview', label: '工作总览', path: '/overview' }] },
  { id: 'projects', label: '项目与 Git', items: [{ id: 'projects', label: '本地项目与 Git', path: '/projects' }] },
  { id: 'execution', label: 'AI 交付', items: [{ id: 'design', label: '需求开发', path: '/design' }, { id: 'queue', label: '执行中心', path: '/delivery/queue', mode: 'queue' }] },
  { id: 'automation', label: '自动化 / 设置', items: [{ id: 'settings', label: '连接与策略设置', path: '/settings' }, { id: 'plugins', label: '功能插件', path: '/agent?view=plugins' }, { id: 'automation', label: '自动化与报告', path: '/agent?view=automation' }] },
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
  if (plugin.section && !sections.some(section => section.id === plugin.section!.id)) sections.splice(plugin.local ? sections.length - 1 : 1, 0, {...plugin.section, items: []});
  for (const view of plugin.views) sections.find(section => section.id === view.section)?.items.push(pluginViews.find(item => item.id === view.id)!);
 }
 for (const view of customPluginViews(customPlugins)) sections.splice(sections.length - 1, 0, { id: view.id, label: view.label, icon: 'plugins', items: [view] });
 return applyNavigationPreferences(sections.filter(section => section.items.length), navigation);
}

/** Choose one menu for integrations that have declared a same-ID application replacement. */
export function workspaceMenuSections(activeIds: string[], customPlugins: CustomPluginInfo[], navigation?: NavigationPreferences) {
  const pairedIds = new Set(customApplicationMenuReplacements.filter(id => activeIds.includes(id)));
  const applicationIds = new Set(customPlugins
    .filter(({ manifest, enabled, showInMenu, error, grants }) => enabled && showInMenu && !error
      && manifest.page.kind === 'application' && grants.includes('application.local')
      && !manifest.capabilities?.some(capability => capability.required && !grants.includes(capability.id)))
    .map(plugin => plugin.manifest.id));
  return registeredWorkspaceSections(
    activeIds.filter(id => !pairedIds.has(id) || !applicationIds.has(id)),
    customPlugins.filter(({ manifest }) => !pairedIds.has(manifest.id) || applicationIds.has(manifest.id)),
    navigation,
  );
}
export function applyNavigationPreferences(sections: WorkspaceSection[], preferences: NavigationPreferences) {
 const rank = new Map(preferences.order.map((id, index) => [id, index]));
 return sections.map(section => ({ ...section, icon: preferences.icons[section.id] || section.icon }))
  .sort((a, b) => (rank.get(a.id) ?? preferences.order.length) - (rank.get(b.id) ?? preferences.order.length));
}
export const legacyExecutionPaths = { '/delivery/plan': 'plan', '/delivery/runs': 'runs' } as const;
export const legacyRedirectPaths = {
  '/delivery/handoff': 'queue',
  '/catchup/execution': 'queue',
  '/catchup/merge': 'queue',
} as const;
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
  if (Object.hasOwn(legacyRedirectPaths, path)) return {
    path: '/agent', query: { ...query, view: legacyRedirectPaths[path as keyof typeof legacyRedirectPaths] },
  };
  const item = workspaceViews.find(view => view.path === path);
  return item ? { path: '/agent', query: { ...query, view: item.id } } : undefined;
}

export function navigationPreferencesForSave(preferences: NavigationPreferences, orderedIds: string[], reordered: boolean): NavigationPreferences {
 return { order: reordered ? [...orderedIds, ...preferences.order.filter(id => !orderedIds.includes(id))] : [...preferences.order], icons: { ...preferences.icons } };
}

export function workspaceChatQuery(mode: 'session' | 'group', sessionId = '', roomId = ''): Record<string, string> {
  if (mode === 'group') return roomId ? { group: '1', room: roomId } : { group: '1' };
  return sessionId ? { session: sessionId } : {};
}
