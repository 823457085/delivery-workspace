import type { IncomingMessage, ServerResponse } from 'node:http';
import type { createBrowserConnection } from './browser-connection.js';

export function createBrowserConnectionRoute(connection: Pick<ReturnType<typeof createBrowserConnection>,
  'status' | 'openSettings' | 'connect' | 'disconnect'>, options: {
  port: number;
  json: (response: ServerResponse, status: number, value: unknown) => void;
  body: (request: IncomingMessage, limit?: number) => Promise<unknown>;
}) {
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    const base = '/api/browser/connection';
    if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return false;
    const reply = (status: number, value: unknown) => options.json(response, status, value);
    const hosts = [`localhost:${options.port}`, `127.0.0.1:${options.port}`];
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress || '')
      || !hosts.includes(request.headers.host || '')) {
      reply(403, { message: '浏览器连接仅接受本机工作台请求' }); return true;
    }
    const action = url.pathname.slice(base.length + 1);
    if (request.method === 'GET' && url.pathname === base) {
      reply(200, await connection.status()); return true;
    }
    if (!['open-settings', 'connect', 'disconnect'].includes(action)) {
      reply(url.pathname === base ? 405 : 404, { message: '浏览器连接操作不存在' }); return true;
    }
    if (request.method !== 'POST') {
      reply(405, { message: '请通过工作台浏览器连接按钮操作' }); return true;
    }
    if (!hosts.map(host => `http://${host}`).includes(request.headers.origin || '')) {
      reply(403, { message: '浏览器连接请求来源不匹配' }); return true;
    }
    if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
      reply(415, { message: '请发送 JSON' }); return true;
    }
    const input = await options.body(request, 1024);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) {
      reply(400, { message: '浏览器连接不接受自定义地址或参数' }); return true;
    }
    const result = action === 'open-settings' ? await connection.openSettings()
      : action === 'connect' ? await connection.connect() : await connection.disconnect();
    reply(200, result);
    return true;
  };
}
