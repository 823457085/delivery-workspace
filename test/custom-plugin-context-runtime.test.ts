import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import { createCustomPluginRuntime, fingerprint } from '../server/plugins/custom-runtime.js';
import { createWorkspaceTodos } from '../server/workspace-todos.js';
import { pluginReference } from '../shared/custom-plugins.js';
import type { AgentRun } from '../shared/agent-runtime.js';
test('real conversation runtime resolves plugin data at send, persists snapshots and citations without AI/network', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-context-runtime-')), directory = path.join(root, 'runtime'), workspacePath = path.join(root, 'workspace');
  await fs.mkdir(directory); await fs.mkdir(workspacePath);
  const todos = await createWorkspaceTodos(path.join(root, 'todos')), plugins = await createCustomPluginRuntime(path.join(root, 'plugins'), todos);
  const pkg = path.resolve('plugins/example-notes'), preview = await plugins.inspect(pkg);
  await plugins.install({ directory: pkg, digest: preview.digest, grants: preview.manifest.permissions, confirmed: true });
  const otherNote = await plugins.saveRecord('example-notes', { values: { title: '未直接引用的备忘' } });
  const incidentalReference = pluginReference('example-notes', 'note', otherNote.id);
  const note = await plugins.saveRecord('example-notes', { values: { title: '发送前的标题', details: '原始说明' } });
  const reference = pluginReference('example-notes', 'note', note.id), calls: AgentRun[] = [];
  const adapter: AgentRuntimeAdapter = {
    id: 'codex', health: async () => ({ provider: 'codex', label: 'fixture', binary: 'fixture', version: 'fixture', authenticated: true, ready: true,
      message: '', modes: ['ask'], accessModes: ['workspace'], models: [{ id: 'fixture', label: 'fixture' }], defaultModel: 'fixture', writable: false, checkedAt: new Date().toISOString() }),
    execute: async context => { calls.push(structuredClone(context.run)); await context.onSession(`fixture-${context.run.id}`); return '本地模拟执行完成'; },
  };
  const options = { adapters: [adapter], resolveKnowledge: plugins.resolveReferences, codexSessionSource: { listSessions: async () => [], session: async () => { throw new Error('no external sessions'); } } };
  let runtime = await createAgentRuntimeService(directory, options);
  try {
    const updated = await plugins.saveRecord('example-notes', { id: note.id, expectedVersion: fingerprint(note), values: { title: '发送时最新标题', details: `最新说明 @${incidentalReference}` } });
    const input = { provider: 'codex' as const, mode: 'ask' as const, accessMode: 'workspace' as const, model: 'fixture', reasoningEffort: '' as const, objective: `分析 @${reference}`, workspacePath, attachmentIds: [] };
    const run = await runtime.start(input);
    for (let i = 0; i < 300 && !run.resultReady && !['failed','cancelled'].includes(run.status); i++) await delay(10);
    assert.equal(run.status, 'completed', run.error); assert.equal(calls.length, 1);
    assert.match(calls[0].knowledgeContext!, /发送时最新标题/);
    assert.equal(runtime.knowledgeCitations(reference)[0].runId, run.id);
    assert.deepEqual(runtime.knowledgeCitations(incidentalReference), []);
    await plugins.removeRecord('example-notes', { id: updated.id, expectedVersion: fingerprint(updated) });
    await runtime.close(); runtime = await createAgentRuntimeService(directory, options);
    assert.match(runtime.getRun(run.id)!.knowledgeContext!, /最新说明/);
    assert.equal(runtime.knowledgeCitations(reference)[0].runId, run.id);
    await assert.rejects(runtime.start(input), /删除/);
    assert.equal(calls.length, 1);
  } finally { await runtime.close(); await plugins.close(); await fs.rm(root, { recursive: true, force: true }); }
});
