export interface PluginDefinition { id: string; name: string; description: string; capabilities: string[]; prefix: string; probe?: string; sourceKeys: string[]; apiPrefixes: string[]; apiPaths: string[] }
export const pluginDefinitions: PluginDefinition[];
export function definition(id: string): PluginDefinition;
export function pluginBaseUrl(id: 'jira' | 'confluence' | 'wecom', env?: NodeJS.ProcessEnv): string;
export function pluginEnabled(id: string, env?: NodeJS.ProcessEnv): boolean;
export function assertPluginEnabled(id: string, env?: NodeJS.ProcessEnv): void;
export function assertIntegrationRequest(pathname: string, env?: NodeJS.ProcessEnv, method?: string): void;
export function assertIntegrationCapability(capability: string, env?: NodeJS.ProcessEnv): void;
