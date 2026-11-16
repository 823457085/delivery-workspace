export type PluginFilterTab = 'all' | 'active' | 'service' | 'local' | 'setup';

export interface RegistryPluginLike {
  id: string;
  name: string;
  description: string;
  local?: boolean;
  localPort?: number;
  installed: boolean;
  runningEnabled: boolean;
  runningConfigured: boolean;
  configured?: boolean;
  views: { id: string; label: string }[];
}

export function isPluginActiveReady(plugin: Pick<RegistryPluginLike, 'installed' | 'runningEnabled' | 'runningConfigured'>): boolean {
  return Boolean(plugin.installed && plugin.runningEnabled && plugin.runningConfigured);
}

export function isPluginNeedsSetup(plugin: Pick<RegistryPluginLike, 'installed' | 'runningEnabled' | 'runningConfigured'>): boolean {
  return !isPluginActiveReady(plugin);
}

/**
 * Filters integration & local module plugins by search keyword and Dify/Backstage registry category tab.
 */
export function filterIntegrationPlugins<T extends RegistryPluginLike>(
  plugins: readonly T[],
  query: string,
  tab: PluginFilterTab = 'all',
  capabilitiesById: Record<string, readonly string[]> = {},
): T[] {
  const needle = (query || '').trim().toLowerCase();

  return plugins.filter(plugin => {
    if (tab === 'active' && !isPluginActiveReady(plugin)) return false;
    if (tab === 'service' && plugin.local) return false;
    if (tab === 'local' && !plugin.local) return false;
    if (tab === 'setup' && !isPluginNeedsSetup(plugin)) return false;

    if (!needle) return true;
    const caps = (capabilitiesById[plugin.id] || []).join(' ');
    const viewLabels = plugin.views.map(v => `${v.id} ${v.label}`).join(' ');
    const portText = plugin.localPort ? String(plugin.localPort) : '';
    const haystack = `${plugin.id} ${plugin.name} ${plugin.description} ${caps} ${viewLabels} ${portText}`.toLowerCase();
    return haystack.includes(needle);
  });
}

export function summarizePluginRegistry(plugins: readonly RegistryPluginLike[]) {
  let active = 0;
  let service = 0;
  let local = 0;
  let setup = 0;
  for (const p of plugins) {
    if (isPluginActiveReady(p)) active++;
    else setup++;
    if (p.local) local++;
    else service++;
  }
  return {
    all: plugins.length,
    active,
    service,
    local,
    setup,
  };
}
