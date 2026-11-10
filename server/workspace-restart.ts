/** 只重启当前受 PM2 托管的工作台。支持保存任务后立即重启，或等待任务自然结束。 */
import type http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { z } from 'zod';
import type { WorkspaceRestartState } from '../shared/workspace-restart.js';

const exec = promisify(execFile);
interface Pm2WorkspaceProcess {
  pid: number;
  name: string;
  pm2_env: { autorestart?: boolean; pm_exec_path: string; pm_cwd: string; args?: string[] | string };
}
export function matchesPm2Workspace(root: string, item: Pm2WorkspaceProcess, pid = process.pid, parentPid = process.ppid) {
  const config = item.pm2_env;
  if (config?.autorestart !== true || config.pm_cwd !== root || item.pid <= 0) return false;
  if (item.pid === pid && item.name === 'delivery-workspace'
    && config.pm_exec_path === path.join(root, 'server/index.ts')) return true;
  // The share launcher initializes its own configuration/data, then owns this backend child.
  // Its exit follows the backend's exit, allowing PM2 to restart the same isolated share instance.
  const args = Array.isArray(config.args) ? config.args : config.args ? [config.args] : [];
  return item.pid === parentPid && (
    config.pm_exec_path === path.join(root, 'delivery.mjs') && args.length === 1 && args[0] === 'start'
    || config.pm_exec_path === path.join(root, 'scripts/start.mjs') && !args.length
  );
}
export function restartTaskActive(status?: string, includePending = true) {
  return ['queued', 'dispatching', 'dispatched', 'running', 'draining', ...(includePending ? ['pending'] : [])].includes(status?.toLowerCase() || '');
}
export async function isPm2ManagedWorkspace(root: string) {
  if (process.env.pm_id === undefined) return false;
  try {
    const { stdout } = await exec('pm2', ['jlist'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
    const processes = JSON.parse(stdout) as Pm2WorkspaceProcess[];
    return processes.some(item => matchesPm2Workspace(root, item));
  } catch { return false; }
}

interface Options {
  available(): Promise<boolean>;
  update?(): Promise<'restart' | 'refresh' | 'current'>;
  prepare?(): Promise<void>;
  blockers(): Promise<string[]>;
  hold(): () => void;
  restart(): Promise<void>;
  intervalMs?: number;
  idleChecks?: number;
}
export function createWorkspaceRestart(options: Options) {
  const startedAt = new Date().toISOString();
  let current: WorkspaceRestartState = { status: 'idle', message: '', startedAt };
  let available: Promise<boolean> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let task: Promise<void> | undefined;
  let stable = 0, closed = false;
  let prepared = false;
  let checkedUpdate = false;
  let pauseTasks = false;
  let release: (() => void) | undefined;
  const supported = () => available ??= options.available();
  const snapshot = () => ({ ...current });
  async function dashboard() {
    return await supported() ? snapshot() : { status: 'unavailable' as const,
      message: '当前后端未由支持自动恢复的 PM2 工作台服务托管，暂不支持一键重启。', startedAt };
  }
  async function check() {
    try {
      if (!checkedUpdate && options.update) {
        const action = await options.update();
        if (closed) return;
        checkedUpdate = true;
        if (action !== 'restart') {
          current = { ...current, status: 'idle', message: action === 'refresh' ? '页面构建已完成，保存草稿后刷新即可。' : '工作台已是最新版本。' };
          return;
        }
        current = waitingState();
      }
      if (pauseTasks && options.prepare) {
        release ??= options.hold();
        if (!prepared) { await options.prepare(); prepared = true; }
      }
      const blockers = await options.blockers();
      if (closed) return;
      if (blockers.length) {
        stable = 0;
        current.message = `等待任务结束：${blockers.join('、')}`;
      } else if (++stable >= (options.idleChecks ?? 3)) {
        current = { ...current, status: 'restarting', message: '正在重启后端服务，请等待连接恢复。' };
        release ??= options.hold();
        const lateBlockers = await options.blockers();
        if (closed) return;
        if (lateBlockers.length) {
          release(); release = undefined; stable = 0;
          current = { ...current, status: 'waiting', message: `等待任务结束：${lateBlockers.join('、')}` };
        } else {
          await options.restart();
          return;
        }
      } else current.message = '任务已空闲，正在确认后端可以安全重启。';
      if (!closed) timer = setTimeout(tick, options.intervalMs ?? 5000).unref();
    } catch (error) {
      release?.(); release = undefined;
      current = { ...current, status: 'failed', message: error instanceof Error ? error.message : '重启检查失败，请重试。' };
    }
  }
  function waitingState(): WorkspaceRestartState {
    return { status: 'waiting', message: pauseTasks ? '正在保存并暂停任务，即将重启。' : '已安排重启，等待当前任务结束。', startedAt };
  }
  function tick() { task = check().finally(() => { task = undefined; }); }
  async function request(mode?: 'when-idle') {
    const value = await dashboard();
    if (closed) throw new Error('工作台正在退出');
    if (value.status === 'unavailable') return value;
    if (['building', 'waiting', 'restarting'].includes(current.status)) return snapshot();
    stable = 0;
    prepared = false;
    checkedUpdate = false;
    pauseTasks = !!options.prepare && mode !== 'when-idle';
    current = options.update ? { status: 'building', message: '正在检查并构建页面，当前任务可以继续。', startedAt } : waitingState();
    // 先返回响应，随后才开始空闲检查；双击和多页面请求共用这一份重启状态。
    timer = setTimeout(tick, 0).unref();
    return snapshot();
  }
  return { dashboard, request, isRestarting: () => current.status === 'restarting' || pauseTasks && current.status === 'waiting',
    close() { closed = true; if (timer) clearTimeout(timer); release?.(); release = undefined; },
    idle: async () => { await task; },
  };
}

export function createWorkspaceRestartRoute(service: Pick<ReturnType<typeof createWorkspaceRestart>, 'dashboard' | 'request'>) {
  return async (request: http.IncomingMessage, response: http.ServerResponse, port: number) => {
    const send = (status: number, data: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(data));
    };
    const origin = `http://${request.headers.host}`;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress || '')
      || ![`localhost:${port}`, `127.0.0.1:${port}`].includes(request.headers.host || '')
      || request.headers.origin && request.headers.origin !== origin) {
      send(403, { message: '仅接受本机工作台请求' }); return;
    }
    if (request.method === 'GET') { send(200, await service.dashboard()); return; }
    if (request.method !== 'POST') { send(405, { message: '请求方法不支持' }); return; }
    if (request.headers.origin !== origin || request.headers['x-delivery-confirmed'] !== 'yes') {
      send(403, { message: '请在当前工作台点击重启按钮' }); return;
    }
    if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
      send(415, { message: '请发送 JSON' }); return;
    }
    try {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 1024) { send(413, { message: '请求内容过大' }); return; }
      }
      const input = z.object({ mode: z.literal('when-idle').optional() }).strict().parse(JSON.parse(body || '{}'));
      const value = await service.request(input.mode);
      send(value.status === 'unavailable' ? 503 : 202, value);
    } catch (error) {
      send(400, { message: error instanceof z.ZodError || error instanceof SyntaxError ? '输入格式不正确'
        : error instanceof Error ? error.message : '重启请求失败' });
    }
  };
}
