/** 使用受控 CLI 验证暂停/编辑的队列时序，不启动真实 Agent，也不改用户会话。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import type { AgentRun } from '../shared/agent-runtime.js';

async function fixture(provider: 'codex' | 'cursor' = 'codex', firstSession = true) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-message-edit-'));
  const executions: { run: AgentRun; session: string; finish: () => void }[] = [];
  let firstConversationId = '';
  const attachment = { id: 'image-1', name: 'screen.png', mimeType: 'image/png' as const, size: 1, url: '/image-1' };
  const adapter: AgentRuntimeAdapter = { id: provider, health: async () => ({
    provider, label: provider, binary: '/mock', version: 'test', authenticated: true, ready: true, message: '',
    modes: ['ask'], models: [{ id: 'test', label: 'test' }], defaultModel: 'test', writable: false, checkedAt: '',
  }), execute: context => new Promise((resolve, reject) => {
    firstConversationId ||= context.run.conversationId || context.run.id;
    const sessionId = context.resumeSessionId || ((context.run.conversationId || context.run.id) === firstConversationId
      ? 'session-kept' : `session-${context.run.conversationId || context.run.id}`);
    if (firstSession || executions.length) context.onSession(sessionId);
    executions.push({ run: context.run, session: context.resumeSessionId || '', finish: () => resolve('done') });
    context.onOutput?.('已生成的部分结果');
    const abort = () => reject(new Error('stopped'));
    if (context.signal.aborted) abort(); else context.signal.addEventListener('abort', abort, { once: true });
  }) };
  const options = { adapters: [adapter], resolveWorkspace: async () => ({ workspacePath: directory, branch: '', headSha: '' }),
    resolveAttachments: async (ids: string[]) => ids.map(() => ({ attachment, filePath: path.join(directory, 'screen.png') })) };
  const service = await createAgentRuntimeService(directory, options);
  const start = () => service.start({ provider, mode: 'ask', model: 'test', objective: '原要求', workspacePath: directory, attachmentIds: [attachment.id],
    ...(provider === 'codex' ? { serviceTier: 'default' as const } : {}) });
  return { directory, executions, attachment, options, service, start,
    close: async () => { await service.close(); await fs.rm(directory, { recursive: true, force: true }); } };
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check(), '等待状态变更超时');
}

for (const provider of ['codex', 'cursor'] as const) {
  test(`${provider} 暂停等待退出，保存保留原结果及附件，修订先于排队消息执行`, { timeout: 10000 }, async () => {
    const f = await fixture(provider);
    try {
      const original = await f.start();
      await waitFor(() => f.executions.length === 1);
      const queued = await f.service.resume(original.id, '后续消息');
      assert.equal(queued.status, 'queued');
      const paused = await f.service.pauseForEdit(original.id);
      assert.equal(paused.status, 'cancelled');
      assert.equal(paused.pausedForEdit, true);
      assert.equal(paused.pid, null);
      assert.equal(paused.objective, '原要求');
      assert.equal(paused.result, '已生成的部分结果');
      await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(f.executions.length, 1);
      assert.equal(queued.status, 'queued');
      if (provider === 'cursor') await assert.rejects(f.service.revise(original.id, '新要求', '/wrong'), /信任确认/);
      const next = await f.service.revise(original.id, '修订后的要求', provider === 'cursor' ? f.directory : undefined);
      await waitFor(() => f.executions.length === 2);
      assert.equal(next.objective, '修订后的要求');
      assert.equal(next.revisesRunId, original.id);
      assert.equal(next.parentRunId, original.id);
      assert.equal(next.accessMode, original.accessMode);
      assert.equal(next.serviceTier, original.serviceTier);
      assert.equal(queued.serviceTier, original.serviceTier);
      assert.deepEqual(next.attachments, [f.attachment]);
      assert.equal(f.executions[1].session, 'session-kept');
      assert.equal(original.pausedForEdit, false);
      assert.equal(original.objective, '原要求');
      assert.equal(queued.status, 'queued');
      await assert.rejects(f.service.revise(original.id, '重复保存'), /先暂停/);
      f.executions[1].finish();
      await waitFor(() => f.executions.length === 3);
      assert.equal(f.executions[2].run.id, queued.id);
      assert.equal(queued.parentRunId, next.id);
    } finally { await f.close(); }
  });
}

test('未取得 sessionId 也可暂停编辑，新轮创建会话后后续队列可恢复', { timeout: 10000 }, async () => {
  const f = await fixture('codex', false);
  try {
    const original = await f.start();
    await waitFor(() => f.executions.length === 1);
    const queued = await f.service.resume(original.id, '后续消息');
    await f.service.pauseForEdit(original.id);
    const next = await f.service.revise(original.id, '修订');
    await waitFor(() => f.executions.length === 2);
    assert.equal(f.executions[1].session, '');
    assert.equal(next.sessionId, 'session-kept');
    f.executions[1].finish();
    await waitFor(() => f.executions.length === 3);
    assert.equal(f.executions[2].run.id, queued.id);
    assert.equal(f.executions[2].session, 'session-kept');
  } finally { await f.close(); }
});

test('暂停状态重启可恢复；已完成消息不允许编辑', { timeout: 10000 }, async () => {
  const f = await fixture();
  let restored: Awaited<ReturnType<typeof createAgentRuntimeService>> | undefined;
  try {
    const original = await f.start();
    await waitFor(() => f.executions.length === 1);
    await f.service.pauseForEdit(original.id);
    await f.service.close();
    restored = await createAgentRuntimeService(f.directory, f.options);
    const saved = (await restored.dashboard()).runs.find(run => run.id === original.id)!;
    assert.equal(saved.pausedForEdit, true);
    const next = await restored.revise(saved.id, '恢复后修改');
    await waitFor(() => f.executions.length === 2);
    f.executions[1].finish();
    await waitFor(() => next.status === 'completed');
    await assert.rejects(restored.pauseForEdit(next.id), /已完成/);
  } finally { await restored?.close(); await f.close(); }
});

test('编辑排队消息先暂停当前执行；空内容拒绝后保持暂停，不影响另一会话', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const original = await f.start();
    await waitFor(() => f.executions.length === 1);
    const queued = await f.service.resume(original.id, '待编辑消息');
    await f.service.pauseForEdit(queued.id);
    assert.equal(original.status, 'cancelled');
    assert.equal(queued.pausedForEdit, true);
    await assert.rejects(f.service.revise(queued.id, '   '), /任务目标或添加附件/);
    assert.equal(queued.pausedForEdit, true);
    assert.equal(f.executions.length, 1);
    await f.start();
    await waitFor(() => f.executions.length === 2);
    assert.equal(queued.pausedForEdit, true);
    const revised = await f.service.revise(queued.id, '修改后的排队消息');
    await waitFor(() => f.executions.length === 3);
    assert.equal(revised.sessionId, 'session-kept');
    assert.equal(revised.parentRunId, queued.id);
  } finally { await f.close(); }
});
