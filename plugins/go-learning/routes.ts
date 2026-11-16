import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  goHttpDebugSchema,
  goProgressUpdateSchema,
  goSandboxInitSchema,
  goSandboxRunSchema,
  goSandboxSaveFileSchema,
} from './types.js';
import type { createGoLearningService } from './service.js';

export function createGoLearningRoutes(
  service: Awaited<ReturnType<typeof createGoLearningService>>,
  io: {
    json(response: ServerResponse, status: number, value: unknown): void;
    body(request: IncomingMessage, limit?: number): Promise<unknown>;
    port: number;
    assertActive?: () => void;
  }
) {
  return async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
    if (!url.pathname.startsWith('/api/go-learning/')) return false;

    const host = request.headers.host || '';
    const isLocalHost = [`localhost:${io.port}`, `127.0.0.1:${io.port}`].includes(host);
    const isLocalSocket = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress || '');
    if (!isLocalHost || !isLocalSocket) {
      io.json(response, 403, { message: '请在本机工作台操作 Go 实训工坊' });
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/go-learning/overview') {
      const dayParam = url.searchParams.get('day');
      const dayNum = dayParam ? Number(dayParam) : undefined;
      const result = await service.overview(Number.isInteger(dayNum) ? dayNum : undefined);
      io.json(response, 200, result);
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/go-learning/day') {
      const dayNum = Number(url.searchParams.get('day') || '1');
      const result = await service.getDay(Number.isInteger(dayNum) ? dayNum : 1);
      io.json(response, 200, result);
      return true;
    }

    if (request.method !== 'POST') {
      io.json(response, 405, { message: '请求方法不支持' });
      return true;
    }

    if (request.headers.origin !== `http://${host}` || request.headers['x-delivery-confirmed'] !== 'yes') {
      io.json(response, 403, { message: '请从本机工作台确认 Go 实训工坊操作' });
      return true;
    }
    if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      io.json(response, 415, { message: '请发送 JSON' });
      return true;
    }

    try {
      const raw = await io.body(request, 250_000);
      io.assertActive?.();

      if (url.pathname === '/api/go-learning/progress') {
        const input = goProgressUpdateSchema.parse(raw);
        const progress = await service.updateProgress(input);
        io.json(response, 200, { progress });
        return true;
      }

      if (url.pathname === '/api/go-learning/sandbox/init') {
        const input = goSandboxInitSchema.parse(raw);
        await service.applySnapshot(input.snapshot);
        const sandbox = await service.readSandboxFiles();
        const overview = await service.overview();
        io.json(response, 200, {
          activeSnapshot: input.snapshot,
          sandboxFiles: sandbox.files,
          tasksJsonContent: sandbox.tasksJsonContent,
          progress: overview.progress,
        });
        return true;
      }

      if (url.pathname === '/api/go-learning/sandbox/save-file') {
        const input = goSandboxSaveFileSchema.parse(raw);
        const sandbox = await service.saveSandboxFile(input.filePath, input.content);
        io.json(response, 200, {
          sandboxFiles: sandbox.files,
          tasksJsonContent: sandbox.tasksJsonContent,
        });
        return true;
      }

      if (url.pathname === '/api/go-learning/sandbox/run') {
        const input = goSandboxRunSchema.parse(raw);
        const result = await service.runCommand(input.action, input.args || []);
        const sandbox = await service.readSandboxFiles();
        io.json(response, 200, {
          result,
          sandboxFiles: sandbox.files,
          tasksJsonContent: sandbox.tasksJsonContent,
        });
        return true;
      }

      if (url.pathname === '/api/go-learning/sandbox/http-debug') {
        const input = goHttpDebugSchema.parse(raw);
        const result = await service.debugHttpEndpoint(input);
        const sandbox = await service.readSandboxFiles();
        io.json(response, 200, {
          result,
          sandboxFiles: sandbox.files,
          tasksJsonContent: sandbox.tasksJsonContent,
        });
        return true;
      }

      io.json(response, 404, { message: '未找到对应的 Go 实训工坊接口' });
      return true;
    } catch (error) {
      io.json(response, 400, {
        message: error instanceof Error ? error.message : '操作执行失败',
      });
      return true;
    }
  };
}
