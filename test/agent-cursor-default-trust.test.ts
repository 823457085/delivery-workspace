import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentRuntimeService, createCursorAdapter, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import type { AgentRun, AgentRuntimeHealth } from '../shared/agent-runtime.js';

const health = async (): Promise<AgentRuntimeHealth> => ({ provider: 'cursor', label: 'Cursor fixture', binary: '/fixture',
  version: 'fixture', ready: true, authenticated: true, message: 'ready', modes: ['ask', 'plan', 'agent'],
  models: [{ id: '', label: 'fixture' }], defaultModel: '', writable: true, checkedAt: new Date().toISOString() });
async function completed(run: AgentRun) {
  for (let i = 0; i < 300 && !run.resultReady; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(run.status, 'completed', run.error);
  assert.equal(run.resultReady, true);
}

test('旧 Cursor 排队记录缺少信任字段，实际派发时补齐当前目录并保持只读权限', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-queued-default-trust-'));
  const workspace = path.join(root, 'workspace'); await fs.mkdir(workspace);
  const received: AgentRun[] = [];
  let release!: (value: string) => void, started!: () => void;
  const gate = new Promise<string>(resolve => { release = resolve; });
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  const adapter: AgentRuntimeAdapter = { id: 'cursor', health, execute: async context => {
    received.push(structuredClone(context.run));
    await context.onSession('cursor-queued-session');
    if (context.run.objective === 'first') { started(); return gate; }
    return 'queued turn completed';
  } };
  const service = await createAgentRuntimeService(path.join(root, 'data'), { adapters: [adapter] });
  try {
    const first = await service.start({ provider: 'cursor', mode: 'ask', accessMode: 'workspace', model: '', objective: 'first', workspacePath: workspace });
    await firstStarted;
    const queued = await service.resume(first.id, 'queued legacy turn');
    assert.equal(queued.status, 'queued');
    // 旧持久化运行不会经过新版 start()：在排队记录中移除该字段，验证 launch() 的兼容边界。
    delete queued.cursorTrustPath;
    release('first completed');
    await completed(queued);
    const launched = received.find(run => run.id === queued.id)!;
    assert.equal(launched.cursorTrustPath, await fs.realpath(workspace));
    assert.equal(launched.workspacePath, launched.cursorTrustPath);
    assert.equal(launched.mode, 'ask');
    assert.equal(launched.accessMode, 'workspace');
    assert.equal(received.length, 2);
  } finally { release('cleanup'); await service.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('Cursor 默认信任从宿主派发传到真实 CLI 子进程，保持沙箱且不批准全部 MCP', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-cli-default-trust-'));
  const workspace = path.join(root, 'workspace'); await fs.mkdir(workspace);
  const adapter: AgentRuntimeAdapter = { ...createCursorAdapter(path.resolve('test/fixtures/cursor-runtime.mjs')), health };
  const service = await createAgentRuntimeService(path.join(root, 'data'), { adapters: [adapter] });
  try {
    const run = await service.start({ provider: 'cursor', mode: 'ask', accessMode: 'workspace', model: '',
      objective: 'require-workspace-trust', workspacePath: workspace });
    await completed(run);
    assert.equal(run.cursorTrustPath, await fs.realpath(workspace));
    assert.equal(run.mode, 'ask');
    assert.equal(run.accessMode, 'workspace');
    assert.match(run.result, /require-workspace-trust/);
  } finally { await service.close(); await fs.rm(root, { recursive: true, force: true }); }
});
