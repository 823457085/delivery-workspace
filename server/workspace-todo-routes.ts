import type { IncomingMessage, ServerResponse } from 'node:http';
import type { createWorkspaceTodos } from './workspace-todos.js';

export function createWorkspaceTodoRoutes(service: Awaited<ReturnType<typeof createWorkspaceTodos>>, io: {
  json(response: ServerResponse, status: number, value: unknown): void;
  body(request: IncomingMessage, limit?: number): Promise<unknown>; port: number;
}) {
  return async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
    if (!['/api/workspace-todos', '/api/workspace-todos/delete'].includes(url.pathname)) return false;
    if (request.method === 'GET' && url.pathname === '/api/workspace-todos') { io.json(response, 200, { items: service.list() }); return true; }
    if (request.method !== 'POST') { io.json(response, 405, { message: '请求方法不支持' }); return true; }
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress || '')
      || ![`localhost:${io.port}`, `127.0.0.1:${io.port}`].includes(request.headers.host || '')
      || request.headers.origin !== `http://${request.headers.host}` || request.headers['x-delivery-confirmed'] !== 'yes') {
      io.json(response, 403, { message: '请从本机工作台管理个人待办' }); return true;
    }
    if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      io.json(response, 415, { message: '请发送 JSON' }); return true;
    }
    try {
      const raw = await io.body(request, 16_000);
      const result = url.pathname.endsWith('/delete') ? await service.remove(raw) : await service.save(raw);
      io.json(response, 200, result);
    } catch (error) { io.json(response, 400, { message: error instanceof Error ? error.message : '待办事项保存失败' }); }
    return true;
  };
}
