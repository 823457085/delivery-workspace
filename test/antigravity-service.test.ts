/** Verify Antigravity wiring through the real scheduler using local fake adapters only. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import { createAgentAttachmentStore } from '../server/agent-attachments.js';
import { agentStartSchema } from '../server/agent-runtime-input.js';
import { createAgentUsageStore, extractAgentUsage } from '../server/agent-usage.js';
import { emptyAgentUsage } from '../shared/agent-usage.js';
import type { AgentProvider, AgentRun, AgentRuntimeHealth } from '../shared/agent-runtime.js';

type Context = Parameters<AgentRuntimeAdapter['execute']>[0];
const model = 'gemini-fixture';
const onePixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZpQAAAABJRU5ErkJggg==';

async function completed(run: AgentRun) {
  for (let attempt = 0; attempt < 300 && !run.resultReady && !['failed', 'interrupted', 'cancelled'].includes(run.status); attempt++) await delay(10);
  assert.equal(run.status, 'completed', run.error);
  assert.equal(run.resultReady, true);
}

async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'antigravity-service-')));
  const directory = path.join(root, 'state');
  const attachments = await createAgentAttachmentStore(path.join(root, 'uploads'));
  const calls: { runId: string; provider: AgentProvider; model: string; resume: string; images: string[];
    files: Context['fileAttachments']; attachmentDirectory: string; readDirectories: string[] }[] = [];
  const health = (provider: AgentProvider): AgentRuntimeHealth => ({ provider, label: provider, binary: '/fixture', version: 'fixture',
    authenticated: true, ready: true, message: '', modes: ['ask', 'plan', 'agent'], accessModes: ['workspace', 'full'],
    models: [{ id: model, label: 'L123' }], defaultModel: model, writable: true, checkedAt: new Date().toISOString() });
  const adapters: AgentRuntimeAdapter[] = (['antigravity', 'kiro'] as const).map(provider => ({ id: provider,
    health: async () => health(provider), execute: async context => {
      calls.push({ runId: context.run.id, provider, model: context.run.model, resume: context.resumeSessionId || '',
        images: [...context.imagePaths], files: structuredClone(context.fileAttachments),
        attachmentDirectory: context.attachmentDirectory || '', readDirectories: [...(context.attachmentReadDirectories || [])] });
      await context.onSession(context.resumeSessionId || `${provider}-native-${context.run.id}`);
      return `完成：${context.run.objective}`;
    } }));
  const options = { adapters, resolveAttachments: attachments.resolve, removeAttachments: attachments.remove,
    codexSessionSource: { listSessions: async () => [], session: async () => { throw new Error('fixture has no Codex session'); } } };
  let service = await createAgentRuntimeService(directory, options);
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  const input = (objective: string, extra: Record<string, unknown> = {}) => agentStartSchema.parse({
    provider: 'antigravity', mode: 'ask', model, objective, ...extra,
  });
  return { root, directory, calls, attachments, input, get service() { return service; },
    reload: async () => { await service.close(); service = await createAgentRuntimeService(directory, options); } };
}

test('Antigravity schema, models and historical runs survive reload, and continuation keeps the native session', async t => {
  const f = await fixture(t);
  const first = await f.service.start(f.input('首轮'));
  await completed(first);
  await f.service.addCustomModel({ provider: 'antigravity', modelId: 'future-model', label: 'L999' });
  await f.reload();
  const dashboard = await f.service.dashboard();
  const stored = dashboard.runs.find(run => run.id === first.id);
  assert.equal(stored?.provider, 'antigravity');
  assert.equal(stored?.sessionId, first.sessionId);
  assert.equal(stored?.mode, 'ask');
  const runtime = dashboard.runtimes.find(item => item.provider === 'antigravity');
  assert.equal(runtime?.models.find(item => item.id === model)?.label, 'L123');
  assert.equal(runtime?.models.find(item => item.id === 'future-model')?.label, 'L999');
  const second = await f.service.resume(first.id, '续聊', 'future-model');
  await completed(second);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.workspacePath, first.workspacePath);
  assert.equal(second.parentRunId, first.id);
  assert.equal(second.conversationId, first.conversationId);
  assert.deepEqual(f.calls.map(call => call.resume), ['', first.sessionId]);
  assert.equal(f.calls[1].model, 'future-model');
});

test('Antigravity receives validated images and ordinary files without mixing their input channels', async t => {
  const f = await fixture(t);
  const image = await f.attachments.upload({ name: '截图.png', mimeType: 'image/png', data: onePixelPng });
  const document = await f.attachments.upload({ name: '说明.txt', mimeType: 'text/plain', data: Buffer.from('附件材料').toString('base64') });
  const resolved = await f.attachments.resolve([image.id, document.id]);
  const first = await f.service.start(f.input('读取附件', { attachmentIds: [image.id, document.id] }));
  await completed(first);
  assert.deepEqual(f.calls[0].images, [resolved[0].filePath]);
  assert.deepEqual(f.calls[0].files, [{ name: '说明.txt', path: resolved[1].filePath }]);
  assert.match(f.calls[0].attachmentDirectory, /[/\\]antigravity-attachments[/\\][a-f0-9]{64}$/);
  assert.deepEqual(first.attachments?.map(item => item.id), [image.id, document.id]);
  assert.equal(JSON.stringify(first.attachments).includes(f.root), false);
  const historicalDirectory = f.calls[0].attachmentDirectory;
  await fs.mkdir(historicalDirectory, { recursive: true });
  await fs.writeFile(path.join(historicalDirectory, 'historical-picture.png'), Buffer.from(onePixelPng, 'base64'));
  await f.reload();
  const second = await f.service.resume(first.id, '继续理解历史图片');
  await completed(second);
  assert.deepEqual(f.calls[1].images, []);
  assert.deepEqual(f.calls[1].files, []);
  assert.equal(f.calls[1].resume, first.sessionId);
  assert.ok(f.calls[1].readDirectories.includes(historicalDirectory), '重启后的续聊仍需授予历史图片副本读取范围');
  assert.deepEqual((await f.attachments.read(image.id)).content, Buffer.from(onePixelPng, 'base64'));
});

test('Switching to Antigravity preserves the conversation but starts its own native session', async t => {
  const f = await fixture(t);
  const previous = await f.service.start(f.input('Kiro 首轮', { provider: 'kiro' }));
  await completed(previous);
  const switched = await f.service.start(f.input('转 Antigravity', { continueConversationId: previous.conversationId,
    workspacePath: previous.workspacePath }));
  await completed(switched);
  assert.equal(switched.providerSwitch?.from, 'kiro');
  assert.equal(switched.conversationId, previous.conversationId);
  assert.equal(f.calls[1].resume, '');
  assert.notEqual(switched.sessionId, previous.sessionId);
  const continued = await f.service.start(f.input('同执行器切工作区', { mode: 'agent', accessMode: 'workspace',
    continueConversationId: previous.conversationId, workspacePath: previous.workspacePath }));
  await completed(continued);
  assert.equal(continued.mode, 'agent');
  assert.equal(continued.accessMode, 'workspace');
  assert.equal(continued.conversationId, switched.conversationId);
  assert.notEqual(continued.sessionId, switched.sessionId);
  assert.equal(f.calls[2].resume, '');
  assert.equal(previous.provider, 'kiro');
  assert.equal(switched.mode, 'ask');
});

test('Deleting Antigravity conversations removes their runtime copies and only orphaned uploaded attachments', async t => {
  const f = await fixture(t);
  const image = await f.attachments.upload({ name: '共享图.png', mimeType: 'image/png', data: onePixelPng });
  const document = await f.attachments.upload({ name: '独立.txt', mimeType: 'text/plain', data: Buffer.from('只属于第一条会话').toString('base64') });
  const first = await f.service.start(f.input('首条会话', { attachmentIds: [image.id, document.id] }));
  await completed(first);
  const second = await f.service.start(f.input('另一条会话', { attachmentIds: [image.id] }));
  await completed(second);
  const copyDirectory = f.calls[0].attachmentDirectory;
  assert.ok(copyDirectory);
  await fs.mkdir(copyDirectory, { recursive: true });
  await fs.writeFile(path.join(copyDirectory, 'retained-copy.txt'), 'fixture staged copy');
  assert.deepEqual(await f.service.removeConversation(first.id), { deleted: 1 });
  await assert.rejects(fs.access(copyDirectory), { code: 'ENOENT' });
  await assert.rejects(f.attachments.read(document.id), { code: 'ENOENT' });
  await f.attachments.read(image.id);
  assert.equal(f.service.getRun(first.id), undefined);
  assert.ok(f.service.getRun(second.id));
  await f.service.removeConversation(second.id);
  await assert.rejects(f.attachments.read(image.id), { code: 'ENOENT' });
  await f.reload();
  assert.deepEqual((await f.service.dashboard()).runs, []);
});

test('Antigravity cumulative usage remains unknown instead of being counted as Cursor per-turn usage', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'antigravity-usage-'));
  const store = await createAgentUsageStore(root);
  t.after(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }); });
  assert.equal(extractAgentUsage('antigravity', { event: 'result', result: { usage: {
    input_tokens: 999, output_tokens: 200, thinking_tokens: 100, cache_read_tokens: 50, total_tokens: 1199,
  } } }), undefined);
  await store.upsert({ runId: 'antigravity-run', provider: 'antigravity', model,
    createdAt: new Date().toISOString(), usage: emptyAgentUsage('antigravity') });
  assert.equal(store.summary().total.unknownRuns, 1);
  assert.equal(store.list()[0]?.provider, 'antigravity');
});
