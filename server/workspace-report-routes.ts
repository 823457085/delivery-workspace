/** 汇报写入和外发均限制为当前工作台的明确同源操作。定时发送授权保存在策略中。 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { createWorkspaceReports } from './workspace-reports.js';
export function createWorkspaceReportRoutes(service: Awaited<ReturnType<typeof createWorkspaceReports>>, io: {
  json(response: ServerResponse, status: number, value: unknown): void;
  body(request: IncomingMessage, limit?: number): Promise<unknown>;
  port: number;
}) {
  return async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
    const base = '/api/workspace-reports';
    if (url.pathname !== base && !url.pathname.startsWith(base + '/')) return false;
    if (![ `localhost:${io.port}`, `127.0.0.1:${io.port}` ].includes(request.headers.host || '')) {
      io.json(response, 403, { message: '仅接受本机工作台请求' }); return true;
    }
    if (request.method !== 'GET' && (request.method !== 'POST'
      || ![`http://localhost:${io.port}`, `http://127.0.0.1:${io.port}`].includes(request.headers.origin || '')
      || request.headers['x-delivery-confirmed'] !== 'yes'
      || !request.headers['content-type']?.includes('application/json'))) {
      io.json(response, 403, { message: '请在当前工作台明确确认汇报配置或发送操作' }); return true;
    }
    const route = url.pathname.slice(base.length);
    try {
      let value: unknown;
      if (!route && request.method === 'GET') value = service.dashboard();
      else if (request.method === 'POST') {
        if (route === '/config') value = await service.configure(await io.body(request, 500_000));
        else if (route === '/bot') value = await service.configureBot(await io.body(request, 30_000));
        else if (route === '/preview') value = await service.preview(await io.body(request, 60_000));
        else if (route === '/send') value = await service.send(await io.body(request, 1000));
      }
      if (value === undefined) io.json(response, 405, { message: '请求方法不支持' });
      else io.json(response, 200, value);
    } catch (error) { io.json(response, 400, { message: error instanceof Error ? error.message : '汇报操作失败' }); }
    return true;
  };
}
