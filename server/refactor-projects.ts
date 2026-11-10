/** 项目组只执行用户已保存的 package script；端口归属与依赖就绪逐项核对，不接管其他服务。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { RefactorProject, RefactorProjectDashboard, RefactorProjectStatus } from '../shared/refactor-projects.js';
import { scanListeningPorts } from './port-monitor.js';
import type { PortSnapshot } from '../shared/port-monitor.js';

const exec = promisify(execFile);
const projectSchema = z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(100),
  role: z.enum(['shell', 'micro-app', 'legacy', 'service']), workspacePath: z.string().min(1).max(1000),
  baseUrl: z.string().min(1).max(2000), packageManager: z.enum(['pnpm', 'npm', 'yarn']),
  startScript: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,79}$/), dependencies: z.array(z.string().uuid()).max(100) }).strict();
const configSchema = z.object({ revision: z.string().uuid(), projects: z.array(projectSchema).max(100) }).strict();
interface Options {
  scanPorts?: typeof scanListeningPorts;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  probe?: (url: string) => Promise<boolean>;
  discoverProjects?: () => Promise<RefactorProject[]>;
  startTimeoutMs?: number;
  pollIntervalMs?: number;
}
const portOf = (project: RefactorProject) => Number(new URL(project.baseUrl).port || (project.baseUrl.startsWith('https:') ? 443 : 80));
const clone = <T>(value: T): T => structuredClone(value);

function ordered(projects: RefactorProject[], ids = projects.map(project => project.id)) {
  const byId = new Map(projects.map(project => [project.id, project]));
  if (byId.size !== projects.length) throw new Error('项目编号重复，请重新添加项目');
  const visiting = new Set<string>(), visited = new Set<string>(), result: RefactorProject[] = [];
  function visit(id: string) {
    const project = byId.get(id);
    if (!project) throw new Error('项目依赖不存在，请重新选择依赖项目');
    if (visiting.has(id)) throw new Error('项目依赖形成循环，请调整后再保存');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of project.dependencies) visit(dependency);
    visiting.delete(id); visited.add(id); result.push(project);
  }
  for (const id of ids) visit(id);
  return result;
}

async function scriptsAt(workspacePath: string) {
  const value = JSON.parse(await fs.readFile(path.join(workspacePath, 'package.json'), 'utf8'));
  return Object.entries(value.scripts || {}).filter(([, script]) => typeof script === 'string').map(([name]) => name);
}
async function validate(project: RefactorProject): Promise<RefactorProject> {
  if (!path.isAbsolute(project.workspacePath)) throw new Error('项目目录必须是本机绝对路径');
  const workspacePath = await fs.realpath(project.workspacePath).catch(() => { throw new Error(`项目目录不存在：${project.name}`); });
  if (!(await fs.stat(workspacePath)).isDirectory()) throw new Error(`请选择有效项目目录：${project.name}`);
  let baseUrl: URL;
  try { baseUrl = new URL(project.baseUrl); } catch { throw new Error(`项目访问地址无效：${project.name}`); }
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash)
    throw new Error('项目访问地址仅接受不含凭据、查询参数和片段的 HTTP(S) 地址');
  const scripts = await scriptsAt(workspacePath).catch(() => { throw new Error(`无法读取项目 package.json：${project.name}`); });
  if (!scripts.includes(project.startScript)) throw new Error(`项目 ${project.name} 没有 package script：${project.startScript}`);
  return { ...project, workspacePath, baseUrl: baseUrl.href, dependencies: [...new Set(project.dependencies)] };
}

export async function createRefactorProjects(root: string, directory: string, options: Options = {}) {
  const file = path.join(directory, 'projects.json');
  let state = { revision: randomUUID() as string, projects: [] as RefactorProject[] };
  try { state = configSchema.parse(JSON.parse(await fs.readFile(file, 'utf8'))); ordered(state.projects); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('项目组配置无法读取，请检查本机 projects.json'); }
  const phases = new Map<string, { state: 'starting' | 'failed'; message: string }>();
  const closing = new AbortController();
  let launchTask: Promise<void> | undefined, saving = false;
  let scanning: Promise<PortSnapshot> | undefined;
  const scan = () => scanning ||= (options.scanPorts || scanListeningPorts)([...new Set(state.projects.map(portOf))], { root })
    .finally(() => { scanning = undefined; });
  const probe = options.probe || (async (url: string) => {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'manual' }); await response.body?.cancel(); return response.status < 500; }
    catch { return false; }
  });
  async function git(cwd: string, args: string[]) {
    return exec('git', ['-C', cwd, ...args], { timeout: 3000, maxBuffer: 128_000 }).then(result => result.stdout.trim()).catch(() => '');
  }
  async function status(project: RefactorProject, ports: PortSnapshot): Promise<RefactorProjectStatus> {
    const [branch, head, changes, scripts] = await Promise.all([git(project.workspacePath, ['branch', '--show-current']),
      git(project.workspacePath, ['rev-parse', 'HEAD']), git(project.workspacePath, ['status', '--porcelain']), scriptsAt(project.workspacePath).catch(() => [])]);
    const listeners = ports.ports.find(item => item.port === portOf(project))?.listeners || [];
    const owners = await Promise.all(listeners.map(async listener => ({ ...listener,
      actualCwd: path.isAbsolute(listener.cwd) ? await fs.realpath(listener.cwd).catch(() => '') : '' })));
    const common = { ...project, branch, head, dirty: !!changes, scripts, ports: [portOf(project)], pids: [...new Set(listeners.map(listener => listener.pid))] };
    const foreign = owners.filter(listener => listener.actualCwd !== project.workspacePath);
    if (foreign.length) return { ...common, state: 'conflict', message: `端口 ${portOf(project)} 被其他目录或归属未确认的进程占用（PID ${foreign.map(item => item.pid).join('、')}），未启动或接管服务` };
    if (owners.length && await probe(project.baseUrl)) return { ...common, state: 'running', message: '访问入口可响应，端口监听目录与项目一致' };
    const phase = phases.get(project.id);
    return { ...common, state: phase?.state || 'stopped', message: phase?.message || (owners.length ? '目录归属一致，访问入口尚未响应' : '配置端口尚未监听') };
  }
  async function snapshot(): Promise<RefactorProjectDashboard> {
    const projects = clone(state.projects), revision = state.revision;
    let statuses: RefactorProjectStatus[];
    try { const ports = projects.length ? await scan() : undefined; statuses = ports ? await Promise.all(projects.map(project => status(project, ports))) : []; }
    catch { statuses = projects.map(project => ({ ...project, branch: '', head: '', dirty: false, scripts: [], ports: [portOf(project)], pids: [], state: 'failed', message: '本机端口归属暂时无法核验，请刷新后重试' })); }
    const suggestions = options.discoverProjects ? await options.discoverProjects().catch(() => []) : [];
    return { revision, projects: statuses, suggestions };
  }
  async function configure(input: unknown) {
    if (saving || launchTask) throw new Error('项目配置保存或启动进行中，请稍后重试');
    const parsed = configSchema.parse(input);
    if (parsed.revision !== state.revision) throw new Error('项目组配置已更新，请刷新后重新保存');
    saving = true;
    try {
      const projects = await Promise.all(parsed.projects.map(validate));
      if (new Set(projects.map(project => project.workspacePath)).size !== projects.length) throw new Error('同一个真实项目目录不能重复添加，符号链接按原目录处理');
      if (new Set(projects.map(portOf)).size !== projects.length) throw new Error('项目组的访问端口不能重复，请使用独立端口');
      ordered(projects);
      const next = { revision: randomUUID(), projects };
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, file); }
      finally { await fs.rm(temporary, { force: true }); }
      state = next; phases.clear();
    } finally { saving = false; }
    return snapshot();
  }
  async function startOne(project: RefactorProject) {
    const current = await validate(project);
    if (current.workspacePath !== project.workspacePath) throw new Error('项目真实目录在保存后发生变化，请重新保存配置');
    const before = await status(project, await scan());
    if (before.state === 'conflict' || before.state === 'failed') throw new Error(before.message);
    if (before.state === 'running') { phases.delete(project.id); return; }
    if (before.pids.length) throw new Error('项目已有监听进程但入口未就绪，请核对后重试；未重复启动');
    await fs.mkdir(path.join(directory, 'logs'), { recursive: true, mode: 0o700 });
    const log = await fs.open(path.join(directory, 'logs', `${project.id}-${Date.now()}.log`), 'wx', 0o600);
    let child: ChildProcess;
    try {
      child = (options.spawn || spawn)(project.packageManager, ['run', project.startScript], {
        cwd: project.workspacePath, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', log.fd, log.fd], env: { ...process.env },
      });
      child.once('error', () => phases.set(project.id, { state: 'failed', message: '启动程序未能执行，请检查已选择的包管理器' }));
      child.once('exit', () => { if (!closing.signal.aborted) phases.set(project.id, { state: 'failed', message: '启动命令已退出，请在项目终端核对启动配置' }); });
      child.unref();
    } finally { await log.close(); }
    const deadline = Date.now() + (options.startTimeoutMs ?? 120_000);
    while (!closing.signal.aborted && Date.now() < deadline) {
      const value = await status(project, await scan());
      if (value.state === 'running') { phases.delete(project.id); return; }
      if (value.state === 'conflict' || value.state === 'failed') throw new Error(value.message);
      await delay(options.pollIntervalMs ?? 1000, undefined, { signal: closing.signal }).catch(() => {});
    }
    if (!closing.signal.aborted) throw new Error('启动后仍未确认本项目端口与访问入口就绪，请检查项目终端；未停止任何进程');
  }
  async function start(input: unknown) {
    if (closing.signal.aborted) throw new Error('工作台正在退出');
    if (saving || launchTask) throw new Error('已有项目组启动或配置操作进行中');
    const { projectIds } = z.object({ projectIds: z.array(z.string().uuid()).min(1).max(100) }).strict().parse(input);
    const sequence = ordered(state.projects, projectIds);
    for (const project of sequence) phases.set(project.id, { state: 'starting', message: '等待依赖就绪并核对本机端口归属' });
    launchTask = (async () => {
      const failed = new Set<string>();
      for (const project of sequence) {
        if (closing.signal.aborted) break;
        if (project.dependencies.some(id => failed.has(id))) {
          failed.add(project.id);
          phases.set(project.id, { state: 'failed', message: '依赖项目未就绪，本项目未启动' });
          continue;
        }
        try { await startOne(project); }
        catch (error) {
          const message = error instanceof Error ? error.message : '项目启动未完成';
          failed.add(project.id);
          phases.set(project.id, { state: 'failed', message });
        }
      }
    })().finally(() => { launchTask = undefined; });
    return snapshot();
  }
  return { snapshot, configure, start,
    get: (id: string) => clone(state.projects.find(project => project.id === id)), list: () => clone(state.projects),
    async close() { closing.abort(); await launchTask; },
  };
}
