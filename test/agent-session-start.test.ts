import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { agentStartSchema } from '../server/agent-runtime-input.js';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import { agentRunProjectPath } from '../src/features/agent-workbench/conversation.js';
import type { AgentRun } from '../shared/agent-runtime.js';

const input = { provider: 'codex', mode: 'agent', model: '', objective: '你好' };

test('启动参数允许不选项目、不传分支及普通文件夹的空分支', () => {
  assert.equal(agentStartSchema.parse(input).workspacePath, '');
  assert.equal(agentStartSchema.parse({ ...input, workspacePath: '', branch: '' }).branch, '');
  assert.equal(agentStartSchema.parse({ ...input, workspacePath: '/tmp/plain', branch: '  ' }).branch, '');
  assert.equal(agentStartSchema.parse({ ...input, workspacePath: '/repo', branch: 'main' }).branch, 'main');
  assert.equal(agentStartSchema.parse({ ...input, provider: 'cursor', cursorTrustPath: '' }).cursorTrustPath, '');
  assert.equal(agentStartSchema.parse({ ...input, serviceTier: 'default' }).serviceTier, 'default');
  assert.equal(agentStartSchema.parse({ ...input, serviceTier: 'priority' }).serviceTier, 'priority');
});

test('放开项目选择不放开消息、分支、附件、权限及未知参数校验', () => {
  for (const invalid of [
    { ...input, objective: ' ' }, { ...input, branch: 'main' },
    { ...input, workspacePath: 123 }, { ...input, branch: 123 },
    { ...input, attachmentIds: ['invalid'] }, { ...input, mode: 'ask', accessMode: 'full' },
    { ...input, extra: true }, { ...input, serviceTier: 'ultrafast' },
  ]) assert.equal(agentStartSchema.safeParse(invalid).success, false);
  assert.equal(agentStartSchema.safeParse({ ...input, objective: '', attachmentIds: ['12345678-1234-4234-8234-123456789012'] }).success, true);
});

test('无项目会话分配私有目录、相互隔离，续聊复用目录且不调用 Git 工作区操作', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-no-project-'));
  const executed: AgentRun[] = [];
  const adapters: AgentRuntimeAdapter[] = (['codex', 'cursor'] as const).map(provider => ({
    id: provider,
    health: async () => ({ provider, label: provider, binary: '/fixture', version: 'test', authenticated: true,
      ready: true, message: 'ready', modes: ['agent', 'ask', 'plan'], models: [{ id: '', label: '默认' }],
      defaultModel: '', writable: true, checkedAt: new Date().toISOString() }),
    execute: async context => { executed.push(context.run); context.onSession(`${context.run.id}-session`); return '会话成功'; },
  }));
  const service = await createAgentRuntimeService(directory, { adapters,
    createIsolatedWorkspace: async () => { throw new Error('不应创建 Git 工作区'); },
    switchWorkspaceBranch: async () => { throw new Error('不应切分支'); },
  });
  const settle = async (run: AgentRun) => {
    for (let i = 0; i < 100 && ['queued', 'running'].includes(run.status); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(run.status, 'completed', run.error);
  };
  try {
    const first = await service.start(agentStartSchema.parse({ ...input, isolateWorkspace: true }));
    const second = await service.start(agentStartSchema.parse({ ...input, workspacePath: '', branch: '' }));
    await settle(first); await settle(second);
    assert.notEqual(first.workspacePath, second.workspacePath);
    assert.equal(first.workspacePath, await fs.realpath(path.join(directory, 'sessions', first.id)));
    assert.equal((await fs.stat(first.workspacePath)).mode & 0o777, 0o700);
    assert.equal(first.branch, '');
    assert.equal(first.headSha, '');
    assert.equal(first.isolatedWorkspace, false);
    assert.equal(first.accessMode, 'workspace');
    assert.equal(agentRunProjectPath(first), '');
    const resumed = await service.resume(first.id, '继续');
    await settle(resumed);
    assert.equal(resumed.workspacePath, first.workspacePath);
    assert.equal(agentRunProjectPath(resumed), '');
    const cursor = await service.start(agentStartSchema.parse({ ...input, provider: 'cursor', cursorTrustPath: '', accessMode: 'full' }));
    await settle(cursor);
    assert.equal(cursor.cursorTrustPath, cursor.workspacePath);
    assert.equal(cursor.accessMode, 'full');
    await assert.rejects(service.start(agentStartSchema.parse({ ...input, provider: 'cursor', cursorTrustPath: '/other' })), /信任确认/);
    assert.equal(executed.length, 4);
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
