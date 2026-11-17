import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import { isExactJsonContentType } from './http-security.js';
import type { createAgentRuntimeService } from './agent-runtime.js';

const taskFlowUrl = /^(?:https:\/\/[A-Za-z0-9.-]{1,253}(?::[1-9][0-9]{0,4})?|http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4})\/#view=tasks&task=[a-f0-9-]{36}(?:&tab=reviews&job=[a-f0-9-]{36})?$/;
const runRef = z.object({ runId: z.string().uuid(), key: z.string().regex(/^[a-f0-9]{64}$/) });
const commandSchema = z.discriminatedUnion('action', [
  runRef.extend({ action: z.literal('start'), provider: z.enum(['codex', 'cursor']),
    mode: z.enum(['read', 'develop', 'review']), title: z.string().min(1).max(240),
    objective: z.string().min(1).max(200_000), workspacePath: z.string().max(1024),
    taskFlowUrl: z.string().regex(taskFlowUrl),
  }).strict(),
  runRef.extend({ action: z.literal('read') }).strict(),
  runRef.extend({ action: z.literal('stop') }).strict(),
]);

const loopback = (address: string | undefined) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address || '');
const digest = (value: string) => createHash('sha256').update(value).digest();

/** Token is created once and never rewritten, so a running Bridge keeps working across restarts. */
export async function ensureTaskFlowBridgeToken(directory: string) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const file = path.join(directory, 'token');
  try {
    await fs.writeFile(file, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077) throw new Error('TaskFlow Bridge 令牌文件权限不安全，已拒绝启用');
  const token = (await fs.readFile(file, 'utf8')).trim();
  if (token.length < 32) throw new Error('TaskFlow Bridge 令牌文件内容无效');
  return { file, token };
}

export function createTaskFlowBridgeRoute(options: {
  token: string;
  runtime: Pick<Awaited<ReturnType<typeof createAgentRuntimeService>>, 'getTaskFlowRun' | 'startTaskFlow' | 'stop'>;
  body: (request: http.IncomingMessage, limit?: number) => Promise<unknown>;
  json: (response: http.ServerResponse, status: number, value: unknown) => void;
}) {
  const { runtime, body, json } = options;
  const expected = digest(options.token);

  return async (request: http.IncomingMessage, response: http.ServerResponse, url: URL) => {
    if (url.pathname !== '/api/taskflow/bridge') return false;
    const reject = (status: number, code: string, message: string) => {
      json(response, status, { error: { code, message } });
      return true;
    };
    if (request.method !== 'POST' || !loopback(request.socket.remoteAddress) || request.headers.origin ||
        request.headers.cookie || !isExactJsonContentType(request.headers['content-type'])) {
      return reject(403, 'BRIDGE_PEER_REQUIRED', '仅接受本机 TaskFlow Bridge 调用');
    }
    const supplied = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(request.headers.authorization || '')?.[1];
    if (!supplied || !timingSafeEqual(digest(supplied), expected)) return reject(401, 'BRIDGE_TOKEN_INVALID', 'TaskFlow Bridge 令牌无效');

    let command: z.infer<typeof commandSchema>;
    try {
      const value = commandSchema.safeParse(await body(request, 1024 * 1024));
      if (!value.success) return reject(400, 'INVALID_BRIDGE_COMMAND', 'TaskFlow Bridge 指令不完整');
      command = value.data;
    } catch {
      return reject(400, 'INVALID_BRIDGE_COMMAND', 'TaskFlow Bridge 指令不是合法 JSON');
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
        workbenchUrl: `/agent?session=${encodeURIComponent(run.id)}`,
      } });
      return true;
    } catch (error) {
      return reject(409, 'WORKBENCH_RUN_REJECTED', error instanceof Error ? error.message : '工作台未能执行本次操作');
    }
  };
}
