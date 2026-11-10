import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createProjectLaunch, createProjectLaunchRoutes } from '../server/project-launch.js';
import { buildPortSnapshot } from '../server/port-monitor.js';
import type { PortActionRequest, PortListener } from '../shared/port-monitor.js';

const scripts = { dev: 'node server.js', 'dev:test': 'node server.js --mode test', 'dev:i18n-test': 'node server.js --mode i18n-test', 'dev:pre': 'node server.js --mode pre', 'dev:prod': 'node server.js --mode production', test: 'uni build', build: 'uni build', 'dev:deploy': 'publish' };
const listener = (cwd: string, manager = '', launchCommand = '', port = 5173): PortListener => ({ cwd, manager, launchCommand, port,
  pid: 12345, address: '127.0.0.1', scope: 'loopback', process: 'node', user: 'test', command: 'node server.js', service: '', mode: '' });

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'project-launch-')));
  const workspacePath = path.join(root, 'project'), directory = path.join(root, 'state');
  await fs.mkdir(workspacePath);
  await fs.writeFile(path.join(workspacePath, 'package.json'), JSON.stringify({ scripts }));
  await fs.writeFile(path.join(workspacePath, 'vite.config.js'), 'export default { plugins: [basicSsl()] }');
  let listeners: PortListener[] = [], hold = false, launchError = '';
  const calls: PortActionRequest[] = [];
  const options: Parameters<typeof createProjectLaunch>[1] = {
    root, dataDir: directory, selfPort: 5288,
    readManagedLog: async () => '',
    scan: async ports => buildPortSnapshot(listeners, ports),
    execute: async (input, options) => {
      calls.push(input);
      if (input.action === 'create') {
        if (hold) await new Promise<void>((resolve, reject) => {
          const signal = options?.startupSignal;
          if (signal?.aborted) { reject(signal.reason); return; }
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        if (launchError) throw new Error(launchError);
        options?.startupSignal?.throwIfAborted();
        listeners.push(listener(input.cwd!, input.pm2Name, `/bin/zsh -lc ${input.command}`, input.port));
      } else if (input.action === 'delete') listeners = listeners.filter(item => item.manager !== input.manager);
      return { ok: true, message: 'fixture-only' };
    },
  };
  const service = createProjectLaunch(directory, options);
  return { root, workspacePath, directory, options, service, calls,
    listeners: (value: PortListener[]) => { listeners = value; }, hold: () => { hold = true; }, fail: () => { launchError = '模拟启动失败'; },
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}
async function until(check: () => Promise<boolean>) {
  for (let index = 0; index < 50; index++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('启动状态未在预期时间内更新');
}

test('按项目脚本生成稳定配置，排除构建发布脚本，只读发现协议和包管理器', async () => {
  const f = await fixture();
  try {
    const first = await f.service.snapshot(f.workspacePath), again = await f.service.snapshot(f.workspacePath);
    assert.equal(first.revision, 0); assert.equal(first.packageManager, 'npm');
    assert.deepEqual(first.configs.map(item => item.name), ['开发', '测试', '国际化测试', '预发', '生产接口']);
    assert.deepEqual(first.configs, again.configs);
    assert.ok(first.configs.every(item => item.protocol === 'https' && item.port === 5173));
    await assert.rejects(fs.access(f.directory)); assert.equal(f.calls.length, 0);
    await fs.writeFile(path.join(f.workspacePath, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
    assert.equal((await f.service.snapshot(f.workspacePath)).packageManager, 'pnpm');
  } finally { await f.cleanup(); }
});

test('配置保存后重开可读，按真实目录隔离，旧版本和重复配置不会覆盖', async () => {
  const f = await fixture();
  try {
    const initial = await f.service.snapshot(f.workspacePath);
    const configs = initial.configs.map(config => ({ ...config, port: 5174 }));
    const saved = await f.service.configure({ workspacePath: f.workspacePath, revision: 0, configs });
    assert.equal(saved.revision, 1);
    const reloaded = createProjectLaunch(f.directory, f.options);
    assert.deepEqual((await reloaded.snapshot(f.workspacePath)).configs, configs);
    const linked = path.join(f.root, 'linked'); await fs.symlink(f.workspacePath, linked);
    assert.equal((await reloaded.snapshot(linked)).revision, 1);
    await assert.rejects(f.service.configure({ workspacePath: f.workspacePath, revision: 0, configs: [] }), /已更新/);
    await assert.rejects(f.service.configure({ workspacePath: f.workspacePath, revision: 1, configs: [configs[0], configs[0]] }), /重复/);
    const files = await fs.readdir(f.directory);
    assert.equal(files.length, 1); assert.equal((await fs.stat(path.join(f.directory, files[0]))).mode & 0o777, 0o600);
    const other = path.join(f.root, 'other'); await fs.mkdir(other); await fs.writeFile(path.join(other, 'package.json'), JSON.stringify({ scripts }));
    assert.equal((await reloaded.snapshot(other)).revision, 0);
  } finally { await f.cleanup(); }
});

test('保存校验脚本与参数，不允许任意命令或缺失脚本', async () => {
  const f = await fixture();
  try {
    const initial = await f.service.snapshot(f.workspacePath);
    for (const config of [
      { ...initial.configs[0], script: 'dev;touch-owned' }, { ...initial.configs[0], script: 'missing' },
      { ...initial.configs[0], command: 'arbitrary command' }, { ...initial.configs[0], port: 0 },
      { ...initial.configs[0], packageManager: 'npm;echo' },
    ]) await assert.rejects(f.service.configure({ workspacePath: f.workspacePath, revision: 0, configs: [config] }));
    assert.equal(f.calls.length, 0); assert.equal((await f.service.snapshot(f.workspacePath)).revision, 0);
  } finally { await f.cleanup(); }
});

test('同目录其他环境和陌生进程占端口时拒绝启动，不接管或停止它们', async () => {
  const f = await fixture();
  try {
    const initial = await f.service.snapshot(f.workspacePath);
    f.listeners([listener(f.workspacePath, 'foreign-manager')]);
    assert.ok((await f.service.snapshot(f.workspacePath)).statuses.every(item => item.state === 'conflict'));
    await assert.rejects(f.service.action({ workspacePath: f.workspacePath, configId: initial.configs[0].id, action: 'start' }), /占用/);
    await f.service.action({ workspacePath: f.workspacePath, configId: initial.configs[0].id, action: 'stop' });
    assert.equal(f.calls.length, 0);
  } finally { await f.cleanup(); }
});

test('启动和停止复用受控服务，仅选中配置运行，禁止运行时编辑，不重复启动', async () => {
  const f = await fixture();
  try {
    const initial = await f.service.snapshot(f.workspacePath), config = initial.configs[1];
    await f.service.action({ workspacePath: f.workspacePath, configId: config.id, action: 'start' });
    await until(async () => (await f.service.snapshot(f.workspacePath)).statuses[1].state === 'running');
    const running = await f.service.snapshot(f.workspacePath);
    assert.equal(running.statuses[1].url, 'https://localhost:5173/');
    assert.equal(running.statuses[0].state, 'conflict');
    assert.equal(f.calls[0].command, 'npm run dev:test'); assert.equal(f.calls[0].cwd, f.workspacePath);
    assert.equal(f.calls[0].usePm2, true);
    await f.service.action({ workspacePath: f.workspacePath, configId: config.id, action: 'start' });
    assert.equal(f.calls.length, 1);
    await assert.rejects(f.service.configure({ workspacePath: f.workspacePath, revision: running.revision, configs: [] }), /先停止/);
    await fs.writeFile(path.join(f.workspacePath, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }));
    await f.service.action({ workspacePath: f.workspacePath, configId: config.id, action: 'stop' });
    assert.equal(f.calls[1].action, 'delete');
    assert.ok((await f.service.snapshot(f.workspacePath)).statuses.every(item => item.state === 'stopped'));
  } finally { await f.cleanup(); }
});

test('启动期间可以取消，阻止配置和重复启动竞态，清理后不会恢复运行', async () => {
  const f = await fixture();
  try {
    f.hold(); const initial = await f.service.snapshot(f.workspacePath), config = initial.configs[0];
    const started = await f.service.action({ workspacePath: f.workspacePath, configId: config.id, action: 'start' });
    assert.equal(started.statuses[0].state, 'starting');
    await assert.rejects(f.service.configure({ workspacePath: f.workspacePath, revision: 0, configs: [] }), /进行中/);
    await assert.rejects(f.service.action({ workspacePath: f.workspacePath, configId: initial.configs[1].id, action: 'start' }), /进行中/);
    await f.service.action({ workspacePath: f.workspacePath, configId: config.id, action: 'stop' });
    await until(async () => !f.service.isBusy());
    assert.ok((await f.service.snapshot(f.workspacePath)).statuses.every(item => item.state === 'stopped'));
    assert.equal(f.calls.length, 1);
  } finally { await f.cleanup(); }
});

test('相同托管名称但目录或命令不匹配时，启动和停止均不接管服务', async () => {
  const f = await fixture();
  try {
    const initial = await f.service.snapshot(f.workspacePath), config = initial.configs[0];
    await f.service.action({ workspacePath: f.workspacePath, configId: config.id, action: 'start' });
    await until(async () => !f.service.isBusy());
    const created = f.calls[0];
    for (const entry of [listener(f.root, created.pm2Name, `/bin/zsh -lc ${created.command}`), listener(f.workspacePath, created.pm2Name, '/bin/zsh -lc unrelated')]) {
      f.listeners([entry]);
      await assert.rejects(f.service.action({ workspacePath: f.workspacePath, configId: config.id, action: 'start' }), /占用/);
      await assert.rejects(f.service.action({ workspacePath: f.workspacePath, configId: config.id, action: 'stop' }), /归属/);
    }
    assert.equal(f.calls.length, 1);
  } finally { await f.cleanup(); }
});

test('启动失败可回读，并在下次保存后清除；未确认监听不会给出运行地址', async () => {
  const f = await fixture();
  try {
    f.fail(); const initial = await f.service.snapshot(f.workspacePath);
    await f.service.action({ workspacePath: f.workspacePath, configId: initial.configs[0].id, action: 'start' });
    await until(async () => !f.service.isBusy());
    const failed = await f.service.snapshot(f.workspacePath);
    assert.equal(failed.statuses[0].state, 'failed'); assert.equal(failed.statuses[0].url, undefined);
    assert.match(failed.statuses[0].message, /模拟启动失败/);
    const saved = await f.service.configure({ workspacePath: f.workspacePath, revision: failed.revision, configs: initial.configs });
    assert.equal(saved.statuses[0].state, 'stopped');
  } finally { await f.cleanup(); }
});

test('已保存配置的脚本被删除时拒绝启动，但仍允许停止已有本配置服务', async () => {
  const f = await fixture();
  try {
    const initial = await f.service.snapshot(f.workspacePath), config = initial.configs[0];
    await f.service.configure({ workspacePath: f.workspacePath, revision: 0, configs: initial.configs });
    await f.service.action({ workspacePath: f.workspacePath, configId: config.id, action: 'start' });
    await until(async () => !f.service.isBusy());
    await fs.writeFile(path.join(f.workspacePath, 'package.json'), JSON.stringify({ scripts: {} }));
    await assert.rejects(f.service.action({ workspacePath: f.workspacePath, configId: config.id, action: 'start' }), /不存在/);
    await f.service.action({ workspacePath: f.workspacePath, configId: config.id, action: 'stop' });
    assert.equal(f.calls.at(-1)?.action, 'delete');
  } finally { await f.cleanup(); }
});

test('路由对读写核验本机来源，对写入核验同源确认头和 JSON', async () => {
  const f = await fixture();
  try {
    let payload: unknown = {}, reads = 0;
    const reply: { status: number; value: unknown } = { status: 0, value: undefined };
    const route = createProjectLaunchRoutes(f.service, { port: 5288, json: (_response, status, value) => { reply.status = status; reply.value = value; }, body: async () => { reads++; return payload; } });
    const response = {} as ServerResponse;
    const invoke = (method: string, extraHeaders: Record<string, string> = {}, remoteAddress = '127.0.0.1', pathname = '/api/projects/launch') => route({
      method, headers: { host: 'localhost:5288', origin: 'http://localhost:5288', 'x-delivery-confirmed': 'yes', 'content-type': 'application/json', ...extraHeaders }, socket: { remoteAddress },
    } as unknown as IncomingMessage, response, new URL(`http://localhost:5288${pathname}?path=${encodeURIComponent(f.workspacePath)}`));
    await invoke('GET'); assert.equal(reply.status, 200);
    await invoke('GET', {}, '192.168.1.3'); assert.equal(reply.status, 403);
    await invoke('PUT', { origin: 'https://foreign.example' }); assert.equal(reply.status, 403);
    await invoke('PUT', { 'x-delivery-confirmed': '' }); assert.equal(reply.status, 403);
    await invoke('PUT', { host: 'foreign.example' }); assert.equal(reply.status, 403);
    await invoke('PUT', { 'content-type': 'text/plain' }); assert.equal(reply.status, 415);
    assert.equal(reads, 0);
    payload = { workspacePath: f.workspacePath, revision: 0, configs: [] };
    await invoke('PUT'); assert.equal(reply.status, 200); assert.equal(reads, 1);
    await invoke('DELETE'); assert.equal(reply.status, 405);
    await invoke('POST', {}, '127.0.0.1', '/api/projects/launch/action'); assert.equal(reply.status, 400);
    const catalog = await f.service.snapshot(f.workspacePath), command = catalog.commands.find(item => item.kind === 'build')!;
    f.options.runCommand = async () => ({ exitCode: 0, cancelled: false, timedOut: false });
    payload = { workspacePath: f.workspacePath, commandId: command.id, fingerprint: command.fingerprint };
    await invoke('POST', { origin: 'https://foreign.example' }, '127.0.0.1', '/api/projects/launch/execute'); assert.equal(reply.status, 403);
    await invoke('POST', {}, '127.0.0.1', '/api/projects/launch/execute'); assert.equal(reply.status, 200);
    await until(async () => !f.service.isBusy());
    payload = { workspacePath: f.workspacePath, executionId: '11111111-1111-4111-8111-111111111111' };
    await invoke('POST', { 'x-delivery-confirmed': '' }, '127.0.0.1', '/api/projects/launch/cancel'); assert.equal(reply.status, 403);
    await invoke('POST', {}, '127.0.0.1', '/api/projects/launch/cancel'); assert.equal(reply.status, 400);
  } finally { await f.cleanup(); }
});

test('项目指令异步执行，回读进度和脱敏日志，成功记录在重开后保留', async () => {
  const f = await fixture();
  try {
    let release!: () => void;
    const calls: { binary: string; args: string[]; workspacePath: string }[] = [];
    f.options.runCommand = async input => {
      calls.push(input);
      input.onOutput('中文构建进度\nAPI_TOKEN=private-split');
      await new Promise<void>(resolve => { release = resolve; });
      input.onOutput('-secret\n构建完成\n');
      return { exitCode: 0, cancelled: false, timedOut: false };
    };
    const initial = await f.service.snapshot(f.workspacePath), command = initial.commands.find(item => item.id === 'script:build')!;
    assert.ok(command); assert.equal(command.command, 'npm run build');
    const running = await f.service.execute({ workspacePath: f.workspacePath, commandId: command.id, fingerprint: command.fingerprint });
    assert.equal(running.executions[0].state, 'running'); assert.equal(f.service.isBusy(), true);
    await until(async () => !!release);
    const progress = (await f.service.snapshot(f.workspacePath)).executions[0];
    assert.match(progress.logs, /中文构建进度/); assert.doesNotMatch(progress.logs, /private-split/);
    assert.equal(calls[0].binary, 'npm'); assert.deepEqual(calls[0].args, ['run', 'build']);
    assert.equal(calls[0].workspacePath, f.workspacePath);
    release(); await until(async () => !f.service.isBusy());
    const completed = (await f.service.snapshot(f.workspacePath)).executions[0];
    assert.equal(completed.state, 'succeeded'); assert.equal(completed.exitCode, 0);
    assert.match(completed.logs, /构建完成/); assert.doesNotMatch(completed.logs, /private-split-secret/);
    assert.ok(completed.finishedAt);
    const reopened = createProjectLaunch(f.directory, f.options);
    assert.deepEqual((await reopened.snapshot(f.workspacePath)).executions[0], completed);
    const historyFile = (await fs.readdir(f.directory)).find(name => name.endsWith('.runs.json'))!;
    assert.equal((await fs.stat(path.join(f.directory, historyFile))).mode & 0o777, 0o600);
  } finally { await f.cleanup(); }
});

test('失败退出和超时保留真实结果，单次执行互斥且取消只针对本项目记录', async () => {
  const f = await fixture();
  try {
    const initial = await f.service.snapshot(f.workspacePath), command = initial.commands.find(item => item.id === 'script:build')!;
    f.options.runCommand = async () => ({ exitCode: 7, cancelled: false, timedOut: false });
    await f.service.execute({ workspacePath: f.workspacePath, commandId: command.id, fingerprint: command.fingerprint });
    await until(async () => !f.service.isBusy());
    const failed = (await f.service.snapshot(f.workspacePath)).executions[0];
    assert.equal(failed.state, 'failed'); assert.equal(failed.exitCode, 7); assert.match(failed.message, /退出码 7/);
    f.options.runCommand = async input => {
      await new Promise<void>(resolve => { if (input.signal.aborted) resolve(); else input.signal.addEventListener('abort', () => resolve(), { once: true }); });
      return { exitCode: null, cancelled: true, timedOut: false };
    };
    const running = await f.service.execute({ workspacePath: f.workspacePath, commandId: command.id, fingerprint: command.fingerprint });
    await assert.rejects(f.service.execute({ workspacePath: f.workspacePath, commandId: command.id, fingerprint: command.fingerprint }), /进行中/);
    await assert.rejects(f.service.configure({ workspacePath: f.workspacePath, revision: initial.revision, configs: [] }), /进行中/);
    await assert.rejects(f.service.action({ workspacePath: f.workspacePath, configId: initial.configs[0].id, action: 'start' }), /进行中/);
    await assert.rejects(f.service.cancel({ workspacePath: f.workspacePath, executionId: failed.id }), /已结束|不属于/);
    await f.service.cancel({ workspacePath: f.workspacePath, executionId: running.executions[0].id });
    await until(async () => !f.service.isBusy());
    assert.equal((await f.service.snapshot(f.workspacePath)).executions[0].state, 'cancelled');
    f.options.runCommand = async () => ({ exitCode: null, cancelled: false, timedOut: true });
    await f.service.execute({ workspacePath: f.workspacePath, commandId: command.id, fingerprint: command.fingerprint });
    await until(async () => !f.service.isBusy());
    assert.match((await f.service.snapshot(f.workspacePath)).executions[0].message, /超时/);
  } finally { await f.cleanup(); }
});

test('指令目录不接受任意命令、过期脚本指纹及其他项目的执行记录', async () => {
  const f = await fixture();
  try {
    let calls = 0; f.options.runCommand = async () => { calls++; return { exitCode: 0, cancelled: false, timedOut: false }; };
    const first = await f.service.snapshot(f.workspacePath), command = first.commands.find(item => item.id === 'script:build')!;
    await assert.rejects(f.service.execute({ workspacePath: f.workspacePath, commandId: command.id, fingerprint: command.fingerprint, command: 'touch owned' }));
    await fs.writeFile(path.join(f.workspacePath, 'package.json'), JSON.stringify({ scripts: { ...scripts, build: 'node changed.js' } }));
    await assert.rejects(f.service.execute({ workspacePath: f.workspacePath, commandId: command.id, fingerprint: command.fingerprint }), /已变化/);
    await assert.rejects(f.service.execute({ workspacePath: f.workspacePath, commandId: 'script:deploy', fingerprint: command.fingerprint }), /已变化/);
    assert.equal(calls, 0);
    const other = path.join(f.root, 'other'); await fs.mkdir(other); await fs.writeFile(path.join(other, 'package.json'), JSON.stringify({ scripts }));
    assert.deepEqual((await f.service.snapshot(other)).executions, []);
    await assert.rejects(f.service.cancel({ workspacePath: other, executionId: '11111111-1111-4111-8111-111111111111' }), /已结束|不属于/);
  } finally { await f.cleanup(); }
});

test('安装指令匹配锁文件，不自动执行；关闭工作台时取消本次进程并保留记录', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.workspacePath, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
    let actual: Parameters<NonNullable<typeof f.options.runCommand>>[0] | undefined;
    f.options.runCommand = async input => {
      actual = input;
      await new Promise<void>(resolve => { if (input.signal.aborted) resolve(); else input.signal.addEventListener('abort', () => resolve(), { once: true }); });
      return { exitCode: null, cancelled: true, timedOut: false };
    };
    const first = await f.service.snapshot(f.workspacePath), command = first.commands.find(item => item.kind === 'install')!;
    assert.equal(actual, undefined); assert.equal(command.command, 'pnpm install --frozen-lockfile');
    await f.service.execute({ workspacePath: f.workspacePath, commandId: command.id, fingerprint: command.fingerprint });
    await until(async () => !!actual);
    assert.equal(actual!.binary, 'pnpm'); assert.deepEqual(actual!.args, ['install', '--frozen-lockfile']);
    await f.service.close(); assert.equal(f.service.isBusy(), false);
    const reopened = createProjectLaunch(f.directory, f.options);
    assert.equal((await reopened.snapshot(f.workspacePath)).executions[0].state, 'cancelled');
    await assert.rejects(f.service.execute({ workspacePath: f.workspacePath, commandId: command.id, fingerprint: command.fingerprint }), /正在关闭/);
  } finally { await f.cleanup(); }
});

test('已有运行配置经指令入口启动，结果和服务状态分开，配置名称与指令完整保留', async () => {
  const f = await fixture();
  try {
    const first = await f.service.snapshot(f.workspacePath), command = first.commands.find(item => item.kind === 'run')!;
    await f.service.execute({ workspacePath: f.workspacePath, commandId: command.id, fingerprint: command.fingerprint });
    await until(async () => !f.service.isBusy());
    const current = await f.service.snapshot(f.workspacePath);
    assert.equal(current.executions[0].state, 'succeeded');
    assert.equal(current.executions[0].configId, command.configId);
    assert.equal(current.statuses.find(item => item.configId === command.configId)!.state, 'running');
    assert.equal(current.executions[0].command, command.command);
    await f.service.action({ workspacePath: f.workspacePath, configId: command.configId, action: 'stop' });
    assert.equal((await f.service.snapshot(f.workspacePath)).executions[0].state, 'succeeded');
  } finally { await f.cleanup(); }
});

test('清单损坏后仍可取消已有指令，保留执行记录而不提供过期命令', async () => {
  const f = await fixture();
  try {
    let started = false;
    f.options.runCommand = async input => {
      started = true;
      await new Promise<void>(resolve => { if (input.signal.aborted) resolve(); else input.signal.addEventListener('abort', () => resolve(), { once: true }); });
      return { exitCode: null, cancelled: true, timedOut: false };
    };
    const first = await f.service.snapshot(f.workspacePath), command = first.commands.find(item => item.kind === 'build')!;
    const active = await f.service.execute({ workspacePath: f.workspacePath, commandId: command.id, fingerprint: command.fingerprint });
    await until(async () => started);
    await fs.writeFile(path.join(f.workspacePath, 'package.json'), '{');
    const cancelled = await f.service.cancel({ workspacePath: f.workspacePath, executionId: active.executions[0].id });
    assert.equal(cancelled.commands.length, 0); assert.equal(cancelled.statuses.length, 0); assert.match(cancelled.discoveryMessage!, /package.json/);
    await until(async () => !f.service.isBusy());
    assert.equal((await f.service.snapshot(f.workspacePath)).executions[0].state, 'cancelled');
  } finally { await f.cleanup(); }
});

test('关闭等待执行准备完成；准备时写盘被延迟也不会在关闭后新建进程', async () => {
  const f = await fixture();
  const originalWrite = fs.writeFile;
  let release!: () => void, announce!: () => void, calls = 0, closed = false;
  const ready = new Promise<void>(resolve => { announce = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
  try {
    f.options.runCommand = async () => { calls++; return { exitCode: 0, cancelled: false, timedOut: false }; };
    const initial = await f.service.snapshot(f.workspacePath), command = initial.commands.find(item => item.kind === 'build')!;
    let intercept = true;
    fs.writeFile = (async (...args: Parameters<typeof fs.writeFile>) => {
      if (intercept && String(args[0]).startsWith(f.directory) && String(args[0]).includes('.runs.json.')) {
        intercept = false; announce(); await hold;
      }
      return originalWrite(...args);
    }) as typeof fs.writeFile;
    const executing = f.service.execute({ workspacePath: f.workspacePath, commandId: command.id, fingerprint: command.fingerprint });
    await ready;
    assert.equal(f.service.isBusy(), true);
    const closing = f.service.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(closed, false); release();
    await Promise.all([closing, executing]);
    assert.equal(calls, 0); assert.equal(closed, true); assert.equal(f.service.isBusy(), false);
    assert.equal((await f.service.snapshot(f.workspacePath)).executions[0].state, 'cancelled');
  } finally { release?.(); fs.writeFile = originalWrite; await f.service.close(); await f.cleanup(); }
});

test('并发首次读取共用历史加载，执行记录不会被迟到空快照覆盖', async () => {
  const f = await fixture();
  const originalRead = fs.readFile;
  try {
    f.options.runCommand = async () => ({ exitCode: 0, cancelled: false, timedOut: false });
    const first = await f.service.snapshot(f.workspacePath), command = first.commands.find(item => item.kind === 'build')!;
    await f.service.execute({ workspacePath: f.workspacePath, commandId: command.id, fingerprint: command.fingerprint });
    await until(async () => !f.service.isBusy());
    const reloaded = createProjectLaunch(f.directory, f.options); let reads = 0;
    fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]).startsWith(f.directory) && String(args[0]).endsWith('.runs.json')) { reads++; await new Promise(resolve => setTimeout(resolve, 20)); }
      return originalRead(...args);
    }) as typeof fs.readFile;
    const snapshots = await Promise.all(Array.from({ length: 5 }, () => reloaded.snapshot(f.workspacePath)));
    assert.equal(reads, 1); assert.ok(snapshots.every(item => item.executions.length === 1 && item.executions[0].state === 'succeeded'));
  } finally { fs.readFile = originalRead; await f.cleanup(); }
});
