import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { fingerprint, type CustomPluginRuntime } from './custom-runtime.js';
import type { PluginJira } from './host-jira.js';
export function createCustomPluginRoutes(runtime: CustomPluginRuntime, jira: PluginJira, io: {
  port: number; json(response: ServerResponse, status: number, value: unknown): void;
  body(request: IncomingMessage, limit?: number): Promise<unknown>;
  examples: { name: string; directory: string }[];
  citations: (reference: string) => { runId: string; title: string; createdAt: string; url: string }[];
}) {
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (!url.pathname.startsWith('/api/custom-plugins')) return false;
    const send = (status: number, data: unknown) => { io.json(response, status, data); return true; };
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress || '') || ![`localhost:${io.port}`, `127.0.0.1:${io.port}`].includes(request.headers.host || '')) return send(403, { message: '仅接受本机插件管理请求' });
    if (!['GET', 'POST'].includes(request.method || '')) return send(405, { message: '请求方法不支持' });
    if (request.method === 'POST' && (request.headers.origin !== `http://${request.headers.host}` || request.headers['x-delivery-confirmed'] !== 'yes')) return send(403, { message: '请从本机工作台确认此操作' });
    if (request.method === 'POST' && request.headers['content-type']?.split(';')[0] !== 'application/json') return send(415, { message: '请发送 JSON' });
    try {
      const parts = url.pathname.split('/').slice(3), [id, action] = parts;
      if (parts.length > 2) return send(404, { message: '插件操作不存在' });
      if (request.method === 'GET') {
        if (!id) return send(200, { ...runtime.list(), examples: io.examples });
        if (id === 'resources') return send(200, await runtime.search((url.searchParams.get('q') || '').slice(0, 200), url.searchParams.get('provider') || ''));
        if (id === 'resource') return send(200, await runtime.resolveReference(url.searchParams.get('reference') || ''));
        if (action === 'records') return send(200, { items: (await runtime.records(id)).map(item => ({ ...item, version: fingerprint(item) })) });
        if (action === 'record') {
          const recordId = url.searchParams.get('id') || '', resource = await runtime.resource(id, recordId);
          const citations = io.citations(resource.reference);
          return send(200, { resource, ...(await jira.status(id, recordId)), citations });
        }
        if (action === 'jira-projects') return send(200, { projects: await jira.projects(id) });
        if (action === 'jira-metadata') return send(200, await jira.metadata(id, url.searchParams.get('project') || '', url.searchParams.get('type') || ''));
        if (action === 'jira-find') return send(200, await jira.find(id, url.searchParams.get('key') || ''));
      } else {
        const input = await io.body(request, 100_000);
        if (id === 'navigation' && action === 'settings') return send(200, await runtime.saveNavigation(input));
        if (id === 'inspect') return send(200, await runtime.inspect(z.object({ directory: z.string() }).strict().parse(input).directory));
        if (id === 'install') return send(200, await runtime.install(input));
        if (action === 'change') return send(200, await runtime.change(id, input));
        if (action === 'save') return send(200, await runtime.saveRecord(id, input));
        if (action === 'delete') return send(200, await runtime.removeRecord(id, input));
        if (action === 'jira-link') return send(200, await jira.link(id, input));
        if (action === 'jira-prepare') return send(200, await jira.prepare(id, input));
        if (action === 'jira-commit') return send(200, await jira.commit(id, input));
        if (action === 'context') {
          runtime.assertCommand(id, 'conversation.context');
          const { recordId } = z.object({ recordId: z.uuid() }).strict().parse(input);
          const resource = await runtime.resource(id, recordId, true);
          return send(200, { reference: resource.reference, prompt: `请结合以下事项分析：@${resource.reference}` });
        }
      }
      return send(404, { message: '插件操作不存在' });
    } catch (error) {
      return send(400, { message: error instanceof z.ZodError ? '参数不符合插件契约，请检查输入' : error instanceof Error ? error.message : '插件操作失败' });
    }
  };
}
