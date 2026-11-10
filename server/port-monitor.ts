import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { LocalProject } from '../shared/hub.js';
import type {
  PortActionRequest,
  PortActionResult,
  PortListener,
  PortProject,
  PortScope,
  PortSnapshot,
  PortStoppedService,
} from '../shared/port-monitor.js';
export { parsePortList } from '../shared/port-monitor.js';
export type {
  PortActionRequest,
  PortActionResult,
  PortActionType,
  PortListener,
  PortScope,
  PortSnapshot,
  PortStatus,
  PortStoppedService,
} from '../shared/port-monitor.js';

const execFileAsync = promisify(execFile);

type ParsedListener = Pick<PortListener, 'pid' | 'process' | 'address' | 'port'>;

type PersistedStoppedEntry = PortStoppedService & { rawCommand?: string };
type PortMonitorState = {
  managerPorts: Record<string, number[]>;
  stoppedServices: PersistedStoppedEntry[];
};

let memoryState: PortMonitorState = {
  managerPorts: {},
  stoppedServices: [],
};

function stateFilePath(dataDir?: string, root?: string) {
  const dir = dataDir || process.env.DELIVERY_DATA_DIR || (root ? path.join(root, '.data') : '');
  return dir ? path.join(dir, 'port-monitor-state.json') : '';
}

async function loadState(dataDir?: string, root?: string): Promise<PortMonitorState> {
  const file = stateFilePath(dataDir, root);
  if (!file) return memoryState;
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<PortMonitorState>;
    memoryState = {
      managerPorts: raw.managerPorts && typeof raw.managerPorts === 'object' ? raw.managerPorts : {},
      stoppedServices: Array.isArray(raw.stoppedServices) ? raw.stoppedServices : [],
    };
  } catch {
    /* State file not created yet */
  }
  return memoryState;
}

async function saveState(state: PortMonitorState, dataDir?: string, root?: string) {
  memoryState = state;
  const file = stateFilePath(dataDir, root);
  if (!file) return;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch {
    /* Ignore write failures in read-only test fixtures */
  }
}

function parseEndpoint(value: string) {
  const match = value.match(/^\[(.*)\]:(\d+)$/) || value.match(/^(.*):(\d+)$/);
  if (!match) return undefined;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  return { address: match[1] === '*' ? '0.0.0.0' : match[1], port };
}

export function parseLsofListeners(output: string): ParsedListener[] {
  const listeners: ParsedListener[] = [];
  let pid = 0;
  let process = '';
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const field = line[0];
    const value = line.slice(1);
    if (field === 'p') pid = Number(value);
    if (field === 'c') process = value;
    if (field === 'n' && pid > 0) {
      const endpoint = parseEndpoint(value);
      if (endpoint) listeners.push({ pid, process, ...endpoint });
    }
  }
  return listeners;
}

export function parsePsProcesses(output: string) {
  const processes = new Map<number, { user: string; command: string; rawCommand: string; parentPid: number }>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (match) {
      processes.set(Number(match[1]), {
        parentPid: Number(match[2]),
        user: match[3],
        command: redactCommand(match[4]),
        rawCommand: match[4],
      });
    }
  }
  return processes;
}

export function parseLsofCwds(output: string) {
  const cwds = new Map<number, string>();
  let pid = 0;
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    if (line[0] === 'p') pid = Number(line.slice(1));
    if (line[0] === 'n' && pid > 0) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

export function inferPortFromCommand(commandText: string, managerName = ''): number {
  const portFlag = commandText.match(/(?:^|\s)(?:--port|-p)(?:=|\s+)(\d{2,5})(?:\s|$)/i);
  if (portFlag) {
    const port = Number(portFlag[1]);
    if (port >= 1 && port <= 65_535) return port;
  }
  const envFlag = commandText.match(/\bPORT=(\d{2,5})\b/);
  if (envFlag) {
    const port = Number(envFlag[1]);
    if (port >= 1 && port <= 65_535) return port;
  }
  if (managerName) {
    const nameMatch = managerName.match(/(?:^|[-_a-zA-Z])([3-9]\d{3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$/);
    if (nameMatch) {
      const port = Number(nameMatch[1]);
      if (port >= 3000 && port <= 65_535) return port;
    }
  }
  return 0;
}

export function buildPortSnapshot(
  listeners: PortListener[],
  requestedPorts: number[] = [],
  scannedAt = new Date().toISOString(),
  stoppedServices: PortStoppedService[] = [],
  selfPort?: number,
): PortSnapshot {
  const grouped = new Map<number, PortListener[]>();
  for (const listener of listeners) {
    // 手动查端口时保留真实占用者，避免把非项目进程占用误报为未监听。
    if (!requestedPorts.length && !listener.project) continue;
    const bucket = grouped.get(listener.port) || [];
    bucket.push(listener);
    grouped.set(listener.port, bucket);
  }
  const ports = requestedPorts.length ? requestedPorts : [...grouped.keys()].sort((left, right) => left - right);
  const statuses = ports.map(port => ({
    port,
    status: grouped.has(port) ? 'listening' as const : 'available' as const,
    listeners: grouped.get(port) || [],
  }));
  const filteredStopped = requestedPorts.length
    ? stoppedServices.filter(item => item.port > 0 && requestedPorts.includes(item.port))
    : stoppedServices;
  const activeListeners = statuses.flatMap(item => item.listeners);
  const pm2Managers = new Set([
    ...activeListeners.flatMap(item => (item.manager ? [item.manager] : [])),
    ...filteredStopped.flatMap(item => (item.manager ? [item.manager] : [])),
  ]);
  return {
    scannedAt,
    ports: statuses,
    stopped: filteredStopped,
    ...(selfPort ? { selfPort } : {}),
    summary: {
      listeningPorts: statuses.filter(item => item.status === 'listening').length,
      listenerCount: statuses.reduce((total, item) => total + item.listeners.length, 0),
      processCount: new Set(activeListeners.map(listener => listener.pid)).size,
      projectCount: new Set([
        ...activeListeners.flatMap(listener => (listener.project ? [listener.project.name] : [])),
        ...filteredStopped.flatMap(item => (item.project ? [item.project.name] : [])),
      ]).size,
      stoppedCount: filteredStopped.length,
      pm2Count: pm2Managers.size,
    },
  };
}

function portScope(address: string): PortScope {
  if (address === '0.0.0.0' || address === '::') return 'all';
  if (address === 'localhost' || address === '::1' || address.startsWith('127.') || address.endsWith(':127.0.0.1')) return 'loopback';
  if (address.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) return 'lan';
  return 'unknown';
}

function redactCommand(command: string) {
  return command
    .replace(/((?:--?|\b)(?:token|password|secret|api[-_]?key|authorization)(?:=|\s+))[^\s]+/gi, '$1[redacted]')
    .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|KEY|AUTH)[A-Z0-9_]*)=\S+/g, '$1=[redacted]');
}

async function command(cmd: string, args: string[], timeout = 5_000) {
  try {
    const result = await execFileAsync(cmd, args, { maxBuffer: 2_000_000, timeout });
    return result.stdout;
  } catch (error) {
    const details = error as { code?: number | string; stdout?: string; stderr?: string };
    if (cmd === 'lsof' && details.code === 1 && !details.stderr?.trim() && typeof details.stdout === 'string') return details.stdout;
    const reason = details.stderr?.trim() || (error instanceof Error ? error.message : String(error));
    throw new Error(`无法执行 ${cmd}：${reason}`);
  }
}

type ManagedProcess = { name: string; script: string; args: string[] };

export type Pm2ProcessInfo = {
  pmId: number;
  name: string;
  pid: number;
  status: string;
  script: string;
  cwd: string;
  args: string[];
  user: string;
};

export function parseManagedProcesses(output: string) {
  const entries = JSON.parse(output) as { pid: number; name: string; pm2_env?: { pm_exec_path?: string; args?: unknown } }[];
  return new Map(entries.filter(entry => entry.pid > 0).map(entry => [entry.pid, {
    name: entry.name, script: entry.pm2_env?.pm_exec_path || '',
    args: Array.isArray(entry.pm2_env?.args) ? entry.pm2_env.args.filter((value): value is string => typeof value === 'string') : [],
  }]));
}

export function parseAllPm2Processes(output: string): Pm2ProcessInfo[] {
  const entries = JSON.parse(output) as {
    pm_id?: number;
    pid?: number;
    name?: string;
    pm2_env?: {
      status?: string;
      pm_exec_path?: string;
      pm_cwd?: string;
      args?: unknown;
      username?: string;
    };
  }[];
  return entries
    .filter(entry => typeof entry.name === 'string' && entry.name.length > 0)
    .map((entry, idx) => ({
      pmId: typeof entry.pm_id === 'number' ? entry.pm_id : idx,
      name: entry.name!,
      pid: typeof entry.pid === 'number' ? entry.pid : 0,
      status: entry.pm2_env?.status || (entry.pid && entry.pid > 0 ? 'online' : 'stopped'),
      script: entry.pm2_env?.pm_exec_path || '',
      cwd: entry.pm2_env?.pm_cwd || '',
      args: Array.isArray(entry.pm2_env?.args) ? entry.pm2_env.args.filter((value): value is string => typeof value === 'string') : [],
      user: entry.pm2_env?.username || '—',
    }));
}

export function findManagedProcess(pid: number, processes: ReturnType<typeof parsePsProcesses>, managed: Map<number, ManagedProcess>) {
  const visited = new Set<number>();
  while (pid > 1 && !visited.has(pid)) {
    if (managed.has(pid)) return managed.get(pid);
    // Agent 启动的服务属于该任务，不能穿过 Agent 父进程归到工作台的 PM2 名下。
    if (/\b(?:codex\s+(?:app-server|exec)|cursor-agent\b|claude(?:\s|$)|agy(?:\s|$)|agent-browser\b)/i.test(processes.get(pid)?.command || '')) return;
    visited.add(pid);
    pid = processes.get(pid)?.parentPid || 0;
  }
}

export function isProjectService(processName: string, commandText: string) {
  if (/agent-browser|chrome|chromium|electron|apifox|\/Applications\/|\/\.codex\//i.test(commandText)) return false;
  if (/\/(?:opt\/homebrew\/lib|[^\s]+\/lib)\/node_modules\//.test(commandText)) return false;
  return /^(?:node|python[\d.]*|ruby|java|go|php|bun|deno|uvicorn|gunicorn|dotnet)(?:$|[-\d.])/i.test(processName);
}

function repositoryId(value: string) {
  return value.replace(/^.*@/, '').replace(/^https?:\/\//, '').replace(/:/g, '/').replace(/\.git\/?$/, '').replace(/\/$/, '');
}

async function git(cwd: string, args: string[]) {
  return execFileAsync('git', ['-C', cwd, ...args], { timeout: 2_000, maxBuffer: 64_000 })
    .then(result => result.stdout.trim()).catch(() => '');
}

async function readProject(cwd: string, projects: LocalProject[], deliveryRoot?: string): Promise<PortProject | undefined> {
  if (!path.isAbsolute(cwd) || cwd === path.parse(cwd).root) return;
  const workspacePath = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (workspacePath) {
    const [branch, remote] = await Promise.all([git(workspacePath, ['branch', '--show-current']), git(workspacePath, ['config', '--get', 'remote.origin.url'])]);
    const known = projects.find(project => project.path === workspacePath)
      || (remote ? projects.find(project => repositoryId(project.remoteUrl) === repositoryId(remote)) : undefined);
    return {
      name: known?.displayName || known?.projectName || path.basename(remote.replace(/\.git$/, '')) || path.basename(workspacePath),
      workspacePath,
      branch: branch || `HEAD ${(await git(workspacePath, ['rev-parse', '--short', 'HEAD'])) || '未确认'}`,
    };
  }
  if (deliveryRoot && cwd === deliveryRoot) return { name: 'Delivery Workspace', workspacePath: cwd, branch: '' };
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8')) as { name?: string };
    if (pkg.name) return { name: pkg.name, workspacePath: cwd, branch: '' };
  } catch { /* 普通目录继续交由调用方核对是否为独立预览服务。 */ }
}

function serviceName(commandText: string, fallback: string, delivery: boolean) {
  if (/lan-gateway-main/.test(commandText)) return '局域网访问网关';
  if (/remote-bridge-main/.test(commandText)) return '远程访问桥接';
  if (delivery && /(?:^|[\s/])(?:server\/index\.ts|delivery\.mjs)(?:\s|$)/.test(commandText)) return '工作台主服务';
  if (/vite|\/uni\.js(?:\s|$)/.test(commandText)) return /\bpreview\b/.test(commandText) ? 'Vite 预览服务' : 'Vite 开发服务';
  return [...commandText.matchAll(/([^\s/]+\.(?:mjs|cjs|js|ts|py|php))(?=\s|$)/g)].at(-1)?.[1] || fallback;
}

export async function scanListeningPorts(requestedPorts: number[] = [], options: {
  readProjects?: () => Promise<{ projects: LocalProject[] }>;
  root?: string;
  dataDir?: string;
  selfPort?: number;
  launched?: { cwd: string; listeners: { pid: number; port: number }[] };
} = {}): Promise<PortSnapshot> {
  const state = await loadState(options.dataDir, options.root);
  const rawListeners = parseLsofListeners(await command('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']));
  const uniqueListeners = [...new Map(rawListeners.map(listener => [`${listener.pid}:${listener.address}:${listener.port}`, listener])).values()];
  const pids = [...new Set(uniqueListeners.map(listener => listener.pid))];
  const processes = parsePsProcesses(await command('ps', ['-axo', 'pid=,ppid=,user=,command=']));
  const cwdOutput = pids.length ? await command('lsof', ['-nP', '-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn']) : '';
  const cwds = parseLsofCwds(cwdOutput);
  const hasPm2Daemon = [...processes.values()].some(item => /PM2.*God Daemon/i.test(item.command));
  const [inventory, pm2Raw] = await Promise.all([
    options.readProjects ? options.readProjects() : Promise.resolve({ projects: [] as LocalProject[] }),
    hasPm2Daemon ? command('pm2', ['jlist']).catch(() => '[]') : Promise.resolve('[]'),
  ]);
  const managed = parseManagedProcesses(pm2Raw);
  const allPm2 = parseAllPm2Processes(pm2Raw);

  const stoppedPm2Cwds = allPm2
    .filter(item => item.status !== 'online' || item.pid <= 0)
    .map(item => item.cwd || (item.script ? path.dirname(item.script) : ''))
    .filter(Boolean);
  const serviceCwds = [...new Set([
    ...uniqueListeners
      .filter(listener => isProjectService(listener.process, processes.get(listener.pid)?.command || listener.process))
      .map(listener => cwds.get(listener.pid) || ''),
    ...stoppedPm2Cwds,
  ].filter(Boolean))];
  const projects = new Map(await Promise.all(serviceCwds.map(async cwd => [cwd, await readProject(cwd, inventory.projects, options.root)] as const)));

  const listeners = uniqueListeners.map(listener => {
    const process = processes.get(listener.pid);
    const cwd = cwds.get(listener.pid) || '—';
    const actualCommand = process?.command || listener.process;
    const manager = findManagedProcess(listener.pid, processes, managed);
    const launchCommand = manager ? redactCommand([manager.script, ...manager.args].join(' ')) : '';
    const service = isProjectService(listener.process, actualCommand);
    // 独立 Node 预览目录可能不含 Git/package.json，只接纳从该目录启动的本地脚本。
    const localScript = [actualCommand, launchCommand].some(value => value.includes(`${cwd}/`) && /\.(?:mjs|cjs|js|ts|py|php)(?:\s|$)/.test(value));
    const detectedProject = service ? projects.get(cwd) || (localScript ? { name: path.basename(cwd), workspacePath: cwd, branch: '' } : undefined) : undefined;
    const launched = options.launched;
    // The launch probe already verified ownership even when OS process metadata is incomplete.
    const project = detectedProject || (launched?.listeners.some(item => item.pid === listener.pid && item.port === listener.port)
      ? { name: path.basename(launched.cwd), workspacePath: launched.cwd, branch: '' } : undefined);
    const serviceCommand = /\bname=/.test(actualCommand) && launchCommand ? launchCommand : actualCommand;
    return {
      ...listener,
      scope: portScope(listener.address),
      user: process?.user || '—',
      command: actualCommand,
      cwd,
      project,
      service: serviceName(serviceCommand, listener.process, project?.name === 'Delivery Workspace'),
      mode: `${serviceCommand} ${launchCommand}`.match(/(?:^|\s)--mode(?:=|\s+)(\S+)/)?.[1] || '',
      manager: manager?.name || '',
      launchCommand,
    } satisfies PortListener;
  });

  // 记录正在监听的 PM2 服务端口映射，供停止后仍能展示对应端口并重新开启。
  let stateChanged = false;
  const activeManagers = new Set<string>();
  const currentManagerPorts = new Map<string, Set<number>>();
  for (const listener of listeners) {
    if (listener.manager) {
      activeManagers.add(listener.manager);
      if (listener.port > 0) {
        const set = currentManagerPorts.get(listener.manager) || new Set<number>();
        set.add(listener.port);
        currentManagerPorts.set(listener.manager, set);
      }
    }
  }
  for (const [manager, portSet] of currentManagerPorts.entries()) {
    const nextPorts = [...portSet].sort((a, b) => a - b);
    const prevPorts = state.managerPorts[manager] || [];
    if (JSON.stringify(prevPorts) !== JSON.stringify(nextPorts)) {
      state.managerPorts[manager] = nextPorts;
      stateChanged = true;
    }
  }

  // 如果独立已停止服务的端口或目录已恢复监听，自动清理已停止记录。
  const activePortSet = new Set(listeners.map(item => item.port));
  const beforeStoppedLen = state.stoppedServices.length;
  state.stoppedServices = state.stoppedServices.filter(item => {
    if (item.port > 0 && activePortSet.has(item.port)) return false;
    return true;
  });
  if (state.stoppedServices.length !== beforeStoppedLen) stateChanged = true;
  if (stateChanged) await saveState(state, options.dataDir, options.root);

  const stoppedServices: PortStoppedService[] = [];
  for (const entry of allPm2) {
    if (activeManagers.has(entry.name) && entry.status === 'online') continue;
    if (entry.status === 'online' && entry.pid > 0) continue;
    const launchCommand = redactCommand([entry.script, ...entry.args].filter(Boolean).join(' '));
    const cwd = entry.cwd || (entry.script ? path.dirname(entry.script) : '—');
    const localScript = cwd !== '—' && launchCommand.includes(`${cwd}/`) && /\.(?:mjs|cjs|js|ts|py|php)(?:\s|$)/.test(launchCommand);
    const project = projects.get(cwd) || (localScript ? { name: path.basename(cwd), workspacePath: cwd, branch: '' } : undefined);
    const rememberedPorts = state.managerPorts[entry.name] || [];
    const inferredPort = rememberedPorts[0] || inferPortFromCommand(launchCommand, entry.name);
    stoppedServices.push({
      id: `pm2:${entry.name}`,
      port: inferredPort,
      process: 'node',
      user: entry.user,
      command: launchCommand || entry.name,
      cwd,
      project,
      service: serviceName(launchCommand, 'PM2 服务', project?.name === 'Delivery Workspace'),
      mode: launchCommand.match(/(?:^|\s)--mode(?:=|\s+)(\S+)/)?.[1] || '',
      manager: entry.name,
      launchCommand,
      state: entry.status === 'errored' ? 'errored' : 'stopped',
      pmId: entry.pmId,
    });
  }

  for (const saved of state.stoppedServices) {
    if (saved.manager && stoppedServices.some(item => item.manager === saved.manager)) continue;
    const { rawCommand: _raw, ...publicFields } = saved;
    stoppedServices.push(publicFields);
  }

  return buildPortSnapshot(listeners, requestedPorts, new Date().toISOString(), stoppedServices, options.selfPort);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminatePid(pid: number, timeoutMs = 1500) {
  if (!isPidAlive(pid) || pid === process.pid) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return;
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  if (isPidAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

type ServiceTarget = { manager?: string; pid?: number };

async function readActionRuntime(manager = '') {
  const [listenerOutput, processOutput] = await Promise.all([
    command('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']),
    command('ps', ['-axo', 'pid=,ppid=,user=,command=']),
  ]);
  const processes = parsePsProcesses(processOutput);
  const pm2 = manager || [...processes.values()].some(item => /PM2.*God Daemon/i.test(item.command))
    ? parseAllPm2Processes(await command('pm2', ['jlist'])) : [];
  const managed = new Map(pm2.filter(item => item.pid > 1).map(item => [item.pid, { name: item.name, script: item.script, args: item.args }]));
  return { listeners: parseLsofListeners(listenerOutput), processes, pm2, managed };
}
type ActionRuntime = Awaited<ReturnType<typeof readActionRuntime>>;

function belongsToTarget(pid: number, target: ServiceTarget, runtime: ActionRuntime): boolean {
  if (target.manager) return findManagedProcess(pid, runtime.processes, runtime.managed)?.name === target.manager;
  const visited = new Set<number>();
  while (pid > 1 && !visited.has(pid)) {
    if (pid === target.pid) return true;
    visited.add(pid);
    pid = runtime.processes.get(pid)?.parentPid || 0;
  }
  return false;
}

function targetPm2(runtime: ActionRuntime, manager: string) {
  const matches = runtime.pm2.filter(item => item.name === manager);
  if (matches.length !== 1) throw new Error(matches.length ? `PM2 服务名称 ${manager} 不唯一，请先确认目标服务` : `找不到 PM2 服务 ${manager}`);
  return matches[0]!;
}

function assertPortsFree(ports: number[], runtime: ActionRuntime, target?: ServiceTarget) {
  const foreign = runtime.listeners.filter(item => ports.includes(item.port) && !(target && belongsToTarget(item.pid, target, runtime)));
  if (foreign.length) {
    throw new Error(`端口已被其他服务占用：${[...new Set(foreign.map(item => `${item.address}:${item.port}（PID ${item.pid}）`))].join('、')}；未启动或重启服务`);
  }
}

function servicePorts(port: number, remembered: number[], runtime: ActionRuntime, target: ServiceTarget, launchCommand = '') {
  return [...new Set([
    port, ...remembered,
    ...runtime.listeners.filter(item => belongsToTarget(item.pid, target, runtime)).map(item => item.port),
    inferPortFromCommand(launchCommand),
  ].filter(value => Number.isInteger(value) && value > 0 && value <= 65_535))];
}

async function waitForService(ports: number[], target: ServiceTarget, timeoutMs = 5000, signal?: AbortSignal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const runtime = await readActionRuntime(target.manager);
    if (target.manager) {
      const pm2 = targetPm2(runtime, target.manager);
      if (pm2.status === 'errored' || pm2.status === 'stopped') throw new Error(`PM2 服务 ${target.manager} 启动失败，未确认目标端口监听`);
    }
    const own = runtime.listeners.filter(item => belongsToTarget(item.pid, target, runtime));
    const expected = [...new Set([...ports, ...own.map(item => item.port)])];
    assertPortsFree(expected, runtime, target);
    if (expected.length && expected.every(port => own.some(item => item.port === port))) return own;
    if (target.pid && !isPidAlive(target.pid)) {
      throw new Error('启动进程已退出，未确认目标端口监听');
    }
    await new Promise(resolve => setTimeout(resolve, 180));
  }
  throw new Error(`服务启动超时，未确认${ports.length ? `端口 ${ports.join('、')}` : '实际端口'}由目标进程监听`);
}

async function startManagedService(ports: number[], manager: string, args: string[], previousPid = 0, created = false, timeoutMs = 5000, signal?: AbortSignal) {
  signal?.throwIfAborted();
  try {
    await command('pm2', args, 12_000);
    await waitForService(ports, { manager }, timeoutMs, signal);
  } catch (error) {
    const runtime = await readActionRuntime(manager).catch(() => undefined);
    const matches = runtime?.pm2.filter(item => item.name === manager) || [];
    // 只回收本次新建或换 PID 启动的目标，不停止原本已在线且未变化的进程。
    if (matches.length === 1 && (created || !previousPid || matches[0]!.pid !== previousPid)) {
      const pids = new Set([...runtime!.processes.keys()].filter(pid => belongsToTarget(pid, { manager }, runtime!)));
      try {
        await command('pm2', [created ? 'delete' : 'stop', manager], 10_000);
        await waitForTargetStopped(pids);
      } catch (cleanupError) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}；目标服务清理失败：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
      }
    }
    throw error;
  }
}

async function waitForTargetStopped(pids: Set<number>, timeoutMs = 1800) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const listeners = parseLsofListeners(await command('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']));
    if (!listeners.some(item => pids.has(item.pid))) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('目标服务仍在监听，未确认停止成功');
}

async function spawnDetachedShell(rawCommand: string, cwd: string, port?: number) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (port && port > 0) env.PORT = String(port);
  const child = spawn('/bin/zsh', ['-lc', rawCommand], { cwd, detached: true, stdio: 'ignore', env });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  return child.pid!;
}

async function startStandalone(rawCommand: string, cwd: string, ports: number[], port?: number) {
  const pid = await spawnDetachedShell(rawCommand, cwd, port);
  try {
    return await waitForService(ports, { pid });
  } catch (error) {
    // 只清理本次创建的独立进程组，避免启动失败留下后台进程。
    try { process.kill(-pid, 'SIGTERM'); } catch { /* 进程已退出 */ }
    throw error;
  }
}

// ponytail: 同一工作台内串行端口动作；外部 CLI 的启动仍由操作系统和启动后归属检查兜底。
let actionQueue: Promise<unknown> = Promise.resolve();

type PortActionOptions = {
  readProjects?: () => Promise<{ projects: LocalProject[] }>;
  root?: string;
  dataDir?: string;
  selfPort?: number;
  requestedPorts?: number[];
  startupTimeoutMs?: number;
  startupSignal?: AbortSignal;
};

export function executePortAction(req: PortActionRequest, options: PortActionOptions = {}): Promise<PortActionResult> {
  const pending = actionQueue.then(() => runPortAction(req, options));
  actionQueue = pending.catch(() => {});
  return pending;
}

async function runPortAction(req: PortActionRequest, options: PortActionOptions): Promise<PortActionResult> {
  const state = await loadState(options.dataDir, options.root);
  const selfPort = options.selfPort;
  const action = req.action;
  if (req.port !== undefined && (!Number.isInteger(req.port) || req.port < 1 || req.port > 65_535)) throw new Error('端口号需为 1–65535 的整数');
  const port = typeof req.port === 'number' && Number.isInteger(req.port) && req.port > 0 ? req.port : 0;
  const pid = typeof req.pid === 'number' && Number.isInteger(req.pid) && req.pid > 1 ? req.pid : 0;
  const manager = typeof req.manager === 'string' ? req.manager.trim() : '';

  const runtime = await readActionRuntime(manager);
  const target: ServiceTarget = manager ? { manager } : { pid };
  if (manager) {
    targetPm2(runtime, manager);
    if (pid && !belongsToTarget(pid, target, runtime)) throw new Error('目标 PID 不属于指定 PM2 服务，请刷新后重试');
  }
  const isSelfService = (selfPort && port === selfPort) || pid === process.pid || belongsToTarget(process.pid, target, runtime);
  if (isSelfService && ['stop', 'delete', 'restart'].includes(action)) {
    throw new Error('当前工作台主服务正在承载本页面，请使用工作台的安全重启入口；端口管理不支持关闭、删除或直接重启该服务。');
  }
  const targetPids = new Set([...runtime.processes.keys()].filter(value => belongsToTarget(value, target, runtime)));

  if (action === 'stop') {
    if (manager) {
      if (port > 0) {
        const existing = new Set(state.managerPorts[manager] || []);
        existing.add(port);
        state.managerPorts[manager] = [...existing].sort((a, b) => a - b);
      }
      await command('pm2', ['stop', manager], 10_000);
      if (pid > 1 && isPidAlive(pid)) await terminatePid(pid, 1200);
      await waitForTargetStopped(targetPids);
      await saveState(state, options.dataDir, options.root);
      const snapshot = await scanListeningPorts(options.requestedPorts || [], options);
      return { ok: true, message: `已关闭 PM2 服务 ${manager}`, snapshot };
    }
    if (!pid) throw new Error('缺少目标进程 PID，无法关闭服务');
    const processes = parsePsProcesses(await command('ps', ['-axo', 'pid=,ppid=,user=,command=']));
    const procInfo = processes.get(pid);
    const cwdOut = await command('lsof', ['-nP', '-a', '-d', 'cwd', '-p', String(pid), '-Fpn']).catch(() => '');
    const resolvedCwd = parseLsofCwds(cwdOut).get(pid) || req.cwd || '—';
    const rawCommand = procInfo?.rawCommand || req.command || '';
    const stoppedId = `standalone:${port || pid}:${resolvedCwd}`;
    if (rawCommand && resolvedCwd && resolvedCwd !== '—') {
      state.stoppedServices = [
        ...state.stoppedServices.filter(item => item.id !== stoppedId && !(port > 0 && item.port === port)),
        {
          id: stoppedId,
          port,
          process: req.service || 'node',
          user: procInfo?.user || '—',
          command: redactCommand(rawCommand),
          rawCommand,
          cwd: resolvedCwd,
          project: req.project,
          service: req.service || serviceName(rawCommand, 'Node 服务', false),
          mode: req.mode || rawCommand.match(/(?:^|\s)--mode(?:=|\s+)(\S+)/)?.[1] || '',
          manager: '',
          launchCommand: '',
          state: 'stopped',
          stoppedAt: new Date().toISOString(),
        },
      ];
    }
    await terminatePid(pid, 1500);
    await waitForTargetStopped(targetPids);
    await saveState(state, options.dataDir, options.root);
    const snapshot = await scanListeningPorts(options.requestedPorts || [], options);
    return { ok: true, message: `已关闭端口 ${port || pid} 上的服务（可随时重新开启）`, snapshot };
  }

  if (action === 'start') {
    if (manager) {
      const entry = targetPm2(runtime, manager);
      const expectedPorts = servicePorts(port, state.managerPorts[manager] || [], runtime, target, [entry.script, ...entry.args].join(' '));
      assertPortsFree(expectedPorts, runtime, target);
      await startManagedService(expectedPorts, manager, ['start', manager], entry.status === 'online' ? entry.pid : 0, false, options.startupTimeoutMs, options.startupSignal);
      const snapshot = await scanListeningPorts(options.requestedPorts || [], options);
      return { ok: true, message: `已开启 PM2 服务 ${manager}`, snapshot };
    }
    const entry = state.stoppedServices.find(
      item => (req.stoppedId && item.id === req.stoppedId) || (port > 0 && item.port === port) || (req.cwd && item.cwd === req.cwd),
    );
    const targetCwd = entry?.cwd || req.cwd || '';
    const targetCmd = entry?.rawCommand || entry?.command || req.command || '';
    const targetPort = entry?.port || port;
    if (!targetCwd || targetCwd === '—' || !existsSync(targetCwd)) {
      throw new Error('缺少有效的工作区目录，无法开启服务');
    }
    if (!targetCmd.trim()) {
      throw new Error('缺少启动命令，无法开启服务');
    }
    const expectedPorts = servicePorts(targetPort, [], runtime, {}, targetCmd);
    assertPortsFree(expectedPorts, runtime);
    await startStandalone(targetCmd, targetCwd, expectedPorts, targetPort);
    if (entry) {
      state.stoppedServices = state.stoppedServices.filter(item => item.id !== entry.id);
      await saveState(state, options.dataDir, options.root);
    }
    const snapshot = await scanListeningPorts(options.requestedPorts || [], options);
    return { ok: true, message: `已开启服务${targetPort ? `（端口 ${targetPort}）` : ''}`, snapshot };
  }

  if (action === 'restart') {
    const entry = manager ? targetPm2(runtime, manager) : undefined;
    const launchCommand = entry ? [entry.script, ...entry.args].join(' ') : runtime.processes.get(pid)?.rawCommand || req.command || '';
    const expectedPorts = servicePorts(port, manager ? state.managerPorts[manager] || [] : [], runtime, target, launchCommand);
    assertPortsFree(expectedPorts, runtime, target);
    if (manager) {
      if (port > 0) {
        const existing = new Set(state.managerPorts[manager] || []);
        existing.add(port);
        state.managerPorts[manager] = [...existing].sort((a, b) => a - b);
        await saveState(state, options.dataDir, options.root);
      }
      await command('pm2', ['stop', manager], 10_000);
      if (pid > 1 && isPidAlive(pid)) await terminatePid(pid, 1200);
      await waitForTargetStopped(targetPids);
      assertPortsFree(expectedPorts, await readActionRuntime(manager));
      await startManagedService(expectedPorts, manager, ['start', manager], entry?.pid);
      const snapshot = await scanListeningPorts(options.requestedPorts || [], options);
      return { ok: true, message: `已重启 PM2 服务 ${manager}`, snapshot };
    }
    if (pid > 1) {
      const processes = parsePsProcesses(await command('ps', ['-axo', 'pid=,ppid=,user=,command=']));
      const procInfo = processes.get(pid);
      const cwdOut = await command('lsof', ['-nP', '-a', '-d', 'cwd', '-p', String(pid), '-Fpn']).catch(() => '');
      const resolvedCwd = parseLsofCwds(cwdOut).get(pid) || req.cwd || '';
      const rawCommand = procInfo?.rawCommand || req.command || '';
      if (!resolvedCwd || resolvedCwd === '—' || !existsSync(resolvedCwd) || !rawCommand.trim()) {
        throw new Error('无法读取该独立进程的启动目录或命令，无法自动重启');
      }
      await terminatePid(pid, 1500);
      await waitForTargetStopped(targetPids);
      assertPortsFree(expectedPorts, await readActionRuntime());
      await startStandalone(rawCommand, resolvedCwd, expectedPorts, port);
      const snapshot = await scanListeningPorts(options.requestedPorts || [], options);
      return { ok: true, message: `已重启端口 ${port || pid} 上的服务`, snapshot };
    }
    if (req.stoppedId) {
      return runPortAction({ ...req, action: 'start' }, options);
    }
    throw new Error('缺少可重启的进程或 PM2 服务信息');
  }

  if (action === 'delete') {
    if (manager) {
      await command('pm2', ['delete', manager], 10_000);
      if (pid > 1 && isPidAlive(pid)) await terminatePid(pid, 1200);
      delete state.managerPorts[manager];
      state.stoppedServices = state.stoppedServices.filter(item => item.manager !== manager);
      await saveState(state, options.dataDir, options.root);
      await waitForTargetStopped(targetPids);
      const snapshot = await scanListeningPorts(options.requestedPorts || [], options);
      return { ok: true, message: `已停止并从 PM2 删除服务 ${manager}`, snapshot };
    }
    if (pid > 1) {
      await terminatePid(pid, 1500);
      await waitForTargetStopped(targetPids);
    }
    state.stoppedServices = state.stoppedServices.filter(
      item => !(req.stoppedId && item.id === req.stoppedId) && !(port > 0 && item.port === port),
    );
    await saveState(state, options.dataDir, options.root);
    const snapshot = await scanListeningPorts(options.requestedPorts || [], options);
    return { ok: true, message: `已删除服务${port ? `（端口 ${port}）` : ''}`, snapshot };
  }

  if (action === 'create') {
    const targetCwd = req.cwd?.trim() || '';
    const rawCommand = req.command?.trim() || '';
    if (!targetCwd || !existsSync(targetCwd)) throw new Error('请选择或填写有效的本地项目目录');
    if (!rawCommand) throw new Error('请填写启动命令');
    const expectedPorts = servicePorts(port, [], runtime, {}, rawCommand);
    assertPortsFree(expectedPorts, runtime);
    const usePm2 = req.usePm2 !== false;
    if (usePm2) {
      const fallbackName = `${path.basename(targetCwd)}${port ? `-${port}` : ''}`.replace(/[^a-zA-Z0-9_-]/g, '-');
      const pm2Name = (req.pm2Name?.trim() || fallbackName).replace(/\s+/g, '-');
      if (runtime.pm2.some(item => item.name === pm2Name)) throw new Error(`PM2 服务 ${pm2Name} 已存在，请使用已有服务的开启或重启操作`);
      await startManagedService(expectedPorts, pm2Name, ['start', '/bin/zsh', '--name', pm2Name, '--cwd', targetCwd, '--', '-lc', rawCommand], 0, true, options.startupTimeoutMs, options.startupSignal);
      state.managerPorts[pm2Name] = expectedPorts;
      await saveState(state, options.dataDir, options.root);
      const snapshot = await scanListeningPorts(options.requestedPorts || [], options);
      return { ok: true, message: `已通过 PM2 开启服务 ${pm2Name}`, snapshot };
    }
    const listeners = await startStandalone(rawCommand, targetCwd, expectedPorts, port);
    const snapshot = await scanListeningPorts(options.requestedPorts || [], { ...options, launched: { cwd: targetCwd, listeners } });
    return { ok: true, message: `已在后台开启服务${port ? `（端口 ${port}）` : ''}`, snapshot };
  }

  throw new Error(`不支持的端口操作：${String(action)}`);
}
