import type { IncomingMessage, ServerResponse } from 'node:http';
import type { createProjectWorkspaces } from './project-workspaces.js';

export function createProjectWorkspaceRoutes(service: Awaited<ReturnType<typeof createProjectWorkspaces>>, io: {
  json(response: ServerResponse, status: number, value: unknown): void;
  body(request: IncomingMessage, limit?: number): Promise<unknown>; port: number;
}) {
  const base = '/api/projects/workspaces';
  return async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
    if (![base, base + '/delete', base + '/schedule'].includes(url.pathname)) return false;
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress || '')
      && [`localhost:${io.port}`, `127.0.0.1:${io.port}`].includes(request.headers.host || '');
    if (!local) { io.json(response, 403, { message: '请从本机工作台管理工作区' }); return true; }
    if (request.method === 'GET' && url.pathname === base) {
      const selected = url.searchParams.get('path');
      io.json(response, 200, selected ? await service.preview(selected) : { rules: service.list() }); return true;
    }
    if (request.method !== 'POST' || url.pathname === base) { io.json(response, 405, { message: '请求方法不支持' }); return true; }
    if (request.headers.origin !== `http://${request.headers.host}` || request.headers['x-delivery-confirmed'] !== 'yes') {
      io.json(response, 403, { message: '请从本机工作台确认工作区操作' }); return true;
    }
    if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      io.json(response, 415, { message: '请发送 JSON' }); return true;
    }
    try {
      const input = await io.body(request, 16_000);
      io.json(response, 200, url.pathname.endsWith('/delete') ? await service.remove(input) : await service.schedule(input));
    } catch (cause) {
      const failure = cause as Error & { statusCode?: number };
      io.json(response, failure.statusCode || 400, { message: failure instanceof Error ? failure.message : '工作区操作失败' });
    }
    return true;
  };
}
