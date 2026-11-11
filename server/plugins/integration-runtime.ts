/** Trusted bundled extensions own their services and compatibility routes. No user code is loaded. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SourceBackend } from '../source-backend.js';
import { assertPluginEnabled } from './definitions.mjs';
import { createExtension as jira } from '../../plugins/jira/server.js';
import { createExtension as confluence } from '../../plugins/confluence/server.js';
export interface IntegrationHost { directory: string; source: Pick<SourceBackend, 'jiraIssueRequest' | 'confluenceReadRequest'>; port: number;
 json(response: ServerResponse, status: number, value: unknown): void; body(request: IncomingMessage, limit?: number): Promise<unknown> }
export interface IntegrationExtension { id: string; contentTypes?: string[]; matches(url: URL): boolean;
 route(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean>;
 hasReference?(objective: string): boolean; resolveKnowledge?(objective: string): Promise<string>; close(): Promise<void> }
export function createIntegrationRuntime(host: IntegrationHost, factories = [jira, confluence]) {
 const extensions = factories.map(create => create(host));
 if (new Set(extensions.map(extension => extension.id)).size !== extensions.length) throw new Error('重复的接入插件 ID');
 return {
  async route(request: IncomingMessage, response: ServerResponse, url: URL) {
   const extension = extensions.find(item => item.matches(url)); if (!extension) return false;
   const send = (status: number, message: string) => {host.json(response, status, {message}); return true;};
   if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress || '') || ![`localhost:${host.port}`, `127.0.0.1:${host.port}`].includes(request.headers.host || '')) return send(403, '仅接受本机插件请求');
   if (request.method !== 'GET' && (request.headers.origin !== `http://${request.headers.host}` || request.headers['x-delivery-confirmed'] !== 'yes')) return send(403, '请在本机工作台确认操作');
   if (request.method !== 'GET' && !(extension.contentTypes || ['application/json']).includes(request.headers['content-type']?.split(';')[0] || '')) return send(415, '请发送 JSON');
   try { assertPluginEnabled(extension.id); return await extension.route(request, response, url); }
   catch(error) { return send(400, error instanceof Error ? error.message : '插件调用失败'); }
  },
  async resolveKnowledge(objective: string) {
   return (await Promise.all(extensions.filter(extension => extension.hasReference?.(objective)).map(extension => {
    assertPluginEnabled(extension.id); return extension.resolveKnowledge!(objective);
   }))).filter(Boolean).join('\n\n');
  },
  async close() { await Promise.all(extensions.map(extension => extension.close())); },
 };
}
