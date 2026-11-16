import fs from 'node:fs/promises';
import path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { applicationHashes, readApplicationPackage } from './application-package.js';
import { fingerprint, type CustomPluginRuntime } from './custom-runtime.js';

type Worker = { child: ChildProcess; pending: Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }> };
export function createPluginApplications(runtime: CustomPluginRuntime, open: (app: 'terminal' | 'cursor', directory: string) => Promise<void>) {
  const workers = new Map<string, Worker>();
  const starting = new Map<string, Promise<Worker>>();
  const epochs = new Map<string, number>();
  const queues = new Map<string, Promise<unknown>>();
  let closing = false;
  function stop(id: string) {
    epochs.set(id, (epochs.get(id) || 0) + 1);
    const worker = workers.get(id);
    if (!worker) return;
    workers.delete(id);
    for (const item of worker.pending.values()) { clearTimeout(item.timer); item.reject(new Error('插件已停止，请重新打开')); }
    worker.pending.clear();
    try { if (process.platform !== 'win32' && worker.child.pid) process.kill(-worker.child.pid, 'SIGTERM'); else worker.child.kill(); } catch { /* Already exited. */ }
    const force = setTimeout(() => { if (worker.child.exitCode !== null || worker.child.signalCode !== null) return; try { if (process.platform !== 'win32' && worker.child.pid) process.kill(-worker.child.pid, 'SIGKILL'); else worker.child.kill('SIGKILL'); } catch { /* Already exited. */ } }, 3000);
    force.unref(); worker.child.once('exit', () => clearTimeout(force));
  }
  async function verified(id: string) {
    const entry = runtime.applicationEntry(id);
    const files = await readApplicationPackage(entry.packageDirectory, entry.manifest);
    if (fingerprint({ manifest: entry.manifest, assets: applicationHashes(files) }) !== entry.digest) throw new Error('已安装插件内容损坏，请核对原包');
    runtime.applicationEntry(id);
    return { entry, files };
  }
  async function start(id: string): Promise<Worker> {
    if (closing) throw new Error('工作台正在关闭');
    runtime.applicationEntry(id);
    if (workers.has(id)) return workers.get(id)!;
    if (starting.has(id)) return starting.get(id)!;
    const epoch = epochs.get(id) || 0;
    const promise = (async () => {
      const { entry } = await verified(id);
      const workspaceDirectory = path.join(entry.dataDirectory, 'workspace');
      await fs.mkdir(workspaceDirectory, { recursive: true, mode: 0o700 });
      const configuration = await runtime.applicationConfiguration(id);
      runtime.applicationEntry(id);
      if (closing || epoch !== (epochs.get(id) || 0)) throw new Error('插件状态已变化');
      const child = fork(fileURLToPath(new URL('./application-worker.mjs', import.meta.url)), [path.join(entry.packageDirectory, 'server.mjs'), entry.dataDirectory, workspaceDirectory], {
        cwd: workspaceDirectory, execArgv: ['--max-old-space-size=384'], detached: process.platform !== 'win32',
        env: { PATH: process.env.PATH, HOME: entry.dataDirectory, TMPDIR: process.env.TMPDIR || '/tmp', LANG: 'en_US.UTF-8', SystemRoot: process.env.SystemRoot },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      child.send({ type: 'initialize', configuration });
      const worker: Worker = { child, pending: new Map() }; workers.set(id, worker);
      child.on('message', (message: any) => {
        const item = worker.pending.get(message?.id); if (!item) return;
        worker.pending.delete(message.id); clearTimeout(item.timer);
        message.error ? item.reject(new Error(String(message.error))) : item.resolve(message.result);
      });
      const failed = () => { if (workers.get(id) === worker) stop(id); };
      child.on('exit', failed); child.on('error', failed);
      return worker;
    })();
    starting.set(id, promise);
    try { return await promise; } finally { if (starting.get(id) === promise) starting.delete(id); }
  }
  async function scopedDirectory(id: string, input: string) {
    const entry = runtime.applicationEntry(id);
    const root = await fs.realpath(path.join(entry.dataDirectory, 'workspace'));
    const actual = await fs.realpath(path.resolve(root, input));
    if (actual !== root && !actual.startsWith(root + path.sep) || !(await fs.stat(actual)).isDirectory()) throw new Error('只能使用该插件的工作目录');
    return actual;
  }
  return {
    stop,
    async page(id: string) { const { files, entry } = await verified(id); return { themeMode: entry.manifest.theme || 'full', javascript: files['ui.js'].toString('utf8'), css: files['ui.css'].toString('utf8') }; },
    call(id: string, raw: unknown) {
      const input = z.object({ method: z.string().regex(/^[a-z][a-z0-9/-]{0,80}$/), input: z.unknown().optional() }).strict().parse(raw);
      runtime.applicationEntry(id);
      const epoch = epochs.get(id) || 0;
      const task = (queues.get(id) || Promise.resolve()).then(async () => {
        if (epoch !== (epochs.get(id) || 0)) throw new Error('插件状态已变化，请重试');
        const worker = await start(id);
        runtime.applicationEntry(id);
        return new Promise((resolve, reject) => {
          const requestId = randomUUID();
          const timer = setTimeout(() => { stop(id); }, 65_000);
          worker.pending.set(requestId, { resolve, reject, timer });
          worker.child.send({ type: 'request', id: requestId, ...input }, error => { if (error) stop(id); });
        });
      });
      queues.set(id, task.catch(() => {}));
      return task;
    },
    async compose(id: string, raw: unknown) {
      runtime.assertCapability(id, 'conversation.compose');
      const input = z.object({ prompt: z.string().min(1).max(30000), workspacePath: z.string().max(2000).optional() }).strict().parse(raw);
      const workspacePath = input.workspacePath ? await scopedDirectory(id, input.workspacePath) : undefined;
      runtime.assertCapability(id, 'conversation.compose');
      return { prompt: input.prompt, workspacePath };
    },
    async open(id: string, raw: unknown) {
      runtime.assertCapability(id, 'workspace.open');
      const input = z.object({ app: z.enum(['terminal', 'cursor']), workspacePath: z.string().max(2000) }).strict().parse(raw);
      const directory = await scopedDirectory(id, input.workspacePath);
      runtime.assertCapability(id, 'workspace.open');
      await open(input.app, directory); return { message: '已打开插件工作目录' };
    },
    async close() { closing = true; for (const id of new Set([...starting.keys(), ...workers.keys()])) stop(id); await Promise.allSettled([...starting.values(), ...queues.values()]); },
  };
}
export type PluginApplications = ReturnType<typeof createPluginApplications>;
