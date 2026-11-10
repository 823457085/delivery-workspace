import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import { CodexDesktopTurnUnconfirmedError } from '../server/codex-desktop-turn.js';
import { createAgentTeamService } from '../server/agent-team-service.js';
import { emptyDeliveryEvidence } from '../shared/delivery-acceptance.js';
import type { AgentRuntimeHealth } from '../shared/agent-runtime.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const turnId = '22222222-2222-4222-8222-222222222222';
const health: AgentRuntimeHealth = { provider: 'codex', label: 'fixture', binary: '/fixture-only', version: 'test',
  authenticated: true, ready: true, message: '', modes: ['ask', 'agent'], models: [{ id: '', label: 'default' }],
  defaultModel: '', writable: true, checkedAt: new Date().toISOString() };

async function eventually(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('等待模拟轮次状态超时');
}

test('团队停止未确认的桌面轮次保留写入锁，重启后仍只核对原轮次，确认停止后才释放', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-stop-safety-'));
  const source = path.join(root, 'source'), data = path.join(root, 'data');
  await fs.mkdir(source); await fs.writeFile(path.join(source, 'value.txt'), 'original');
  let executions = 0;
  let observed: 'unknown' | 'inProgress' | 'interrupted' = 'unknown';
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => health, execute: async context => {
    executions++;
    await context.onSession(sessionId); await context.onTurn!(turnId);
    return new Promise<string>((_resolve, reject) => {
      const stop = () => reject(new CodexDesktopTurnUnconfirmedError('本轮中断未获桌面端确认'));
      if (context.signal.aborted) stop(); else context.signal.addEventListener('abort', stop, { once: true });
    });
  } };
  const create = () => createAgentRuntimeService(data, { adapters: [adapter],
    codexSessionSource: { listSessions: async () => [], session: async () => { throw new Error('无持久化终态'); } },
    readCodexDesktopSnapshot: async id => {
      if (observed === 'unknown') throw new Error('desktop unavailable');
      return { id, hostId: 'local', resumeState: 'resumed', turns: [{ id: turnId, status: observed, items: [] }] };
    } });
  let runtime = await create();
  try {
    const run = await runtime.startTeamNode({ provider: 'codex', model: '', mode: 'agent', objective: '原任务', workspacePath: source },
      { team: { taskId: 'safety-task', nodeId: 'writer', stageKey: 'writer:1', profileId: 'engineer', profileRevision: 1 },
        context: '', parentConversationId: 'parent', title: 'writer', role: 'worker' });
    await eventually(() => !!run.codexTurnId);
    await runtime.stop(run.id);
    await eventually(() => run.status === 'interrupted' && !runtime.isRunActive(run.id));
    assert.equal(run.recovery?.stopRequested, true);
    assert.equal(run.recovery?.nativeObservation, 'codex-desktop');
    assert.equal(runtime.isIdle(), false);
    await assert.rejects(runtime.withTeamWorkspace(source, 'other-writer', async () => assert.fail('未知原生写入不能放行')), /正在被其他写入者使用/);
    await assert.rejects(runtime.retry(run.id), /自动核对|原轮次/);
    assert.equal(executions, 1);
    await runtime.close(); runtime = await create();
    const persisted = runtime.getRun(run.id)!;
    assert.equal(persisted.recovery?.stopRequested, true);
    observed = 'inProgress'; await runtime.reconcileRecovery();
    assert.equal(persisted.status, 'interrupted');
    assert.equal(persisted.recovery?.state, 'active');
    await assert.rejects(runtime.resume(run.id, '继续'), /原轮次仍在执行/);
    assert.equal(executions, 1);
    await fs.writeFile(path.join(source, 'value.txt'), '停止确认前最后一次写入');
    observed = 'interrupted'; await runtime.reconcileRecovery();
    assert.equal(persisted.status, 'cancelled');
    assert.equal(persisted.recovery?.state, 'completed');
    assert.equal(persisted.changedFiles?.some(file => file.path === 'value.txt'), true);
    assert.equal(persisted.recovery?.workspaceBefore, undefined);
    assert.equal(runtime.isIdle(), true);
    assert.equal(await runtime.withTeamWorkspace(source, 'confirmed-safe', async () => 'available'), 'available');
    assert.equal(executions, 1);
  } finally { await runtime.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('立即重启不绕过停止确认；原轮停止后仅续作一次，原轮已完成则不重跑', async () => {
  for (const terminal of ['interrupted', 'completed'] as const) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-restart-stop-'));
    const source = path.join(root, 'source'), data = path.join(root, 'data'); await fs.mkdir(source);
    let executions = 0;
    let observed: 'inProgress' | 'interrupted' | 'completed' = 'inProgress';
    const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => health, execute: async context => {
      executions++;
      await context.onSession(sessionId);
      await context.onTurn!(executions === 1 ? turnId : '44444444-4444-4444-8444-444444444444');
      if (executions > 1) return '续作完成';
      return new Promise<string>((_resolve, reject) => {
        const stop = () => reject(new CodexDesktopTurnUnconfirmedError('中断确认超时'));
        if (context.signal.aborted) stop(); else context.signal.addEventListener('abort', stop, { once: true });
      });
    } };
    const create = () => createAgentRuntimeService(data, { adapters: [adapter],
      codexSessionSource: { listSessions: async () => [], session: async () => { throw new Error('无持久化终态'); } },
      readCodexDesktopSnapshot: async id => ({ id, hostId: 'local', resumeState: 'resumed',
        turns: [{ id: turnId, status: observed, items: observed === 'completed' ? [{ type: 'agentMessage', text: '原轮自然完成' }] : [] }] }) });
    let runtime = await create();
    try {
      const run = await runtime.start({ provider: 'codex', model: '', mode: 'agent', objective: '原任务', workspacePath: source });
      await eventually(() => !!run.codexTurnId);
      await runtime.prepareWorkspaceRestart();
      assert.equal(run.status, 'interrupted');
      assert.equal(run.resumeAfterWorkspaceRestart, true);
      await runtime.close(); runtime = await create();
      assert.equal(executions, 1, '重启扫描不能把未知的旧轮次当作已停止');
      const persisted = runtime.getRun(run.id)!;
      assert.equal(persisted.status, 'interrupted');
      assert.equal(persisted.resumeAfterWorkspaceRestart, true);
      observed = terminal;
      await runtime.reconcileRecovery();
      await eventually(() => persisted.status === 'completed' && !!persisted.resultReady);
      assert.equal(executions, terminal === 'interrupted' ? 2 : 1);
      assert.equal(persisted.result, terminal === 'interrupted' ? '续作完成' : '原轮自然完成');
      assert.equal(persisted.pausedForEdit, false);
      assert.equal(persisted.resumeAfterWorkspaceRestart, undefined);
      await runtime.reconcileRecovery();
      assert.equal(executions, terminal === 'interrupted' ? 2 : 1);
    } finally { await runtime.close(); await fs.rm(root, { recursive: true, force: true }); }
  }
});

test('团队暂停等待原生停止证据，提前继续在确认后恢复一次且不重叠写入', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-pause-native-'));
  const source = path.join(root, 'source'); await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'value.txt'), 'before');
  const report = (value: object) => `\`\`\`delivery-report\n${JSON.stringify({ version: 1, ...value })}\n\`\`\``;
  let writers = 0, leaders = 0, maxNativeWriters = 0, resumedWriterReady = false;
  const nativeWriters = new Set<number>();
  let observed: 'inProgress' | 'interrupted' = 'inProgress';
  const adapter: AgentRuntimeAdapter = { id: 'codex', health: async () => ({ ...health,
    models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'].map(id => ({ id, label: id, efforts: ['low', 'medium', 'high'] })) }), execute: async context => {
    await context.onSession(`${sessionId}`);
    if (context.run.team?.profileId === 'leader') {
      leaders++;
      if (leaders > 1) return report({ conversationReply: { text: '已记下补充，完成后说明改动。', resumeWorkflow: true } });
      return report({ taskPlan: { templateId: 'engineering', reason: '用户要求', risk: 'low',
        acceptanceCriteria: [{ id: 'AC-1', text: 'value为after', source: '用户' }], allowedPaths: ['value.txt'],
        needsAnalyst: false, needsArchitect: false, questions: [], risks: [], ownership: [], shared: [] } });
    }
    if (context.run.team?.profileId === 'engineer') {
      const writer = ++writers;
      nativeWriters.add(writer); maxNativeWriters = Math.max(maxNativeWriters, nativeWriters.size);
      await context.onTurn!(writer === 1 ? turnId : '44444444-4444-4444-8444-444444444444');
      await fs.writeFile(path.join(context.run.workspacePath, 'value.txt'), writer === 1 ? 'partial' : 'after');
      if (writer > 1) resumedWriterReady = true;
      return new Promise<string>((_resolve, reject) => {
        const stop = () => {
          // 本机连接退出不代表原生 writer 已停止；旧轮次只在快照确认后移出。
          if (writer === 1) reject(new CodexDesktopTurnUnconfirmedError('停止未确认'));
          else { nativeWriters.delete(writer); reject(new Error('测试结束，停止续作轮次')); }
        };
        if (context.signal.aborted) stop(); else context.signal.addEventListener('abort', stop, { once: true });
      });
    }
    return report({ validationEvidence: emptyDeliveryEvidence(), taskResult: { role: 'verifier', status: 'succeeded',
      summary: '已核对', acceptance: [{ id: 'AC-1', status: 'passed', evidence: 'fixture' }] } });
  } };
  const runtime = await createAgentRuntimeService(path.join(root, 'data'), { adapters: [adapter],
    codexSessionSource: { listSessions: async () => [], session: async () => { throw new Error('无持久化终态'); } },
    readCodexDesktopSnapshot: async id => {
      if (observed === 'interrupted') nativeWriters.delete(1);
      return { id, hostId: 'local', resumeState: 'resumed', turns: [{ id: turnId, status: observed, items: [] }] };
    } });
  const team = await createAgentTeamService(path.join(root, 'data'), runtime);
  try {
    const created = await team.chat({ objective: '将value改为after', attachmentIds: [], requestId: 'start', workspacePath: source });
    await eventually(() => writers === 1);
    await team.chat({ taskId: created.task.id, objective: '先别改代码', attachmentIds: [], requestId: 'pause' });
    await eventually(() => runtime.teamRuns(created.task.id).some(run => run.recovery?.stopRequested));
    const before = runtime.teamRuns(created.task.id).length;
    const early = await team.chat({ taskId: created.task.id, objective: '继续执行', attachmentIds: [], requestId: 'early-resume' });
    assert.equal(early.task.chat?.paused, true);
    assert.equal(early.task.chat?.resumeRequested, true);
    assert.equal(early.task.chat?.coordination?.phase, 'stopping');
    await team.chat({ taskId: created.task.id, objective: '补充：完成后说明改了什么', attachmentIds: [], requestId: 'supplement' });
    assert.equal(writers, 1); assert.equal(leaders, 1);
    assert.deepEqual([...nativeWriters], [1]);
    assert.equal(runtime.teamRuns(created.task.id).length, before);
    assert.equal(await fs.readFile(path.join(source, 'value.txt'), 'utf8'), 'partial');
    // 暂停期间的新输入保持待处理，原轮次终态未确认前不生成新 writer。
    assert.equal(team.getTask(created.task.id).chat?.pendingInputs.length, 1);
    observed = 'interrupted';
    await runtime.reconcileRecovery();
    await eventually(() => resumedWriterReady && team.isIdle()).catch(() => {
      const current = team.getTask(created.task.id);
      assert.fail(`停止确认后未恢复：${JSON.stringify({ writers, leaders, state: current.state, paused: current.chat?.paused,
        resumeRequested: current.chat?.resumeRequested, coordination: current.chat?.coordination,
        nodes: current.nodes.map(node => ({ profile: node.profileId, status: node.status, reason: node.reason, error: node.error })) })}`);
    });
    const resumed = team.getTask(created.task.id);
    assert.equal(resumed.chat?.paused, false);
    assert.equal(resumed.chat?.resumeRequested, false);
    assert.equal(resumed.chat?.pendingInputs.length, 0);
    assert.equal(resumed.state, 'running');
    assert.equal(resumed.nodes.filter(node => node.profileId === 'engineer' && node.status === 'running').length, 1);
    assert.equal(await fs.readFile(path.join(source, 'value.txt'), 'utf8'), 'after');
    assert.equal(writers, 2); assert.equal(leaders, 2);
    assert.deepEqual([...nativeWriters], [2]);
    assert.equal(maxNativeWriters, 1, '停止确认前后始终最多只有一个原生 writer');
    await runtime.reconcileRecovery();
    await eventually(() => team.isIdle());
    assert.equal(writers, 2, '重复核对不会再次派发已恢复的步骤');
    assert.equal(runtime.teamRuns(created.task.id).filter(run => run.team?.profileId === 'engineer').length, 2);
  } finally { await team.close(); await runtime.close(); await fs.rm(root, { recursive: true, force: true }); }
});
