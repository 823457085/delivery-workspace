import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { boundedResponse } from './catalog-http.js';
import { readGithubSource } from './github-catalog.js';
import type { GitHubSettings } from './github-source.mjs';
import { catalogEndpoint } from './catalog-connection.mjs';

export type CatalogSource = GitHubSettings & { id: string; name: string; location: string; transport?: 'http' | 'mcp' | 'github'; error?: string };

async function readMcp(endpoint: URL, uri: string, limit: number) {
  const client = new Client({ name: 'delivery-workspace-catalog', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(endpoint, { fetch: async (input, init) => {
    const url = new URL(input);
    if (url.href !== endpoint.href) throw new Error('MCP 不允许切换连接地址');
    // SDK uses JSON or SSE; buffer a bounded, time-limited response before parsing either format.
    const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(init?.signal ? [init.signal] : [])]) });
    if (response.status === 202 || response.status === 204 || !response.ok) return response;
    const bytes = await boundedResponse(response, Math.ceil(limit * 4 / 3) + 64_000);
    const headers = new Headers(response.headers); headers.delete('content-encoding'); headers.delete('content-length');
    return new Response(bytes, { status: response.status, headers });
  } });
  try {
    await client.connect(transport, { timeout: 20_000 });
    const result = await client.readResource({ uri }, { timeout: 20_000 });
    if (result.contents.length !== 1 || result.contents[0].uri !== uri) throw new Error('MCP 返回了不匹配的资源');
    const resource = result.contents[0];
    const bytes = 'blob' in resource ? Buffer.from(resource.blob, 'base64') : Buffer.from(resource.text, 'utf8');
    if (bytes.length > limit || 'blob' in resource && bytes.toString('base64') !== resource.blob) throw new Error('MCP 资源编码或大小无效');
    return bytes;
  } finally { await client.close().catch(() => {}); }
}
/** Reads a declared catalog or package only; never executes MCP tools or follows remote URLs. */
export async function readCatalogRemote(source: CatalogSource, limit: number, packageName?: string) {
  if (packageName && !/^[a-z0-9][a-z0-9.-]*\.dwp$/.test(packageName)) throw new Error('发布包文件名无效');
  if (source.transport === 'github') return readGithubSource(source, limit, packageName);
  const endpoint = catalogEndpoint(source.location, source.transport || 'http');
  if (source.transport === 'mcp') return readMcp(endpoint, packageName ? `plugin-market://packages/${packageName}` : 'plugin-market://catalog', limit);
  const url = packageName ? new URL(packageName, endpoint) : endpoint;
  return boundedResponse(await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { Accept: 'application/json' } }), limit);
}
