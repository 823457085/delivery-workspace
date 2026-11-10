import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import { agentStartSchema } from '../server/agent-runtime-input.js';
import { createAgentUsageStore, extractAgentUsage } from '../server/agent-usage.js';
import { emptyAgentUsage } from '../shared/agent-usage.js';
import type { AgentRun } from '../shared/agent-runtime.js';

test('Kiro starts through the API schema, persists custom models and resumes the exact session after reload', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-service-'));
  const calls: { resume?: string; model: string }[] = [];
  const adapter: AgentRuntimeAdapter = { id: 'kiro', health: async () => ({
    provider: 'kiro', label: 'Kiro CLI', binary: '/fixture', version: 'fixture', authenticated: true, ready: true,
    message: '', modes: ['ask', 'plan', 'agent'], accessModes: ['workspace', 'full'],
    models: [{ id: 'auto', label: 'Auto' }], defaultModel: 'auto', writable: true, checkedAt: new Date().toISOString(),
  }), execute: async context => {
    calls.push({ resume: context.resumeSessionId, model: context.run.model });
    await context.onSession('kiro-session-fixture');
    context.onEvent('message', 'Kiro reply');
    return 'Kiro reply';
  } };
  const wait = async (run: AgentRun) => {
    for (let i = 0; i < 200 && !run.resultReady && !['failed', 'interrupted'].includes(run.status); i++) await delay(10);
    assert.equal(run.status, 'completed', run.error);
    assert.equal(run.resultReady, true);
  };
  const directory = path.join(root, 'state');
  let service = await createAgentRuntimeService(directory, { adapters: [adapter] });
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  const input = agentStartSchema.parse({ provider: 'kiro', mode: 'ask', model: 'auto', objective: 'first' });
  const first = await service.start(input);
  await wait(first);
  await service.addCustomModel({ provider: 'kiro', modelId: 'future-model', label: 'Future Model' });
  await service.close();
  service = await createAgentRuntimeService(directory, { adapters: [adapter] });
  const dashboard = await service.dashboard();
  assert.equal(dashboard.runs[0]?.provider, 'kiro');
  assert.equal(dashboard.runs[0]?.sessionId, 'kiro-session-fixture');
  assert.ok(dashboard.runtimes[0]?.models.some(model => model.id === 'future-model'));
  const second = await service.resume(first.id, 'second', 'future-model');
  await wait(second);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.workspacePath, first.workspacePath);
  assert.equal(second.parentRunId, first.id);
  assert.deepEqual(calls.map(call => call.resume || ''), ['', 'kiro-session-fixture']);
  assert.equal(calls[1]?.model, 'future-model');
});

test('Kiro unknown usage is stored as unknown without falling through to Cursor attribution', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-usage-'));
  const store = await createAgentUsageStore(root);
  t.after(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }); });
  assert.equal(extractAgentUsage('kiro', { type: 'runFinished', usage: { input_tokens: 999 } }), undefined);
  await store.upsert({ runId: 'kiro-run', provider: 'kiro', model: 'auto', createdAt: new Date().toISOString(), usage: emptyAgentUsage('kiro') });
  assert.equal(store.summary().total.unknownRuns, 1);
  assert.equal(store.list()[0]?.provider, 'kiro');
});
