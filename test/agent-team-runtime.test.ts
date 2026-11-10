import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentRuntimeService, agentExecutionPrompt, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import type { AgentProvider, AgentRun, AgentRuntimeHealth, StartAgentRunInput } from '../shared/agent-runtime.js';

type Context = Parameters<AgentRuntimeAdapter['execute']>[0];
const choices = ['gpt-6.1-sol', 'gpt-6-astra'];
function health(provider: AgentProvider): AgentRuntimeHealth {
  return { provider, label: provider, binary: `/fixture/${provider}`, version: 'fixture', authenticated: true, ready: true,
    message: 'ready', modes: ['agent', 'ask', 'plan'], defaultModel: '', writable: true, checkedAt: new Date().toISOString(),
    models: provider === 'codex' ? choices.map(id => ({ id, label: id, efforts: ['low', 'medium', 'high'] }))
      : provider === 'claude' ? [{ id: 'sonnet', label: 'Sonnet 5.5', efforts: ['low', 'medium', 'high'] }, { id: 'opus', label: 'Opus 5.5', efforts: ['low', 'medium', 'high'] }]
        : [{ id: 'composer-2.5', label: 'Composer 2.5' }] };
}
async function waitFor<T>(read: () => T, predicate: (value: T) => boolean, label: string) {
  for (let count = 0; count < 1000; count += 1) { const value = read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(`等待超时：${label}`);
}
async function harness(execute?: (context: Context) => Promise<string>, options: { beforeHoldDelay?: number } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-team-runtime-'));
  const calls: { run: AgentRun; resume: string; prompt: string }[] = [];
  const releases = new Map<string, () => void>();
  const finalized: AgentRun[] = [];
  const adapters = (['codex', 'claude', 'cursor'] as const).map(provider => ({ id: provider, health: async () => health(provider), execute: async (context: Context) => {
    await context.onSession(context.resumeSessionId || `${provider}-native-${context.run.id}`);
    if (options.beforeHoldDelay) await new Promise(resolve => setTimeout(resolve, options.beforeHoldDelay));
    if (context.signal.aborted) throw new Error('stopped');
    const call = { run: structuredClone(context.run), resume: context.resumeSessionId || '', prompt: agentExecutionPrompt(context.run) };
    if (execute) { calls.push(call); return execute(context); }
    const held = new Promise<void>((resolve, reject) => {
      const finish = () => { context.signal.removeEventListener('abort', abort); releases.delete(context.run.objective); resolve(); };
      const abort = () => { context.signal.removeEventListener('abort', abort); releases.delete(context.run.objective); reject(new Error('stopped')); };
      if (context.signal.aborted) { reject(new Error('stopped')); return; }
      releases.set(context.run.objective, finish);
      context.signal.addEventListener('abort', abort, { once: true });
    });
    // 只有 session 已落盘且 hold/abort 已注册才公开“启动”，避免负载下提前 release。
    calls.push(call);
    await held;
    return 'fixture complete';
  } }));
  const data = path.join(root, 'data');
  const service = await createAgentRuntimeService(data, { adapters, onFinalized: run => { finalized.push(structuredClone(run)); } });
  const workspace = async (name: string) => { const directory = path.join(root, name); await fs.mkdir(directory, { recursive: true }); return directory; };
  const input = async (objective: string, provider: AgentProvider = 'codex', mode: 'agent' | 'ask' = 'ask'): Promise<StartAgentRunInput> => ({
    provider, mode, model: provider === 'codex' ? 'gpt-6.1-sol' : provider === 'claude' ? 'claude-sonnet-5-5' : 'composer-2.5',
    reasoningEffort: provider === 'cursor' ? '' : 'high', objective, workspacePath: await workspace(objective) });
  const metadata = (node: string) => ({ parentConversationId: 'parent-conversation', title: node, context: `岗位上下文 ${node}`,
    team: { taskId: 'team-runtime-fixture', nodeId: node, stageKey: `team-runtime-fixture:${node}:1`, profileId: 'engineer', profileRevision: 3 },
    modelAlias: { id: 'sonnet', label: 'Sonnet 5.5' } });
  return { root, data, service, calls, releases, finalized, adapters, workspace, input, metadata,
    release: (name: string) => { const value = releases.get(name); assert.ok(value, `运行尚未启动 ${name}`); value(); },
    cleanup: async () => {
      for (const release of [...releases.values()]) release();
      await service.close();
      await fs.rm(root, { recursive: true, force: true });
    } };
}

test('高级节点按stageKey去重，完整Claude模型/只读权限/上下文与usage写入真实运行记录', async () => {
  const f = await harness(async context => {
    context.onUsage?.({ type: 'result', usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2 }, total_cost_usd: 0.02 });
    return 'node done';
  });
  try {
    const input = { ...await f.input('readonly', 'claude'), accessMode: 'full' as const };
    const metadata = { ...f.metadata('readonly'), team: { ...f.metadata('readonly').team, profileId: 'analyst' }, role: 'worker' as const };
    const first = await f.service.startTeamNode(input, metadata);
    const duplicate = await f.service.startTeamNode(input, metadata);
    assert.equal(first.id, duplicate.id);
    await waitFor(() => f.finalized.length, value => value === 1, '节点完成并回调');
    assert.equal(f.calls.length, 1);
    const stored = f.service.getRun(first.id)!;
    assert.deepEqual([stored.provider, stored.model, stored.mode, stored.accessMode], ['claude', 'claude-sonnet-5-5', 'ask', 'workspace']);
    assert.match(f.calls[0].prompt, /岗位上下文 readonly/);
    assert.equal(stored.team?.profileRevision, 3);
    assert.equal(stored.task?.parentConversationId, 'parent-conversation');
    assert.equal(stored.usage?.inputTokens, 12);
    assert.equal(stored.usage?.outputTokens, 4);
    assert.equal(stored.usage?.costUsd, 0.02);
    const disk = JSON.parse(await fs.readFile(path.join(f.data, 'agent-runs.json'), 'utf8')) as AgentRun[];
    assert.equal(disk.find(run => run.id === first.id)?.usage?.inputTokens, 12);
  } finally { await f.cleanup(); }
});

test('节点续接保留原生会话，新stageKey只创建一轮，历史stageKey重启后仍去重', async () => {
  const f = await harness(async () => 'node done');
  let reopened: Awaited<ReturnType<typeof createAgentRuntimeService>> | undefined;
  try {
    const input = await f.input('implement');
    const first = await f.service.startTeamNode(input, f.metadata('implement:1'));
    await waitFor(() => f.finalized.length, value => value === 1, '第一轮完成');
    const second = await f.service.startTeamNode({ ...input, objective: 'rework', model: 'gpt-6-astra' },
      { ...f.metadata('implement:2'), resumeRunId: first.id });
    await waitFor(() => f.finalized.length, value => value === 2, '续接完成');
    assert.equal(f.calls[1].resume, f.service.getRun(first.id)?.sessionId);
    assert.equal(second.conversationId, first.conversationId);
    assert.equal(second.parentRunId, first.id);
    await f.service.close();
    reopened = await createAgentRuntimeService(f.data, { adapters: f.adapters });
    const duplicate = await reopened.startTeamNode(input, f.metadata('implement:1'));
    assert.equal(duplicate.id, first.id);
    assert.equal(reopened.teamRuns('team-runtime-fixture').length, 2);
  } finally { await reopened?.close(); await f.cleanup(); }
});

test('未配置并发上限时全局和单执行器节点均可并发启动', async () => {
  const f = await harness();
  try {
    const one = await f.service.startTeamNode(await f.input('codex-1'), f.metadata('codex-1'));
    const two = await f.service.startTeamNode(await f.input('codex-2'), f.metadata('codex-2'));
    const three = await f.service.startTeamNode(await f.input('codex-3'), f.metadata('codex-3'));
    const claudeOne = await f.service.startTeamNode(await f.input('claude-1', 'claude'), f.metadata('claude-1'));
    const claudeTwo = await f.service.startTeamNode(await f.input('claude-2', 'claude'), f.metadata('claude-2'));
    const cursor = await f.service.startTeamNode(await f.input('cursor-1', 'cursor'), f.metadata('cursor-1'));
    await waitFor(() => f.calls.length, value => value === 6, '全部并发节点启动');
    const expected = new Set([one.id, two.id, three.id, claudeOne.id, claudeTwo.id, cursor.id]);
    assert.deepEqual(new Set(f.calls.map(call => call.run.id)), expected);
    for (const id of expected) assert.equal(f.service.getRun(id)?.status, 'running');
  } finally { await f.cleanup(); }
});

test('未配置并发上限时手动会话与团队节点均可立即启动', async () => {
  const f = await harness();
  try {
    const first = await f.service.startTeamNode(await f.input('block-one'), f.metadata('block-one'));
    const second = await f.service.startTeamNode(await f.input('block-two'), f.metadata('block-two'));
    const team = await f.service.startTeamNode(await f.input('team-wait'), f.metadata('team-wait'));
    const manual = await f.service.start(await f.input('manual-wait'));
    await waitFor(() => f.calls.length, value => value === 4, '手动与团队节点启动');
    assert.deepEqual(new Set(f.calls.map(call => call.run.id)), new Set([first.id, second.id, team.id, manual.id]));
    for (const id of [first.id, second.id, team.id, manual.id]) assert.equal(f.service.getRun(id)?.status, 'running');
  } finally { await f.cleanup(); }
});

test('同一实际目录只有一个写入者，目录别名不能绕过；只读节点可读取', async () => {
  const f = await harness();
  try {
    const workspace = await f.workspace('shared'); const alias = path.join(f.root, 'alias'); await fs.symlink(workspace, alias);
    const writer = await f.service.startTeamNode({ ...await f.input('writer', 'codex', 'agent'), workspacePath: workspace }, f.metadata('writer'));
    const waiting = await f.service.startTeamNode({ ...await f.input('second-writer', 'claude', 'agent'), workspacePath: alias }, f.metadata('second-writer'));
    const reader = await f.service.startTeamNode({ ...await f.input('reader', 'claude', 'ask'), workspacePath: workspace }, f.metadata('reader'));
    await waitFor(() => f.calls.length, value => value === 2, '一个写入者和只读节点');
    assert.equal(f.service.getRun(writer.id)?.status, 'running');
    assert.equal(f.service.getRun(waiting.id)?.status, 'queued');
    assert.equal(f.service.getRun(reader.id)?.status, 'running');
    f.release('writer');
    await waitFor(() => f.calls.length, value => value === 3, '写入者退出');
    assert.equal(f.calls[2].run.id, waiting.id);
  } finally { await f.cleanup(); }
});

test('跨执行器续接保留工作台会话，新CLI不复用另一执行器的原生会话', async () => {
  const f = await harness(async () => 'node done');
  try {
    const firstInput = await f.input('claude-implementation', 'claude');
    const first = await f.service.startTeamNode(firstInput, f.metadata('claude-implementation'));
    await waitFor(() => f.finalized.length, value => value === 1, 'Claude轮次完成');
    const next = await f.service.startTeamNode({ ...firstInput, provider: 'codex', model: 'gpt-6.1-sol', objective: 'fallback' },
      { ...f.metadata('codex-fallback'), resumeRunId: first.id });
    await waitFor(() => f.finalized.length, value => value === 2, 'Codex续接完成');
    assert.equal(f.calls[1].resume, '');
    assert.equal(next.conversationId, first.conversationId);
    assert.equal(next.providerSwitch?.from, 'claude');
    assert.equal(next.workspacePath, first.workspacePath);
  } finally { await f.cleanup(); }
});

test('未返回usage的手动运行也持久化null，不把未知写为0', async () => {
  const f = await harness(async () => 'node done');
  try {
    const run = await f.service.start(await f.input('manual-unknown-usage'));
    await waitFor(() => f.finalized.length, value => value === 1, '手动轮次完成');
    const stored = JSON.parse(await fs.readFile(path.join(f.data, 'agent-runs.json'), 'utf8')) as AgentRun[];
    const usage = stored.find(item => item.id === run.id)?.usage;
    assert.ok(usage);
    assert.equal(usage.inputTokens, null);
    assert.equal(usage.outputTokens, null);
  } finally { await f.cleanup(); }
});

test('夹具在原生会话回执等待期间关闭也能收尾，晚注册hold不会漏掉abort', { timeout: 2000 }, async () => {
  const f = await harness(undefined, { beforeHoldDelay: 50 });
  try {
    const run = await f.service.startTeamNode(await f.input('closing-before-hold'), f.metadata('closing-before-hold'));
    await f.service.close();
    assert.equal(f.service.getRun(run.id)?.status, 'cancelled');
    assert.equal(f.releases.size, 0);
  } finally { await f.cleanup(); }
});
