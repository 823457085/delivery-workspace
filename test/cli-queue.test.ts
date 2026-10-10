import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCliQueue, assertDesktopDispatchersPaused } from '../server/cli-queue.js';

function fakeWorker() {
  let finish!: () => void;
  const completion = new Promise<void>((resolve) => { finish = resolve; });
  return { dispatcherId: '', stopping: false, initialized: false, starts: 0,
    ledger: { read: async () => ({ runs: { one: { jobId: 'catchup:REQ-001', threadId: 'test-thread', workspacePath: '/test', pid: 123, phase: 'running', claimToken: 'MUST_NOT_LEAK' } } }) },
    async initialize() { this.initialized = true; }, async heartbeat() {},
    async runForever() { this.starts++; await completion; this.initialized = false; },
    stop() { this.stopping = true; }, finish,
  };
}
const check = async () => ({ version: 'test-cli', authenticated: true });

test('CLI queue starts once, hides claim tokens, and pause drains without killing current work', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-control-test-'));
  const worker = fakeWorker();
  const service = await createCliQueue(directory, { check, guard: async () => {}, createWorker: async () => worker });
  try {
    assert.equal((await service.dashboard()).status, 'paused');
    await Promise.all([service.start(), service.start()]);
    assert.equal(worker.starts, 1);
    assert.equal(JSON.stringify(await service.dashboard()).includes('MUST_NOT_LEAK'), false);
    assert.equal((await service.pause()).status, 'draining');
    assert.equal(worker.stopping, true);
    await assert.rejects(service.start(), /等待当前任务结束/);
    worker.finish(); await service.close();
    assert.equal((await service.dashboard()).status, 'paused');
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'cli-queue.json'), 'utf8')).enabled, false);
  } finally { worker.finish(); await service.close(); await fs.rm(directory, { recursive: true }); }
});

test('active heartbeat or missing authentication prevents any worker creation', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-guard-test-'));
  let starts = 0;
  try {
    for (const options of [
      { guard: async () => { throw new Error('heartbeat active'); }, check },
      { guard: async () => {}, check: async () => ({ version: 'test', authenticated: false }) },
    ]) {
      const service = await createCliQueue(directory, { ...options, createWorker: async () => { starts++; return fakeWorker(); } });
      await assert.rejects(service.start()); await service.close();
    }
    assert.equal(starts, 0);
    await fs.mkdir(path.join(directory, 'apex-codex'));
    await fs.writeFile(path.join(directory, 'apex-codex/automation.toml'), 'status = "ACTIVE"');
    await assert.rejects(assertDesktopDispatchersPaused(directory), /apex-codex/);
    await fs.writeFile(path.join(directory, 'apex-codex/automation.toml'), 'status = "PAUSED"');
    await assertDesktopDispatchersPaused(directory);
  } finally { await fs.rm(directory, { recursive: true }); }
});

test('CLI startup preference survives normal shutdown; failed loop pauses instead of restarting work', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-restart-test-'));
  const worker = fakeWorker();
  const first = await createCliQueue(directory, { check, guard: async () => {}, createWorker: async () => worker });
  try {
    await first.start(); worker.finish(); await first.close();
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'cli-queue.json'), 'utf8')).enabled, true);
    const failing = fakeWorker();
    failing.runForever = async () => { throw new Error('callback uncertain'); };
    const next = await createCliQueue(directory, { check, guard: async () => {}, createWorker: async () => failing });
    await next.close();
    assert.equal((await next.dashboard()).status, 'blocked');
    assert.match((await next.dashboard()).error, /callback uncertain/);
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'cli-queue.json'), 'utf8')).enabled, false);
  } finally { worker.finish(); await first.close(); await fs.rm(directory, { recursive: true }); }
});
