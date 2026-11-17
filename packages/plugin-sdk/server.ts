/** Server-only public hostApi 2 services; configuration secrets must never be returned to UI. */
export interface PluginMcpTool {
  name: string;
  description?: string;
  inputSchema: { type?: string; properties?: Record<string, any>; required?: string[]; [key: string]: unknown };
  annotations?: { readOnlyHint?: boolean; [key: string]: unknown };
}
export interface PluginMcpConnection {
  listTools(): Promise<PluginMcpTool[]>;
  callTool(name: string, args?: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
}
export interface PluginApplicationHost {
  workspaces: PluginWorkspaces;
  dataDirectory: string;
  workspaceDirectory: string;
  configuration: Readonly<Record<string, string>>;
  capabilities: { call(name: string, method: string, input?: unknown, provider?: string): Promise<unknown> };
  mcp: { connect(options: { command: string; args?: string[]; env?: Record<string, string>; timeoutMs?: number }): Promise<PluginMcpConnection> };
}

/** Only session-associated linked worktrees; primary repositories are never removable. */
export interface PluginWorkspaceUsage {
  path: string; branch: string; bytes: number | null;
  sessions: { id: string; title: string; updatedAt: string }[];
  eligible: boolean; reason?: string; managed: boolean; lastUsedAt: string;
}
export interface PluginWorkspacePreview { path: string; revision: string; eligible: boolean; reason?: string }
export interface PluginWorkspaceRemoval {
  path: string; revision: string; confirmName: string;
  /** Periodic cleanup must use a fresh cutoff; host rechecks age and ownership under its workspace lock. */
  idleBefore?: number;
}
export interface PluginWorkspaces {
  access(): Promise<{ read: boolean; cleanup: boolean; background: boolean }>;
  list(): Promise<PluginWorkspaceUsage[]>;
  preview(path: string): Promise<PluginWorkspacePreview>;
  remove(input: PluginWorkspaceRemoval): Promise<{ path: string; deleted: true }>;
}
