import type { CatalogSource } from './catalog-transport.js';
import type { GitHubSettings } from './github-source.mjs';
import type { PluginDefinition } from './definitions.mjs';
export interface PluginConfig extends GitHubSettings { clearGithubToken?: boolean; transport?: 'http' | 'mcp' | 'github'; enabled: boolean; installed?: boolean; baseUrl?: string; username?: string; token?: string; groupName?: string; webhook?: string }
export interface PluginData { version: 1; plugins: Record<string, PluginConfig> }
export interface PluginStatus extends PluginDefinition { transport?: 'http' | 'mcp' | 'github'; githubKind?: 'market' | 'plugin'; githubPath?: string; githubPolicy?: 'stable' | 'all' | 'pinned'; githubRef?: string; githubTokenConfigured?: boolean; enabled: boolean; installed: boolean; runningEnabled: boolean; runningConfigured: boolean; baseUrl: string; username: string; groupName: string; configured: boolean; restartRequired: boolean; source: string }
export function pluginFile(env?: NodeJS.ProcessEnv): string;
export function readPluginFile(file: string): Promise<PluginData>;
export function applyPluginEnvironment(data: PluginData, env: NodeJS.ProcessEnv): void;
export function createPluginStore(options?: {
  port?: number; file?: string; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch;
  wecomConfig?: () => { groupName?: string; hasWebhook?: boolean };
  catalogProbe?: (config: PluginConfig) => Promise<{ message: string }>;
  legacyProbe?: (id: 'jira' | 'confluence') => Promise<Response>;
}): Promise<{
  list(): Promise<PluginStatus[]>;
  catalogSources(): Promise<CatalogSource[]>;
  state(id: string, input: unknown): Promise<{ plugins: PluginStatus[]; message: string }>;
  save(id: string, input: unknown): Promise<{ plugins: PluginStatus[]; message: string }>;
  test(id: string, input: unknown): Promise<{ message: string }>;
}>;
