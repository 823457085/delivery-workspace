/** Legacy restricted full sessions migrate once; local adapters never invoke a model or load account configuration. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import type { AgentRun } from '../shared/agent-runtime.js';

for (const provider of ['claude', 'kiro', 'antigravity'] as const) test(`${provider} 历史 full 工具配置只迁移一次，重启与后续续聊正常复用新会话`, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-full-migration-'));
  const state = path.join(root, 'state'), workspacePath = path.join(root, 'workspace');
  await fs.mkdir(state); await fs.mkdir(workspacePath);
  const id = randomUUID(), now = new Date().toISOString();
  const legacy: AgentRun = { id, conversationId: id, queueRootId: id, provider, mode: 'agent', accessMode: 'full',
    model: 'fixture', reasoningEffort: '', objective: '已授权测试登录持续验证', workspacePath, branch: '', headSha: '',
    status: 'completed', sessionId: 'old-restricted-full', pid: null, result: '旧结果保留', error: '', events: [], createdAt: now, updatedAt: now };
  await fs.writeFile(path.join(state, 'agent-runs.json'), JSON.stringify([legacy]));
  const calls: { run: AgentRun; resume: string }[] = [];
  const adapter: AgentRuntimeAdapter = { id: provider, health: async () => ({ provider, label: provider, binary: 'fixture',
    version: 'fixture', authenticated: true, ready: true, message: '', modes: ['agent'], accessModes: ['workspace', 'full'],
    models: [{ id: 'fixture', label: 'fixture' }], defaultModel: 'fixture', writable: true, checkedAt: now }),
    execute: async context => { calls.push({ run: structuredClone(context.run), resume: context.resumeSessionId || '' });
      await context.onSession(context.resumeSessionId || `native-${context.run.id}`); return '新的真实结果'; } };
  const options = { adapters: [adapter], codexSessionSource: { listSessions: async () => [], session: async () => { throw new Error('no imported session'); } } };
  let service = await createAgentRuntimeService(state, options);
  const done = async (run: AgentRun) => {
    for (let i = 0; i < 300 && !run.resultReady && !['failed', 'cancelled'].includes(run.status); i++) await delay(10);
    assert.equal(run.status, 'completed', run.error); assert.equal(run.resultReady, true);
  };
  try {
    const migrated = await service.resume(id, '继续原任务'); await done(migrated);
    assert.equal(calls[0].resume, ''); assert.notEqual(migrated.sessionId, legacy.sessionId);
    assert.equal(migrated.accessMode, 'full'); assert.equal(migrated.nativeConfiguredTools, true);
    assert.ok(calls[0].run.accessTransition?.context.includes(legacy.objective));
    const same = await service.resume(migrated.id, '再次验证'); await done(same);
    assert.equal(calls[1].resume, migrated.sessionId);
    await service.close(); service = await createAgentRuntimeService(state, options);
    const afterRestart = await service.resume(same.id, '重启后继续验证'); await done(afterRestart);
    assert.equal(calls[2].resume, migrated.sessionId); assert.equal(afterRestart.nativeConfiguredTools, true);
    assert.equal(service.getRun(id)?.result, legacy.result); assert.equal(service.getRun(id)?.sessionId, legacy.sessionId);
  } finally { await service.close(); await fs.rm(root, { recursive: true, force: true }); }
});
