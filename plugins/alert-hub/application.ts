import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { PluginApplicationHost, PluginMcpConnection, PluginMcpTool } from '../../shared/plugin-application-host.js';
const callSchema = z.object({ name: z.string().min(1).max(100), arguments: z.record(z.string(), z.unknown()).default({}), ticket: z.string().optional() }).strict();
// Explicitly audited read operations. MCP annotations alone never authorize a write as a read.
const readTools = new Set(['get_health', 'get_me', 'get_summary', 'list_cases', 'get_case', 'list_events', 'get_event', 'list_todos', 'get_todo', 'list_owners', 'list_rules', 'dry_run_rule']);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function createPlugin(host: PluginApplicationHost) {
  let connection: PluginMcpConnection | undefined, tools: PluginMcpTool[] = [];
  const tickets = new Map<string, { digest: string; expires: number }>();
  function config() {
    const { endpoint, command, username, password } = host.configuration;
    if (!endpoint || !command || !username?.trim() || !password) throw new Error('请先在设置 → 自定义功能插件 → 告警中心 → 配置中填写 MCP 路径、服务地址和账号密码');
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('服务地址必须是无账号、查询参数的 HTTPS 地址');
    return { endpoint: url.toString().replace(/\/$/, ''), command, username, password };
  }
  function sanitize(value: unknown): any {
    // Do not leak configured credentials if an upstream error echoes request inputs.
    const secret = host.configuration.password;
    if (typeof value === 'string') return secret ? value.split(secret).join('[已隐藏]') : value;
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
    return value;
  }
  async function connect() {
    if (connection) return connection;
    const c = config();
    connection = await host.mcp.connect({ command: c.command, env: { ALERT_HUB_MCP_URL: c.endpoint, ALERT_HUB_MCP_USERNAME: c.username, ALERT_HUB_MCP_PASSWORD: c.password } });
    try { tools = await connection.listTools(); } catch (error) { await connection.close(); connection = undefined; throw error; }
    return connection;
  }
  function readonly(tool: PluginMcpTool) { return readTools.has(tool.name) && tool.annotations?.readOnlyHint === true; }
  return {
    async close() { tickets.clear(); await connection?.close(); connection = undefined; tools = []; },
    async request(method: string, raw?: unknown): Promise<any> {
      if (method === 'status') return { configured: !!(host.configuration.endpoint && host.configuration.command && host.configuration.username && host.configuration.password), endpoint: host.configuration.endpoint || '', transport: 'stdio MCP' };
      if (method === 'reconnect') { tickets.clear(); await connection?.close(); connection = undefined; tools = []; await connect(); return { connected: true }; }
      const client = await connect();
      if (method === 'tools') return sanitize(tools.map(t => ({ ...t, readOnly: readonly(t) })));
      if (!['read', 'prepare', 'commit'].includes(method)) throw new Error('插件操作不存在');
      const input = callSchema.parse(raw), tool = tools.find(t => t.name === input.name);
      if (!tool) throw new Error('MCP 未提供此工具');
      const signature = digest({ name: input.name, arguments: input.arguments });
      if (method === 'prepare') {
        if (readonly(tool)) throw new Error('只读工具无需写入确认');
        for (const [key, ticket] of tickets) if (ticket.expires < Date.now()) tickets.delete(key);
        if (tickets.size >= 20) throw new Error('待确认操作过多，请重新连接');
        const ticket = randomUUID(); tickets.set(ticket, { digest: signature, expires: Date.now() + 120000 });
        return { ticket, name: input.name, arguments: sanitize(input.arguments) };
      }
      if (method === 'read' && !readonly(tool)) throw new Error('该操作会修改远端数据，请预览并确认');
      if (method === 'commit') {
        const ticket = tickets.get(input.ticket || ''); tickets.delete(input.ticket || '');
        if (!ticket || ticket.digest !== signature || ticket.expires < Date.now()) throw new Error('确认已失效或参数已变化，请重新预览');
      }
      const result = sanitize(await client.callTool(input.name, input.arguments));
      if (result?.isError) throw new Error(result.content?.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n') || 'MCP 工具执行失败');
      return result?.structuredContent ?? result?.content?.filter((c: any) => c.type === 'text').map((c: any) => { try { return JSON.parse(c.text); } catch { return c.text; } }) ?? result;
    },
  };
}
