/** Exercise mode changes through the real scheduler and persisted runtime; never invoke a model CLI. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import type { AgentProvider, AgentRun, AgentRuntimeHealth, StartAgentRunInput } from '../shared/agent-runtime.js';

type Context = Parameters<AgentRuntimeAdapter['execute']>[0];
const model = 'fixture-model';

async function until(condition: () => boolean, label: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (condition()) return;
    await delay(10);
  }
  assert.ok(condition(), label);
}

async function completed(run: AgentRun) {
  await until(() => !!run.resultReady || ['failed', 'cancelled', 'interrupted'].includes(run.status), '等待运行结束超时');
  assert.equal(run.status, 'completed', run.error);
  assert.equal(run.resultReady, true);
}

function history(workspacePath: string, overrides: Partial<AgentRun> = {}): AgentRun {
  const id = randomUUID(), now = new Date().toISOString();
  return { id, conversationId: id, queueRootId: id, provider: 'kiro', mode: 'ask', accessMode: 'workspace',
    model, reasoningEffort: '', objective: '历史只读消息', workspacePath, branch: '', headSha: '', status: 'completed',
    sessionId: `kiro-native-${id}`, pid: null, result: '历史回复', error: '', events: [], createdAt: now, updatedAt: now,
    ...overrides };
}

async function fixture(t: TestContext, options: {
  seed?: (workspacePath: string) => unknown[]; controlled?: boolean; live?: boolean; failFirst?: string;
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-mode-switch-'));
  const directory = path.join(root, 'state'), workspacePath = path.join(root, 'workspace');
  await Promise.all([fs.mkdir(directory), fs.mkdir(workspacePath)]);
  const seeds = options.seed?.(workspacePath) || [];
  if (seeds.length) await fs.writeFile(path.join(directory, 'agent-runs.json'), JSON.stringify(seeds));
  const calls: { run: AgentRun; resume: string }[] = [];
  const releases = new Map<string, () => void>();
  const supplements: { runId: string; text: string }[] = [];
  const failures = new Set<string>();
  const health = (provider: AgentProvider): AgentRuntimeHealth => ({ provider, label: provider, binary: '/fixture',
    version: 'fixture', authenticated: true, ready: true, message: '', modes: ['ask', 'plan', 'agent'],
    accessModes: ['workspace', 'full'], models: [{ id: model, label: model }], defaultModel: model, writable: true,
    checkedAt: new Date().toISOString() });
  const adapters: AgentRuntimeAdapter[] = (['kiro', 'cursor'] as const).map(provider => ({ id: provider,
    health: async () => health(provider), execute: async (context: Context) => {
      await context.onSession(context.resumeSessionId || `${provider}-native-${context.run.id}`);
      if (options.live) context.onSteer?.(async input => { supplements.push({ runId: context.run.id, text: input.text }); });
      if (options.failFirst === context.run.objective && !failures.has(context.run.objective)) {
        failures.add(context.run.objective);
        calls.push({ run: structuredClone(context.run), resume: context.resumeSessionId || '' });
        throw new Error('fixture intentional failure');
      }
      const held = options.controlled ? new Promise<void>((resolve, reject) => {
        const finish = () => { context.signal.removeEventListener('abort', abort); releases.delete(context.run.id); resolve(); };
        const abort = () => { context.signal.removeEventListener('abort', abort); releases.delete(context.run.id); reject(new Error('fixture stopped')); };
        if (context.signal.aborted) { reject(new Error('fixture stopped')); return; }
        releases.set(context.run.id, finish);
        context.signal.addEventListener('abort', abort, { once: true });
      }) : undefined;
      calls.push({ run: structuredClone(context.run), resume: context.resumeSessionId || '' });
      await held;
      return `完成：${context.run.objective}`;
    } }));
  const service = await createAgentRuntimeService(directory, { adapters,
    codexSessionSource: { listSessions: async () => [], session: async () => { throw new Error('fixture has no Codex session'); } } });
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  const input = (objective: string, override: Partial<StartAgentRunInput> = {}): StartAgentRunInput => ({
    provider: 'kiro', mode: 'ask', accessMode: 'workspace', model, reasoningEffort: '', objective, workspacePath, ...override,
  });
  return { service, directory, workspacePath, calls, releases, supplements, input,
    release: (run: AgentRun) => { const release = releases.get(run.id); assert.ok(release, '运行尚未进入受控执行阶段'); release(); } };
}

test('普通续聊变更权限时新建原生会话，同权限复用且保留聊天与历史配置', async t => {
  const f = await fixture(t);
  const first = await f.service.start(f.input('先只读'));
  await completed(first);
  const firstSnapshot = structuredClone(first);
  const workspace = await f.service.resume(first.id, '允许工作区写入', model, '', [], 'workspace', 'append', undefined, 'agent');
  await completed(workspace);
  const inherited = await f.service.resume(workspace.id, '旧调用继续');
  await completed(inherited);
  const full = await f.service.resume(inherited.id, '明确完全访问', model, '', [], 'full', 'append', undefined, 'agent');
  await completed(full);
  const readOnly = await f.service.resume(full.id, '下一轮恢复只读', model, '', [], undefined, 'append', undefined, 'ask');
  await completed(readOnly);
  const stillReadOnly = await f.service.resume(readOnly.id, '省略模式仍为只读');
  await completed(stillReadOnly);
  assert.deepEqual([first, workspace, inherited, full, readOnly, stillReadOnly].map(run => [run.mode, run.accessMode]),
    [['ask', 'workspace'], ['agent', 'workspace'], ['agent', 'workspace'], ['agent', 'full'], ['ask', 'workspace'], ['ask', 'workspace']]);
  assert.deepEqual(f.calls.map(call => call.resume), ['', '', workspace.sessionId, '', '', readOnly.sessionId]);
  assert.match(workspace.accessTransition?.context || '', /先只读/);
  assert.match(full.accessTransition?.context || '', /旧调用继续/);
  assert.ok([workspace, inherited, full, readOnly, stillReadOnly].every(run => run.conversationId === first.conversationId));
  assert.deepEqual(first, firstSnapshot);
  await assert.rejects(f.service.resume(stillReadOnly.id, '无效只读完全访问', model, '', [], 'full', 'append', undefined, 'ask'), /只有 Agent/);
  assert.equal(f.calls.length, 6);
  const saved = JSON.parse(await fs.readFile(path.join(f.directory, 'agent-runs.json'), 'utf8')) as AgentRun[];
  assert.deepEqual(saved.find(run => run.id === first.id)?.mode, 'ask');
  assert.equal(saved.find(run => run.id === full.id)?.accessMode, 'full');
});

test('旧团队主对话的 main/workflow/team sourceId 记录允许手动切换下一轮模式', async t => {
  let original!: AgentRun;
  const sourceId = `team:${randomUUID()}`;
  const f = await fixture(t, { seed: workspacePath => {
    original = history(workspacePath, { task: { parentConversationId: '', dependsOnConversationIds: [], role: 'main',
      title: '旧团队主对话', source: 'workflow', sourceId } });
    return [{ ...original, team: null }];
  } });
  const next = await f.service.resume(original.id, '主对话明确执行', model, '', [], 'full', 'append', undefined, 'agent');
  await completed(next);
  assert.equal(next.mode, 'agent'); assert.equal(next.accessMode, 'full');
  assert.equal(next.task?.role, 'main'); assert.equal(next.task?.source, 'workflow'); assert.equal(next.task?.sourceId, sourceId);
  assert.notEqual(next.sessionId, original.sessionId);
  assert.match(next.accessTransition?.context || '', /历史回复/);
  assert.equal(f.service.getRun(original.id)?.mode, 'ask');
  const switched = await f.service.start(f.input('主对话跨执行器恢复只读', { provider: 'cursor', mode: 'ask',
    continueConversationId: original.conversationId }));
  await completed(switched);
  assert.equal(switched.mode, 'ask'); assert.equal(switched.task?.role, 'main');
  assert.equal(switched.conversationId, original.conversationId);
  assert.equal(f.calls.at(-1)?.resume, '');
});

test('worker/reviewer 与带 team 的岗位拒绝经续聊或跨执行器改写固定模式', async t => {
  let nodes: AgentRun[] = [];
  const f = await fixture(t, { seed: workspacePath => {
    nodes = [
      history(workspacePath, { task: { parentConversationId: randomUUID(), dependsOnConversationIds: [], role: 'worker',
        title: '分析岗位', source: 'workflow' } }),
      history(workspacePath, { task: { parentConversationId: randomUUID(), dependsOnConversationIds: [], role: 'reviewer',
        title: '只读审查', source: 'manual' } }),
      history(workspacePath, { task: { parentConversationId: '', dependsOnConversationIds: [], role: 'main',
        title: '仍有真实 team 的节点', source: 'workflow' },
        team: { taskId: randomUUID(), nodeId: randomUUID(), stageKey: 'review:1', profileId: 'reviewer', profileRevision: 1 } }),
    ];
    return nodes;
  } });
  for (const node of nodes) {
    await assert.rejects(f.service.resume(node.id, '不允许升权', model, '', [], 'full', 'append', undefined, 'agent'), /团队岗位.*模式/);
    await assert.rejects(f.service.start(f.input('跨执行器也不能升权', { provider: 'cursor', mode: 'agent', accessMode: 'full',
      continueConversationId: node.conversationId })), /团队岗位.*模式/);
    assert.equal(f.service.getRun(node.id)?.mode, 'ask');
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await f.service.dashboard()).runs.length, nodes.length);
});

test('跨执行器传递显式模式但不复用另一 CLI 会话，同 provider 路径准确续接', async t => {
  const f = await fixture(t);
  const first = await f.service.start(f.input('Kiro 只读'));
  await completed(first);
  const switched = await f.service.start(f.input('Cursor 工作区执行', { provider: 'cursor', mode: 'agent',
    accessMode: 'workspace', continueConversationId: first.conversationId }));
  await completed(switched);
  assert.equal(switched.mode, 'agent'); assert.equal(switched.accessMode, 'workspace');
  assert.equal(switched.providerSwitch?.from, 'kiro'); assert.equal(f.calls[1].resume, '');
  assert.notEqual(switched.sessionId, first.sessionId);
  const sameProvider = await f.service.start(f.input('同执行器改回只读', { provider: 'cursor', mode: 'ask',
    continueConversationId: first.conversationId }));
  await completed(sameProvider);
  assert.equal(sameProvider.mode, 'ask'); assert.equal(sameProvider.accessMode, 'workspace');
  assert.equal(f.calls[2].resume, '');
  assert.notEqual(sameProvider.sessionId, switched.sessionId);
  assert.equal(first.mode, 'ask'); assert.equal(switched.mode, 'agent');
});

test('排队下一轮冻结各自模式，串行启动并在权限边界切换原生会话', async t => {
  const f = await fixture(t, { controlled: true });
  const first = await f.service.start(f.input('运行中的只读轮'));
  await until(() => f.releases.has(first.id), '首轮未启动');
  const second = await f.service.resume(first.id, '排队的完全访问轮', model, '', [], 'full', 'append', undefined, 'agent');
  const third = await f.service.resume(second.id, '随后恢复只读', model, '', [], undefined, 'append', undefined, 'ask');
  assert.equal(second.status, 'queued'); assert.equal(third.status, 'queued');
  assert.deepEqual([first, second, third].map(run => [run.mode, run.accessMode]),
    [['ask', 'workspace'], ['agent', 'full'], ['ask', 'workspace']]);
  assert.equal(f.calls.length, 1);
  f.release(first);
  await until(() => f.releases.has(second.id), '第二轮未启动');
  assert.deepEqual([f.calls[1].run.mode, f.calls[1].run.accessMode, f.calls[1].resume], ['agent', 'full', '']);
  assert.match(f.calls[1].run.accessTransition?.context || '', /完成：运行中的只读轮/);
  assert.equal(third.status, 'queued');
  f.release(second);
  await until(() => f.releases.has(third.id), '第三轮未启动');
  assert.deepEqual([f.calls[2].run.mode, f.calls[2].run.accessMode, f.calls[2].resume], ['ask', 'workspace', '']);
  f.release(third); await completed(third);
  assert.deepEqual(f.calls.map(call => call.run.id), [first.id, second.id, third.id]);
  assert.equal(new Set([first, second, third].map(run => run.sessionId)).size, 3);
});

test('实时插入拒绝改变当前模式，省略模式的补充仍送达原轮且不新建运行', async t => {
  const f = await fixture(t, { controlled: true, live: true });
  const first = await f.service.start(f.input('保持当前只读轮'));
  await until(() => f.releases.has(first.id) && !!first.liveInputReady, '当前轮未提供实时输入');
  await assert.rejects(f.service.resume(first.id, '不能插入可写模式', model, '', [], 'workspace', 'next', undefined, 'agent'), /插入沿用当前轮模式/);
  assert.deepEqual(f.supplements, []);
  const same = await f.service.resume(first.id, '仍然只读的补充', model, '', [], 'workspace', 'next');
  assert.equal(same.id, first.id);
  assert.deepEqual(f.supplements, [{ runId: first.id, text: '仍然只读的补充' }]);
  assert.equal((await f.service.dashboard()).runs.length, 1);
  assert.equal(first.mode, 'ask'); assert.equal(first.accessMode, 'workspace');
  f.release(first); await completed(first);
});

test('权限切换轮尚未取得session时继续排入同权限消息，后续复用新权限会话', async t => {
  const f = await fixture(t, { controlled: true });
  const first = await f.service.start(f.input('当前只读轮'));
  await until(() => f.releases.has(first.id), '首轮未启动');
  const second = await f.service.resume(first.id, '排队授权完全访问', model, '', [], 'full', 'append', undefined, 'agent');
  const third = await f.service.resume(second.id, '同权限继续排队');
  assert.equal(third.status, 'queued');
  f.release(first);
  await until(() => f.releases.has(second.id), '权限切换轮未启动');
  f.release(second);
  await until(() => f.releases.has(third.id), '同权限后续轮未启动');
  assert.deepEqual(f.calls.map(call => call.resume), ['', '', second.sessionId]);
  assert.equal(third.sessionId, second.sessionId);
  f.release(third); await completed(third);
});

test('权限变更的排队消息调整方向后仍新建原生会话，不回填正在运行的只读session', async t => {
  const f = await fixture(t, { controlled: true });
  const first = await f.service.start(f.input('正在运行的只读任务'));
  await until(() => f.releases.has(first.id), '首轮未启动');
  const next = await f.service.resume(first.id, '允许立即执行', model, '', [], 'full', 'append', undefined, 'agent');
  await f.service.steer(next.id);
  await until(() => f.releases.has(next.id), '调整方向后的新轮未启动');
  assert.equal(f.calls[1].resume, '');
  assert.notEqual(next.sessionId, first.sessionId);
  assert.deepEqual([next.mode, next.accessMode], ['agent', 'full']);
  f.release(next); await completed(next);
});

test('模式切换后的失败重试沿用该失败轮权限和精确会话，不回退或改写旧轮', async t => {
  const f = await fixture(t, { failFirst: '失败一次' });
  const first = await f.service.start(f.input('最初只读'));
  await completed(first);
  const failed = await f.service.resume(first.id, '失败一次', model, '', [], 'full', 'append', undefined, 'agent');
  await until(() => failed.status === 'failed', '预期失败未发生');
  const retried = await f.service.retry(failed.id);
  await completed(retried);
  assert.deepEqual([retried.mode, retried.accessMode, retried.sessionId], ['agent', 'full', failed.sessionId]);
  assert.equal(f.calls.at(-1)?.resume, failed.sessionId);
  assert.notEqual(failed.sessionId, first.sessionId);
  assert.equal(retried.parentRunId, failed.id);
  assert.equal(first.mode, 'ask'); assert.equal(first.accessMode, 'workspace');
  assert.equal(failed.status, 'failed');
});

test('重新执行旧只读失败轮采用当前完全访问并新建原生会话，保留历史原轮', async t => {
  for (const mode of ['ask', 'plan'] as const) await t.test(mode, async t => {
    const f = await fixture(t, { failFirst: '失败一次' });
    const failed = await f.service.start(f.input('失败一次', { mode }));
    await until(() => failed.status === 'failed' && f.service.isIdle(), '预期失败未结束');
    const original = structuredClone(failed);
    const originalSaved = (JSON.parse(await fs.readFile(path.join(f.directory, 'agent-runs.json'), 'utf8')) as AgentRun[])
      .find(run => run.id === failed.id);
    const retried = await f.service.retry(failed.id, undefined, { mode: 'agent', accessMode: 'full' });
    await completed(retried);
    assert.deepEqual([retried.mode, retried.accessMode], ['agent', 'full']);
    assert.notEqual(retried.sessionId, failed.sessionId);
    assert.equal(retried.parentRunId, failed.id);
    assert.equal(retried.conversationId, failed.conversationId);
    assert.deepEqual([f.calls.at(-1)?.run.mode, f.calls.at(-1)?.run.accessMode, f.calls.at(-1)?.resume],
      ['agent', 'full', '']);
    assert.deepEqual(f.service.getRun(failed.id), original);
    const saved = JSON.parse(await fs.readFile(path.join(f.directory, 'agent-runs.json'), 'utf8')) as AgentRun[];
    assert.deepEqual(saved.find(run => run.id === failed.id), originalSaved);
    assert.deepEqual([saved.find(run => run.id === retried.id)?.mode, saved.find(run => run.id === retried.id)?.accessMode], ['agent', 'full']);
  });
});

test('重新执行未提供新选择时沿用原轮的只读权限', async t => {
  for (const mode of ['ask', 'plan'] as const) await t.test(mode, async t => {
    let original!: AgentRun;
    const f = await fixture(t, { seed: workspacePath => [original = history(workspacePath, { mode, status: 'failed' })] });
    const retried = await f.service.retry(original.id);
    await completed(retried);
    assert.deepEqual([retried.mode, retried.accessMode, f.calls[0]?.resume], [mode, 'workspace', original.sessionId]);
  });
});

test('重新执行明确选择只读时不继承旧轮的完全访问', async t => {
  for (const mode of ['ask', 'plan'] as const) await t.test(mode, async t => {
    let original!: AgentRun;
    const f = await fixture(t, { seed: workspacePath => [original = history(workspacePath, { mode: 'agent', accessMode: 'full', status: 'failed' })] });
    const retried = await f.service.retry(original.id, undefined, { mode });
    await completed(retried);
    assert.deepEqual([retried.mode, retried.accessMode, f.calls[0]?.run.mode, f.calls[0]?.run.accessMode],
      [mode, 'workspace', mode, 'workspace']);
    assert.deepEqual([f.service.getRun(original.id)?.mode, f.service.getRun(original.id)?.accessMode], ['agent', 'full']);
  });
});

test('重新执行拒绝只读模式与完全访问的无效组合', async t => {
  let original!: AgentRun;
  const f = await fixture(t, { seed: workspacePath => [original = history(workspacePath, { status: 'failed' })] });
  await assert.rejects(f.service.retry(original.id, undefined, { mode: 'ask', accessMode: 'full' }), /只有 Agent/);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.service.dashboard()).runs.length, 1);
});

test('团队节点从旧只读轮切到完全访问创建新会话，后续同权限节点继续复用', async t => {
  const f = await fixture(t);
  const metadata = (stageKey: string, resumeRunId?: string) => ({ parentConversationId: 'team-parent', title: stageKey,
    context: '执行本轮团队任务', resumeRunId,
    team: { taskId: 'permission-team', nodeId: stageKey, stageKey, profileId: 'engineer', profileRevision: 1 } });
  const first = await f.service.startTeamNode(f.input('旧只读调查'), metadata('investigate'));
  await completed(first);
  const full = await f.service.startTeamNode(f.input('执行已授权修改', { mode: 'agent', accessMode: 'full' }), metadata('implement', first.id));
  await completed(full);
  const continued = await f.service.startTeamNode(f.input('继续完整权限', { mode: 'agent', accessMode: 'full' }), metadata('continue', full.id));
  await completed(continued);
  assert.deepEqual(f.calls.map(call => call.resume), ['', '', full.sessionId]);
  assert.match(full.accessTransition?.context || '', /完成：旧只读调查/);
  assert.equal(continued.conversationId, first.conversationId);
  assert.deepEqual([first.mode, first.accessMode], ['ask', 'workspace']);
});

test('旧版本曾把完全访问轮续到只读session时，重试按原生创建权限重建', async t => {
  let original!: AgentRun, legacy!: AgentRun;
  const f = await fixture(t, { seed: workspacePath => {
    original = history(workspacePath);
    legacy = history(workspacePath, { parentRunId: original.id, conversationId: original.conversationId,
      queueRootId: original.queueRootId, sessionId: original.sessionId, mode: 'agent', accessMode: 'full', status: 'failed',
      objective: '旧版已选择完全访问', createdAt: new Date(Date.parse(original.createdAt) + 1).toISOString() });
    return [legacy, original];
  } });
  const next = await f.service.retry(legacy.id);
  await completed(next);
  assert.equal(f.calls[0].resume, '');
  assert.notEqual(next.sessionId, original.sessionId);
  assert.match(next.accessTransition?.context || '', /旧版已选择完全访问/);
  assert.equal(f.service.getRun(legacy.id)?.sessionId, original.sessionId);
});

test('重启恢复旧权限切换队列时不复用只读session，也不改写原轮权限', async t => {
  let original!: AgentRun, queued!: AgentRun;
  const f = await fixture(t, { seed: workspacePath => {
    original = history(workspacePath);
    queued = history(workspacePath, { parentRunId: original.id, conversationId: original.conversationId,
      queueRootId: original.queueRootId, sessionId: original.sessionId, mode: 'agent', accessMode: 'full', status: 'cancelled',
      objective: '重启前已授权的完全访问轮', pausedForEdit: true, resumeAfterWorkspaceRestart: true,
      createdAt: new Date(Date.parse(original.createdAt) + 1).toISOString() });
    return [queued, original];
  } });
  const resumed = f.service.getRun(queued.id)!;
  await completed(resumed);
  assert.deepEqual([f.calls[0].resume, resumed.mode, resumed.accessMode], ['', 'agent', 'full']);
  assert.notEqual(resumed.sessionId, original.sessionId);
  assert.match(resumed.accessTransition?.context || '', /历史回复/);
  assert.deepEqual([f.service.getRun(original.id)?.mode, f.service.getRun(original.id)?.accessMode], ['ask', 'workspace']);
});

test('尚未取得session的权限切换轮失败后重试保留背景并新建原生会话', async t => {
  let original!: AgentRun, failed!: AgentRun;
  const f = await fixture(t, { seed: workspacePath => {
    original = history(workspacePath);
    failed = history(workspacePath, { parentRunId: original.id, conversationId: original.conversationId,
      queueRootId: original.queueRootId, sessionId: '', mode: 'agent', accessMode: 'full', status: 'failed',
      objective: '尚未执行的完全访问轮', createdAt: new Date(Date.parse(original.createdAt) + 1).toISOString() });
    return [failed, original];
  } });
  const retried = await f.service.retry(failed.id);
  await completed(retried);
  assert.equal(f.calls[0].resume, '');
  assert.match(retried.accessTransition?.context || '', /历史回复/);
  assert.deepEqual([retried.mode, retried.accessMode], ['agent', 'full']);
});

test('重新执行不能改写 worker/reviewer 与真实 team 岗位的固定模式', async t => {
  let nodes: AgentRun[] = [];
  const f = await fixture(t, { seed: workspacePath => {
    nodes = [
      history(workspacePath, { status: 'failed', task: { parentConversationId: randomUUID(), dependsOnConversationIds: [],
        role: 'worker', title: '分析岗位', source: 'workflow' } }),
      history(workspacePath, { status: 'failed', task: { parentConversationId: randomUUID(), dependsOnConversationIds: [],
        role: 'reviewer', title: '只读审查', source: 'manual' } }),
      history(workspacePath, { status: 'failed', team: { taskId: randomUUID(), nodeId: randomUUID(), stageKey: 'review:1',
        profileId: 'reviewer', profileRevision: 1 } }),
    ];
    return nodes;
  } });
  for (const node of nodes) {
    await assert.rejects(f.service.retry(node.id, undefined, { mode: 'agent', accessMode: 'full' }), /团队岗位.*模式/);
    assert.deepEqual([f.service.getRun(node.id)?.mode, f.service.getRun(node.id)?.accessMode], ['ask', 'workspace']);
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await f.service.dashboard()).runs.length, nodes.length);
});
