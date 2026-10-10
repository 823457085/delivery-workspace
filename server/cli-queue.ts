/** 新面板管理 CLI 生命周期，复用现有领取协议、全局锁及工作区串行门禁；不复制业务队列或接管正在运行的桌面任务。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cliBinary, codexHome } from './cli-runtime.js';
import type { CliExecutionState } from '../shared/cli-execution.js';

interface Worker {
  dispatcherId: string; stopping: boolean; initialized: boolean;
  heartbeat(): Promise<void>; initialize(): Promise<void>; runForever(): Promise<void>; stop(): void;
  ledger: { read(): Promise<{ runs: Record<string, CliExecutionState['runs'][number]> }> };
}
interface Options {
  createWorker?: () => Promise<Worker>;
  check?: () => Promise<{ version: string; authenticated: boolean }>;
  guard?: () => Promise<void>;
}
export async function assertDesktopDispatchersPaused(directory = path.join(codexHome, 'automations')) {
  for (const id of ['apex-codex', 'jira-ai']) {
    let content: string;
    try { content = await fs.readFile(path.join(directory, id, 'automation.toml'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (!/^status\s*=\s*"PAUSED"\s*$/m.test(content)) throw new Error(`请先暂停旧派发心跳 ${id}，避免重复执行`);
  }
}
async function createWorker(): Promise<Worker> {
  const location = new URL('./jira-backend/catchup-cli-dispatcher.mjs', import.meta.url).href;
  const module = await import(location);
  const worker: Worker = new module.CatchupCliDispatcher({ codexBinary: cliBinary, api: module.createCatchupCliApi({ includeJira: true }) });
  worker.dispatcherId = 'delivery-workspace:codex-cli';
  return worker;
}
const exec = promisify(execFile);
async function checkCli() {
  const [version, login] = await Promise.all([
    exec(cliBinary, ['--version'], { timeout: 10_000 }), exec(cliBinary, ['login', 'status'], { timeout: 10_000 }),
  ]);
  return { version: version.stdout.trim(), authenticated: /Logged in/i.test(login.stdout + login.stderr) };
}
export async function createCliQueue(directory: string, options: Options = {}) {
  const file = path.join(directory, 'cli-queue.json');
  const guard = options.guard || assertDesktopDispatchersPaused;
  let enabled = false, error = '', worker: Worker | undefined, loop: Promise<void> | undefined;
  let health = { version: '', authenticated: false }, checkedAt = 0;
  let transition: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(action: () => Promise<T>) => { const result = transition.then(action); transition = result.catch(() => {}); return result; };
  async function persist() {
    await fs.mkdir(directory, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ enabled }), { mode: 0o600 });
    await fs.rename(temporary, file);
  }
  async function dashboard(): Promise<CliExecutionState> {
    if (Date.now() - checkedAt > 30_000) {
      try { health = await (options.check || checkCli)(); } catch { health = { version: '', authenticated: false }; }
      checkedAt = Date.now();
    }
    const runs = worker ? Object.values((await worker.ledger.read()).runs).map(({ jobId, threadId, workspacePath, pid, phase }) => ({ jobId, threadId, workspacePath, pid, phase })) : [];
    return { status: loop ? enabled ? 'running' : 'draining' : error ? 'blocked' : 'paused', enabled,
      binary: cliBinary, codexHome, ...health, error, maxConcurrent: 8, runs };
  }
  async function start() {
    if (loop) { if (!enabled) throw new Error('执行器正在等待当前任务结束，请稍后再启动'); return dashboard(); }
    await guard();
    health = await (options.check || checkCli)(); checkedAt = Date.now();
    if (!health.authenticated) throw new Error('本机 Codex CLI 尚未登录');
    worker = await (options.createWorker || createWorker)();
    const heartbeat = worker.heartbeat.bind(worker);
    worker.heartbeat = async () => { await guard(); await heartbeat(); };
    await worker.initialize();
    error = ''; enabled = true;
    try { await persist(); } catch (failure) { enabled = false; worker.stop(); await worker.runForever(); throw failure; }
    loop = worker.runForever().catch(async (failure: unknown) => {
      error = failure instanceof Error ? failure.message : 'CLI 队列运行失败'; enabled = false;
      try { await persist(); } catch { error += '；暂停配置保存失败，请检查数据目录权限'; }
    }).finally(() => { loop = undefined; });
    return dashboard();
  }
  async function pause() {
    enabled = false; worker?.stop(); await persist(); return dashboard();
  }
  try { enabled = JSON.parse(await fs.readFile(file, 'utf8')).enabled === true; }
  catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') error = '执行器配置不可读，请检查后手动启动'; }
  if (enabled) { enabled = false; try { await start(); } catch (failure) { error = failure instanceof Error ? failure.message : '启动失败'; await persist(); } }
  return { dashboard, start: () => exclusive(start), pause: () => exclusive(pause),
    close: () => exclusive(async () => { worker?.stop(); await loop; }) };
}
