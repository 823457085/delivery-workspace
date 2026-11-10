import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { createRefactorProjects } from '../server/refactor-projects.js';
import { buildPortSnapshot } from '../server/port-monitor.js';
import type { PortListener } from '../shared/port-monitor.js';
import type { RefactorProject } from '../shared/refactor-projects.js';

function listener(port: number, cwd: string, pid = 101): PortListener {
  return { port, cwd, pid, address: '127.0.0.1', scope: 'loopback', process: 'node', user: 'fixture', command: '', service: '', mode: '', manager: '', launchCommand: '' };
}
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'refactor-projects-')));
  const directory = path.join(root, 'state');
  const calls: { command: string; args: string[]; cwd: string; shell: unknown }[] = [];
  let listeners: PortListener[] = [], failSpawn = false, killCount = 0;
  const projects: RefactorProject[] = [];
  async function project(name: string, port: number, dependencies: string[] = []) {
    const workspacePath = path.join(root, name); await fs.mkdir(workspacePath);
    await fs.writeFile(path.join(workspacePath, 'package.json'), JSON.stringify({ name, scripts: { dev: 'fixture-only', 'dev:test': 'fixture-only' } }));
    const value: RefactorProject = { id: randomUUID(), name, role: 'micro-app', workspacePath, baseUrl: `http://localhost:${port}/`, packageManager: 'pnpm', startScript: 'dev', dependencies };
    projects.push(value); return value;
  }
  const options: Parameters<typeof createRefactorProjects>[2] = {
    scanPorts: async ports => buildPortSnapshot(listeners, ports), probe: async () => true,
    startTimeoutMs: 100, pollIntervalMs: 1,
    spawn: (command, args, options) => {
      calls.push({ command, args, cwd: String(options.cwd), shell: options.shell });
      const child = Object.assign(new EventEmitter(), { pid: calls.length + 200, unref() {}, kill() { killCount += 1; return true; } });
      if (failSpawn) queueMicrotask(() => child.emit('error', new Error('raw-secret-do-not-publish')));
      else { const project = projects.find(item => item.workspacePath === options.cwd)!; listeners.push(listener(Number(new URL(project.baseUrl).port), project.workspacePath, child.pid)); }
      return child as unknown as ChildProcess;
    },
  };
  const service = await createRefactorProjects(root, directory, options);
  return { root, directory, service, calls, project, options, listeners: (value: PortListener[]) => { listeners = value; }, failSpawn: () => { failSpawn = true; }, killed: () => killCount,
    cleanup: async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); } };
}
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 40; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('项目状态未在预期时间内更新');
}

test('项目组空初始、保存与重启读取保持一致，乐观锁和真实目录去重保护已有配置', async () => {
  const f = await fixture();
  try {
    const initial = await f.service.snapshot(); assert.deepEqual(initial.projects, []);
    const p = await f.project('modern', 44301);
    const saved = await f.service.configure({ revision: initial.revision, projects: [p] });
    assert.notEqual(saved.revision, initial.revision); assert.equal(f.service.get(p.id)?.workspacePath, p.workspacePath);
    const copy = f.service.get(p.id)!; copy.name = 'must-not-mutate'; assert.equal(f.service.get(p.id)?.name, 'modern');
    assert.equal((await fs.stat(path.join(f.directory, 'projects.json'))).mode & 0o777, 0o600);
    await assert.rejects(f.service.configure({ revision: initial.revision, projects: [] }), /已更新/);
    const reopened = await createRefactorProjects(f.root, f.directory, f.options);
    assert.equal(reopened.list()[0].id, p.id); await reopened.close();
    const linked = path.join(f.root, 'linked'); await fs.symlink(p.workspacePath, linked);
    await assert.rejects(f.service.configure({ revision: saved.revision, projects: [p, { ...p, id: randomUUID(), workspacePath: linked, baseUrl: 'http://localhost:44302/' }] }), /真实项目目录不能重复/);
    assert.equal(f.service.list().length, 1);
  } finally { await f.cleanup(); }
});

test('保存前校验依赖缺失/循环、真实package script、独立端口与地址，不接受任意shell参数', async () => {
  const f = await fixture();
  try {
    const a = await f.project('a', 44303), b = await f.project('b', 44304), revision = (await f.service.snapshot()).revision;
    for (const projects of [
      [{ ...a, dependencies: [randomUUID()] }],
      [{ ...a, dependencies: [b.id] }, { ...b, dependencies: [a.id] }],
      [{ ...a, startScript: 'dev;touch-owned' }],
      [{ ...a, startScript: 'not-declared' }],
      [a, { ...b, baseUrl: a.baseUrl }],
      [{ ...a, baseUrl: 'http://user:private-password@localhost:44303/' }],
      [{ ...a, packageManager: 'pnpm;echo' as RefactorProject['packageManager'] }],
    ]) await assert.rejects(f.service.configure({ revision, projects }));
    assert.deepEqual(f.service.list(), []); assert.equal(f.calls.length, 0);
  } finally { await f.cleanup(); }
});

test('同端口只要包含其他cwd就冲突，不复用HTTP200、不重复启动或杀进程', async () => {
  const f = await fixture();
  try {
    const p = await f.project('modern', 44305);
    await f.service.configure({ revision: (await f.service.snapshot()).revision, projects: [p] });
    f.listeners([listener(44305, p.workspacePath), listener(44305, f.root, 102)]);
    assert.equal((await f.service.snapshot()).projects[0].state, 'conflict');
    await f.service.start({ projectIds: [p.id] });
    await until(async () => (await f.service.snapshot()).projects[0].state === 'conflict');
    await f.service.close(); assert.equal(f.calls.length, 0); assert.equal(f.killed(), 0);
  } finally { await f.cleanup(); }
});

test('依赖先就绪再启动主项目，仅传固定manager/run/script且已运行项目不重复启动', async () => {
  const f = await fixture();
  try {
    const child = await f.project('child', 44306), shell = await f.project('shell', 44307, [child.id]);
    await f.service.configure({ revision: (await f.service.snapshot()).revision, projects: [shell, child] });
    await f.service.start({ projectIds: [shell.id] });
    await until(async () => (await f.service.snapshot()).projects.every(project => project.state === 'running'));
    assert.deepEqual(f.calls.map(call => call.cwd), [child.workspacePath, shell.workspacePath]);
    assert.ok(f.calls.every(call => call.command === 'pnpm' && call.shell === false && JSON.stringify(call.args) === '["run","dev"]'));
    await f.service.close(); assert.equal(f.killed(), 0);
    const again = await createRefactorProjects(f.root, f.directory, f.options);
    await again.start({ projectIds: [shell.id] }); await again.close();
    assert.equal(f.calls.length, 2);
    const logs = await fs.readdir(path.join(f.directory, 'logs'));
    assert.equal(logs.length, 2); assert.equal((await fs.stat(path.join(f.directory, 'logs', logs[0]))).mode & 0o777, 0o600);
  } finally { await f.cleanup(); }
});

test('启动失败保留安全状态并阻止依赖项目派发，close不停止业务进程', async () => {
  const f = await fixture();
  try {
    const child = await f.project('child', 44308), shell = await f.project('shell', 44309, [child.id]);
    await f.service.configure({ revision: (await f.service.snapshot()).revision, projects: [shell, child] }); f.failSpawn();
    await f.service.start({ projectIds: [shell.id] });
    await until(async () => (await f.service.snapshot()).projects.every(project => project.state === 'failed'));
    const d = await f.service.snapshot(); assert.equal(f.calls.length, 1); assert.ok(!JSON.stringify(d).includes('raw-secret'));
    assert.match(d.projects.find(project => project.id === shell.id)!.message, /未启动/);
    await f.service.close(); assert.equal(f.killed(), 0);
  } finally { await f.cleanup(); }
});

test('端口冲突只阻止该项目及其依赖链，其他独立项目仍按已保存脚本启动', async () => {
  const f = await fixture();
  try {
    const blocked = await f.project('blocked', 44310), shell = await f.project('shell', 44311, [blocked.id]), independent = await f.project('independent', 44312);
    await f.service.configure({ revision: (await f.service.snapshot()).revision, projects: [shell, blocked, independent] });
    f.listeners([listener(44310, f.root)]);
    await f.service.start({ projectIds: [shell.id, independent.id] });
    await until(async () => (await f.service.snapshot()).projects.find(project => project.id === independent.id)?.state === 'running');
    const d = await f.service.snapshot();
    assert.equal(d.projects.find(project => project.id === blocked.id)?.state, 'conflict');
    assert.equal(d.projects.find(project => project.id === shell.id)?.state, 'failed');
    assert.deepEqual(f.calls.map(call => call.cwd), [independent.workspacePath]);
  } finally { await f.cleanup(); }
});
