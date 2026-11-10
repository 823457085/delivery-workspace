import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { LaunchConfig, LaunchSnapshot, LaunchStatus, ProjectCommand, ProjectExecution } from '../shared/project-launch.js';
import type { PortListener, PortSnapshot, PortStoppedService } from '../shared/port-monitor.js';
import { executePortAction, scanListeningPorts } from './port-monitor.js';
import { discoverProject, projectCommands } from './project-command-discovery.js';
import { runProjectCommand, redactProjectOutput, readManagedLaunchLog, createProjectLogBuffer } from './project-command-runner.js';

const scriptName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,79}$/);
const configSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), name: z.string().trim().min(1).max(100),
  script: scriptName, packageManager: z.enum(['npm', 'pnpm', 'yarn']),
  port: z.number().int().min(1).max(65535), protocol: z.enum(['http', 'https']),
}).strict();
const savedSchema = z.object({ workspacePath: z.string().min(1).max(2000), revision: z.number().int().nonnegative(), configs: z.array(configSchema).max(50) }).strict();
const actionSchema = z.object({ workspacePath: z.string().min(1).max(2000), configId: configSchema.shape.id, action: z.enum(['start', 'stop']) }).strict();
const executeSchema = z.object({ workspacePath: z.string().min(1).max(2000), commandId: z.string().min(1).max(100), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const cancelSchema = z.object({ workspacePath: z.string().min(1).max(2000), executionId: z.string().uuid() }).strict();
const executionSchema = z.object({
  id: z.string().uuid(), commandId: z.string(), kind: z.enum(['install', 'run', 'build', 'test', 'check']), name: z.string(), command: z.string(),
  configId: z.string().optional(), state: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'interrupted']), message: z.string(),
  startedAt: z.string(), finishedAt: z.string().optional(), exitCode: z.number().int().optional(), logs: z.string().max(70_000), logTruncated: z.boolean().optional(),
});
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
const commandFor = (config: LaunchConfig) => `${config.packageManager} run ${config.script}`;
const managerFor = (workspacePath: string, config: LaunchConfig) => `delivery-launch-${hash(JSON.stringify([workspacePath, config.id, config.script, config.packageManager, config.port]))}`;
const configKey = (config: LaunchConfig) => hash(JSON.stringify([config.id, config.script, config.packageManager, config.port, config.protocol]));
const bindingSchema = z.object({ configId: configSchema.shape.id, configKey: z.string().regex(/^[a-f0-9]{24}$/),
  port: configSchema.shape.port, protocol: configSchema.shape.protocol, manager: z.string().regex(/^delivery-launch-[a-f0-9]{24}$/),
  command: z.string().regex(/^(?:npm|pnpm|yarn) run [A-Za-z0-9][A-Za-z0-9:._-]{0,79}(?: --)?(?: --port \d{1,5}(?: --strictPort)?)?$/),
}).strict();
type Binding = z.infer<typeof bindingSchema>;

// Only recognize a static final framework invocation; never evaluate a project config or .env.
function frameworkCommand(command: string) {
  const final = command.split('&&').at(-1)!.trim();
  if (!final || /[;&|<>`$\n\r]/.test(final)) return;
  const tokens = final.match(/"[^"$`]*"|'[^']*'|[^\s]+/g)?.map(token => /^['"]/.test(token) ? token.slice(1, -1) : token) || [];
  if (tokens.some(token => !/^[A-Za-z0-9_./:@%+=,-]+$/.test(token))) return;
  let index = 0, environment = false;
  if (['cross-env', 'env'].includes(tokens[index])) index++;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] || '')) { environment = true; index++; }
  if (tokens[index] === 'npx') index++;
  else if (['npm', 'pnpm', 'yarn'].includes(tokens[index]) && tokens[index + 1] === 'exec') index += 2;
  if (/^(?:.*\/)?node(?:\.exe)?$/.test(tokens[index] || '')) index++;
  const binary = tokens[index++] || '';
  const framework = /(?:^|\/)vite(?:\.js)?$/.test(binary) ? 'vite'
    : /(?:^|\/)vue-cli-service(?:\.js)?$/.test(binary) ? 'vue-cli'
      : /(?:^|\/)uni(?:\.js)?$/.test(binary) ? 'uni' : undefined;
  if (!framework) return;
  const args = tokens.slice(index);
  if (framework === 'vue-cli' && args.shift() !== 'serve') return;
  if (framework === 'vite' && ['build', 'preview', 'optimize'].includes(args[0])) return;
  if (framework === 'vite' && ['serve', 'dev'].includes(args[0])) args.shift();
  if (framework === 'uni') {
    if (args[0] === 'dev') args.shift();
    // Uni only serves HTTP for H5 development. Build can follow options, too.
    if (args.some(arg => ['build', 'preview', 'serve'].includes(arg)) || args[0] && !args[0].startsWith('-')) return;
  }
  const identity: string[] = [];
  for (let i = 0; i < args.length; i++) {
    // Unlike Vite/vue-cli, Uni uses -p for the target platform, not the port.
    if (framework === 'uni' && /^(?:--platform(?:=|$)|-p)/.test(args[i])) {
      const flag = args[i], platform = ['--platform', '-p'].includes(flag) ? args[++i]
        : flag.replace(/^(?:--platform=|-p=?)/, '');
      if (!['h5', 'web'].includes(platform)) return;
      identity.push(flag);
      if (['--platform', '-p'].includes(flag)) identity.push(platform);
      continue;
    }
    if (['--port', '-p'].includes(args[i])) { if (!/^\d+$/.test(args[++i] || '')) return; continue; }
    if (/^(?:--port=|-p=?)\d+$/.test(args[i]) || args[i] === '--strictPort') continue;
    identity.push(args[i]);
  }
  const mode = /(?:^|\s)(?:--mode|-m)(?:=|\s+)([\w.-]+)(?:\s|$)/.exec(identity.join(' '))?.[1];
  return { framework, identity: JSON.stringify([framework, identity]), environment, mode };
}
function portCommand(config: LaunchConfig, body: string, port: number) {
  const framework = frameworkCommand(body);
  if (!framework) return;
  return `${commandFor(config)}${config.packageManager === 'npm' ? ' --' : ''} --port ${port}${framework.framework !== 'vue-cli' ? ' --strictPort' : ''}`;
}
const kindNames = { install: '安装依赖', run: '启动服务', build: '构建', test: '测试', check: '检查' };
const managedLogDivider = '\n--- 托管服务最近输出 ---\n';
type Saved = z.infer<typeof savedSchema>;
type Options = {
  root: string; dataDir: string; selfPort: number;
  scan?: typeof scanListeningPorts;
  execute?: typeof executePortAction;
  runCommand?: typeof runProjectCommand;
  readManagedLog?: typeof readManagedLaunchLog;
};

export function createProjectLaunch(directory: string, options: Options) {
  const locks = new Set<string>();
  const pending = new Map<string, { configId?: string; record: ProjectExecution; controller: AbortController; task: Promise<void> }>();
  const failures = new Map<string, string>();
  const histories = new Map<string, ProjectExecution[]>();
  const loadingHistories = new Map<string, Promise<ProjectExecution[]>>();
  const logBuffers = new Map<string, ReturnType<typeof createProjectLogBuffer>>();
  const preparations = new Set<Promise<unknown>>();
  const knownPaths = new Map<string, string>();
  const snapshotCache = new Map<string, LaunchSnapshot>();
  const runtimeBindings = new Map<string, Binding[]>();
  const loadingBindings = new Map<string, Promise<Binding[]>>();
  const reusedPorts = new Map<string, number>();
  let closed = false;
  const portOptions = { root: options.root, dataDir: options.dataDir, selfPort: options.selfPort };
  async function inspect(inputPath: string) {
    if (!path.isAbsolute(inputPath)) throw new Error('请选择本机项目的绝对路径');
    const workspacePath = await fs.realpath(inputPath).catch(() => { throw new Error('项目目录不存在'); });
    if (!(await fs.stat(workspacePath)).isDirectory()) throw new Error('请选择有效的项目目录');
    const discovered = await discoverProject(workspacePath);
    const defaults: Saved = { workspacePath, revision: 0, configs: discovered.defaultConfigs };
    const file = path.join(directory, `${hash(workspacePath)}.json`);
    let saved = defaults;
    try { saved = savedSchema.parse(JSON.parse(await fs.readFile(file, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('启动配置无法读取，请检查本机配置文件'); }
    if (saved.workspacePath !== workspacePath) throw new Error('启动配置的项目目录不匹配');
    knownPaths.set(inputPath, workspacePath);
    return { ...discovered, workspacePath, saved, file };
  }
  const historyFile = (workspacePath: string) => path.join(directory, `${hash(workspacePath)}.runs.json`);
  const runtimeFile = (workspacePath: string) => path.join(directory, `${hash(workspacePath)}.runtime.json`);
  async function bindings(workspacePath: string): Promise<Binding[]> {
    const cached = runtimeBindings.get(workspacePath); if (cached) return cached;
    const loading = loadingBindings.get(workspacePath); if (loading) return loading;
    const task = (async () => {
      let values: Binding[] = [];
      try {
        const value = z.object({ workspacePath: z.string(), bindings: z.array(bindingSchema).max(50) }).strict()
          .parse(JSON.parse(await fs.readFile(runtimeFile(workspacePath), 'utf8')));
        if (value.workspacePath !== workspacePath || new Set(value.bindings.map(item => item.configId)).size !== value.bindings.length) throw new Error('归属不匹配');
        values = value.bindings;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('项目运行端口记录无法核对，请检查本机运行记录'); }
      runtimeBindings.set(workspacePath, values); return values;
    })();
    loadingBindings.set(workspacePath, task);
    try { return await task; } finally { loadingBindings.delete(workspacePath); }
  }
  async function bindingFor(workspacePath: string, config: LaunchConfig): Promise<Binding> {
    const recorded = (await bindings(workspacePath)).find(item => item.configId === config.id);
    if (recorded) {
      const portArgs = `${commandFor(config)}${config.packageManager === 'npm' ? ' --' : ''} --port ${recorded.port}`;
      if (recorded.configKey !== configKey(config) || recorded.protocol !== config.protocol
        || recorded.manager !== managerFor(workspacePath, { ...config, port: recorded.port })
        || ![commandFor(config), portArgs, `${portArgs} --strictPort`].includes(recorded.command))
        throw new Error('项目运行记录与启动配置不匹配，请先核对原服务');
      return recorded;
    }
    return { configId: config.id, configKey: configKey(config), port: config.port, protocol: config.protocol,
      manager: managerFor(workspacePath, config), command: commandFor(config) };
  }
  async function saveBinding(workspacePath: string, binding: Binding | undefined, configId: string) {
    const next = (await bindings(workspacePath)).filter(item => item.configId !== configId);
    if (binding) next.push(bindingSchema.parse(binding));
    await write(runtimeFile(workspacePath), { workspacePath, bindings: next });
    runtimeBindings.set(workspacePath, next);
  }
  async function history(workspacePath: string) {
    const existing = histories.get(workspacePath);
    if (existing) return existing;
    const loading = loadingHistories.get(workspacePath);
    if (loading) return loading;
    const task = loadHistory(workspacePath);
    loadingHistories.set(workspacePath, task);
    try { return await task; } finally { loadingHistories.delete(workspacePath); }
  }
  async function loadHistory(workspacePath: string) {
    let records: ProjectExecution[] = [];
    try { records = z.array(executionSchema).max(10).parse(JSON.parse(await fs.readFile(historyFile(workspacePath), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('项目执行记录无法读取，请检查本机记录文件'); }
    for (const record of records) {
      record.logs = redactProjectOutput(record.logs);
      if (record.state === 'running') {
        record.state = 'interrupted'; record.finishedAt = new Date().toISOString();
        record.message = '工作台已重新启动，上次指令的完成结果未知，请先核对实际进程';
      }
    }
    histories.set(workspacePath, records);
    return records;
  }
  async function persistHistory(workspacePath: string) { await write(historyFile(workspacePath), await history(workspacePath)); }
  function appendLog(record: ProjectExecution, chunk: string, flush = false) {
    let buffer = logBuffers.get(record.id);
    if (!buffer) { buffer = createProjectLogBuffer(64_000); buffer.append(record.logs); logBuffers.set(record.id, buffer); }
    record.logs = flush ? buffer.flush() : buffer.append(chunk);
    if (buffer.truncated()) record.logTruncated = true;
  }
  async function begin(workspacePath: string, command: ProjectCommand) {
    const records = await history(workspacePath);
    const record: ProjectExecution = { id: randomUUID(), commandId: command.id, kind: command.kind, name: command.name, command: command.command,
      ...(command.configId ? { configId: command.configId } : {}), state: 'running', message: `正在${kindNames[command.kind]}`,
      startedAt: new Date().toISOString(), logs: `$ ${command.command}\n` };
    records.unshift(record); records.splice(10);
    try { await persistHistory(workspacePath); }
    catch { records.splice(records.indexOf(record), 1); throw new Error('无法保存执行记录，本次指令未启动'); }
    return record;
  }
  async function managedLogs(workspacePath: string, record: ProjectExecution, config: LaunchConfig) {
    const binding = await bindingFor(workspacePath, config);
    const log = await (options.readManagedLog || readManagedLaunchLog)({ workspacePath, manager: binding.manager, command: binding.command }).catch(() => '');
    if (log) {
      const text = redactProjectOutput(record.logs.split(managedLogDivider)[0] + managedLogDivider + log);
      record.logs = text.slice(-64_000); if (text.length > 64_000) record.logTruncated = true;
    }
  }
  async function finish(workspacePath: string, record: ProjectExecution) {
    if (record.kind !== 'run') appendLog(record, '', true); logBuffers.delete(record.id);
    record.finishedAt = new Date().toISOString();
    try { await persistHistory(workspacePath); }
    catch { record.message += '；执行记录未能保存到磁盘，请保留当前结果'; }
  }
  async function scan(configs: LaunchConfig[], workspacePath: string) {
    const current = await bindings(workspacePath);
    return (options.scan || scanListeningPorts)([...new Set([...configs.map(config => config.port),
      ...current.map(binding => binding.port), ...configs.flatMap(config => reusedPorts.get(`${workspacePath}:${config.id}`) || [])])], portOptions);
  }
  async function owned(entry: PortListener | PortStoppedService, workspacePath: string, config: LaunchConfig) {
    const binding = await bindingFor(workspacePath, config);
    return entry.manager === binding.manager
      && entry.launchCommand === `/bin/zsh -lc ${binding.command}`
      && await fs.realpath(entry.cwd).catch(() => '') === workspacePath;
  }
  async function reusable(entry: PortListener, workspacePath: string, config: LaunchConfig, body: string) {
    if (entry.port === options.selfPort || entry.manager.startsWith('delivery-launch-')
      || await fs.realpath(entry.cwd).catch(() => '') !== workspacePath) return false;
    // An exact lifecycle invocation proves the selected script. Otherwise require an
    // unambiguous framework invocation, including the literal mode (dev != development).
    const expected = frameworkCommand(body), actual = frameworkCommand(entry.command);
    if (expected?.mode && actual?.mode && expected.mode !== actual.mode) return false;
    if ([entry.command, entry.launchCommand].some(value => value === commandFor(config) || value === `/bin/zsh -lc ${commandFor(config)}`)) return true;
    return !!expected && !!actual && !expected.environment && !actual.environment
      && (!!expected.mode || ['dev', 'start', 'serve'].includes(config.script)) && expected.identity === actual.identity;
  }
  async function reuseAt(workspacePath: string, config: LaunchConfig, ports: PortSnapshot, body: string) {
    for (const port of ports.ports) {
      if (port.listeners.length && (await Promise.all(port.listeners.map(entry => reusable(entry, workspacePath, config, body)))).every(Boolean)) return port.port;
    }
  }
  async function status(workspacePath: string, config: LaunchConfig, ports: PortSnapshot, body = ''): Promise<LaunchStatus> {
    const binding = await bindingFor(workspacePath, config);
    const listeners = ports.ports.find(item => item.port === binding.port)?.listeners || [];
    const own = await Promise.all(listeners.map(item => owned(item, workspacePath, config)));
    const base = { configId: config.id };
    const busy = pending.get(workspacePath);
    if (busy?.configId === config.id) return { ...base, state: 'starting', managed: true, port: binding.port,
      message: busy.controller.signal.aborted ? '正在停止本次启动' : `正在启动并等待端口 ${binding.port} 监听` };
    if (listeners.length && own.every(Boolean)) return { ...base, state: 'running', managed: true, port: binding.port,
      message: `端口 ${binding.port} 已由本配置进程监听${binding.port !== config.port ? `（配置端口 ${config.port} 已占用，已自动换端口）` : ''}`,
      url: `${binding.protocol}://localhost:${binding.port}/` };
    const externalPort = body && await reuseAt(workspacePath, config, ports, body);
    if (externalPort) return { ...base, state: 'running', managed: false, port: externalPort,
      message: `已复用端口 ${externalPort} 的相同项目与环境服务；原进程由其启动方管理`, url: `${config.protocol}://localhost:${externalPort}/` };
    if (listeners.length && own.some(value => !value)) return { ...base, state: 'conflict', managed: false, port: binding.port,
      message: `端口 ${binding.port} 已被其他配置或进程占用${frameworkCommand(body) ? '，执行时将自动选择可用端口' : '；当前启动脚本未识别到可安全覆盖端口的启动器'}` };
    const failure = failures.get(`${workspacePath}:${config.id}`);
    return failure ? { ...base, state: 'failed', message: failure } : { ...base, state: 'stopped', message: '未发现本配置的端口监听' };
  }
  async function snapshot(inputPath: string): Promise<LaunchSnapshot> {
    let project: Awaited<ReturnType<typeof inspect>>;
    try { project = await inspect(inputPath); }
    catch (error) {
      const workspacePath = knownPaths.get(inputPath) || inputPath, previous = snapshotCache.get(workspacePath);
      if (!previous) throw error;
      return { ...previous, commands: [], statuses: [], executions: (await history(workspacePath)).map(record => ({ ...record })),
        discoveryMessage: redactProjectOutput(error instanceof Error ? error.message : '项目配置无法读取') };
    }
    const ports = await scan(project.saved.configs, project.workspacePath);
    const statuses = await Promise.all(project.saved.configs.map(config => status(project.workspacePath, config, ports, project.scriptCommands[config.script])));
    const executions = await history(project.workspacePath);
    const seenConfigs = new Set<string>();
    for (const record of executions) {
      if (!record.configId || seenConfigs.has(record.configId)) continue;
      seenConfigs.add(record.configId);
      const config = project.saved.configs.find(item => item.id === record.configId);
      if (config && (record.state === 'running' || statuses.some(item => item.configId === config.id && item.state === 'running')))
        await managedLogs(project.workspacePath, record, config);
    }
    const result = { workspacePath: project.workspacePath, revision: project.saved.revision, packageManager: project.packageManager,
      scripts: project.scripts, configs: project.saved.configs, statuses, commands: projectCommands(project, project.saved.configs),
      detectedConfigs: project.defaultConfigs,
      executions: executions.map(record => ({ ...record })) };
    snapshotCache.set(project.workspacePath, result);
    return result;
  }
  async function write(file: string, value: unknown) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, file); }
    finally { await fs.rm(temporary, { force: true }); }
  }
  async function configure(raw: unknown) {
    const input = savedSchema.parse(raw), project = await inspect(input.workspacePath), workspacePath = project.workspacePath;
    if (closed) throw new Error('工作台正在关闭，请稍后重试');
    if (locks.has(workspacePath) || pending.has(workspacePath)) throw new Error('项目启动或配置操作进行中，请稍后重试');
    locks.add(workspacePath);
    try {
      const current = await inspect(workspacePath);
      if (current.saved.revision !== input.revision) throw new Error('启动配置已更新，请刷新后重新保存');
      if (new Set(input.configs.map(config => config.id)).size !== input.configs.length) throw new Error('启动配置编号重复');
      if (input.configs.some(config => !current.scripts.includes(config.script))) throw new Error('所选启动脚本已不存在，请重新选择');
      const ports = await scan(current.saved.configs, workspacePath);
      for (const config of current.saved.configs) {
        const next = input.configs.find(item => item.id === config.id);
        if (JSON.stringify(config) === JSON.stringify(next)) continue;
        const binding = await bindingFor(workspacePath, config);
        const listeners = ports.ports.flatMap(item => item.listeners).filter(item => item.manager === binding.manager);
        if (listeners.length) throw new Error('请先停止正在运行的配置，再修改或删除');
        // 手动在端口管理中停止的本功能服务仍可能保留；禁止静默遗留已改名配置。
        const stopped = ports.stopped?.find(item => item.manager === binding.manager);
        if (stopped) {
          if (!await owned(stopped, workspacePath, config)) throw new Error('已有同名服务的归属不匹配，请到端口管理核对');
          await (options.execute || executePortAction)({ action: 'delete', manager: stopped.manager, port: binding.port }, portOptions);
        }
        if ((await bindings(workspacePath)).some(item => item.configId === config.id)) await saveBinding(workspacePath, undefined, config.id);
        reusedPorts.delete(`${workspacePath}:${config.id}`);
      }
      await write(current.file, { workspacePath, revision: current.saved.revision + 1, configs: input.configs });
      for (const config of current.saved.configs) failures.delete(`${workspacePath}:${config.id}`);
    } finally { locks.delete(workspacePath); }
    return snapshot(workspacePath);
  }
  async function removeOwned(workspacePath: string, config: LaunchConfig) {
    const binding = await bindingFor(workspacePath, config), ports = await scan([config], workspacePath);
    let entries = [...ports.ports.flatMap(item => item.listeners), ...(ports.stopped || [])].filter(item => item.manager === binding.manager);
    if (!entries.length) {
      const all = await (options.scan || scanListeningPorts)([], portOptions);
      entries = [...all.ports.flatMap(item => item.listeners), ...(all.stopped || [])].filter(item => item.manager === binding.manager);
    }
    if (!entries.length) return;
    if (!(await Promise.all(entries.map(entry => owned(entry, workspacePath, config)))).every(Boolean)) throw new Error('服务归属与启动配置不匹配，未停止任何进程');
    await (options.execute || executePortAction)({ action: 'delete', manager: binding.manager, port: binding.port }, portOptions);
  }
  async function freePort(preferred: number, excluded: number[] = []) {
    const candidates = [preferred, ...Array.from({ length: 64 }, (_, index) => {
      const value = Math.max(1024, preferred + 1) + index;
      return value <= 65535 ? value : 49152 + index;
    })].filter(port => port !== options.selfPort && !excluded.includes(port));
    const ports = await (options.scan || scanListeningPorts)(candidates, portOptions);
    const selected = candidates.find(port => !ports.ports.find(item => item.port === port)?.listeners.length);
    if (!selected) throw new Error('配置端口及附近可用端口均被占用，请在启动设置中选择其他端口');
    return selected;
  }
  async function action(raw: unknown, expectedFingerprint?: string): Promise<LaunchSnapshot> {
    const input = actionSchema.parse(raw), project = await inspect(input.workspacePath), workspacePath = project.workspacePath;
    if (closed) throw new Error('工作台正在关闭，请稍后重试');
    const config = project.saved.configs.find(item => item.id === input.configId);
    if (!config) throw new Error('启动配置不存在，请刷新后重试');
    if (locks.has(workspacePath)) throw new Error('项目配置操作进行中，请稍后重试');
    const busy = pending.get(workspacePath);
    if (busy) {
      if (input.action === 'stop' && busy.configId === config.id) { busy.record.message = '正在停止本次启动'; busy.controller.abort(); return snapshot(workspacePath); }
      throw new Error('已有项目指令操作进行中');
    }
    if (input.action === 'start' && !project.scripts.includes(config.script)) throw new Error('项目启动脚本已不存在，请重新选择');
    if (input.action === 'start' && config.port === options.selfPort) throw new Error('不能使用当前工作台端口启动业务项目');
    locks.add(workspacePath);
    try {
      const latest = await inspect(workspacePath);
      if (latest.saved.revision !== project.saved.revision || JSON.stringify(latest.saved.configs.find(item => item.id === config.id)) !== JSON.stringify(config))
        throw new Error('启动配置已更新，请刷新后重试');
      const command = projectCommands(latest, latest.saved.configs).find(item => item.configId === config.id);
      if (input.action === 'start' && (!command || expectedFingerprint && command.fingerprint !== expectedFingerprint))
        throw new Error('项目指令已变化，请刷新后重新执行');
      const ports = await scan(project.saved.configs, workspacePath);
      const body = latest.scriptCommands[config.script] || '';
      const current = await status(workspacePath, config, ports, body);
      if (input.action === 'stop') {
        await removeOwned(workspacePath, config); failures.delete(`${workspacePath}:${config.id}`);
        await persistHistory(workspacePath);
      } else {
        if (current.state === 'running') return snapshot(workspacePath);
        let binding = await bindingFor(workspacePath, config);
        const conflictingOwner = ports.ports.flatMap(port => port.listeners).filter(entry => entry.manager === binding.manager);
        if (!(await Promise.all(conflictingOwner.map(entry => owned(entry, workspacePath, config)))).every(Boolean))
          throw new Error('已有同名服务占用端口且归属不匹配，未启动或停止任何进程');
        let stopped = ports.stopped?.find(entry => entry.manager === binding.manager);
        if (stopped && !await owned(stopped, workspacePath, config)) throw new Error('已有同名服务的归属不匹配，未启动');
        const external = await reuseAt(workspacePath, config, await (options.scan || scanListeningPorts)([], portOptions), body);
        if (external) { reusedPorts.set(`${workspacePath}:${config.id}`, external); return snapshot(workspacePath); }
        const adjustable = !!portCommand(config, body, config.port);
        if (current.state === 'conflict' && !adjustable) throw new Error(current.message);
        const actualPort = adjustable ? await freePort(config.port) : config.port;
        const next: Binding = { configId: config.id, configKey: configKey(config), port: actualPort, protocol: config.protocol,
          command: portCommand(config, body, actualPort) || commandFor(config), manager: managerFor(workspacePath, { ...config, port: actualPort }) };
        if (stopped && (binding.manager !== next.manager || binding.command !== next.command)) { await removeOwned(workspacePath, config); stopped = undefined; }
        // 首次启动时固定本次发现的配置，随后脚本删改仍保留停止入口。
        if (!latest.saved.revision) await write(latest.file, { ...latest.saved, revision: 1 });
        await saveBinding(workspacePath, next, config.id); binding = next;
        reusedPorts.delete(`${workspacePath}:${config.id}`);
        const controller = new AbortController();
        failures.delete(`${workspacePath}:${config.id}`);
        const record = await begin(workspacePath, { ...command!, command: binding.command });
        if (closed) controller.abort();
        record.message = `正在启动并等待端口 ${binding.port} 监听${binding.port !== config.port ? `；配置端口 ${config.port} 已占用` : ''}`;
        // 保持操作异步，页面可以在静态检查期间轮询状态或取消本次启动。
        const pendingEntry = { configId: config.id, record, controller, task: Promise.resolve() };
        pending.set(workspacePath, pendingEntry);
        pendingEntry.task = (async () => {
          try {
            const verified = await inspect(workspacePath);
            if (verified.workspacePath !== workspacePath) throw new Error('项目实际目录已变化，请重新选择工作区');
            if (!verified.scripts.includes(config.script)) throw new Error('项目启动脚本已不存在');
            if (projectCommands(verified, verified.saved.configs).find(item => item.configId === config.id)?.fingerprint !== command!.fingerprint)
              throw new Error('项目指令已变化，请刷新后重新执行');
            controller.signal.throwIfAborted();
            if (closed) throw new Error('工作台正在关闭，本次启动已取消');
            const attemptedPorts: number[] = [];
            for (let attempt = 0; ; attempt++) {
              controller.signal.throwIfAborted();
              try {
                await (options.execute || executePortAction)(stopped ? { action: 'start', manager: stopped.manager, port: binding.port }
                  : { action: 'create', cwd: workspacePath, command: binding.command, port: binding.port, usePm2: true, pm2Name: binding.manager },
                { ...portOptions, requestedPorts: [binding.port], startupTimeoutMs: 120_000, startupSignal: controller.signal });
                break;
              } catch (error) {
                // A different process can claim a scanned port before PM2 starts. Only retry
                // the explicit preflight conflict; unknown launch failures are not replayed.
                if (!adjustable || attempt >= 2 || controller.signal.aborted || !/^端口已被其他服务占用：/.test(error instanceof Error ? error.message : '')) throw error;
                if (stopped) { await removeOwned(workspacePath, config); stopped = undefined; }
                attemptedPorts.push(binding.port);
                const port = await freePort(config.port, attemptedPorts);
                binding = { ...binding, port, command: portCommand(config, body, port)!, manager: managerFor(workspacePath, { ...config, port }) };
                await saveBinding(workspacePath, binding, config.id);
                record.command = binding.command; appendLog(record, `端口被其他进程占用，改用 ${port}\n$ ${binding.command}\n`);
              }
            }
            const verifiedPorts = await scan([config], workspacePath);
            const listeners = verifiedPorts.ports.find(item => item.port === binding.port)?.listeners || [];
            if (!listeners.length || !(await Promise.all(listeners.map(entry => owned(entry, workspacePath, config)))).every(Boolean)) {
              await removeOwned(workspacePath, config);
              throw new Error(`未确认端口 ${binding.port} 由本次配置进程监听，未提供运行地址`);
            }
            if (controller.signal.aborted) await removeOwned(workspacePath, config);
            record.state = controller.signal.aborted ? 'cancelled' : 'succeeded';
            record.message = controller.signal.aborted ? '本次启动已取消' : `启动完成，端口 ${binding.port} 已由本配置进程监听${binding.port !== config.port ? `（配置端口 ${config.port} 已占用）` : ''}`;
            await managedLogs(workspacePath, record, config);
          } catch (error) {
            record.state = controller.signal.aborted ? 'cancelled' : 'failed';
            record.message = controller.signal.aborted ? '本次启动已取消' : redactProjectOutput(error instanceof Error ? error.message : '项目启动失败');
            if (!controller.signal.aborted) failures.set(`${workspacePath}:${config.id}`, record.message);
            await managedLogs(workspacePath, record, config);
          } finally { await finish(workspacePath, record); pending.delete(workspacePath); }
        })();
      }
    } finally { locks.delete(workspacePath); }
    return snapshot(workspacePath);
  }
  async function execute(raw: unknown): Promise<LaunchSnapshot> {
    const input = executeSchema.parse(raw), project = await inspect(input.workspacePath), workspacePath = project.workspacePath;
    if (closed) throw new Error('工作台正在关闭，请稍后重试');
    const selected = projectCommands(project, project.saved.configs).find(command => command.id === input.commandId);
    if (!selected || selected.fingerprint !== input.fingerprint) throw new Error('项目指令已变化，请刷新后重新执行');
    if (selected.kind === 'run') return action({ workspacePath, configId: selected.configId, action: 'start' }, input.fingerprint);
    if (locks.has(workspacePath) || pending.has(workspacePath)) throw new Error('已有项目指令操作进行中');
    locks.add(workspacePath);
    try {
      const latest = await inspect(workspacePath);
      const command = projectCommands(latest, latest.saved.configs).find(item => item.id === input.commandId);
      if (latest.workspacePath !== workspacePath || !command || command.fingerprint !== input.fingerprint)
        throw new Error('项目指令已变化，请刷新后重新执行');
      const record = await begin(workspacePath, command), controller = new AbortController();
      if (closed) controller.abort();
      const entry = { record, controller, task: Promise.resolve() };
      pending.set(workspacePath, entry);
      entry.task = (async () => {
        try {
          const verified = await inspect(workspacePath);
          if (verified.workspacePath !== workspacePath || projectCommands(verified, verified.saved.configs).find(item => item.id === command.id)?.fingerprint !== command.fingerprint)
            throw new Error('项目指令已变化，请刷新后重新执行');
          controller.signal.throwIfAborted();
          if (closed) throw new Error('工作台正在关闭，本次指令已取消');
          const args = command.kind === 'install' ? verified.installArgs : ['run', command.script!];
          const result = await (options.runCommand || runProjectCommand)({ workspacePath, binary: verified.packageManager, args, signal: controller.signal,
            onOutput: text => appendLog(record, text), timeoutMs: 20 * 60_000 });
          if (result.exitCode !== null) record.exitCode = result.exitCode;
          record.state = result.cancelled || controller.signal.aborted ? 'cancelled' : result.exitCode === 0 && !result.timedOut ? 'succeeded' : 'failed';
          record.message = record.state === 'cancelled' ? `${kindNames[command.kind]}已取消`
            : result.timedOut ? `${kindNames[command.kind]}超时，已停止本次进程`
              : `${kindNames[command.kind]}${record.state === 'succeeded' ? '完成' : '失败'}${result.exitCode === null ? '' : `（退出码 ${result.exitCode}）`}`;
        } catch (error) {
          record.state = controller.signal.aborted ? 'cancelled' : 'failed';
          record.message = controller.signal.aborted ? '本次指令已取消' : redactProjectOutput(error instanceof Error ? error.message : '项目指令执行失败');
        } finally { await finish(workspacePath, record); pending.delete(workspacePath); }
      })();
    } finally { locks.delete(workspacePath); }
    return snapshot(workspacePath);
  }
  async function cancel(raw: unknown) {
    const input = cancelSchema.parse(raw);
    if (!path.isAbsolute(input.workspacePath)) throw new Error('请选择本机项目的绝对路径');
    const workspacePath = knownPaths.get(input.workspacePath) || await fs.realpath(input.workspacePath).catch(() => input.workspacePath);
    const entry = pending.get(workspacePath);
    if (!entry || entry.record.id !== input.executionId) throw new Error('该指令已结束或不属于当前项目，请刷新执行记录');
    entry.record.message = '正在取消本次指令并等待进程退出'; entry.controller.abort();
    return snapshot(workspacePath);
  }
  function mutate<T>(operation: () => Promise<T>) {
    if (closed) return Promise.reject(new Error('工作台正在关闭，请稍后重试'));
    const task = operation(); preparations.add(task);
    void task.then(() => preparations.delete(task), () => preparations.delete(task));
    return task;
  }
  return { snapshot, configure: (raw: unknown) => mutate(() => configure(raw)), action: (raw: unknown) => mutate(() => action(raw)),
    execute: (raw: unknown) => mutate(() => execute(raw)), cancel: (raw: unknown) => mutate(() => cancel(raw)),
    isBusy: () => pending.size > 0 || locks.size > 0 || preparations.size > 0,
    async close() {
      closed = true;
      for (const entry of pending.values()) entry.controller.abort();
      await Promise.allSettled([...preparations]);
      for (const entry of pending.values()) entry.controller.abort();
      await Promise.all([...pending.values()].map(entry => entry.task));
    },
  };
}

export function createProjectLaunchRoutes(service: ReturnType<typeof createProjectLaunch>, io: {
  json(response: ServerResponse, status: number, value: unknown): void;
  body(request: IncomingMessage, limit?: number): Promise<unknown>; port: number;
}) {
  const base = '/api/projects/launch';
  return async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
    if (![base, `${base}/action`, `${base}/execute`, `${base}/cancel`].includes(url.pathname)) return false;
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress || '')
      && [`localhost:${io.port}`, `127.0.0.1:${io.port}`].includes(request.headers.host || '');
    if (!local) { io.json(response, 403, { message: '请从本机工作台管理启动配置' }); return true; }
    try {
      if (url.pathname === base && request.method === 'GET') {
        io.json(response, 200, await service.snapshot(url.searchParams.get('path') || '')); return true;
      }
      if (!(url.pathname === base && request.method === 'PUT' || [`${base}/action`, `${base}/execute`, `${base}/cancel`].includes(url.pathname) && request.method === 'POST')) {
        io.json(response, 405, { message: '请求方法不支持' }); return true;
      }
      if (request.headers.origin !== `http://${request.headers.host}` || request.headers['x-delivery-confirmed'] !== 'yes') {
        io.json(response, 403, { message: '请从当前工作台发起启动配置操作' }); return true;
      }
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        io.json(response, 415, { message: '请发送 JSON' }); return true;
      }
      const input = await io.body(request, 32_000);
      io.json(response, 200, url.pathname === base ? await service.configure(input) : url.pathname.endsWith('/execute') ? await service.execute(input)
        : url.pathname.endsWith('/cancel') ? await service.cancel(input) : await service.action(input));
    } catch (error) { io.json(response, 400, { message: error instanceof z.ZodError ? '项目指令参数不正确，请检查后重试' : redactProjectOutput(error instanceof Error ? error.message : '项目指令操作失败') }); }
    return true;
  };
}
