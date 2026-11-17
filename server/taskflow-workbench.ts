import type http from 'node:http';
import { z } from 'zod';
import { isExactJsonContentType } from './http-security.js';
import type { createAgentRuntimeService } from './agent-runtime.js';

const ticketBody = z.object({ ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const runRef = z.object({ runId: z.string().uuid(), key: z.string().regex(/^[a-f0-9]{64}$/) });
const commandSchema = z.discriminatedUnion('action', [
  runRef.extend({ action: z.literal('start'), provider: z.enum(['codex', 'cursor']),
    mode: z.enum(['read', 'develop', 'review']), title: z.string().min(1).max(240),
    objective: z.string().min(1).max(200_000), workspacePath: z.string().max(1024),
    taskFlowUrl: z.string().regex(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/#view=tasks&task=[a-f0-9-]{36}(?:&tab=reviews&job=[a-f0-9-]{36})?$/),
  }).strict(),
  runRef.extend({ action: z.literal('read') }).strict(),
  runRef.extend({ action: z.literal('stop') }).strict(),
]);

const loopback = (address: string | undefined) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address || '');

export function createTaskFlowWorkbenchRoute(options: {
  taskFlowApi: string;
  runtime: Pick<Awaited<ReturnType<typeof createAgentRuntimeService>>, 'getTaskFlowRun' | 'startTaskFlow' | 'stop'>;
  body: (request: http.IncomingMessage, limit?: number) => Promise<unknown>;
  json: (response: http.ServerResponse, status: number, value: unknown) => void;
}) {
  const { runtime, body, json } = options;
  const peer = new URL(options.taskFlowApi);
  if (peer.protocol !== 'http:' || peer.hostname !== '127.0.0.1' || peer.pathname !== '/' ||
      peer.search || peer.hash || peer.username || peer.password || !peer.port) {
    throw new Error('TaskFlow API 必须使用明确端口的本机回环 HTTP 地址');
  }

  return async (request: http.IncomingMessage, response: http.ServerResponse, url: URL) => {
    if (url.pathname !== '/api/taskflow/workbench') return false;
    const reject = (status: number, code: string, message: string) => {
      json(response, status, { error: { code, message } });
      return true;
    };
    if (request.method !== 'POST' || !loopback(request.socket.remoteAddress) || request.headers.origin ||
        request.headers.cookie || !isExactJsonContentType(request.headers['content-type'])) {
      return reject(403, 'WORKBENCH_PEER_REQUIRED', '仅接受 TaskFlow 服务间调用');
    }

    const parsed = ticketBody.safeParse(await body(request, 2048));
    if (!parsed.success) return reject(400, 'INVALID_HANDOFF', '无效的 TaskFlow 交接票据');
    let command: z.infer<typeof commandSchema>;
    try {
      const exchanged = await fetch(new URL('/api/taskflow/workbench/exchange', peer), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
        body: JSON.stringify(parsed.data), signal: AbortSignal.timeout(3500),
      });
      if (!exchanged.ok) return reject(403, 'HANDOFF_REJECTED', 'TaskFlow 交接已失效，请从原任务重试');
      const value = commandSchema.safeParse(await exchanged.json());
      if (!value.success) return reject(400, 'INVALID_HANDOFF', 'TaskFlow 交接内容不完整');
      command = value.data;
    } catch {
      return reject(503, 'TASKFLOW_UNAVAILABLE', '无法回连 TaskFlow 服务');
    }

    let run = runtime.getTaskFlowRun(command.runId, command.key);
    try {
      if (!run && command.action === 'start') run = await runtime.startTaskFlow(command);
      if (!run) return reject(404, 'WORKBENCH_RUN_NOT_FOUND', '未找到对应的工作台会话');
      if (command.action === 'stop' && ['queued', 'running'].includes(run.status)) {
        try { run = await runtime.stop(run.id); }
        catch (error) {
          const current = runtime.getTaskFlowRun(command.runId, command.key);
          if (!current || ['queued', 'running'].includes(current.status)) throw error;
          run = current;
        }
      }
      json(response, 200, { run: {
        id: command.runId, status: run.status === 'completed' && run.resultReady === false ? 'running' : run.status,
        output: (run.result || '').slice(-64_000),
        error: (run.error || '').slice(0, 1000), updatedAt: run.updatedAt,
      } });
      return true;
    } catch (error) {
      return reject(409, 'WORKBENCH_RUN_REJECTED', error instanceof Error ? error.message : '工作台未能执行本次操作');
    }
  };
}
