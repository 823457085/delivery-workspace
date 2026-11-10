/** 只从已选分支提交创建 worktree；服务使用独立端口，核对 cwd 与进程组后才允许复测。 */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type { RefactorBranchSource, RefactorLocalPlan, RefactorLocalRuntime } from '../shared/refactor-local-retest.js';
import { scanListeningPorts } from './port-monitor.js';

const exec = promisify(execFile);
const git = async (cwd: string, args: string[], signal?: AbortSignal) => (await exec('git',
  ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args],
  { timeout: 60_000, maxBuffer: 2_000_000, signal, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })).stdout.trim();
const lockfiles = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'];

export async function refactorBranches(workspacePath: string) {
  const source = await fs.realpath(workspacePath);
  const repositoryPath = await fs.realpath(await git(source, ['rev-parse', '--show-toplevel']));
  const current = await git(repositoryPath, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => '');
  const output = await git(repositoryPath, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', 'refs/heads', 'refs/remotes']);
  const branches: RefactorBranchSource['branches'] = output.split('\n').filter(Boolean).flatMap(line => {
    const [ref, head, symbolic] = line.split('\0');
    return symbolic || !/^[a-f0-9]{40,64}$/.test(head || '') ? []
      : [{ ref: ref!, name: ref!.replace(/^refs\/(?:heads|remotes)\//, ''), head: head! }];
  });
  return { workspacePath: source, repositoryPath, current, branches };
}

export async function planLocalRetest(workspacePath: string, ref: string,
  saved?: { startScript?: string; packageManager?: RefactorLocalPlan['packageManager'] }): Promise<RefactorLocalPlan> {
  const source = await refactorBranches(workspacePath);
  const branch = source.branches.find(item => item.ref === ref);
  if (!branch) throw new Error('所选分支不存在，请刷新分支后重选');
  const relativePath = path.relative(source.repositoryPath, source.workspacePath);
  const prefix = relativePath ? `${relativePath.split(path.sep).join('/')}/` : '';
  let manifest: { scripts?: Record<string, string>; packageManager?: string };
  try { manifest = JSON.parse(await git(source.repositoryPath, ['show', `${branch.head}:${prefix}package.json`])); }
  catch { throw new Error('所选分支缺少可读取的 package.json，无法自动启动本地复测'); }
  const scripts = manifest.scripts || {};
  const startScript = [saved?.startScript, 'dev', 'start'].find(name => name && typeof scripts[name] === 'string');
  if (!startScript || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,79}$/.test(startScript)) throw new Error('所选分支没有可用启动脚本，请先在项目配置中选择 package script');
  const declared = manifest.packageManager?.split('@')[0];
  let packageManager = saved?.packageManager || (['pnpm', 'npm', 'yarn'].includes(declared || '') ? declared as RefactorLocalPlan['packageManager'] : undefined);
  if (!packageManager) {
    const files = (await git(source.repositoryPath, ['ls-tree', '--name-only', branch.head, '--', ...lockfiles.map(name => `${prefix}${name}`)])).split('\n');
    packageManager = files.includes(`${prefix}pnpm-lock.yaml`) ? 'pnpm' : files.includes(`${prefix}yarn.lock`) ? 'yarn' : 'npm';
  }
  return { sourceWorkspacePath: source.workspacePath, repositoryPath: source.repositoryPath, relativePath,
    ref: branch.ref, branch: branch.name, head: branch.head, packageManager, startScript, script: scripts[startScript]! };
}

async function availablePort() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
function startArguments(plan: RefactorLocalPlan, port: number) {
  const cli = /(?:^|[\s/])(?:vite|vue-cli-service\s+serve)(?:\s|$)/.test(plan.script)
    ? ['--host', '127.0.0.1', '--port', String(port), ...(/(?:^|[\s/])vite(?:\s|$)/.test(plan.script) ? ['--strictPort'] : [])]
    : /(?:^|[\s/])next\s+dev(?:\s|$)/.test(plan.script) ? ['--hostname', '127.0.0.1', '--port', String(port)] : [];
  return ['run', plan.startScript, ...(cli.length && plan.packageManager === 'npm' ? ['--'] : []), ...cli];
}
async function ensurePnpmWorkspace(workspacePath: string, worktree: string) {
  // A task can live below Delivery's own pnpm workspace. Keep a selected monorepo's
  // workspace, but never let a standalone checkout inherit the host workspace.
  for (let folder = workspacePath; folder === worktree || folder.startsWith(`${worktree}${path.sep}`); folder = path.dirname(folder)) {
    if (await fs.access(path.join(folder, 'pnpm-workspace.yaml')).then(() => true, () => false)) return;
    if (folder === worktree) {
      // pnpm 12.3 still discovers parent projects with --ignore-workspace. This
      // generated boundary is local to the disposable checkout; its lockfile and
      // manifest stay those of the selected commit, and the source is untouched.
      await fs.writeFile(path.join(workspacePath, 'pnpm-workspace.yaml'), 'packages:\n  - .\n', { flag: 'wx', mode: 0o600 });
      return;
    }
  }
  throw new Error('复测项目目录不在本次独立工作区内');
}
async function sameDependencies(source: string, target: string) {
  for (const name of ['package.json', ...lockfiles]) {
    const read = (root: string) => fs.readFile(path.join(root, name)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const [a, b] = await Promise.all([read(source), read(target)]);
    if ((a === null) !== (b === null) || a && b && !a.equals(b)) return false;
  }
  return fs.lstat(path.join(source, 'node_modules')).then(stat => stat.isDirectory(), () => false);
}
async function processGroup(pid: number) {
  if (process.platform === 'win32') return pid;
  return Number((await exec('ps', ['-o', 'pgid=', '-p', String(pid)], { timeout: 3000 })).stdout.trim());
}

export function createLocalRetests(root: string, directory: string, options: { timeoutMs?: number; pollMs?: number } = {}) {
  const controllers = new Map<string, AbortController>();
  const children = new Map<string, ChildProcess>();
  const live = new Map<string, RefactorLocalRuntime>();
  const phases = new Map<string, string>();
  const cancelled = new Set<string>();
  let closed = false;
  function killChild(id: string) {
    const child = children.get(id);
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    // Only children created by this manager in this process; never stop a pre-existing listener.
    try { if (process.platform === 'win32') child.kill('SIGTERM'); else process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
  }
  async function ready(value: RefactorLocalRuntime) {
    const snapshot = await scanListeningPorts([value.port], { root });
    const listeners = snapshot.ports.find(item => item.port === value.port)?.listeners || [];
    if (!listeners.length) return false;
    for (const listener of listeners) {
      const cwd = await fs.realpath(listener.cwd).catch(() => '');
      if (cwd !== value.workspacePath || await processGroup(listener.pid).catch(() => 0) !== value.pid)
        throw new Error('复测端口被其他工作区或进程占用，未使用该服务');
    }
    const response = await fetch(value.baseUrl, { redirect: 'manual', signal: AbortSignal.timeout(3000) }).catch(() => undefined);
    if (!response) return false;
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (location && new URL(location, value.baseUrl).origin !== new URL(value.baseUrl).origin)
      throw new Error('本地页面跳转到其他服务，未将远端页面作为分支复测入口');
    return response.status >= 200 && response.status < 400;
  }
  async function stop(id: string) {
    controllers.get(id)?.abort(); killChild(id);
    const value = live.get(id) || await fs.readFile(path.join(directory, id, 'runtime.json'), 'utf8').then(text => JSON.parse(text) as RefactorLocalRuntime).catch(() => undefined);
    // After a workspace restart, only stop a recorded process group if its current listeners still belong to this job's worktree.
    if (!children.has(id) && value?.state === 'running' && process.platform !== 'win32') {
      const workspace = await fs.realpath(path.join(directory, id, 'workspace')).catch(() => '');
      if (workspace && (value.workspacePath === workspace || value.workspacePath.startsWith(`${workspace}${path.sep}`))) {
        const snapshot = await scanListeningPorts([value.port], { root }).catch(() => undefined);
        const listeners = snapshot?.ports.find(item => item.port === value.port)?.listeners || [];
        if (listeners.length && (await Promise.all(listeners.map(async listener =>
          await fs.realpath(listener.cwd).catch(() => '') === value.workspacePath && await processGroup(listener.pid).catch(() => 0) === value.pid))).every(Boolean)) {
          try { process.kill(-value.pid, 'SIGTERM'); } catch { /* already exited */ }
        }
      }
    }
    if (value) {
      value.state = 'stopped'; live.delete(id);
      await fs.writeFile(path.join(directory, id, 'runtime.json'), JSON.stringify(value, null, 2), { mode: 0o600 });
    }
    children.delete(id); phases.delete(id);
  }
  async function prepare(id: string, plan: RefactorLocalPlan): Promise<RefactorLocalRuntime> {
    if (closed || cancelled.has(id)) throw new Error('本地复测已停止');
    if (live.has(id)) return live.get(id)!;
    const controller = new AbortController(), { signal } = controller;
    controllers.set(id, controller);
    const folder = path.join(directory, id), worktree = path.join(folder, 'workspace');
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    const log = await fs.open(path.join(folder, 'startup.log'), 'a', 0o600);
    try {
      phases.set(id, '正在创建分支独立工作区');
      const exists = await fs.lstat(worktree).then(() => true, () => false);
      if (exists) throw new Error('本次复测工作区已存在，未覆盖或重复启动，请重新发起');
      await git(plan.repositoryPath, ['worktree', 'add', '--detach', worktree, plan.head], signal);
      const workspacePath = await fs.realpath(path.join(worktree, plan.relativePath));
      if (await git(workspacePath, ['rev-parse', 'HEAD'], signal) !== plan.head) throw new Error('隔离工作区 Commit 与所选分支不一致');
      const manifest = JSON.parse(await fs.readFile(path.join(workspacePath, 'package.json'), 'utf8'));
      if (manifest.scripts?.[plan.startScript] !== plan.script) throw new Error('启动脚本与已确认版本不一致');
      signal.throwIfAborted();
      if (plan.packageManager === 'pnpm') await ensurePnpmWorkspace(workspacePath, await fs.realpath(worktree));
      const env = { ...process.env, NODE_ENV: 'development', npm_config_production: 'false', npm_config_omit: '',
        HUSKY: '0', LEFTHOOK: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' };
      if (await sameDependencies(plan.sourceWorkspacePath, workspacePath)) {
        phases.set(id, '正在准备本地依赖');
        const from = path.join(plan.sourceWorkspacePath, 'node_modules'), to = path.join(workspacePath, 'node_modules');
        if (process.platform === 'darwin') await exec('cp', ['-cR', from, to], { timeout: 300_000, signal });
        else await fs.cp(from, to, { recursive: true, mode: constants.COPYFILE_FICLONE });
      } else if (Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).length) {
        phases.set(id, '正在安装所选分支依赖');
        const hasLock = await fs.access(path.join(workspacePath, plan.packageManager === 'pnpm' ? 'pnpm-lock.yaml' : plan.packageManager === 'yarn' ? 'yarn.lock' : 'package-lock.json')).then(() => true, () => false);
        const args = plan.packageManager === 'npm' ? [hasLock ? 'ci' : 'install', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund']
          : ['install', '--ignore-scripts', ...(hasLock ? ['--frozen-lockfile'] : [])];
        await new Promise<void>((resolve, reject) => {
          const child = spawn(plan.packageManager, args, { cwd: workspacePath, shell: false, detached: process.platform !== 'win32',
            stdio: ['ignore', log.fd, log.fd], env: { ...env, CI: '1' } });
          children.set(id, child);
          const abort = () => { killChild(id); reject(new Error('本地复测已停止')); };
          signal.addEventListener('abort', abort, { once: true });
          const timeout = setTimeout(() => { killChild(id); reject(new Error('本地依赖安装超时，请检查任务启动日志')); }, 600_000).unref();
          const done = (error?: Error) => { clearTimeout(timeout); signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
          child.once('error', () => done(new Error('依赖安装未能启动，请检查本机包管理器')));
          child.once('exit', code => done(code === 0 ? undefined : new Error('依赖安装未完成，请检查任务启动日志')));
          if (signal.aborted) abort();
        });
        children.delete(id);
      }
      signal.throwIfAborted();
      phases.set(id, '正在启动并核对本地服务');
      const port = await availablePort();
      const child = spawn(plan.packageManager, startArguments(plan, port), { cwd: workspacePath, shell: false,
        detached: process.platform !== 'win32', stdio: ['ignore', log.fd, log.fd], env: { ...env, PORT: String(port), HOST: '127.0.0.1', BROWSER: 'none' } });
      children.set(id, child);
      let exited = false, exitDetail = '';
      child.once('error', error => { exited = true; exitDetail = error.message; });
      child.once('exit', (code, signal) => { exited = true; exitDetail = signal ? `信号 ${signal}` : `退出码 ${code}`; });
      if (!child.pid) throw new Error('本地服务未能启动，请检查已配置的包管理器');
      const value: RefactorLocalRuntime = { ...plan, workspacePath, baseUrl: `http://127.0.0.1:${port}/`, pid: child.pid,
        port, startedAt: new Date().toISOString(), state: 'running' };
      await fs.writeFile(path.join(folder, 'runtime.json'), JSON.stringify(value, null, 2), { mode: 0o600 });
      const deadline = Date.now() + (options.timeoutMs ?? 120_000);
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        if (exited) throw new Error(`本地启动命令已退出（${exitDetail}），启动日志：${path.join(folder, 'startup.log')}`);
        if (await ready(value)) { live.set(id, value); phases.delete(id); return value; }
        await delay(options.pollMs ?? 500, undefined, { signal });
      }
      throw new Error('本地服务未在独立端口就绪，请检查启动脚本是否支持 PORT 或 --port');
    } catch (error) { await stop(id); throw error; }
    finally { controllers.delete(id); await log.close(); }
  }
  return { prepare, stop, phase: (id: string) => phases.get(id),
    cancel(id: string) { cancelled.add(id); controllers.get(id)?.abort(); killChild(id); },
    async verify(value: RefactorLocalRuntime) {
      if (await git(value.workspacePath, ['rev-parse', 'HEAD']) !== value.head
        || await git(value.workspacePath, ['diff', '--name-only', 'HEAD'])) throw new Error('复测工作区代码与选定 Commit 不一致，不能使用该结果');
    },
    async close(preserveRunning = false) {
      closed = true;
      await Promise.all([...new Set([...controllers.keys(), ...children.keys()])].filter(id => !preserveRunning || !live.has(id)).map(stop));
      if (preserveRunning) {
        for (const id of live.keys()) { children.get(id)?.unref(); children.delete(id); }
        live.clear();
      }
    },
  };
}
