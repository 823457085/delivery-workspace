import type { PluginDefinition } from './definitions.mjs';
export interface PluginConfig { enabled: boolean; installed?: boolean; baseUrl?: string; username?: string; token?: string; groupName?: string; webhook?: string }
export interface PluginData { version: 1; plugins: Record<string, PluginConfig> }
export interface PluginStatus extends PluginDefinition { enabled: boolean; installed: boolean; runningEnabled: boolean; runningConfigured: boolean; baseUrl: string; username: string; groupName: string; configured: boolean; restartRequired: boolean; source: string }
export function pluginFile(env?: NodeJS.ProcessEnv): string;
export function readPluginFile(file: string): Promise<PluginData>;
export function managedPluginCredential(key: string, env?: NodeJS.ProcessEnv): boolean;
export function applyPluginEnvironment(data: PluginData, env: NodeJS.ProcessEnv): void;
export function createPluginStore(options?: {
  file?: string; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch;
  wecomConfig?: () => { groupName?: string; hasWebhook?: boolean };
  legacyProbe?: (id: 'jira' | 'confluence') => Promise<Response>;
}): Promise<{
  list(): Promise<PluginStatus[]>;
  state(id: string, input: unknown): Promise<{ plugins: PluginStatus[]; message: string }>;
  save(id: string, input: unknown): Promise<{ plugins: PluginStatus[]; message: string }>;
  test(id: string, input: unknown): Promise<{ message: string }>;
}>;
