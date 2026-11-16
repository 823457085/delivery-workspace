import jira from '../plugins/jira/integration.json';
import confluence from '../plugins/confluence/integration.json';
import wecom from '../plugins/wecom/integration.json';
import pluginMarket from '../plugins/plugin-market/integration.json';
import interfaceCenter from '../plugins/interface-center/integration.json';
import systemCatalog from '../plugins/system-catalog/integration.json';
import portMonitor from '../plugins/port-monitor/integration.json';
import deployments from '../plugins/deployments/integration.json';
import refactorControl from '../plugins/refactor-control/integration.json';
import overseasRequirements from '../plugins/overseas-requirements/integration.json';
export interface IntegrationView { id: string; label: string; path: string; section: string; component: string; mode?: string; embedded?: boolean }
export interface IntegrationManifest { id: string; name: string; description: string; capabilities: string[]; prefix: string; probe?: string; local?: boolean; localPort?: number;
 connection?: { type: string; label: string; openLabel: string; openPath?: string };
 section?: { id: string; label: string; shortLabel: string; icon: string }; views: IntegrationView[];
 slots?: {id: string; component: string; label: string}[];
 widgets?: {id: string; component: string}[]; historyPaths?: string[];
 knowledge?: { id: string; label: string; component: string }[]; mention?: { kind: string; label: string; prefixes: string[] };
 sourceKeys: string[]; apiPrefixes: string[]; apiPaths: string[]; businessTypes?: string[] }
export interface IntegrationStatus { id: string; enabled: boolean; installed: boolean; runningEnabled: boolean; runningConfigured: boolean; configured: boolean; restartRequired: boolean; name: string }
export const integrationCatalog: IntegrationManifest[] = [
  jira, confluence, wecom, pluginMarket,
  interfaceCenter, systemCatalog, portMonitor, deployments, refactorControl, overseasRequirements,
];
export function integrationAvailable(status: IntegrationStatus | undefined) { return !!status?.installed && status.runningEnabled && status.runningConfigured; }
export function sourceOwner(key: string) { return integrationCatalog.find(plugin => plugin.sourceKeys.includes(key)); }
