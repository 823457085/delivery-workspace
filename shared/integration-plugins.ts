import jira from '../plugins/jira/integration.json';
import confluence from '../plugins/confluence/integration.json';
import wecom from '../plugins/wecom/integration.json';
export interface IntegrationView { id: string; label: string; path: string; section: string; component: string; mode?: string }
export interface IntegrationManifest { id: string; name: string; description: string; capabilities: string[]; prefix: string; probe?: string;
 section?: { id: string; label: string; shortLabel: string; icon: string }; views: IntegrationView[];
 slots?: {id: string; component: string; label: string}[];
 widgets?: {id: string; component: string}[]; historyPaths?: string[];
 knowledge?: { id: string; label: string; component: string }[]; mention?: { kind: string; label: string; prefixes: string[] };
 sourceKeys: string[]; apiPrefixes: string[]; apiPaths: string[]; businessTypes?: string[] }
export interface IntegrationStatus { id: string; enabled: boolean; installed: boolean; runningEnabled: boolean; runningConfigured: boolean; configured: boolean; restartRequired: boolean; name: string }
export const integrationCatalog: IntegrationManifest[] = [jira, confluence, wecom];
export function integrationAvailable(status: IntegrationStatus | undefined) { return !!status?.installed && status.runningEnabled && status.runningConfigured; }
export function sourceOwner(key: string) { return integrationCatalog.find(plugin => plugin.sourceKeys.includes(key)); }
