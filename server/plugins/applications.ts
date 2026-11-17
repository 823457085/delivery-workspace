import fs from 'node:fs/promises';
import path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { applicationHashes, readApplicationPackage } from './application-package.js';
import type { createProjectWorkspaces } from '../project-workspaces.js';
import { fingerprint, type CustomPluginRuntime } from './custom-runtime.js';

type Worker = { digest: string; child: ChildProcess; pending: Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }> };
export function createPluginApplications(runtime: CustomPluginRuntime, open: (app: 'terminal' | 'cursor', directory: string) => Promise<void>, workspaceService?: () => Pick<Awaited<ReturnType<typeof createProjectWorkspaces>>, 'pluginInventory' | 'preview' | 'removeSessionWorkspace'>) {
  const workers = new Map<string, Worker>();
  const starting = new Map<string, Promise<Worker>>();
  const epochs = new Map<string, number>();
  const queues = new Map<string, Promise<unknown>>();
  let closing = false;
  let backgroundTimer: ReturnType<typeof setInterval> | undefined;
  const backgroundNext = new Map<string, number>(), backgroundPending = new Set<string>();
  const capabilityTargets = new Map<string, number>();
  async function capabilityCall(caller: string, raw: unknown): Promise<unknown> {
    const input = z.object({name:z.string(),version:z.literal(1),method:z.string(),input:z.unknown().optional(),provider:z.string().optional()}).strict().parse(raw);
    const callerEpoch = epochs.get(caller) || 0;
    const checkCaller = () => {
      if (callerEpoch !== (epochs.get(caller) || 0)) throw new Error('调用者授权或状态已变化');
      const source = runtime.assertCapability(caller, 'capabilities.call');
      if (!source.manifest.consumes?.some(c => c.name === input.name && c.version === input.version && c.methods.includes(input.method))) throw new Error('未声明该能力及操作范围');
    };
    checkCaller();
    if (capabilityTargets.has(caller)) throw new Error('不支持嵌套能力调用，避免循环依赖');
    const matches = runtime.list().plugins.filter(p => p.enabled && p.grants.includes('application.local') && p.manifest.id !== caller && (!input.provider || input.provider === p.manifest.id) && p.manifest.provides?.some(c => c.name === input.name && c.version === input.version && c.methods.includes(input.method)));
    if (matches.length !== 1) throw new Error(matches.length ? '存在多个能力提供者，请显式选择' : '能力提供者未安装、未启用或未授权');
    const target = matches[0].manifest.id;
    capabilityTargets.set(target, (capabilityTargets.get(target) || 0) + 1);
    try { return await call(target, { method: input.method, input: input.input }, checkCaller); }
    finally { const count = (capabilityTargets.get(target) || 1) - 1; if (count) capabilityTargets.set(target, count); else capabilityTargets.delete(target); }
  }

  async function workspaceCall(id: string, worker: Worker, raw: unknown) {
    const input = z.object({ method: z.enum(['access', 'list', 'preview', 'remove']), input: z.unknown().optional() }).strict().parse(raw);
    const epoch = epochs.get(id) || 0;
    const guard = () => {
      if (closing || workers.get(id) !== worker || epoch !== (epochs.get(id) || 0)) throw new Error('插件实例或授权已变化');
      runtime.applicationEntry(id);
      if (input.method !== 'access') runtime.assertCapability(id, input.method === 'remove' ? 'workspaces.cleanup' : 'workspaces.read');
      if (input.method === 'remove' && (input.input as any)?.idleBefore !== undefined) runtime.assertCapability(id, 'background.run');
    };
    guard();
    if (input.method === 'access') {
      const grants = runtime.applicationEntry(id).grants;
      return { read: grants.includes('workspaces.read'), cleanup: grants.includes('workspaces.cleanup'), background: grants.includes('background.run') };
    }
    if (!workspaceService) throw new Error('宿主未提供会话工作区接口');
    const service = workspaceService();
    if (input.method === 'remove') return service.removeSessionWorkspace(input.input, guard);
    const result = input.method === 'list' ? await service.pluginInventory()
      : await service.preview(z.object({ path: z.string().min(1).max(2000) }).strict().parse(input.input).path, true);
    guard();
    return result;
  }
  async function runBackground(now = Date.now()) {
    if (closing) return;
    await Promise.allSettled(runtime.list().plugins.map(async plugin => {
      const id = plugin.manifest.id, background = plugin.manifest.background;
      if (!background || !plugin.enabled || !plugin.grants.includes('background.run') || !plugin.grants.includes('application.local')
        || backgroundPending.has(id) || (backgroundNext.get(id) || 0) > now) return;
      backgroundNext.set(id, now + background.intervalSeconds * 1000);
      backgroundPending.add(id);
      try { await call(id, { method: background.method }, () => { runtime.assertCapability(id, 'background.run'); }); }
      finally { backgroundPending.delete(id); }
    }));
  }
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
    const installed = runtime.applicationEntry(id);
    if (workers.has(id) && workers.get(id)!.digest !== installed.digest) stop(id);
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
      const worker: Worker = { digest: entry.digest, child, pending: new Map() }; workers.set(id, worker);
      child.on('message', (message: any) => {
        if (message?.type === 'host-workspaces') {
          void workspaceCall(id, worker, message.input).then(result => { if (child.connected) child.send({ type: 'host-capability-result', id: message.id, result }); }, error => { if (child.connected) child.send({ type: 'host-capability-result', id: message.id, error: error.message }); });
          return;
        }
        if (message?.type === 'host-capability') {
          void capabilityCall(id, message.input).then(result => { if (child.connected) child.send({ type: 'host-capability-result', id: message.id, result }); }, error => { if (child.connected) child.send({type:'host-capability-result',id:message.id,error:error.message}); });
          return;
        }
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
function call(id: string, raw: unknown, guard = () => {}) {
      const input = z.object({ method: z.string().regex(/^[a-z][a-z0-9/-]{0,80}$/), input: z.unknown().optional() }).strict().parse(raw);
      runtime.applicationEntry(id);
      const epoch = epochs.get(id) || 0;
      const task = (queues.get(id) || Promise.resolve()).then(async () => {
        if (epoch !== (epochs.get(id) || 0)) throw new Error('插件状态已变化，请重试');
        guard();
        const worker = await start(id);
        guard();
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
    }
  return {
    stop, runBackground,
    startBackground() { if (backgroundTimer || closing) return; backgroundTimer = setInterval(() => { void runBackground(); }, 60_000); backgroundTimer.unref(); void runBackground(); },
    async page(id: string) { const { files, entry } = await verified(id); return { themeMode: entry.manifest.theme || 'full', javascript: files['ui.js'].toString('utf8'), css: files['ui.css'].toString('utf8') }; },
    call, capabilityCall,
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
    async close() { closing = true; if (backgroundTimer) clearInterval(backgroundTimer); for (const id of new Set([...starting.keys(), ...workers.keys()])) stop(id); await Promise.allSettled([...starting.values(), ...queues.values()]); },
  };
}
export type PluginApplications = ReturnType<typeof createPluginApplications>;
