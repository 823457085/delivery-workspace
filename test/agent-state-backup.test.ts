import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStateBackupStore } from '../server/state-backup.js';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import type { AgentRun } from '../shared/agent-runtime.js';

test('真实运行账本写入保留可校验备份；损坏重启明确提示恢复且不覆盖原件', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-agent-state-'));
  const store = await createStateBackupStore(root);
  const directory = path.join(root, 'agent-runtimes');
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => ({ provider: 'codex', label: 'fixture',
    binary: '', version: '', authenticated: true, ready: true, message: '', modes: ['ask'], models: [{ id: '', label: 'fixture' }],
    defaultModel: '', writable: false, checkedAt: '' }), execute: async () => '隔离验证结果' };
  const options = { stateBackup: store, adapters: [adapter], resolveWorkspace: async () => ({ workspacePath: root, branch: '', headSha: '' }) };
  const service = await createAgentRuntimeService(directory, options);
  try {
    const run = await service.start({ provider: 'codex', mode: 'ask', model: '', objective: '保存运行状态', workspacePath: root });
    for (let attempt = 0; attempt < 100 && run.status !== 'completed'; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(run.status, 'completed');
    await service.close();
    const entries = await store.list('agent-runtimes/agent-runs.json');
    assert.ok(entries.length >= 2);
    assert.ok(entries.every(entry => entry.valid));
    const target = path.join(directory, 'agent-runs.json');
    await fs.writeFile(target, '{ damaged ledger');
    await assert.rejects(createAgentRuntimeService(directory, options), /原件未覆盖.*停止服务后恢复备份/);
    assert.equal(await fs.readFile(target, 'utf8'), '{ damaged ledger');
    assert.deepEqual(await store.list('agent-runtimes/agent-runs.json'), entries);
  } finally { await service.close(); await store.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('只有最终运行账本保存成功才通知自动整理；保存失败不发完成信号', async t => {
  for (const mode of ['保存成功', '保存失败', '保存期间正文又变化']) await t.test(mode, async () => {
    const failFinalWrite = mode === '保存失败';
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-finalized-'));
    const store = await createStateBackupStore(root);
    let releaseWrite!: () => void, writingFinal!: () => void, finalized!: () => void;
    const gate = new Promise<void>(resolve => { releaseWrite = resolve; });
    const started = new Promise<void>(resolve => { writingFinal = resolve; });
    const finished = new Promise<void>(resolve => { finalized = resolve; });
    const snapshots: { status: string; pid: number | null; resultReady?: boolean }[] = [];
    const provisional: (boolean | undefined)[] = [];
    const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => ({ provider: 'codex', label: 'fixture',
      binary: '', version: '', authenticated: true, ready: true, message: '', modes: ['ask'], models: [{ id: '', label: 'fixture' }],
      defaultModel: '', writable: false, checkedAt: '' }), execute: async () => '本轮报告' };
    const service = await createAgentRuntimeService(path.join(root, 'agent-runtimes'), {
      adapters: [adapter], resolveWorkspace: async () => ({ workspacePath: root, branch: '', headSha: '' }),
      stateBackup: { ...store, writeJson: async (relative, value) => {
        if (relative === 'agent-runtimes/agent-runs.json' && Array.isArray(value)) {
          assert.ok(value.every(run => !Object.hasOwn(run, 'resultReady')), '派生标记不能写入账本或备份');
        }
        if (relative === 'agent-runtimes/agent-runs.json' && Array.isArray(value) && value.some(run => run.status === 'completed')) {
          writingFinal(); await gate;
          if (failFinalWrite) throw new Error('fixture: final persistence failed');
        }
        await store.writeJson(relative, value);
      } },
    });
    service.subscribe((_revision, run, committed) => {
      if (run?.status === 'completed' && !committed) provisional.push(run.resultReady);
      if (!committed || !run) return;
      snapshots.push({ status: run.status, pid: run.pid, resultReady: run.resultReady }); finalized();
    });
    try {
      const run = await service.start({ provider: 'codex', mode: 'ask', model: '', objective: '检查完成通知', workspacePath: root });
      await started;
      assert.equal(run.status, 'completed');
      assert.equal(run.pid, null);
      assert.equal(run.resultReady, false);
      assert.equal((await service.dashboard()).runs.find(item => item.id === run.id)?.resultReady, false);
      assert.ok(provisional.length > 0); assert.ok(provisional.every(value => value === false));
      assert.deepEqual(snapshots, []);
      if (mode === '保存期间正文又变化') run.result = '账本写入期间的新报告';
      releaseWrite();
      if (failFinalWrite) {
        for (let attempt = 0; attempt < 100 && !run.recovery; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(run.status, 'interrupted');
        assert.equal(run.resultReady, false);
        assert.equal((await service.dashboard()).runs.find(item => item.id === run.id)?.resultReady, false);
        assert.deepEqual(snapshots, []);
      } else {
        await finished;
        const ready = mode === '保存成功';
        assert.deepEqual(snapshots, [{ status: 'completed', pid: null, resultReady: ready }]);
        assert.equal(run.resultReady, ready);
        assert.equal((await service.dashboard()).runs.find(item => item.id === run.id)?.resultReady, ready);
        assert.equal(JSON.parse(JSON.stringify(run)).resultReady, ready, 'HTTP 和 SSE 序列化应暴露就绪标记');
        const saved = JSON.parse(await fs.readFile(path.join(root, 'agent-runtimes/agent-runs.json'), 'utf8'));
        assert.equal(saved[0].status, 'completed');
        assert.equal(saved[0].result, '本轮报告');
        assert.equal(Object.hasOwn(saved[0], 'resultReady'), false);
      }
    } finally { releaseWrite(); await service.close(); await store.close(); await fs.rm(root, { recursive: true, force: true }); }
  });
});

test('重启从已持久化的完成运行派生就绪，不信任磁盘标记或未收尾的 completed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-ready-restart-'));
  const directory = path.join(root, 'agent-runtimes');
  await fs.mkdir(directory);
  const base: AgentRun = { id: 'complete', provider: 'codex', mode: 'ask', accessMode: 'workspace', model: '', reasoningEffort: '',
    objective: '隔离完成记录', workspacePath: root, branch: '', headSha: '', status: 'completed', sessionId: '', pid: null,
    result: '已持久化报告', error: '', events: [], createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z' };
  await fs.writeFile(path.join(directory, 'agent-runs.json'), JSON.stringify([
    base, { ...base, id: 'stored-false', resultReady: false },
    { ...base, id: 'running', status: 'running', pid: 12345, resultReady: true },
    { ...base, id: 'failed', status: 'failed', resultReady: true },
    { ...base, id: 'unfinished', pid: 12345, resultReady: true },
  ]));
  const service = await createAgentRuntimeService(directory, { adapters: [] });
  try {
    const { runs } = await service.dashboard();
    assert.deepEqual(Object.fromEntries(runs.map(run => [run.id, run.resultReady])),
      { complete: true, 'stored-false': true, running: false, failed: false, unfinished: false });
    assert.equal(service.recoveryRuns().find(run => run.id === 'running')?.resultReady, false);
    const saved = JSON.parse(await fs.readFile(path.join(directory, 'agent-runs.json'), 'utf8')) as AgentRun[];
    assert.ok(saved.every(run => !Object.hasOwn(run, 'resultReady')));
  } finally { await service.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('完成后的正文和时间版本改写立即失效，失败落盘不恢复，成功保存新版本才重新就绪', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-ready-version-'));
  const store = await createStateBackupStore(root);
  const outputs = new Map<string, (text: string) => void>();
  let rejectWrites = false;
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => ({ provider: 'codex', label: 'fixture',
    binary: '', version: '', authenticated: true, ready: true, message: '', modes: ['ask'], models: [{ id: '', label: 'fixture' }],
    defaultModel: '', writable: false, checkedAt: '' }), execute: async context => {
    outputs.set(context.run.id, context.onOutput!); return '已保存的原报告';
  } };
  const service = await createAgentRuntimeService(path.join(root, 'agent-runtimes'), { adapters: [adapter],
    resolveWorkspace: async () => ({ workspacePath: root, branch: '', headSha: '' }),
    stateBackup: { ...store, writeJson: async (relative, value) => {
      if (rejectWrites && relative === 'agent-runtimes/agent-runs.json') throw new Error('fixture: updated result write failed');
      await store.writeJson(relative, value);
    } },
  });
  const start = () => service.start({ provider: 'codex', mode: 'ask', model: '', objective: '隔离版本检查', workspacePath: root });
  const finished = async (run: AgentRun) => {
    for (let attempt = 0; attempt < 100 && !run.resultReady; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(run.resultReady, true);
  };
  try {
    const run = await start(); await finished(run);
    assert.equal(Reflect.set(run, 'resultReady', true), false);
    outputs.get(run.id)!('结束后修正的正文');
    assert.equal(run.resultReady, false);
    assert.equal((await service.dashboard()).runs.find(item => item.id === run.id)?.resultReady, false);
    rejectWrites = true;
    await assert.rejects(start(), /updated result write failed/);
    assert.equal(run.resultReady, false);
    const old = await store.readJson<AgentRun[]>('agent-runtimes/agent-runs.json');
    assert.equal(old.find(item => item.id === run.id)?.result, '已保存的原报告');
    rejectWrites = false;
    await finished(await start()); assert.equal(run.resultReady, true);
    run.updatedAt = new Date(Date.parse(run.updatedAt) + 1000).toISOString();
    assert.equal(run.resultReady, false);
    await finished(await start()); assert.equal(run.resultReady, true);
    const saved = await store.readJson<AgentRun[]>('agent-runtimes/agent-runs.json');
    assert.equal(saved.find(item => item.id === run.id)?.result, '结束后修正的正文');
    assert.ok(saved.every(item => !Object.hasOwn(item, 'resultReady')));
  } finally { await service.close(); await store.close(); await fs.rm(root, { recursive: true, force: true }); }
});
