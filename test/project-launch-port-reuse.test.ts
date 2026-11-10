import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProjectLaunch } from '../server/project-launch.js';
import { buildPortSnapshot } from '../server/port-monitor.js';
import type { PortActionRequest, PortListener } from '../shared/port-monitor.js';

const scripts = { dev: 'vite --port 7332 --mode development', 'dev:dev': 'vite --port 7332 --mode dev',
  'dev:test': 'vite --port 7332 --mode test', 'dev:pre': 'vite --port 7332 --mode pre' };
async function fixture(manager: 'npm' | 'pnpm' | 'yarn' = 'npm') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'launch-port-reuse-')));
  const workspacePath = path.join(root, 'project'), foreignPath = path.join(root, 'foreign'), directory = path.join(root, 'state');
  await fs.mkdir(workspacePath); await fs.mkdir(foreignPath);
  await fs.writeFile(path.join(workspacePath, 'package.json'), JSON.stringify({ scripts, packageManager: `${manager}@1.0.0` }));
  let pid = 5000, hold = false, race = false, absent = false;
  let listeners: PortListener[] = [];
  const calls: PortActionRequest[] = [];
  const listener = (cwd: string, port: number, command = 'node server.js', launchCommand = '', manager = ''): PortListener => ({
    port, address: '127.0.0.1', scope: 'loopback', pid: ++pid, process: 'node', user: 'fixture', cwd, command, launchCommand, manager,
    project: { name: path.basename(cwd), workspacePath: cwd, branch: '' }, service: '', mode: '',
  });
  const options: Parameters<typeof createProjectLaunch>[1] = { root, dataDir: directory, selfPort: 5288,
    scan: async ports => buildPortSnapshot(listeners, ports), readManagedLog: async () => '',
    execute: async (input, options) => {
      calls.push(input);
      if (input.action === 'create') {
        if (race) { race = false; listeners.push(listener(foreignPath, input.port!)); throw new Error('端口已被其他服务占用：模拟启动前竞争'); }
        if (hold) await new Promise<void>((_resolve, reject) => {
          if (options?.startupSignal?.aborted) reject(options.startupSignal.reason);
          else options?.startupSignal?.addEventListener('abort', () => reject(options.startupSignal!.reason), { once: true });
        });
        options?.startupSignal?.throwIfAborted();
        if (!absent) listeners.push(listener(input.cwd!, input.port!, 'node /fixture/node_modules/vite/bin/vite.js --mode dev', `/bin/zsh -lc ${input.command}`, input.pm2Name));
      } else if (input.action === 'delete') listeners = listeners.filter(entry => entry.manager !== input.manager);
      return { ok: true, message: 'fixture only' };
    },
  };
  const service = createProjectLaunch(directory, options);
  return { root, workspacePath, foreignPath, directory, options, service, calls, listener,
    add: (...values: PortListener[]) => listeners.push(...values), listeners: () => listeners,
    hold: () => { hold = true; }, race: () => { race = true; }, absent: () => { absent = true; },
    close: async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); },
  };
}
async function idle(service: ReturnType<typeof createProjectLaunch>) {
  for (let index = 0; index < 300; index++) { if (!service.isBusy()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('启动未结束');
}

for (const packageManager of ['npm', 'pnpm', 'yarn'] as const) test(`${packageManager} 在异项目占用7332时实际传入新端口，重载后仅停止自己的服务`, async () => {
  const f = await fixture(packageManager);
  try {
    const foreign = f.listener(f.foreignPath, 7332); f.add(foreign);
    const first = await f.service.snapshot(f.workspacePath), config = first.configs.find(item => item.script === 'dev:dev')!;
    const command = first.commands.find(item => item.configId === config.id)!;
    await f.service.execute({ workspacePath: f.workspacePath, commandId: command.id, fingerprint: command.fingerprint }); await idle(f.service);
    const running = await f.service.snapshot(f.workspacePath), status = running.statuses.find(item => item.configId === config.id)!;
    assert.deepEqual([status.state, status.managed, status.port, status.url], ['running', true, 7333, 'http://localhost:7333/']);
    assert.equal(f.calls[0].command, `${packageManager} run dev:dev${packageManager === 'npm' ? ' --' : ''} --port 7333 --strictPort`);
    assert.equal(running.executions[0].command, f.calls[0].command); assert.equal(running.executions[0].state, 'succeeded');
    assert.equal(running.configs.find(item => item.id === config.id)!.port, 7332, '不能改写用户配置');
    const files = await fs.readdir(f.directory), runtimeFile = path.join(f.directory, files.find(name => name.endsWith('.runtime.json'))!);
    const stored = JSON.parse(await fs.readFile(runtimeFile, 'utf8'));
    assert.equal(stored.bindings[0].port, 7333); assert.equal(stored.bindings[0].command, f.calls[0].command);
    assert.equal((await fs.stat(runtimeFile)).mode & 0o777, 0o600);
    const reopened = createProjectLaunch(f.directory, f.options);
    assert.equal((await reopened.snapshot(f.workspacePath)).statuses.find(item => item.configId === config.id)!.managed, true);
    await fs.writeFile(path.join(f.workspacePath, 'package.json'), JSON.stringify({ scripts: {} }));
    await reopened.action({ workspacePath: f.workspacePath, configId: config.id, action: 'stop' });
    assert.equal(f.calls.at(-1)!.manager, f.calls[0].pm2Name); assert.equal(f.calls.at(-1)!.port, 7333);
    assert.deepEqual(f.listeners(), [foreign]); await reopened.close();
  } finally { await f.close(); }
});

test('相同真实目录及精确mode的现有服务只复用，不新建或接管停止', async () => {
  const f = await fixture();
  try {
    const alias = path.join(f.root, 'alias'); await fs.symlink(f.workspacePath, alias);
    const external = f.listener(alias, 7332, 'node /fixture/node_modules/vite/bin/vite.js --port 7332 --mode dev', '', 'external-project'); f.add(external);
    const first = await f.service.snapshot(f.workspacePath), config = first.configs.find(item => item.script === 'dev:dev')!;
    const status = first.statuses.find(item => item.configId === config.id)!;
    assert.deepEqual([status.state, status.managed, status.port], ['running', false, 7332]);
    await f.service.action({ workspacePath: f.workspacePath, configId: config.id, action: 'start' });
    const after = await f.service.action({ workspacePath: f.workspacePath, configId: config.id, action: 'stop' });
    assert.equal(after.statuses.find(item => item.configId === config.id)!.state, 'running');
    assert.equal(f.calls.length, 0); assert.deepEqual(f.listeners(), [external]);
  } finally { await f.close(); }
});

test('同项目development不能冒充dev，无法确认的进程及不同config也不复用', async () => {
  for (const processCommand of ['node /fixture/node_modules/vite/bin/vite.js --port 7332 --mode development',
    'node server.js', 'node /fixture/node_modules/vite/bin/vite.js --mode dev --config other.config.ts']) {
    const f = await fixture();
    try {
      const external = f.listener(f.workspacePath, 7332, processCommand); f.add(external);
      const first = await f.service.snapshot(f.workspacePath), config = first.configs.find(item => item.script === 'dev:dev')!;
      assert.equal(first.statuses.find(item => item.configId === config.id)!.state, 'conflict');
      await f.service.action({ workspacePath: f.workspacePath, configId: config.id, action: 'start' }); await idle(f.service);
      assert.equal((await f.service.snapshot(f.workspacePath)).statuses.find(item => item.configId === config.id)!.port, 7333);
      await f.service.action({ workspacePath: f.workspacePath, configId: config.id, action: 'stop' }); assert.deepEqual(f.listeners(), [external]);
    } finally { await f.close(); }
  }
});

test('精确脚本的外部服务运行在其他端口时发现并打开，不能删除外部PM2服务', async () => {
  const f = await fixture();
  try {
    const external = f.listener(f.workspacePath, 7410, 'node app.js', '/bin/zsh -lc npm run dev:test', 'user-service'); f.add(external);
    const first = await f.service.snapshot(f.workspacePath), config = first.configs.find(item => item.script === 'dev:test')!;
    const reused = await f.service.action({ workspacePath: f.workspacePath, configId: config.id, action: 'start' });
    assert.deepEqual(reused.statuses.find(item => item.configId === config.id)!.url, 'http://localhost:7410/');
    assert.equal(reused.statuses.find(item => item.configId === config.id)!.managed, false);
    await f.service.action({ workspacePath: f.workspacePath, configId: config.id, action: 'stop' });
    assert.equal(f.calls.length, 0); assert.deepEqual(f.listeners(), [external]);
  } finally { await f.close(); }
});

test('扫描后端口被抢占时有限重选，仅停止最终归属匹配的服务', async () => {
  const f = await fixture();
  try {
    f.add(f.listener(f.foreignPath, 7332)); f.race();
    const first = await f.service.snapshot(f.workspacePath), config = first.configs.find(item => item.script === 'dev:dev')!;
    await f.service.action({ workspacePath: f.workspacePath, configId: config.id, action: 'start' }); await idle(f.service);
    const final = await f.service.snapshot(f.workspacePath), status = final.statuses.find(item => item.configId === config.id)!;
    assert.equal(status.port, 7334); assert.equal(status.state, 'running'); assert.equal(f.calls.filter(item => item.action === 'create').length, 2);
    assert.match(final.executions[0].logs, /端口被其他进程占用，改用 7334/);
    await f.service.action({ workspacePath: f.workspacePath, configId: config.id, action: 'stop' });
    assert.deepEqual(f.listeners().map(item => item.port), [7332, 7333]);
  } finally { await f.close(); }
});

test('新端口启动期间可取消，配置锁仍有效，未确认监听不能报成功', async () => {
  for (const cancel of [true, false]) {
    const f = await fixture();
    try {
      f.add(f.listener(f.foreignPath, 7332)); if (cancel) f.hold(); else f.absent();
      const first = await f.service.snapshot(f.workspacePath), config = first.configs.find(item => item.script === 'dev:dev')!;
      await f.service.action({ workspacePath: f.workspacePath, configId: config.id, action: 'start' });
      if (cancel) {
        await assert.rejects(f.service.configure({ workspacePath: f.workspacePath, revision: 1, configs: first.configs }), /进行中/);
        await f.service.action({ workspacePath: f.workspacePath, configId: config.id, action: 'stop' });
      }
      await idle(f.service);
      const final = await f.service.snapshot(f.workspacePath), status = final.statuses.find(item => item.configId === config.id)!;
      assert.equal(final.executions[0].state, cancel ? 'cancelled' : 'failed'); assert.equal(status.url, undefined);
      if (!cancel) assert.match(status.message, /未确认端口 7333/);
      assert.equal(f.listeners().length, 1);
    } finally { await f.close(); }
  }
});

test('vue-cli明确支持port参数，未知启动器保持具体占用错误且不执行', async () => {
  for (const body of ['vue-cli-service serve --mode test --port 7332', 'node server.js --port 7332']) {
    const f = await fixture();
    try {
      await fs.writeFile(path.join(f.workspacePath, 'package.json'), JSON.stringify({ scripts: { 'dev:test': body } }));
      f.add(f.listener(f.foreignPath, 7332)); const first = await f.service.snapshot(f.workspacePath), config = first.configs[0];
      if (body.startsWith('node')) {
        await assert.rejects(f.service.action({ workspacePath: f.workspacePath, configId: config.id, action: 'start' }), /未识别到可安全覆盖端口/);
        assert.equal(f.calls.length, 0);
      } else {
        await f.service.action({ workspacePath: f.workspacePath, configId: config.id, action: 'start' }); await idle(f.service);
        assert.equal(f.calls[0].command, 'npm run dev:test -- --port 7333');
        assert.equal((await f.service.snapshot(f.workspacePath)).statuses[0].port, 7333);
      }
    } finally { await f.close(); }
  }
});

for (const packageManager of ['npm', 'pnpm', 'yarn'] as const) test(`${packageManager} 的Uni H5冲突换端口，重载及停止保留外部服务`, async () => {
  const f = await fixture(packageManager);
  try {
    await fs.writeFile(path.join(f.workspacePath, 'package.json'), JSON.stringify({
      scripts: { 'dev:i18n-test': 'uni --mode i18n-test' }, packageManager: `${packageManager}@1.0.0`,
    }));
    const foreign = f.listener(f.foreignPath, 5173); f.add(foreign);
    const first = await f.service.snapshot(f.workspacePath), config = first.configs[0];
    const command = first.commands.find(item => item.configId === config.id)!;
    await f.service.execute({ workspacePath: f.workspacePath, commandId: command.id, fingerprint: command.fingerprint }); await idle(f.service);
    const running = await f.service.snapshot(f.workspacePath), status = running.statuses[0];
    assert.deepEqual([status.state, status.managed, status.port, status.url], ['running', true, 5174, 'http://localhost:5174/']);
    assert.equal(f.calls[0].command, `${packageManager} run dev:i18n-test${packageManager === 'npm' ? ' --' : ''} --port 5174 --strictPort`);
    assert.equal(running.executions[0].state, 'succeeded'); assert.equal(running.executions[0].command, f.calls[0].command);
    assert.equal(running.configs[0].port, 5173);
    const runtimeName = (await fs.readdir(f.directory)).find(name => name.endsWith('.runtime.json'))!;
    const stored = JSON.parse(await fs.readFile(path.join(f.directory, runtimeName), 'utf8'));
    assert.equal(stored.bindings[0].port, 5174); assert.equal(stored.bindings[0].command, f.calls[0].command);
    const reopened = createProjectLaunch(f.directory, f.options);
    try {
      const restored = (await reopened.snapshot(f.workspacePath)).statuses[0];
      assert.deepEqual([restored.state, restored.managed, restored.port], ['running', true, 5174]);
      await reopened.action({ workspacePath: f.workspacePath, configId: config.id, action: 'stop' });
      assert.equal(f.calls.at(-1)!.port, 5174); assert.equal(f.calls.at(-1)!.manager, f.calls[0].pm2Name);
      assert.deepEqual(f.listeners(), [foreign]);
    } finally { await reopened.close(); }
  } finally { await f.close(); }
});

test('Uni实际CLI进程只复用相同目录及精确模式，不接管外部服务', async () => {
  for (const mode of ['i18n-test', 'test']) {
    const f = await fixture();
    try {
      await fs.writeFile(path.join(f.workspacePath, 'package.json'), JSON.stringify({
        scripts: { 'dev:i18n-test': 'uni --mode i18n-test --port 7332' },
      }));
      const external = f.listener(f.workspacePath, 7332,
        `node /fixture/node_modules/@dcloudio/vite-plugin-uni/bin/uni.js --mode ${mode} --port 7332 --strictPort`, '', 'user-uni');
      f.add(external);
      const first = await f.service.snapshot(f.workspacePath), config = first.configs[0];
      assert.equal(first.statuses[0].state, mode === 'i18n-test' ? 'running' : 'conflict');
      assert.equal(first.statuses[0].managed, false);
      await f.service.action({ workspacePath: f.workspacePath, configId: config.id, action: 'start' }); await idle(f.service);
      const running = (await f.service.snapshot(f.workspacePath)).statuses[0];
      assert.equal(running.port, mode === 'i18n-test' ? 7332 : 7333);
      assert.equal(running.managed, mode !== 'i18n-test');
      await f.service.action({ workspacePath: f.workspacePath, configId: config.id, action: 'stop' });
      if (mode === 'i18n-test') assert.equal(f.calls.length, 0);
      assert.deepEqual(f.listeners(), [external]);
    } finally { await f.close(); }
  }
});

test('Uni显式H5平台及dev别名支持换端口，短参数p保持平台含义', async () => {
  for (const body of ['uni -p h5 --mode test --port 7332', 'uni --platform=web --mode test --port 7332',
    'uni dev --platform h5 --mode test --port 7332', 'node static-check.js && uni --mode test --port 7332']) {
    const f = await fixture();
    try {
      await fs.writeFile(path.join(f.workspacePath, 'package.json'), JSON.stringify({ scripts: { 'dev:test': body } }));
      const foreign = f.listener(f.foreignPath, 7332); f.add(foreign);
      const first = await f.service.snapshot(f.workspacePath), config = first.configs[0];
      await f.service.action({ workspacePath: f.workspacePath, configId: config.id, action: 'start' }); await idle(f.service);
      assert.equal(f.calls[0].command, 'npm run dev:test -- --port 7333 --strictPort');
      assert.equal((await f.service.snapshot(f.workspacePath)).statuses[0].port, 7333);
      await f.service.action({ workspacePath: f.workspacePath, configId: config.id, action: 'stop' });
      assert.deepEqual(f.listeners(), [foreign]);
    } finally { await f.close(); }
  }
});

test('Uni构建及非H5平台不自动覆盖端口，包括参数前置的build', async () => {
  for (const body of ['uni build --mode test --port 7332', 'uni --mode test build --port 7332',
    'uni --platform=mp-weixin --mode test --port 7332', 'uni -p app --mode test --port 7332']) {
    const f = await fixture();
    try {
      await fs.writeFile(path.join(f.workspacePath, 'package.json'), JSON.stringify({ scripts: { 'dev:test': body } }));
      const foreign = f.listener(f.foreignPath, 7332); f.add(foreign);
      const first = await f.service.snapshot(f.workspacePath), config = first.configs[0];
      assert.equal(first.statuses[0].state, 'conflict');
      assert.match(first.statuses[0].message, /未识别到可安全覆盖端口/);
      await assert.rejects(f.service.action({ workspacePath: f.workspacePath, configId: config.id, action: 'start' }),
        /未识别到可安全覆盖端口|项目指令已变化/);
      assert.equal(f.calls.length, 0); assert.deepEqual(f.listeners(), [foreign]);
    } finally { await f.close(); }
  }
});
