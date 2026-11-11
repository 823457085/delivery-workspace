import { computed, type Component } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { integrationCatalog, integrationAvailable, type IntegrationStatus } from '../../shared/integration-plugins';
interface FrontendModule { components: Record<string, Component>; mentions?: (workspace: string, query: string, signal: AbortSignal) => Promise<{id: string; kind: string; label: string; detail: string; value: string}[]> }
let packages: Record<string, {default: FrontendModule}> = {};
try { packages = import.meta.glob<{ default: FrontendModule }>('../../plugins/*/frontend.ts', { eager: true }); } catch { /* Pure Node contract tests do not load browser components. */ }
export const integrationComponents = Object.fromEntries(integrationCatalog.map(plugin => [plugin.id, packages[`../../plugins/${plugin.id}/frontend.ts`]?.default]));
export function useIntegrationPlugins() {
 const query = useQuery({ queryKey: ['integration-plugins'], queryFn: async ({signal}) => {
  const response = await fetch('/api/plugins', {signal}); const data = await response.json();
  if (!response.ok) throw new Error(data.message || '插件状态读取失败'); return data.plugins as IntegrationStatus[];
 }, staleTime: 5000, refetchInterval: 10000, retry: false });
 const statuses = computed(() => query.data.value || []);
 const available = (id: string) => !query.error.value && integrationAvailable(statuses.value.find(item => item.id === id));
 const active = computed(() => integrationCatalog.filter(plugin => available(plugin.id)));
 const capability = (name: string) => active.value.some(plugin => plugin.capabilities.includes(name));
 const knowledge = computed(() => active.value.flatMap(plugin => (plugin.knowledge || []).map(item => ({...item, pluginId: plugin.id, component: integrationComponents[plugin.id]?.components[item.component]}))));
 const slots = (id: string) => active.value.flatMap(plugin => (plugin.slots || []).filter(item => item.id === id).map(item => ({...item, pluginId: plugin.id, component: integrationComponents[plugin.id]?.components[item.component]})));
 const widgets = computed(() => active.value.flatMap(plugin => (plugin.widgets || []).map(item => ({...item, component: integrationComponents[plugin.id]?.components[item.component]}))));
 const mentions = computed(() => active.value.filter(plugin => plugin.mention && integrationComponents[plugin.id]?.mentions).map(plugin => ({ ...plugin.mention!, search: integrationComponents[plugin.id]!.mentions! })));
 return { query, statuses, available, active, capability, knowledge, widgets, slots, mentions };
}
