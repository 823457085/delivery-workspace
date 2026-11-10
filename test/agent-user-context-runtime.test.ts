/** Exercise private user history through real runtime transitions with local, model-free adapters. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import type { AgentRun } from '../shared/agent-runtime.js';

test('超过六轮的真实用户原话在重启及执行器交接后仍可私有核对，收紧保留且删除会话清理', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'user-context-runtime-'));
  const directory = path.join(root, 'state'), workspacePath = path.join(root, 'workspace');
  await fs.mkdir(directory); await fs.mkdir(workspacePath);
  const calls: AgentRun[] = [];
  const adapters: AgentRuntimeAdapter[] = (['codex', 'cursor'] as const).map(provider => ({
    id: provider,
    health: async () => ({ provider, label: provider, binary: 'fixture', version: 'fixture', authenticated: true,
      ready: true, message: '', modes: ['agent', 'ask', 'plan'], accessModes: ['workspace', 'full'],
      models: [{ id: 'fixture', label: 'fixture' }], defaultModel: 'fixture', writable: true, checkedAt: new Date().toISOString() }),
    execute: async context => {
      calls.push(structuredClone(context.run));
      await context.onSession(context.resumeSessionId || `fixture-${context.run.id}`);
      return '合成本地结果';
    },
  }));
  const options = { adapters, codexSessionSource: { listSessions: async () => [], session: async () => { throw new Error('no imported sessions'); } } };
  let runtime = await createAgentRuntimeService(directory, options);
  const done = async (run: AgentRun) => {
    for (let i = 0; i < 300 && !run.resultReady && !['failed', 'cancelled'].includes(run.status); i++) await delay(10);
    assert.equal(run.status, 'completed', run.error); assert.equal(run.resultReady, true);
    return run;
  };
  try {
    const original = '持续授权原测试环境与合成账号登录；不要推送代码。';
    let latest = await done(await runtime.start({ provider: 'codex', mode: 'agent', accessMode: 'full', model: 'fixture',
      reasoningEffort: '', objective: original, workspacePath, attachmentIds: [] }));
    const conversationId = latest.conversationId || latest.id;
    for (let i = 0; i < 8; i++) latest = await done(await runtime.resume(latest.id, `后续检查 ${i}`));
    latest = await done(await runtime.resume(latest.id, '收紧：仅核对现有会话，不再登录。'));
    await runtime.close(); runtime = await createAgentRuntimeService(directory, options);
    const switched = await done(await runtime.start({ provider: 'cursor', mode: 'agent', accessMode: 'full', model: 'fixture',
      reasoningEffort: '', objective: '根据已有要求继续核对', workspacePath, attachmentIds: [], continueConversationId: conversationId }));
    const context = calls.at(-1)!.providerSwitch!.context;
    const match = /完整用户原话的私有记录：("(?:[^"\\]|\\.)*")/.exec(context);
    assert.ok(match, '完整原话应通过私有文件交接');
    assert.equal(context.includes(original), false, '早期原话不应被无限塞进近期摘要');
    const file = JSON.parse(match[1]!) as string;
    const saved = JSON.parse(await fs.readFile(file, 'utf8')) as { inputs: { user: string }[] };
    assert.equal(saved.inputs[0]!.user, original);
    assert.ok(saved.inputs.some(input => input.user === '收紧：仅核对现有会话，不再登录。'));
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    await done(await runtime.start({ provider: 'codex', mode: 'agent', accessMode: 'workspace', model: 'fixture',
      reasoningEffort: '', objective: '使用所选工作区继续', workspacePath, attachmentIds: [], continueConversationId: switched.conversationId }));
    assert.equal(calls.at(-1)!.providerSwitch!.context.includes(file), false, '工作区模式不开放私有状态目录');
    await runtime.removeConversation(conversationId);
    await assert.rejects(fs.access(file), { code: 'ENOENT' });
  } finally { await runtime.close(); await fs.rm(root, { recursive: true, force: true }); }
});
