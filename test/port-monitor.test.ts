import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import {
  buildPortSnapshot,
  executePortAction,
  findManagedProcess,
  inferPortFromCommand,
  isProjectService,
  parseAllPm2Processes,
  parseLsofCwds,
  parseLsofListeners,
  parseManagedProcesses,
  parsePortList,
  parsePsProcesses,
} from '../server/port-monitor.js';

const service = { service: 'Node 服务', mode: '', manager: '', launchCommand: '', project: { name: '示例项目', workspacePath: '/tmp/a', branch: 'feature/demo' } };

test('解析 lsof 监听端口和 IPv6 地址', () => {
  const listeners = parseLsofListeners('p123\ncnode\nn127.0.0.1:5199\nf4\nn[::1]:5173\np456\ncpython\nn*:8080\n');
  assert.deepEqual(listeners, [
    { pid: 123, process: 'node', address: '127.0.0.1', port: 5199 },
    { pid: 123, process: 'node', address: '::1', port: 5173 },
    { pid: 456, process: 'python', address: '0.0.0.0', port: 8080 },
  ]);
});

test('解析进程、工作目录并隐藏常见命令行密钥参数', () => {
  const processes = parsePsProcesses(' 123 1 lzr node server.js --token abc123\n456 1 root python app.py API_KEY=secret\n');
  assert.equal(processes.get(123)?.command, 'node server.js --token [redacted]');
  assert.equal(processes.get(456)?.command, 'python app.py API_KEY=[redacted]');
  assert.deepEqual([...parseLsofCwds('p123\nfcwd\nn/tmp/demo\n')], [[123, '/tmp/demo']]);
});

test('端口过滤支持单个、列表、范围并限制输入规模', () => {
  assert.deepEqual(parsePortList('5199, 5173-5174 5199'), [5173, 5174, 5199]);
  assert.deepEqual(parsePortList(''), []);
  assert.throws(() => parsePortList('0'), /端口范围不正确/);
  assert.throws(() => parsePortList('5173-6000'), /最多检查/);
  assert.deepEqual(parsePortList('5199，5173-5174'), [5173, 5174, 5199]);
  assert.throws(() => parsePortList('1-300,301-600'), /最多检查/);
});

test('同一端口不同绑定地址保留为多个监听入口，未监听端口可被标记', () => {
  const snapshot = buildPortSnapshot([
    { ...service, port: 5199, address: '127.0.0.1', scope: 'loopback', pid: 1, process: 'node', user: 'lzr', command: 'node app', cwd: '/tmp/a' },
    { ...service, port: 5199, address: '172.16.88.50', scope: 'lan', pid: 2, process: 'node', user: 'lzr', command: 'node gateway', cwd: '/tmp/b' },
  ], [5173, 5199], '2026-10-23T00:00:00.000Z');
  assert.equal(snapshot.summary.listeningPorts, 1);
  assert.equal(snapshot.summary.listenerCount, 2);
  assert.equal(snapshot.ports[0].status, 'available');
  assert.equal(snapshot.ports[1].listeners.length, 2);
});

test('默认只展示项目服务，手动查端口仍保留非项目占用者', () => {
  const listener = { ...service, project: undefined, port: 4523, address: '0.0.0.0', scope: 'all' as const, pid: 20, process: 'Apifox', user: 'lzr', command: 'Apifox', cwd: '/' };
  assert.equal(buildPortSnapshot([listener]).ports.length, 0);
  const explicit = buildPortSnapshot([listener], [4523]);
  assert.equal(explicit.ports[0].status, 'listening');
  assert.equal(explicit.ports[0].listeners[0].process, 'Apifox');
  assert.equal(explicit.summary.projectCount, 0);
});

test('项目目录里的浏览器、自动化工具和全局 CLI 不冒充项目服务', () => {
  assert.equal(isProjectService('node', 'node /work/app/node_modules/vite/bin/vite.js'), true);
  assert.equal(isProjectService('Google Chrome', '/Applications/Google Chrome.app --remote-debugging-port=0'), false);
  assert.equal(isProjectService('agent-browser', '/opt/homebrew/lib/node_modules/agent-browser/bin/agent-browser'), false);
  assert.equal(isProjectService('node', 'node /opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'), false);
});

test('监听子进程按父链匹配 PM2，启动参数来自实际 PM2 配置', () => {
  const processes = parsePsProcesses('100 1 lzr npm run dev\n101 100 lzr sh -c vite\n102 101 lzr node vite.js\n');
  const managed = parseManagedProcesses(JSON.stringify([{ pid: 100, name: 'project-preview', pm2_env: { pm_exec_path: '/work/npm', args: ['run', 'dev', '--', '--mode', 'test'], SECRET: 'never-returned' } }]));
  assert.equal(findManagedProcess(102, processes, managed)?.name, 'project-preview');
  assert.deepEqual(managed.get(100)?.args, ['run', 'dev', '--', '--mode', 'test']);
  assert.equal(JSON.stringify([...managed.values()]).includes('never-returned'), false);
  const agentChild = parsePsProcesses('100 1 lzr node server/index.ts\n200 100 lzr /Applications/CodexCLI/codex app-server --stdio\n201 200 lzr node vite.js\n');
  assert.equal(findManagedProcess(201, agentChild, managed), undefined);
  const antigravityChild = parsePsProcesses('100 1 lzr node server/index.ts\n200 100 lzr /Users/demo/.local/bin/agy --print\n201 200 lzr node vite.js\n');
  assert.equal(findManagedProcess(201, antigravityChild, managed), undefined);
});

test('从命令参数与 PM2 名称推断端口，并汇总已停止与 PM2 托管服务', () => {
  assert.equal(inferPortFromCommand('vite --mode test --port 5185', 'apex-455-preview'), 5185);
  assert.equal(inferPortFromCommand('vite --mode pre', 'thor-admin-pre5177'), 5177);
  assert.equal(inferPortFromCommand('node serve.mjs', 'apex-mfe-demo-9e41'), 0);

  const allPm2 = parseAllPm2Processes(JSON.stringify([
    { pm_id: 1, pid: 1234, name: 'thor-admin-pre5177', pm2_env: { status: 'online', pm_exec_path: '/work/vite.js', pm_cwd: '/work' } },
    { pm_id: 8, pid: 0, name: 'apex-mfe-demo-9e41', pm2_env: { status: 'stopped', pm_exec_path: '/work/serve.mjs', pm_cwd: '/work' } },
  ]));
  assert.equal(allPm2.length, 2);
  assert.equal(allPm2[1].status, 'stopped');

  const snapshot = buildPortSnapshot(
    [{ ...service, manager: 'thor-admin-pre5177', port: 5177, address: '0.0.0.0', scope: 'all', pid: 1234, process: 'node', user: 'lzr', command: 'node vite', cwd: '/tmp/a' }],
    [],
    '2026-11-04T00:00:00.000Z',
    [{
      id: 'pm2:apex-mfe-demo-9e41',
      port: 7330,
      process: 'node',
      user: 'lzr',
      command: 'node serve.mjs',
      cwd: '/tmp/b',
      project: { name: 'BFF 项目', workspacePath: '/tmp/b', branch: 'main' },
      service: 'serve.mjs',
      mode: '',
      manager: 'apex-mfe-demo-9e41',
      launchCommand: 'node serve.mjs',
      state: 'stopped',
      pmId: 8,
    }],
    5288,
  );
  assert.equal(snapshot.summary.stoppedCount, 1);
  assert.equal(snapshot.summary.pm2Count, 2);
  assert.equal(snapshot.summary.projectCount, 2);
  assert.equal(snapshot.selfPort, 5288);
});


test('端口动作按真实监听归属预检并核验启动结果', async t => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-port-actions-')));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const stateFile = path.join(dir, 'fake-pm2.json');
  const logFile = path.join(dir, 'fake-pm2.log');
  const script = path.join(dir, 'server.mjs');
  await fs.writeFile(script, `import http from 'node:http';
import fs from 'node:fs';
const [port, marker, mode, secondaryPort, host = '127.0.0.1'] = process.argv.slice(2);
if (marker) fs.writeFileSync(marker, String(process.pid));
if (mode === 'exit') process.exit(1);
if (mode === 'idle') setInterval(() => {}, 1000);
else {
  const server = http.createServer((req, res) => res.end('port-action-fixture'));
  server.listen(Number(port), mode === 'foreign' ? host : '127.0.0.1', () => {
    if (mode === 'multi') {
      http.createServer((req, res) => res.end('secondary')).listen(Number(secondaryPort), host, () => process.send?.({ port: server.address().port }));
    } else process.send?.({ port: server.address().port });
  });
}
`);
  await fs.writeFile(path.join(bin, 'pm2'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const stateFile = process.env.PORT_ACTION_PM2_STATE;
const logFile = process.env.PORT_ACTION_PM2_LOG;
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
fs.appendFileSync(logFile, JSON.stringify(args) + '\\n');
if (args[0] === 'jlist') process.stdout.write(JSON.stringify(state.entries));
else if (state.fail) { process.stderr.write('fake PM2 action failed'); process.exit(1); }
else {
  if (args[0] === 'start' && state.launch) {
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, state.launch.args, { cwd: state.launch.cwd, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child.once('message', () => {
      state.entries = [{ name: state.launch.name, pid: child.pid, pm2_env: { status: 'online', pm_exec_path: state.launch.args[0], pm_cwd: state.launch.cwd, args: [] } }];
      fs.writeFileSync(stateFile, JSON.stringify(state));
      child.disconnect(); child.unref();
    });
    child.once('error', () => process.exit(1));
  }
  if (args[0] === 'start' && state.afterStart) state.entries = state.afterStart;
  if (args[0] === 'stop' || args[0] === 'delete') {
    for (const entry of state.entries.filter(item => item.name === args[1])) {
      if (state.killOnStop && entry.pid > 1) { try { process.kill(entry.pid, 'SIGTERM'); } catch {} }
      entry.pid = 0; entry.pm2_env.status = 'stopped';
    }
    if (args[0] === 'delete') state.entries = state.entries.filter(item => item.name !== args[1]);
  }
  fs.writeFileSync(stateFile, JSON.stringify(state));
}
`, { mode: 0o755 });
  const originalEnv = { PATH: process.env.PATH, PORT_ACTION_PM2_STATE: process.env.PORT_ACTION_PM2_STATE, PORT_ACTION_PM2_LOG: process.env.PORT_ACTION_PM2_LOG };
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  process.env.PORT_ACTION_PM2_STATE = stateFile;
  process.env.PORT_ACTION_PM2_LOG = logFile;
  const children: ChildProcess[] = [];
  const actionPids = new Set<number>();
  t.after(async () => {
    for (const child of children) child.kill('SIGTERM');
    for (const pid of actionPids) { try { process.kill(pid, 'SIGTERM'); } catch { /* already stopped */ } }
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
  const setup = async (entries: unknown[] = [], managerPorts = {}, extra = {}) => {
    await fs.writeFile(stateFile, JSON.stringify({ entries, ...extra }));
    await fs.writeFile(logFile, '');
    await fs.writeFile(path.join(dir, 'port-monitor-state.json'), JSON.stringify({ managerPorts, stoppedServices: [] }));
  };
  const pm2Entry = (name: string, pid: number, status = 'online') => ({ pid, name, pm2_env: { status, pm_exec_path: script, pm_cwd: dir, args: [] } });
  const mutations = async () => (await fs.readFile(logFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]).filter(args => args[0] !== 'jlist');
  const listen = async (port = 0, host = '127.0.0.1') => {
    const child = spawn(process.execPath, [script, String(port), '', 'foreign', '', host], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.push(child);
    const actualPort = await new Promise<number>((resolve, reject) => {
      child.once('message', message => resolve((message as { port: number }).port));
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`Fixture exited: ${code}`)));
    });
    return { pid: child.pid!, port: actualPort };
  };
  const freePort = async () => {
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return port;
  };
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = (port: number, marker: string, mode = '') => `exec ${quote(process.execPath)} ${quote(script)} ${port} ${quote(marker)} ${quote(mode)}`;
  const options = { dataDir: dir, root: dir };

  await t.test('显式非法端口不能降为未知端口绕过检查', async () => {
    await setup();
    for (const port of [0, -1, 65_536, 1.5, NaN]) {
      await assert.rejects(executePortAction({ action: 'create', port, cwd: dir, command: 'true', usePm2: false }, options), /端口号/);
    }
    assert.deepEqual(await mutations(), []);
  });

  await t.test('已有不同地址/进程的监听时，开启与新建均在执行命令前拒绝', async () => {
    const foreign = await listen();
    await setup([pm2Entry('stopped-target', 0, 'stopped')], { 'stopped-target': [foreign.port] });
    const marker = path.join(dir, 'must-not-launch');
    for (const action of ['start', 'create'] as const) {
      await assert.rejects(executePortAction({ action, port: foreign.port, cwd: dir, command: command(foreign.port, marker), usePm2: false }, options), /其他服务占用/);
    }
    await assert.rejects(executePortAction({ action: 'start', manager: 'stopped-target', port: foreign.port }, options), /其他服务占用/);
    await assert.rejects(fs.access(marker));
    assert.deepEqual(await mutations(), []);
    assert.equal(await (await fetch(`http://127.0.0.1:${foreign.port}`)).text(), 'port-action-fixture');
  });

  await t.test('重启多端口PM2服务时检查全部端口，同cwd的外部监听也不豁免，目标不会被停止', async () => {
    const target = await listen();
    const foreign = await listen();
    await setup([pm2Entry('multi-target', target.pid)], { 'multi-target': [target.port, foreign.port] });
    await assert.rejects(executePortAction({ action: 'restart', manager: 'multi-target', pid: target.pid, port: target.port }, options), /其他服务占用/);
    assert.deepEqual(await mutations(), []);
    assert.equal(await (await fetch(`http://127.0.0.1:${target.port}`)).text(), 'port-action-fixture');
  });

  await t.test('即使省略port和pid，也按真实PM2父链保护当前工作台', async () => {
    await setup([pm2Entry('current-workspace', process.pid)]);
    for (const action of ['stop', 'delete', 'restart'] as const) {
      await assert.rejects(executePortAction({ action, manager: 'current-workspace' }, options), /安全重启入口/);
    }
    assert.deepEqual(await mutations(), []);
  });

  await t.test('指定端口必须由本次spawn监听，并发请求只有一个启动成功', async () => {
    await setup();
    const port = await freePort();
    const marker = path.join(dir, 'standalone-pid');
    const req = { action: 'create' as const, port, cwd: dir, command: command(port, marker), usePm2: false };
    const results = await Promise.allSettled([executePortAction(req, { ...options, requestedPorts: [port] }), executePortAction(req, options)]);
    const pid = Number(await fs.readFile(marker, 'utf8'));
    actionPids.add(pid);
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
    const success = results.find(item => item.status === 'fulfilled');
    assert.ok(success?.status === 'fulfilled');
    assert.equal(success.value.snapshot?.ports[0]?.listeners[0]?.pid, pid);
    const failure = results.find(item => item.status === 'rejected');
    assert.ok(failure?.status === 'rejected' && /其他服务占用/.test(String(failure.reason)));
  });

  await t.test('退出和未监听的启动命令不会返回成功，超时目标会被清理', async () => {
    await setup();
    const port = await freePort();
    await assert.rejects(executePortAction({ action: 'create', port, cwd: dir, command: command(port, path.join(dir, 'exited-pid'), 'exit'), usePm2: false }, options), /已退出|超时/);
    const marker = path.join(dir, 'idle-pid');
    await assert.rejects(executePortAction({ action: 'create', port, cwd: dir, command: command(port, marker, 'idle'), usePm2: false }, options), /超时/);
    const pid = Number(await fs.readFile(marker, 'utf8'));
    actionPids.add(pid);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.throws(() => process.kill(pid, 0));
  });

  await t.test('未指定端口时核验本次目标的实际监听', async () => {
    await setup();
    const marker = path.join(dir, 'unknown-port-pid');
    const result = await executePortAction({ action: 'create', cwd: dir, command: command(0, marker), usePm2: false }, options);
    const pid = Number(await fs.readFile(marker, 'utf8'));
    actionPids.add(pid);
    assert.ok(result.snapshot?.ports.some(item => item.listeners.some(listener => listener.pid === pid)));
  });

  await t.test('PM2验证失败只回收本次启动目标；不会把其他PID的监听判为成功', async () => {
    const foreign = await listen();
    const failedTarget = await listen();
    const expected = await freePort();
    await setup([pm2Entry('failed-target', 0, 'stopped')], { 'failed-target': [expected] }, { afterStart: [pm2Entry('failed-target', failedTarget.pid)], killOnStop: true });
    await assert.rejects(executePortAction({ action: 'start', manager: 'failed-target', port: expected }, options), /超时/);
    assert.deepEqual((await mutations()).map(args => args[0]), ['start', 'stop']);
    assert.equal(await (await fetch(`http://127.0.0.1:${foreign.port}`)).text(), 'port-action-fixture');
  });

  await t.test('启动配置可取消PM2等待，并删除本次新建服务', async () => {
    const target = await listen(), expected = await freePort();
    await setup([], {}, { afterStart: [pm2Entry('cancel-start', target.pid)], killOnStop: true });
    const controller = new AbortController();
    const completion = assert.rejects(executePortAction({ action: 'create', pm2Name: 'cancel-start', port: expected, cwd: dir, command: 'fixture-launch', usePm2: true },
      { ...options, startupTimeoutMs: 120_000, startupSignal: controller.signal }), { name: 'AbortError' });
    for (let index = 0; index < 40 && !(await mutations()).some(args => args[0] === 'start'); index++) await new Promise(resolve => setTimeout(resolve, 25));
    controller.abort();
    await completion;
    assert.deepEqual((await mutations()).map(args => args[0]), ['start', 'delete']);
    assert.throws(() => process.kill(target.pid, 0));
  });

  await t.test('启动等待使用调用方配置的时限，超时仍只清理本次服务', async () => {
    const target = await listen(), expected = await freePort();
    await setup([], {}, { afterStart: [pm2Entry('custom-timeout', target.pid)], killOnStop: true });
    await assert.rejects(executePortAction({ action: 'create', pm2Name: 'custom-timeout', port: expected, cwd: dir, command: 'fixture-launch', usePm2: true },
      { ...options, startupTimeoutMs: 10 }), /超时/);
    assert.deepEqual((await mutations()).map(args => args[0]), ['start', 'delete']);
    assert.throws(() => process.kill(target.pid, 0));
  });

  await t.test('预期主端口正常时，额外端口的跨地址冲突也会失败并删除本次新建PM2目标', async () => {
    const foreign = await listen();
    const primary = await freePort();
    const marker = path.join(dir, 'secondary-conflict-pid');
    const secondaryHost = process.platform === 'darwin' ? '0.0.0.0' : '127.0.0.2';
    await setup([], {}, { launch: { name: 'secondary-conflict', cwd: dir, args: [script, String(primary), marker, 'multi', String(foreign.port), secondaryHost] }, killOnStop: true });
    await assert.rejects(executePortAction({ action: 'create', pm2Name: 'secondary-conflict', port: primary, cwd: dir, command: 'fixture-launch', usePm2: true }, options), /其他服务占用/);
    const pid = Number(await fs.readFile(marker, 'utf8'));
    actionPids.add(pid);
    assert.deepEqual((await mutations()).map(args => args[0]), ['start', 'delete']);
    assert.throws(() => process.kill(pid, 0));
    assert.equal(await (await fetch(`http://127.0.0.1:${foreign.port}`)).text(), 'port-action-fixture');
  });

  await t.test('关闭目标PID后仍保留另一同端口listener时，不误报关闭失败或停止对方', async () => {
    const target = await listen();
    const foreignHost = process.platform === 'darwin' ? '0.0.0.0' : '127.0.0.2';
    const foreign = await listen(target.port, foreignHost);
    await setup();
    const result = await executePortAction({ action: 'stop', pid: target.pid, port: target.port }, { ...options, requestedPorts: [target.port] });
    assert.equal(result.ok, true);
    assert.equal(result.snapshot?.ports[0]?.listeners.some(item => item.pid === foreign.pid), true);
    const address = foreignHost === '0.0.0.0' ? '127.0.0.1' : foreignHost;
    assert.equal(await (await fetch(`http://${address}:${foreign.port}`)).text(), 'port-action-fixture');
  });

  await t.test('PM2已errored时即使PID仍监听也不能返回启动成功', async () => {
    const target = await listen();
    await setup([pm2Entry('errored-target', target.pid)], { 'errored-target': [target.port] }, { afterStart: [pm2Entry('errored-target', target.pid, 'errored')] });
    await assert.rejects(executePortAction({ action: 'start', manager: 'errored-target', port: target.port }, options), /启动失败/);
    assert.deepEqual((await mutations()).map(args => args[0]), ['start']);
  });

  await t.test('PM2非零退出码不会被当成启动成功', async () => {
    const expected = await freePort();
    await setup([pm2Entry('command-failed', 0, 'stopped')], { 'command-failed': [expected] }, { fail: true });
    await assert.rejects(executePortAction({ action: 'start', manager: 'command-failed', port: expected }, options), /fake PM2 action failed/);
  });
});
