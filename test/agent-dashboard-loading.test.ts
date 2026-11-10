import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import type { AgentRun, AgentRuntimeHealth } from '../shared/agent-runtime.js';

const ready: AgentRuntimeHealth = { provider: 'codex', label: 'Codex fixture', binary: '/fixture',
  version: 'fixture', authenticated: true, ready: true, message: 'ready', modes: ['ask'], models: [{ id: 'fixture', label: 'Fixture' }],
  defaultModel: 'fixture', writable: false, checkedAt: '2026-11-02T00:00:00.000Z' };

test('工作台快照立即可读，慢健康检查只阻塞状态请求且并发复用', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-dashboard-loading-'));
  let finish!: (health: AgentRuntimeHealth) => void;
  const pending = new Promise<AgentRuntimeHealth>(resolve => { finish = resolve; });
  let checks = 0;
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: () => { checks++; return pending; }, execute: async () => '' };
  const saved: AgentRun = { id: '88888888-8888-4888-8888-888888888888', provider: 'codex', mode: 'ask', accessMode: 'workspace',
    model: 'fixture', reasoningEffort: '', objective: '已有会话', workspacePath: directory, branch: '', headSha: '', status: 'completed',
    sessionId: 'saved-session', pid: null, result: '已有结果', error: '', events: [], createdAt: ready.checkedAt, updatedAt: ready.checkedAt };
  await fs.writeFile(path.join(directory, 'agent-runs.json'), JSON.stringify([saved]));
  const service = await createAgentRuntimeService(directory, { adapters: [adapter] });
  t.after(async () => { finish(ready); await service.close(); await fs.rm(directory, { recursive: true, force: true }); });

  assert.deepEqual(service.snapshot().runtimes, [], '未检查过的执行器不能伪造就绪状态或模型');
  assert.equal(checks, 0, '本地会话快照不启动任何 CLI 健康检查');
  const first = service.runtimeStatuses(true);
  const second = service.runtimeStatuses(true);
  let settled = false;
  void first.then(() => { settled = true; });
  assert.equal(checks, 1, '并发状态请求复用同一检查');
  assert.equal(service.snapshot().runs[0]?.id, saved.id);
  assert.equal(service.snapshot().runs[0]?.result, saved.result, '慢连接检查不妨碍读取已有会话与结果');
  assert.equal(service.snapshot().runs[0]?.resultReady, true);
  assert.deepEqual(service.snapshot().runtimes, []);
  assert.equal(settled, false, '快照可用时，慢状态请求仍在执行');

  finish(ready);
  assert.deepEqual(await first, [ready]);
  assert.deepEqual(await second, [ready]);
  assert.deepEqual(service.snapshot().runtimes, [ready]);
  assert.equal(checks, 1, '读已有状态缓存不会额外探测 CLI');
  assert.deepEqual((await service.dashboard()).runtimes, [ready], '既有完整 dashboard 仍读取真实状态');
});

test('快速快照在账号维护期间禁用缓存就绪状态，维护后不展示旧账号状态', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-dashboard-maintenance-'));
  let checks = 0;
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => { checks++; return ready; }, execute: async () => '' };
  const service = await createAgentRuntimeService(directory, { adapters: [adapter] });
  t.after(async () => { await service.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await service.runtimeStatuses();
  assert.equal(service.snapshot().runtimes[0]?.ready, true);
  await service.withProviderMaintenance('codex', async () => {
    const status = service.snapshot().runtimes[0]!;
    assert.equal(status.ready, false);
    assert.match(status.message, /正在管理/);
    assert.equal(checks, 1);
  });
  assert.deepEqual(service.snapshot().runtimes, []);
  assert.equal(checks, 1);
});

test('账号维护开始前的慢状态检查完成后不能回写就绪状态', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-dashboard-maintenance-race-'));
  let finish!: (health: AgentRuntimeHealth) => void;
  const pending = new Promise<AgentRuntimeHealth>(resolve => { finish = resolve; });
  const service = await createAgentRuntimeService(directory, { adapters: [{ id: 'codex', health: () => pending, execute: async () => '' }] });
  t.after(async () => { finish(ready); await service.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const checking = service.runtimeStatuses(true);
  const maintenance = service.withProviderMaintenance('codex', async () => {
    assert.equal(service.snapshot().runtimes[0]?.ready, false);
  });
  while (!service.snapshot().runtimes.length) await new Promise(resolve => setImmediate(resolve));
  finish(ready);
  const statuses = await checking;
  assert.equal(statuses[0]?.ready, false, '已启动的请求也必须遵守后来生效的维护门禁');
  assert.match(statuses[0]?.message || '', /正在管理/);
  await maintenance;
  assert.deepEqual(service.snapshot().runtimes, []);
});

test('额度晚于健康结果返回时，跨账号维护的状态响应丢弃旧额度和旧就绪状态', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-dashboard-status-version-'));
  const service = await createAgentRuntimeService(directory, { adapters: [{ id: 'codex', health: async () => ready, execute: async () => '' }] });
  t.after(async () => { await service.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const initialVersion = service.runtimeStatusVersion();
  const requestedVersion = initialVersion;
  await service.runtimeStatuses();
  let finishQuota!: () => void;
  const quota = new Promise<void>(resolve => { finishQuota = resolve; });
  const pending = quota.then(() => service.runtimeStatusResult(requestedVersion, { codexUsage: { account: 'old-account-fixture' } }));
  await service.withProviderMaintenance('codex', async () => {
    assert.ok(service.runtimeStatusVersion() > initialVersion);
    const during = service.runtimeStatusResult(requestedVersion, { codexUsage: { account: 'old-account-fixture' } });
    assert.equal(during.runtimes[0]?.ready, false);
    assert.equal(Object.hasOwn(during, 'codexUsage'), false);
  });
  assert.ok(service.runtimeStatusVersion() > initialVersion + 1);
  finishQuota();
  const late = await pending;
  assert.equal(late.runtimeStatusVersion, service.snapshot().runtimeStatusVersion);
  assert.deepEqual(late.runtimes, []);
  assert.equal(Object.hasOwn(late, 'codexUsage'), false);
  const currentVersion = service.runtimeStatusVersion();
  await service.runtimeStatuses();
  const fresh = service.runtimeStatusResult(currentVersion, { codexUsage: { account: 'new-account-fixture' } });
  assert.equal(fresh.runtimes[0]?.ready, true);
  assert.deepEqual((fresh as { codexUsage?: unknown }).codexUsage, { account: 'new-account-fixture' });
});

test('模型增删更新状态版本并清除旧目录，普通状态查询不使初次额度响应过期', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-dashboard-model-version-'));
  const service = await createAgentRuntimeService(directory, { adapters: [{ id: 'codex', health: async () => ready, execute: async () => '' }] });
  t.after(async () => { await service.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const version = service.runtimeStatusVersion();
  await service.runtimeStatuses();
  assert.equal(service.runtimeStatusVersion(), version);
  assert.equal(Object.hasOwn(service.runtimeStatusResult(version, { codexUsage: { remaining: 20 } }), 'codexUsage'), true);
  const model = await service.addCustomModel({ provider: 'codex', modelId: 'custom-fixture', label: 'L_MODEL' });
  assert.ok(service.runtimeStatusVersion() > version);
  assert.deepEqual(service.snapshot().runtimes, []);
  const addedVersion = service.runtimeStatusVersion();
  await service.runtimeStatuses();
  assert.equal(service.snapshot().runtimes[0]?.models.some(item => item.id === model.modelId), true);
  await assert.rejects(service.addCustomModel({ provider: 'codex', modelId: 'custom-fixture', label: 'duplicate' }));
  assert.equal(service.runtimeStatusVersion(), addedVersion, '失败的变更不更新状态版本');
  await service.removeCustomModel(model.id);
  assert.ok(service.runtimeStatusVersion() > addedVersion);
  assert.deepEqual(service.snapshot().runtimes, []);
  assert.equal(Object.hasOwn(service.runtimeStatusResult(addedVersion, { codexUsage: { remaining: 20 } }), 'codexUsage'), false);
  await service.runtimeStatuses();
  assert.equal(service.snapshot().runtimes[0]?.models.some(item => item.id === model.modelId), false);
});

test('配置更新后复用旧的在途健康检查，不能将旧结果重新标为新版', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-dashboard-old-check-version-'));
  let finish!: (health: AgentRuntimeHealth) => void;
  const pending = new Promise<AgentRuntimeHealth>(resolve => { finish = resolve; });
  const service = await createAgentRuntimeService(directory, { adapters: [
    { id: 'codex', health: () => pending, execute: async () => '' },
    { id: 'cursor', health: async () => ({ ...ready, provider: 'cursor' }), execute: async () => '' },
  ] });
  t.after(async () => { finish(ready); await service.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const oldCheck = service.health('codex');
  await service.withProviderMaintenance('cursor', async () => {});
  const reusedCheck = service.health('codex');
  finish(ready);
  const statuses = await Promise.all([oldCheck, reusedCheck]);
  assert.ok(statuses.every(status => !status.ready));
  assert.deepEqual(service.snapshot().runtimes, []);
});
