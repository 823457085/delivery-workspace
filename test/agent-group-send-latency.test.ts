import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import { createAgentGroupChat } from '../server/agent-group-chat.js';
import { defaultTeamProfileConfig } from '../shared/agent-team.js';
import type { AgentRun, AgentRuntimeHealth, AgentUsageLimits } from '../shared/agent-runtime.js';
import type { GroupMember, GroupState } from '../shared/agent-group-chat.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => resolve = done);
  return { promise, resolve };
}
// This is only a deadlock guard: progress is checked against unresolved probe gates, not a timing target.
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('受控探测仍未释放时，发送或状态等待被阻塞')), 5000);
    })]);
  } finally { clearTimeout(timer!); }
}
async function settle<T>(read: () => T, predicate: (value: T) => boolean) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const value = read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('等待受控群聊状态超时');
}
const health = (): AgentRuntimeHealth => ({ provider: 'codex', label: 'Codex', binary: 'fixture', version: 'fixture',
  ready: true, authenticated: true, message: 'ready', modes: ['ask', 'agent', 'plan'], accessModes: ['workspace', 'full'],
  models: [{ id: 'fixture-model', label: 'Fixture' }], defaultModel: 'fixture-model', writable: true, checkedAt: new Date().toISOString() });
const usage = (remaining: number): AgentUsageLimits => ({ available: true, checkedAt: new Date().toISOString(),
  primary: { usedPercent: 100 - remaining, remainingPercent: remaining, windowDurationMins: 10080, resetsAt: null } });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-group-send-')), data = path.join(root, 'data'), source = path.join(root, 'project');
  await fs.mkdir(source);
  const healthGate = deferred<AgentRuntimeHealth>(), healthStarted = deferred<void>();
  const usageGate = deferred<AgentUsageLimits>(), usageStarted = deferred<void>();
  const calls: AgentRun[] = [];
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => { healthStarted.resolve(); return healthGate.promise; },
    execute: async context => { calls.push(structuredClone(context.run)); await context.onSession(`fixture:${context.run.id}`); return '已核对用户问题 L123'; } };
  const runtime = await createAgentRuntimeService(data, { adapters: [adapter] });
  const group = await createAgentGroupChat(data, runtime, { profiles: defaultTeamProfileConfig,
    readProviderUsage: { codex: async () => { usageStarted.resolve(); return usageGate.promise; } } });
  const member: GroupMember = { id: 'captain', name: '技术负责人', instructions: '仅只读核对用户本轮问题', capability: 'read', enabled: true,
    binding: { provider: 'codex', model: 'fixture-model', reasoningEffort: '' }, fallbackBinding: null };
  await group.saveConfig({ expectedRevision: 1, name: '发送延迟测试团队', members: [member] });
  const input = { text: '请只读核对 PC 需求 L123', requestId: 'send-latency', workspacePath: source, accessMode: 'workspace' as const };
  return { group, runtime, calls, input, healthGate, healthStarted, usageGate, usageStarted,
    persisted: async () => JSON.parse(await fs.readFile(path.join(data, 'group-chat.json'), 'utf8')) as GroupState,
    cleanup: async () => { healthGate.resolve(health()); usageGate.resolve(usage(60)); await group.close(); await runtime.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

test('发送先保存用户消息并返回，健康和额度探测完成前不派发，完成后只执行一次', async () => {
  const f = await fixture();
  try {
    const sent = await bounded(f.group.send(f.input));
    const saved = (await f.persisted()).rooms.find(room => room.id === sent.room.id)!;
    assert.equal(saved.rounds[0].text, f.input.text);
    assert.equal(saved.rounds[0].state, 'queued');
    assert.equal(saved.rounds[0].turns[0].status, 'pending');
    assert.equal(f.calls.length, 0);
    await bounded(f.healthStarted.promise);
    f.healthGate.resolve(health());
    await bounded(f.usageStarted.promise);
    assert.equal(f.calls.length, 0, '健康通过但额度仍在读取时不执行模型任务');
    f.usageGate.resolve(usage(60));
    const done = await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'completed');
    assert.equal(done.room.rounds[0].text, f.input.text);
    assert.equal(f.calls.length, 1);
    await f.group.send(f.input);
    assert.equal(f.calls.length, 1, '同 requestId 重试不重复派发');
  } finally { await f.cleanup(); }
});

test('发送确认后执行器不可用，消息保留并显示真实失败原因，不启动执行', async () => {
  const f = await fixture();
  try {
    const sent = await bounded(f.group.send(f.input));
    f.healthGate.resolve({ ...health(), ready: false, message: 'fixture 执行器尚未登录' });
    const failed = await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'failed');
    assert.equal(failed.room.rounds[0].text, f.input.text);
    assert.match(failed.room.rounds[0].turns[0].error, /fixture 执行器尚未登录/);
    assert.equal(failed.room.paused, true);
    assert.equal(f.calls.length, 0);
    assert.equal((await f.persisted()).rooms[0].rounds[0].state, 'failed');
  } finally { await f.cleanup(); }
});

test('发送确认后额度用尽仍在派发前阻止执行，失败消息与原因持久保留', async () => {
  const f = await fixture();
  try {
    const sent = await bounded(f.group.send(f.input));
    f.healthGate.resolve(health());
    await bounded(f.usageStarted.promise);
    f.usageGate.resolve(usage(0));
    const failed = await settle(() => f.group.detail(sent.room.id), value => value.room.rounds[0].state === 'failed');
    assert.equal(failed.room.rounds[0].text, f.input.text);
    assert.match(failed.room.rounds[0].turns[0].error, /模型服务额度已用尽/);
    assert.equal(f.calls.length, 0);
    const saved = (await f.persisted()).rooms[0].rounds[0];
    assert.equal(saved.state, 'failed');
    assert.match(saved.turns[0].error, /模型服务额度已用尽/);
  } finally { await f.cleanup(); }
});
