import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import type { AgentRun, AgentRuntimeHealth } from '../shared/agent-runtime.js';

const health: AgentRuntimeHealth = { provider: 'claude', label: 'Claude Code', binary: '/fixture/claude', version: 'fixture',
  authenticated: true, ready: true, message: 'fixture', modes: ['agent', 'plan', 'ask'], accessModes: ['workspace', 'full'],
  models: [{ id: '', label: '默认' }], defaultModel: '', writable: true, checkedAt: '' };
async function completed(run: AgentRun) {
  for (let attempt = 0; attempt < 100 && ['running', 'queued'].includes(run.status); attempt++) await delay(10);
  assert.equal(run.status, 'completed', run.error);
}

test('Claude 运行、续聊和自定义模型跨服务重建保留；拒绝 Codex 速度参数', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-service-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const resumes: (string | undefined)[] = [];
  const attachmentDirectories = new Map<string, string>();
  const attachmentReadDirectories = new Map<string, string[]>();
  const adapter: AgentRuntimeAdapter = { id: 'claude', health: async () => health, execute: async context => {
    resumes.push(context.resumeSessionId);
    attachmentDirectories.set(context.run.id, context.attachmentDirectory!);
    attachmentReadDirectories.set(context.run.id, context.attachmentReadDirectories || []);
    await context.onSession('claude-service-session');
    return context.run.objective;
  } };
  let service = await createAgentRuntimeService(directory, { adapters: [adapter] });
  const input = { provider: 'claude' as const, mode: 'ask' as const, model: '', objective: '第一条', workspacePath: '' };
  try {
    await assert.rejects(service.start({ ...input, accessMode: 'full' }), /只有 Agent 模式可使用完全访问/);
    await assert.rejects(service.start({ ...input, serviceTier: 'default' }), /不使用 Codex 速度/);
    const first = await service.start(input);
    await completed(first);
    const staged = attachmentDirectories.get(first.id)!;
    await fs.mkdir(staged, { recursive: true });
    await fs.writeFile(path.join(staged, 'attachment.txt'), '本轮附件');
    const second = await service.resume(first.id, '第二条');
    await completed(second);
    assert.equal(second.provider, 'claude');
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.conversationId, first.conversationId);
    assert.equal(second.workspacePath, first.workspacePath);
    assert.deepEqual(resumes, ['', 'claude-service-session']);
    assert.deepEqual(attachmentReadDirectories.get(second.id), [staged]);
    const separate = await service.start({ ...input, objective: '另一个会话' });
    await completed(separate);
    assert.deepEqual(attachmentReadDirectories.get(separate.id), []);
    await service.addCustomModel({ provider: 'claude', modelId: 'custom-claude-model', label: '自定义 Claude' });
    await service.close();
    service = await createAgentRuntimeService(directory, { adapters: [adapter] });
    const dashboard = await service.dashboard();
    assert.equal(dashboard.runtimes[0].provider, 'claude');
    assert.ok(dashboard.runtimes[0].models.some(model => model.id === 'custom-claude-model'));
    assert.equal(dashboard.runs.find(run => run.id === second.id)?.sessionId, 'claude-service-session');
    await service.removeConversation(first.conversationId!);
    await assert.rejects(fs.access(staged), { code: 'ENOENT' });
  } finally { await service.close(); }
});

test('Claude Agent 完全访问和续聊每轮权限跨服务重建保留', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-full-service-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executed: { accessMode: AgentRun['accessMode']; resumeSessionId: string | undefined }[] = [];
  const adapter: AgentRuntimeAdapter = { id: 'claude', health: async () => health, execute: async context => {
    executed.push({ accessMode: context.run.accessMode, resumeSessionId: context.resumeSessionId });
    await context.onSession(context.resumeSessionId || `claude-${context.run.accessMode}-session`);
    return context.run.objective;
  } };
  let service = await createAgentRuntimeService(directory, { adapters: [adapter] });
  try {
    const first = await service.start({ provider: 'claude', mode: 'agent', accessMode: 'full', model: '',
      objective: '完全访问', workspacePath: directory });
    await completed(first);
    const second = await service.resume(first.id, '继续完全访问');
    await completed(second);
    const third = await service.resume(second.id, '改为工作区访问', '', '', [], 'workspace');
    await completed(third);
    assert.deepEqual(executed, [
      { accessMode: 'full', resumeSessionId: '' },
      { accessMode: 'full', resumeSessionId: 'claude-full-session' },
      { accessMode: 'workspace', resumeSessionId: '' },
    ]);
    assert.equal(third.conversationId, first.conversationId);
    assert.equal(third.sessionId, 'claude-workspace-session');
    assert.notEqual(third.sessionId, second.sessionId);
    assert.equal(first.accessMode, 'full');
    await service.close();
    service = await createAgentRuntimeService(directory, { adapters: [adapter] });
    const dashboard = await service.dashboard();
    for (const run of [first, second, third]) {
      assert.equal(dashboard.runs.find(saved => saved.id === run.id)?.accessMode, run.accessMode);
    }
  } finally { await service.close(); }
});

test('Claude 按模型校验强度，续聊和服务重建保留选择，默认不覆盖 CLI 配置', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-effort-service-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executed: { effort: AgentRun['reasoningEffort']; resumeSessionId: string | undefined }[] = [];
  const adapter: AgentRuntimeAdapter = { id: 'claude', health: async () => ({ ...health, models: [
    ...health.models, { id: 'opus', label: 'Opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'limited', label: 'Limited', efforts: ['low', 'medium', 'high', 'max'] },
  ] }), execute: async context => {
    executed.push({ effort: context.run.reasoningEffort, resumeSessionId: context.resumeSessionId });
    await context.onSession('claude-effort-session');
    return context.run.objective;
  } };
  let service = await createAgentRuntimeService(directory, { adapters: [adapter] });
  const input = { provider: 'claude' as const, mode: 'ask' as const, model: 'opus', objective: '选择强度', workspacePath: '' };
  try {
    await assert.rejects(service.start({ ...input, reasoningEffort: 'ultra' }), /推理强度不受当前模型支持/);
    await assert.rejects(service.start({ ...input, model: 'limited', reasoningEffort: 'xhigh' }), /推理强度不受当前模型支持/);
    await assert.rejects(service.start({ ...input, model: '', reasoningEffort: 'high' }), /推理强度不受当前模型支持/);
    const first = await service.start({ ...input, reasoningEffort: 'xhigh' });
    await completed(first);
    const second = await service.resume(first.id, '沿用强度');
    await completed(second);
    await service.close();
    service = await createAgentRuntimeService(directory, { adapters: [adapter] });
    assert.equal((await service.dashboard()).runs.find(run => run.id === second.id)?.reasoningEffort, 'xhigh');
    const third = await service.resume(second.id, '恢复 CLI 默认', 'opus', '');
    await completed(third);
    assert.deepEqual(executed, [
      { effort: 'xhigh', resumeSessionId: '' },
      { effort: 'xhigh', resumeSessionId: 'claude-effort-session' },
      { effort: '', resumeSessionId: 'claude-effort-session' },
    ]);
    assert.equal(third.reasoningEffort, '');
    assert.equal(third.conversationId, first.conversationId);
  } finally { await service.close(); }
});

test('Claude 账号维护锁阻止新任务；任务执行期间禁止账号切换', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-maintenance-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let finish!: (text: string) => void;
  const adapter: AgentRuntimeAdapter = { id: 'claude', health: async () => health,
    execute: async context => new Promise((resolve, reject) => {
      finish = resolve;
      context.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
    }) };
  const service = await createAgentRuntimeService(directory, { adapters: [adapter] });
  const input = { provider: 'claude' as const, mode: 'ask' as const, model: '', objective: 'fixture', workspacePath: '' };
  try {
    await service.withProviderMaintenance('claude', async () => {
      assert.equal((await service.dashboard()).runtimes[0].ready, false);
      await assert.rejects(service.start(input), /Claude Code 账号/);
    });
    const run = await service.start(input);
    for (let attempt = 0; attempt < 100 && !finish; attempt++) await delay(10);
    await assert.rejects(service.withProviderMaintenance('claude', async () => {}), /Claude Code.*任务/);
    finish('完成');
    await completed(run);
    await service.withProviderMaintenance('claude', async () => {});
  } finally { finish?.('停止'); await service.close(); }
});
