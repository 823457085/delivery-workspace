import { computed, shallowRef, type Component } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { integrationCatalog, integrationAvailable, type IntegrationManifest, type IntegrationStatus } from '../../shared/integration-plugins';
interface FrontendModule { components: Record<string, Component>; mentions?: (workspace: string, query: string, signal: AbortSignal) => Promise<{id: string; kind: string; label: string; detail: string; value: string}[]> }
let packages: Record<string, {default: FrontendModule}> = {};
try { packages = import.meta.glob<{ default: FrontendModule }>('../../plugins/*/frontend.ts', { eager: true }); } catch { /* Pure Node contract tests do not load browser components. */ }
export const integrationComponents = Object.fromEntries(integrationCatalog.map(plugin => [plugin.id, packages[`../../plugins/${plugin.id}/frontend.ts`]?.default]));

const LOCAL_OVERRIDE_KEY = 'delivery-workspace.local-module-plugins:v1';
type LocalOverrideMap = Record<string, { enabled?: boolean; installed?: boolean }>;
function loadOverrides(): LocalOverrideMap {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(LOCAL_OVERRIDE_KEY) : null;
    return raw ? JSON.parse(raw) as LocalOverrideMap : {};
  } catch { return {}; }
}
const localOverrides = shallowRef<LocalOverrideMap>(loadOverrides());
export function saveLocalModuleOverride(id: string, input: { enabled?: boolean; installed?: boolean }) {
  const next = { ...localOverrides.value, [id]: { ...localOverrides.value[id], ...input } };
  localOverrides.value = next;
  try { window.localStorage.setItem(LOCAL_OVERRIDE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
}
export function fallbackLocalPluginStatus(plugin: IntegrationManifest): IntegrationStatus {
  const saved = localOverrides.value[plugin.id] || {};
  const installed = saved.installed !== false;
  const enabled = saved.enabled !== false;
  const portOk = !plugin.localPort || (typeof window !== 'undefined' && String(plugin.localPort) === window.location.port);
  return {
    id: plugin.id,
    name: plugin.name,
    installed,
    enabled,
    runningEnabled: installed && enabled,
    configured: portOk,
    runningConfigured: portOk,
    restartRequired: false,
  };
}

export function useIntegrationPlugins() {
 const query = useQuery({ queryKey: ['integration-plugins'], queryFn: async ({signal}) => {
  const response = await fetch('/api/plugins', {signal}); const data = await response.json();
  if (!response.ok) throw new Error(data.message || '插件状态读取失败'); return data.plugins as IntegrationStatus[];
 }, staleTime: 15_000, refetchInterval: 30_000, refetchIntervalInBackground: false, retry: false });
 const statuses = computed(() => {
  const remote = query.data.value || [];
  if (!remote.length) return remote;
  const known = new Set(remote.map(item => item.id));
  const missingLocals = integrationCatalog
    .filter(plugin => plugin.local && !known.has(plugin.id))
    .map(plugin => fallbackLocalPluginStatus(plugin));
  return missingLocals.length ? [...remote, ...missingLocals] : remote;
 });
 const available = (id: string) => {
  const status = statuses.value.find(item => item.id === id);
  // 后台轮询偶发超时或重启切换瞬间，沿用最近一次已成功拉取的插件快照，避免顶部导航栏整排闪烁消失。
  if (status) return integrationAvailable(status);
  const manifest = integrationCatalog.find(item => item.id === id);
  if (manifest?.local) return integrationAvailable(fallbackLocalPluginStatus(manifest));
  return false;
 };
 const active = computed(() => integrationCatalog.filter(plugin => available(plugin.id)));
 const capability = (name: string) => active.value.some(plugin => plugin.capabilities.includes(name));
 const knowledge = computed(() => active.value.flatMap(plugin => (plugin.knowledge || []).map(item => ({...item, pluginId: plugin.id, component: integrationComponents[plugin.id]?.components[item.component]}))));
 const slots = (id: string) => active.value.flatMap(plugin => (plugin.slots || []).filter(item => item.id === id).map(item => ({...item, pluginId: plugin.id, component: integrationComponents[plugin.id]?.components[item.component]})));
 const widgets = computed(() => active.value.flatMap(plugin => (plugin.widgets || []).map(item => ({...item, component: integrationComponents[plugin.id]?.components[item.component]}))));
 const mentions = computed(() => active.value.filter(plugin => plugin.mention && integrationComponents[plugin.id]?.mentions).map(plugin => ({ ...plugin.mention!, search: integrationComponents[plugin.id]!.mentions! })));
 return { query, statuses, available, active, capability, knowledge, widgets, slots, mentions };
}
