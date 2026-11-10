import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import type { AgentProvider, AgentRuntimeHealth } from '../shared/agent-runtime.js';

const health = (provider: AgentProvider): AgentRuntimeHealth => ({ provider, label: provider, binary: '/fixture', version: 'fixture',
  authenticated: true, ready: true, message: 'ready', modes: ['agent', 'ask', 'plan'],
  models: [{ id: '', label: 'default' }], defaultModel: '', writable: true, checkedAt: new Date().toISOString() });
const input = (provider: AgentProvider) => ({ provider, mode: 'ask' as const, model: '', objective: 'fixture task', workspacePath: '/fixture' });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

test('账号维护等已存在的状态查询退出；维护期间不启动 Cursor health，但 Codex 可继续', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-maintenance-'));
  const existingHealth = deferred<AgentRuntimeHealth>();
  const entered = deferred<void>();
  const finish = deferred<void>();
  let healthCalls = 0;
  const cursor: AgentRuntimeAdapter = { id: 'cursor', health: async () => { healthCalls++; return existingHealth.promise; }, execute: async () => 'done' };
  const codex: AgentRuntimeAdapter = { id: 'codex', health: async () => health('codex'), execute: async () => 'done' };
  const service = await createAgentRuntimeService(directory, { adapters: [cursor, codex],
    resolveWorkspace: async workspacePath => ({ workspacePath, branch: 'feature/fixture', headSha: '' }) });
  try {
    const pendingDashboard = service.dashboard(true);
    let called = false;
    const maintenance = service.withProviderMaintenance('cursor', async () => { called = true; entered.resolve(); await finish.promise; });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(called, false);
    const during = await service.dashboard(true);
    assert.equal(during.runtimes.find(item => item.provider === 'cursor')?.ready, false);
    assert.equal(healthCalls, 1);
    existingHealth.resolve(health('cursor'));
    await pendingDashboard;
    await entered.promise;
    await assert.rejects(service.start(input('cursor')), /正在管理 Cursor 账号/);
    await assert.rejects(service.withProviderMaintenance('cursor', async () => {}), /另一个账号/);
    const codexRun = await service.start(input('codex'));
    assert.equal(codexRun.provider, 'codex');
    assert.equal(healthCalls, 1);
    finish.resolve(); await maintenance;
    const cursorRun = await service.start(input('cursor'));
    assert.equal(cursorRun.provider, 'cursor');
    assert.equal(healthCalls, 2);
  } finally { existingHealth.resolve(health('cursor')); finish.resolve(); await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('有 Cursor 运行或排队时拒绝维护；维护异常后释放启动门禁', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-maintenance-busy-'));
  const finish = deferred<string>();
  const cursor: AgentRuntimeAdapter = { id: 'cursor', health: async () => health('cursor'), execute: async context => {
    context.onSession('cursor-fixture-session');
    return finish.promise;
  } };
  const service = await createAgentRuntimeService(directory, { adapters: [cursor],
    resolveWorkspace: async workspacePath => ({ workspacePath, branch: 'feature/fixture', headSha: '' }) });
  try {
    const run = await service.start(input('cursor'));
    const queued = await service.resume(run.id, 'queued task');
    assert.equal(queued.status, 'queued');
    let invoked = false;
    await assert.rejects(service.withProviderMaintenance('cursor', async () => { invoked = true; }), /正在运行或排队/);
    assert.equal(invoked, false);
    await service.stop(queued.id);
    finish.resolve('done');
    for (let i = 0; i < 50 && run.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(run.status, 'completed');
    await assert.rejects(service.withProviderMaintenance('cursor', async () => { throw new Error('fixture failure'); }), /fixture failure/);
    assert.equal((await service.start(input('cursor'))).provider, 'cursor');
  } finally { finish.resolve('done'); await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});


test('账号维护结束后首次普通看板查询强刷适配器缓存，异常退出也刷新', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-maintenance-refresh-'));
  let authenticated = true;
  let cached = health('cursor');
  const forces: boolean[] = [];
  const cursor: AgentRuntimeAdapter = { id: 'cursor', health: async (force = false) => {
    forces.push(force);
    if (force) cached = { ...health('cursor'), authenticated, ready: authenticated };
    return cached;
  }, execute: async () => 'done' };
  const service = await createAgentRuntimeService(directory, { adapters: [cursor] });
  try {
    assert.equal((await service.dashboard()).runtimes[0].ready, true);
    await service.withProviderMaintenance('cursor', async () => { authenticated = false; });
    assert.equal((await service.dashboard()).runtimes[0].ready, false);
    await service.dashboard();
    assert.deepEqual(forces, [false, true, false]);
    await assert.rejects(service.withProviderMaintenance('cursor', async () => {
      authenticated = true; throw new Error('fixture rollback');
    }), /fixture rollback/);
    assert.equal((await service.dashboard()).runtimes[0].ready, true);
    assert.deepEqual(forces, [false, true, false, true]);
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
