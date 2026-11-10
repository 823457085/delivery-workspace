import type http from 'node:http';
import { z } from 'zod';
import { accountProviderLabels, type AccountProvider } from '../shared/cursor-accounts.js';
import type { createCursorAccountsService } from './cursor-accounts.js';

const legacyBase = '/api/agent-runtimes/cursor-accounts';
const named = z.object({ name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/) }).strict();
type Service = Pick<ReturnType<typeof createCursorAccountsService>, 'dashboard' | 'start' | 'cancel'>;

export function createCursorAccountsRoute(service: Service, provider: AccountProvider = 'cursor') {
  const providerBase = `/api/agent-runtimes/accounts/${provider}`;
  return async (request: http.IncomingMessage, response: http.ServerResponse, port: number) => {
    const send = (status: number, data: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(data));
    };
    try {
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress || '');
      if (!local || ![`localhost:${port}`, `127.0.0.1:${port}`].includes(request.headers.host || '')) {
        send(403, { message: '仅接受本机看板请求' }); return;
      }
      const expectedOrigin = `http://${request.headers.host}`;
      if (request.headers.origin && request.headers.origin !== expectedOrigin) {
        send(403, { message: '请求来源不匹配' }); return;
      }
      const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
      const base = provider === 'cursor' && (url.pathname === legacyBase || url.pathname.startsWith(`${legacyBase}/`))
        ? legacyBase : providerBase;
      if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) {
        send(404, { message: '账号操作不存在' }); return;
      }
      if (request.method === 'GET' && url.pathname === base) {
        send(200, await service.dashboard(url.searchParams.get('refresh') === '1')); return;
      }
      if (request.method !== 'POST') { send(405, { message: '请求方法不支持' }); return; }
      if (request.headers.origin !== expectedOrigin
        || request.headers['x-delivery-confirmed'] !== 'yes') {
        send(403, { message: `请在当前面板确认 ${accountProviderLabels[provider]} 账号操作` }); return;
      }
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        send(415, { message: '请发送 JSON' }); return;
      }
      let text = '';
      for await (const chunk of request) {
        text += chunk;
        if (Buffer.byteLength(text) > 1024) { send(413, { message: '请求内容过大' }); return; }
      }
      const input: unknown = JSON.parse(text || '{}');
      const action = url.pathname.slice(base.length);
      if (action === '/save' || action === '/login' || action === '/use' || action === '/delete') {
        const { name } = named.parse(input);
        send(202, await service.start(action.slice(1) as 'save' | 'login' | 'use' | 'delete', name)); return;
      }
      if (action === '/restore') {
        z.object({}).strict().parse(input);
        send(202, await service.start('restore')); return;
      }
      if (action === '/cancel') {
        const { operationId } = z.object({ operationId: z.string().uuid() }).strict().parse(input);
        send(200, await service.cancel(operationId)); return;
      }
      send(404, { message: '账号操作不存在' });
    } catch (error) {
      send(400, { message: error instanceof z.ZodError || error instanceof SyntaxError ? '输入格式不正确'
        : error instanceof Error ? error.message : '账号操作未完成' });
    }
  };
}
