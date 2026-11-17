import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import { agentStartSchema } from '../server/agent-runtime-input.js';

test('工作区标识通过启动输入校验，并随续聊和服务重载保留', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'named-workspace-runtime-'));
  const repository = path.join(root, 'project');
  await fs.mkdir(repository);
  const adapter: AgentRuntimeAdapter = {
    id: 'codex',
    health: async () => ({ provider: 'codex', label: 'test', binary: 'test', version: 'test', authenticated: true, ready: true, message: 'ready', modes: ['agent'], models: [{ id: '', label: '默认' }], defaultModel: '', writable: true, checkedAt: new Date().toISOString() }),
    execute: async context => { context.onSession('mock-session'); return '模拟执行完成'; },
  };
  const options = { adapters: [adapter] };
  let service = await createAgentRuntimeService(path.join(root, 'data'), options);
  try {
    const input = agentStartSchema.parse({ provider: 'codex', mode: 'agent', model: '', objective: '验证工作区归属', workspacePath: repository, workspaceId: 'named-workspace' });
    const first = await service.start(input);
    for (let i = 0; i < 100 && !first.resultReady; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(first.workspaceId, 'named-workspace');
    assert.equal(first.status, 'completed');
    const resumed = await service.resume(first.id, '继续模拟任务');
    assert.equal(resumed.workspaceId, 'named-workspace');
    assert.equal(resumed.workspacePath, first.workspacePath);
    for (let i = 0; i < 100 && !resumed.resultReady; i++) await new Promise(resolve => setTimeout(resolve, 10));
    await service.close();
    service = await createAgentRuntimeService(path.join(root, 'data'), options);
    const saved = JSON.parse(await fs.readFile(path.join(root, 'data', 'agent-runs.json'), 'utf8'));
    assert.equal(saved.find((run: {id:string}) => run.id === resumed.id).workspaceId, 'named-workspace');
  } finally { await service.close(); await fs.rm(root, { recursive: true, force: true }); }
});
