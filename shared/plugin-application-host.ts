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
  dataDirectory: string;
  workspaceDirectory: string;
  configuration: Readonly<Record<string, string>>;
  mcp: { connect(options: { command: string; args?: string[]; env?: Record<string, string>; timeoutMs?: number }): Promise<PluginMcpConnection> };
}
