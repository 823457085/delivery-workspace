import path from 'node:path';
import { z } from 'zod';
import { createConfluenceKnowledge } from '../../server/confluence-knowledge.js';
import type { IntegrationHost, IntegrationExtension } from '../../server/plugins/integration-runtime.js';
export function createExtension(host: IntegrationHost): IntegrationExtension {
 let pending: ReturnType<typeof createConfluenceKnowledge> | undefined;
 const service = () => pending ||= createConfluenceKnowledge(path.join(host.directory, 'confluence-knowledge'), host.source.confluenceReadRequest).catch(error => {pending = undefined; throw error;});
 return {
  id: 'confluence', matches: url => url.pathname.startsWith('/api/agent-runtimes/confluence/'),
  async route(request, response, url) {
    const confluenceKnowledge = await service(), {json, body} = host;
          const action = url.pathname.slice('/api/agent-runtimes/confluence/'.length);
          if (action === 'config' && request.method === 'GET') {
            json(response, 200, await confluenceKnowledge.config(url.searchParams.get('workspacePath') || '')); return true;
          }
          if (action === 'config' && request.method === 'POST') {
            const input = z.object({ workspacePath: z.string().min(1).max(1000), scope: z.unknown() }).strict().parse(await body(request));
            json(response, 200, await confluenceKnowledge.configure(input.workspacePath, input.scope)); return true;
          }
          if (action === 'search' && request.method === 'GET') {
            const input = z.object({ workspacePath: z.string().max(1000).default(''), q: z.string().trim().max(200).default(''),
              start: z.coerce.number().int().min(0).max(10000).default(0), field: z.enum(['title', 'text']).default('title') }).parse(Object.fromEntries(url.searchParams));
            json(response, 200, await confluenceKnowledge.search(input.workspacePath, input.q, input.start, input.field)); return true;
          }
          if (action === 'page' && request.method === 'GET') {
            const reference = z.string().min(1).max(2000).parse(url.searchParams.get('reference'));
            json(response, 200, await confluenceKnowledge.read(reference)); return true;
          }
          if (action === 'related' && request.method === 'POST') {
            const input = z.object({ text: z.string().max(100000) }).strict().parse(await body(request, 150000));
            json(response, 200, await confluenceKnowledge.related(input.text)); return true;
          }
          json(response, 404, { message: 'Confluence 文档接口不存在' }); return true;

  },
  async resolveKnowledge(objective) { return (await service()).resolveReferences(objective); },
  hasReference: objective => /@confluence:[^\s<>"`]+/.test(objective),
  async close() { if (pending) await (await pending).close(); },
 };
}
