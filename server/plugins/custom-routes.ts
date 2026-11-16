import type { PluginApplications } from './applications.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { fingerprint, type CustomPluginRuntime } from './custom-runtime.js';
import type { PluginJira } from './host-jira.js';
import type { PluginDistribution } from './distribution.js';
export function createCustomPluginRoutes(runtime: CustomPluginRuntime, jira: PluginJira, io: {
  port: number; json(response: ServerResponse, status: number, value: unknown): void;
  body(request: IncomingMessage, limit?: number): Promise<unknown>;
  examples: { name: string; directory: string }[];
  applications?: PluginApplications;
  distribution?: PluginDistribution;
  citations: (reference: string) => { runId: string; title: string; createdAt: string; url: string }[];
}) {
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (!url.pathname.startsWith('/api/custom-plugins')) return false;
    const send = (status: number, data: unknown) => { io.json(response, status, data); return true; };
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress || '') || ![`localhost:${io.port}`, `127.0.0.1:${io.port}`].includes(request.headers.host || '')) return send(403, { message: '仅接受本机插件管理请求' });
    if (!['GET', 'POST'].includes(request.method || '')) return send(405, { message: '请求方法不支持' });
    if (request.headers['sec-fetch-site'] === 'cross-site' || request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) return send(403, { message: '仅接受本机同源插件管理请求' });
    if (request.method === 'POST' && (request.headers.origin !== `http://${request.headers.host}` || request.headers['x-delivery-confirmed'] !== 'yes')) return send(403, { message: '请从本机工作台确认此操作' });
    if (request.method === 'POST' && request.headers['content-type']?.split(';')[0] !== 'application/json') return send(415, { message: '请发送 JSON' });
    try {
      const parts = url.pathname.split('/').slice(3), [id, action] = parts;
      if (parts.length > 2) return send(404, { message: '插件操作不存在' });
      if (request.method === 'GET') {
        if (id === 'protocol') return send(200, { protocol: 1, sdk: '2.1.0', hostApi: [1, 2] });
        if (id === 'catalogs' && io.distribution) return send(200, await io.distribution.catalogs());
        if (id === 'install-tasks' && action && io.distribution) return send(200, await io.distribution.getTask(action));
        if (!id) return send(200, { ...runtime.list(), examples: io.examples });
        if (id === 'resources') return send(200, await runtime.search((url.searchParams.get('q') || '').slice(0, 200), url.searchParams.get('provider') || ''));
        if (id === 'resource') return send(200, await runtime.resolveReference(url.searchParams.get('reference') || ''));
        if (action === 'configuration') return send(200, await runtime.configuration(id));
        if (action === 'application' && io.applications) return send(200, await io.applications.page(id));
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
        const input = await io.body(request, 500_000);
        if (id === 'installation' && io.distribution) {
          if (action === 'preview') return send(200, await io.distribution.preview(input));
          if (action === 'confirm') return send(200, await io.distribution.confirm(input));
          if (action === 'cancel') return send(200, await io.distribution.cancel(z.object({ id: z.uuid() }).strict().parse(input).id));
        }
        if (id === 'navigation' && action === 'settings') return send(200, await runtime.saveNavigation(input));
        if (id === 'inspect' && !action) return send(200, await runtime.inspect(z.object({ directory: z.string() }).strict().parse(input).directory));
        if (id === 'install' && !action) { const result = await runtime.install(input); for (const plugin of result.plugins) if (plugin.digest === (input as any).digest) io.applications?.stop(plugin.manifest.id); return send(200, result); }
        if (action === 'configure') { const result = await runtime.configure(id, input); io.applications?.stop(id); return send(200, result); }
        if (action === 'change') {
          const result = await runtime.change(id, input), current = result.plugins.find(p => p.manifest.id === id);
          if ((input as any).grants || !current?.enabled || !current.grants.includes('application.local')) io.applications?.stop(id);
          return send(200, result);
        }
        if (action === 'application-call' && io.applications) return send(200, await io.applications.call(id, input));
        if (action === 'compose' && io.applications) return send(200, await io.applications.compose(id, input));
        if (action === 'open-workspace' && io.applications) return send(200, await io.applications.open(id, input));
        if (id === 'upgrade-preview' && !action) {
          const parsed = z.object({ id: z.string(), directory: z.string().optional() }).strict().parse(input);
          return send(200, await runtime.inspectUpgrade(parsed.id, parsed.directory));
        }
        if (id === 'upgrade' && !action) return send(200, await runtime.upgrade(input));
        if (action === 'save') return send(200, await runtime.saveRecord(id, input));
        if (action === 'delete') return send(200, await runtime.removeRecord(id, input));
        if (action === 'jira-link') return send(200, await jira.link(id, input));
        if (action === 'jira-prepare') return send(200, await jira.prepare(id, input));
        if (action === 'jira-commit') return send(200, await jira.commit(id, input));
        if (action === 'jira-reconcile') return send(200, await jira.reconcile(id, input));
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
