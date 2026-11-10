import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import { createAgentTeamService, type TeamServiceOptions } from '../server/agent-team-service.js';
import { planRepairScopeError, restorePlanRepairSources, teamChatControl } from '../server/agent-team-coordinator.js';
import { emptyDeliveryEvidence } from '../shared/delivery-acceptance.js';
import type { AgentAccessMode, AgentProvider, AgentRuntimeHealth, AgentRun } from '../shared/agent-runtime.js';
import type { AgentTaskPlan } from '../shared/agent-task-plan.js';
import { defaultGroupConfig } from '../shared/agent-group-chat.js';
import { createAgentGroupChat } from '../server/agent-group-chat.js';
import { createAgentGroupChatRoutes } from '../server/agent-group-chat-routes.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

type Context = Parameters<AgentRuntimeAdapter['execute']>[0];
const report = (value: object) => `\`\`\`delivery-report\n${JSON.stringify({ version: 1, ...value })}\n\`\`\``;
const plan = (extra: Partial<AgentTaskPlan> = {}): AgentTaskPlan => ({ templateId: 'engineering', reason: '完成原任务', risk: 'medium',
  acceptanceCriteria: [{ id: 'AC-1', text: 'value为2', source: '用户原话' }], allowedPaths: ['src/**'], needsAnalyst: false, needsArchitect: false,
  questions: [], risks: [], ownership: [], shared: [], ...extra });
const health = (provider: AgentProvider): AgentRuntimeHealth => ({ provider, label: provider, binary: 'fixture', version: 'fixture', ready: true, authenticated: true,
  message: 'ready', modes: ['agent', 'ask', 'plan'], writable: true, defaultModel: '', checkedAt: new Date().toISOString(),
  models: provider === 'codex' ? ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'].map(id => ({ id, label: id, efforts: ['low', 'medium', 'high'] }))
    : provider === 'cursor' ? [{ id: 'composer-2.5', label: 'Composer' }]
      : [{ id: 'sonnet', label: 'Sonnet 5.5', efforts: ['high'] }, { id: 'opus', label: 'Opus 5.5', efforts: ['high'] }] });
async function wait<T>(read: () => T, done: (item: T) => boolean) {
  for (let i = 0; i < 1000; i++) { const value = read(); if (done(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('等待状态超时');
}
function gate() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }
async function fixture(options: {
  coordinator?: (context: Context) => string | Promise<string>;
  planner?: (context: Context, turn: number) => string | Promise<string>;
  writer?: (context: Context, turn: number) => string | Promise<string>;
  verifier?: (context: Context) => string | Promise<string>;
  reviewer?: (context: Context) => string | Promise<string>;
  analyst?: (context: Context, turn: number) => string | Promise<string>;
  answer?: (context: Context) => string | Promise<string>;
  failFinalReceipt?: boolean;
  failSteerIntent?: boolean;
  failPlanSourceReceipt?: boolean;
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-coordination-')), data = path.join(root, 'data'), source = path.join(root, 'source');
  await fs.mkdir(path.join(source, 'src'), { recursive: true }); await fs.writeFile(path.join(source, 'src/value.js'), 'export const value = 1;\n');
  const calls: AgentRun[] = []; let plans = 0, writes = 0, analyses = 0, failedWrites = 0;
  const adapters: AgentRuntimeAdapter[] = (['codex', 'claude', 'cursor'] as const).map(provider => ({ id: provider, health: async () => health(provider), execute: async context => {
    await context.onSession(context.resumeSessionId || `${provider}:${context.run.id}`); calls.push(structuredClone(context.run));
    const role = context.run.team?.profileId;
    if (options.answer && context.run.teamContext?.includes('输出 {"version":1,"answer":')) return options.answer(context);
    if (role === 'leader') {
      if (context.run.teamContext?.includes('本次诊断目标节点：')) return options.coordinator?.(context) || report({ coordinationReply: { action: 'observe', text: '已核对阻塞，仍需处理。' } });
      plans++; return options.planner?.(context, plans) || report({ taskPlan: plan() });
    }
    if (role === 'engineer') {
      if (options.writer) return options.writer(context, ++writes);
      writes++; await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), 'export const value = 2;\n');
      return report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '已修改value' } });
    }
    if (role === 'analyst') {
      if (options.analyst) return options.analyst(context, ++analyses);
      analyses++; return report({ requirementBrief: { facts: [], inferences: [], gaps: [], acceptanceCriteria: [], sources: [] } });
    }
    if (role === 'verifier') return options.verifier?.(context) || report({ validationEvidence: emptyDeliveryEvidence(), taskResult: { role: 'verifier', status: 'succeeded', summary: '夹具验证通过', acceptance: [{ id: 'AC-1', status: 'passed', evidence: 'value为2' }] } });
    if (role === 'reviewer') return options.reviewer?.(context) || report({ taskResult: { role: 'reviewer', status: 'succeeded', verdict: 'approved', summary: '独立检查通过', findings: [] } });
    throw new Error(`未配置岗位：${role}`);
  } }));
  const serviceOptions: TeamServiceOptions = options.failFinalReceipt || options.failSteerIntent || options.failPlanSourceReceipt ? { writeJson: async (relative, value) => {
    const tasks = (value as { tasks?: { plan?: unknown; chat?: { coordination?: { phase?: string }; steering?: { phase?: string } } }[] }).tasks;
    if (!failedWrites && options.failFinalReceipt && tasks?.some(task => task.chat?.coordination?.phase === 'delivered')) { failedWrites++; throw new Error('模拟送达后持久化失败'); }
    if (!failedWrites && options.failSteerIntent && tasks?.some(task => task.chat?.steering?.phase === 'stopping')) { failedWrites++; throw new Error('模拟插队意图持久化失败'); }
    if (!failedWrites && options.failPlanSourceReceipt && tasks?.some(task => task.plan && task.chat?.coordination?.phase === 'paused')) { failedWrites++; throw new Error('模拟计划重新接收保存失败'); }
    const target = path.join(root, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, JSON.stringify(value));
    // The service uses data as its root when reopening, whereas writeJson receives workspace-relative paths.
    if (relative.startsWith('agent-runtimes/')) { const copy = path.join(data, relative.slice('agent-runtimes/'.length)); await fs.mkdir(path.dirname(copy), { recursive: true }); await fs.writeFile(copy, JSON.stringify(value)); }
  } } : {};
  const runtime = await createAgentRuntimeService(data, { adapters, resolveAttachments: async ids => ids.map(id => ({
    attachment: { id, name: `${id}.txt`, mimeType: 'text/plain', size: 1, url: `/attachments/${id}`, createdAt: new Date().toISOString() }, filePath: path.join(source, 'src/value.js'),
  })) }), team = await createAgentTeamService(data, runtime, serviceOptions);
  const start = (accessMode: AgentAccessMode = 'full') => team.chat({ objective: '把value改为2并验证', attachmentIds: [], requestId: 'start', workspacePath: source, accessMode });
  const roomId = randomUUID();
  const startGroup = () => team.chat({ objective: '把value改为2并验证', attachmentIds: [], requestId: 'group-start', workspacePath: source, accessMode: 'workspace',
    group: { roomId, config: defaultGroupConfig(team.profiles.read()), cursorTrustPaths: [] } });
  return { root, data, source, runtime, team, adapters, calls, start, startGroup, roomId, counts: () => ({ plans, writes, analyses, failedWrites }),
    cleanup: async () => { await team.close(); await runtime.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

for (const saved of [false, true]) test(`继续诊断确认误选实时补充时交回重新安排：${saved ? '已保存失败只重处理宿主结果' : '新协调结果'}，不重放诊断`, async () => {
  const hold = gate(); let taskId = '', coordinators = 0;
  let currentTeam: Awaited<ReturnType<typeof createAgentTeamService>>;
  const f = await fixture({ planner: async (context, turn) => {
    if (turn === 1) return report({ taskPlan: plan({ templateId: 'diagnosis' }) });
    assert.match(context.run.teamContext || '', /本次用户输入：继续执行/);
    await hold.promise;
    return report({ taskPlan: plan({ templateId: 'verification' }) });
  }, writer: () => report({ questions: [{ to: 'user', text: '复现已完成，是否开始下一步？', blocking: true }] }),
  coordinator: () => {
    coordinators++;
    const target = currentTeam.getTask(taskId).nodes.find(node => node.stage === 'diagnose')!;
    return report({ coordinationReply: saved ? { action: 'observe', text: '已保存的历史协调' }
      : { action: 'steer', targetNodeId: target.id, text: '继续核对原范围' } });
  } });
  currentTeam = f.team;
  const getRun = f.runtime.getRun;
  let reopened: Awaited<ReturnType<typeof createAgentTeamService>> | undefined;
  try {
    const started = await f.start(); taskId = started.task.id;
    await wait(() => currentTeam.getTask(taskId), task => task.state === 'waiting_input');
    await currentTeam.chat({ taskId, objective: '暂停任务', attachmentIds: [], requestId: 'pause-diagnosis' });
    await currentTeam.chat({ taskId, objective: '继续执行', attachmentIds: [], requestId: 'continue-diagnosis' });
    if (saved) {
      const completed = await wait(() => currentTeam.getTask(taskId), task => task.nodes.some(node => node.purpose === 'coordinate' && node.status === 'completed'));
      await currentTeam.close();
      const node = completed.nodes.find(node => node.purpose === 'coordinate')!, target = completed.nodes.find(node => node.stage === 'diagnose')!;
      const original = report({ coordinationReply: { action: 'steer', targetNodeId: target.id, text: '继续核对原范围' } });
      completed.state = 'blocked'; node.status = 'blocked'; node.error = '实时补充只允许送到当前任务的实施岗位';
      node.coordinationAction = 'steer'; node.result = original; node.receiptRunId = node.runId;
      completed.chat!.pendingInputs = [node.coordinationInput!];
      const file = path.join(f.data, 'team-tasks.json'), stored = JSON.parse(await fs.readFile(file, 'utf8'));
      stored.tasks = [completed]; await fs.writeFile(file, JSON.stringify(stored));
      f.runtime.getRun = id => id === node.runId ? { ...getRun(id)!, result: original } : getRun(id);
      currentTeam = reopened = await createAgentTeamService(f.data, f.runtime);
      await currentTeam.decide(taskId, { action: 'retry', nodeId: node.id, requestId: 'retry-saved-coordination' });
    }
    await wait(() => f.counts().plans, count => count === 2);
    const task = currentTeam.getTask(taskId), coordinator = task.nodes.find(node => node.purpose === 'coordinate')!;
    assert.equal(coordinators, 1); assert.equal(f.counts().writes, 1);
    assert.equal(coordinator.attempt, 1); assert.equal(coordinator.coordinationAction, 'replan');
    assert.equal(coordinator.status, 'completed');
    assert.equal(task.nodes.find(node => node.stage === 'diagnose')!.attempt, 1);
    if (saved) assert.match(f.runtime.getRun(coordinator.runId!)!.result, /"action":"steer"/);
  } finally {
    hold.release(); if (reopened) await reopened.close(); f.runtime.getRun = getRun; await f.cleanup();
  }
});

for (const guard of ['retired', 'host-active', 'pid-alive', 'previous-pid-alive', 'recovery-active', 'current-unknown'] as const) {
  test(`继续执行核对历史尝试：${guard}，只越过已被终态新尝试取代的无进程旧记录`, async () => {
    const hold = gate();
    const f = await fixture({ writer: async (context, turn) => {
      if (turn < 3) {
        await new Promise<void>(resolve => context.signal.aborted ? resolve() : context.signal.addEventListener('abort', () => resolve(), { once: true }));
        throw new Error('运行已停止');
      }
      await hold.promise;
      return report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '续接已完成' } });
    } });
    const teamRuns = f.runtime.teamRuns, getRun = f.runtime.getRun, isRunActive = f.runtime.isRunActive;
    try {
      const started = await f.start(); await wait(() => f.counts().writes, count => count === 1);
      await f.team.chat({ taskId: started.task.id, objective: '暂停任务', attachmentIds: [], requestId: 'pause-first' });
      await f.team.chat({ taskId: started.task.id, objective: '继续执行', attachmentIds: [], requestId: 'resume-first' });
      await wait(() => f.counts().writes, count => count === 2);
      await f.team.chat({ taskId: started.task.id, objective: '暂停任务', attachmentIds: [], requestId: 'pause-second' });
      await wait(() => f.team.getTask(started.task.id), task => task.chat?.coordination?.phase === 'paused');
      const node = f.team.getTask(started.task.id).nodes.find(item => item.stage === 'implement')!;
      const current = getRun(node.runId!)!, old = teamRuns(started.task.id).find(item => item.team?.nodeId === node.id && item.id !== current.id)!;
      const interrupted = (run: AgentRun): AgentRun => ({ ...run, status: 'interrupted', resultReady: false, pid: guard === 'pid-alive' ? process.pid : null,
        recovery: { previousStatus: 'running', previousPid: guard === 'previous-pid-alive' ? process.pid : 99999999,
          state: guard === 'recovery-active' ? 'active' : 'pending', checkedAt: '', message: '历史观察未回收' } });
      const oldView = interrupted(old), currentView: AgentRun = guard === 'current-unknown' ? interrupted(current)
        : { ...current, status: 'completed', resultReady: true, recovery: undefined };
      f.runtime.teamRuns = id => teamRuns(id).map(run => run.id === old.id ? oldView : run.id === current.id ? currentView : run);
      f.runtime.getRun = id => id === current.id ? currentView : getRun(id);
      f.runtime.isRunActive = id => guard === 'host-active' && id === old.id || isRunActive(id);
      const input = { taskId: started.task.id, objective: '继续执行', attachmentIds: [], requestId: 'resume-with-history' };
      const response = await f.team.chat(input); await f.team.chat(input);
      assert.equal(response.task.chat!.paused, guard !== 'retired');
      if (guard === 'retired') await wait(() => f.counts().writes, count => count === 3);
      assert.equal(f.counts().writes, guard === 'retired' ? 3 : 2);
      assert.equal(oldView.status, 'interrupted'); assert.equal(oldView.recovery!.state, guard === 'recovery-active' ? 'active' : 'pending');
    } finally {
      f.runtime.teamRuns = teamRuns; f.runtime.getRun = getRun; f.runtime.isRunActive = isRunActive;
      hold.release(); await f.cleanup();
    }
  });
}

for (const restored of [false, true]) test(`暂停后的继续路由到未答确认题，不重做已完成复现：${restored ? '恢复已记录请求' : '新请求'}`, async () => {
  let currentTeam: Awaited<ReturnType<typeof createAgentTeamService>>;
  const f = await fixture({ coordinator: context => {
    const ask = currentTeam.ledger.messages(context.run.team!.taskId).find(message => message.type === 'ask' && message.to.kind === 'user' && message.processing !== 'answered')!;
    assert.match(context.run.teamContext!, /本次原始补充：继续执行/);
    return report({ coordinationReply: { action: 'answer', questionId: ask.id, text: '用户确认继续执行。' } });
  }, writer: async (context, turn) => {
    if (turn === 1) return report({ questions: [{ to: 'user', text: '已完成复现，是否开始执行前端修复？', blocking: true }] });
    assert.ok(context.resumeSessionId, '从原岗位会话接续，不重新安排复现');
    await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), 'export const value = 2;\n');
    return report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '已按确认修复' } });
  } });
  currentTeam = f.team;
  let reopenedRuntime: Awaited<ReturnType<typeof createAgentRuntimeService>> | undefined;
  try {
    const started = await f.start();
    await wait(() => f.team.getTask(started.task.id), task => task.state === 'waiting_input');
    const question = f.team.ledger.messages(started.task.id).find(message => message.type === 'ask' && message.to.kind === 'user')!;
    await f.team.chat({ taskId: started.task.id, objective: '暂停任务', attachmentIds: [], requestId: 'pause-confirmation' });
    if (restored) {
      await f.team.close(); await f.runtime.close();
      const file = path.join(f.data, 'team-tasks.json'), saved = JSON.parse(await fs.readFile(file, 'utf8')) as { tasks: ReturnType<typeof f.team.getTask>[] };
      const task = saved.tasks.find(item => item.id === started.task.id)!, id = randomUUID();
      task.chat!.messages.push({ id, role: 'user', kind: 'message', text: '继续执行', attachmentIds: [], createdAt: new Date().toISOString() });
      task.chat!.resumeRequested = true; task.chat!.coordination = { phase: 'stopping', inputId: id, text: '原运行尚未确认停止，继续请求已记录；确认停止前不会重复派发。' };
      task.nodes.push({ id: randomUUID(), stage: 'plan', profileId: 'leader', purpose: 'coordinate', status: 'blocked', dependencies: [],
        attempt: 1, round: task.round, error: '历史协调额度失败', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      await fs.writeFile(file, JSON.stringify(saved));
      reopenedRuntime = await createAgentRuntimeService(f.data, { adapters: f.adapters });
      currentTeam = await createAgentTeamService(f.data, reopenedRuntime);
    } else await f.team.chat({ taskId: started.task.id, objective: '继续执行', attachmentIds: [], requestId: 'continue-confirmation' });
    assert.ok(currentTeam.getTask(started.task.id).nodes.some(node => node.purpose === 'coordinate' && node.coordinationInput?.text === '继续执行'));
    await wait(() => currentTeam.getTask(started.task.id), task => task.state === 'completed');
    assert.equal(currentTeam.ledger.messages(started.task.id).find(message => message.id === question.id)!.processing, 'answered');
    assert.equal(f.counts().plans, 1); assert.equal(f.counts().writes, 2);
    if (restored) assert.ok(currentTeam.getTask(started.task.id).nodes.some(node => node.purpose === 'coordinate' && node.status === 'blocked' && node.error === '历史协调额度失败'));
  } finally {
    if (reopenedRuntime) { await currentTeam.close(); await reopenedRuntime.close(); }
    await f.cleanup();
  }
});

test('暂停后继续遇到多项未答问题仍由负责人澄清，不把一句继续批量当作答案', async () => {
  const f = await fixture({ writer: () => report({ questions: [
    { to: 'user', text: '本轮只排查还是修改？', blocking: true },
    { to: 'user', text: '使用哪一个测试账号？', blocking: true },
  ] }), coordinator: () => report({ coordinationReply: { action: 'ask', text: '请明确本轮范围及测试账号。' } }) });
  try {
    const started = await f.start(); await wait(() => f.team.getTask(started.task.id), task => task.state === 'waiting_input');
    const original = f.team.ledger.messages(started.task.id).filter(message => message.type === 'ask' && message.to.kind === 'user');
    await f.team.chat({ taskId: started.task.id, objective: '暂停任务', attachmentIds: [], requestId: 'pause-multiple' });
    await f.team.chat({ taskId: started.task.id, objective: '继续执行', attachmentIds: [], requestId: 'continue-multiple' });
    await wait(() => f.team.getTask(started.task.id), task => task.chat!.messages.some(message => message.text === '请明确本轮范围及测试账号。'));
    assert.ok(original.every(ask => f.team.ledger.messages(started.task.id).find(message => message.id === ask.id)!.processing !== 'answered'));
    assert.equal(f.counts().writes, 1); assert.equal(f.counts().plans, 1);
  } finally { await f.cleanup(); }
});

test('群聊插队先停止当前执行并保留改动，优先选中消息及附件且不重放旧实施', async () => {
  const leaderHold = gate(); let aborted = false;
  const f = await fixture({ coordinator: () => report({ coordinationReply: { action: 'replan', text: '阶段结束后调整' } }), writer: async context => {
    await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), 'export const value = 3;\n');
    await new Promise<void>(resolve => context.signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
    return report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '旧步骤已停止' } });
  }, planner: async (context, turn) => {
    if (turn === 1) return report({ taskPlan: plan() });
    if (turn === 2) {
      assert.equal(aborted, true); assert.match(context.run.teamContext || '', /本次用户输入：先解释这个字段/);
      assert.deepEqual(context.run.attachments?.map(item => item.id), ['selected-attachment']);
      await leaderHold.promise;
    }
    return report({ conversationReply: { text: '字段解释已返回。', resumeWorkflow: false } });
  } });
  try {
    const started = await f.startGroup(); await wait(() => f.counts().writes, count => count === 1);
    await f.team.chat({ taskId: started.task.id, objective: '稍后处理原安排', attachmentIds: [], requestId: 'older' });
    const queued = await f.team.chat({ taskId: started.task.id, objective: '先解释这个字段', attachmentIds: ['selected-attachment'], requestId: 'selected' });
    const input = queued.task.chat!.pendingInputs.find(item => item.text === '先解释这个字段')!;
    await assert.rejects(f.team.steerChatInput(started.task.id, { messageId: input.id }, randomUUID()), /群聊/);
    await f.team.steerChatInput(started.task.id, { messageId: input.id }, f.roomId);
    await wait(() => f.counts().plans, count => count === 2);
    const selected = f.team.getTask(started.task.id);
    assert.equal(selected.chat!.steering?.inputId, input.id);
    assert.equal(selected.chat!.steering?.phase, 'processing');
    assert.deepEqual(selected.chat!.pendingInputs.map(item => item.text), ['稍后处理原安排']);
    assert.equal(f.counts().writes, 1);
    const writer = selected.nodes.find(node => node.stage === 'implement')!;
    assert.equal(writer.status, 'skipped');
    assert.equal(await fs.readFile(path.join(f.runtime.getRun(writer.runId!)!.workspacePath, 'src/value.js'), 'utf8'), 'export const value = 3;\n');
    await f.team.steerChatInput(started.task.id, { requestId: 'selected' }, f.roomId);
    assert.equal(f.counts().plans, 2);
    leaderHold.release();
    await wait(() => f.team.getTask(started.task.id), task => task.chat!.messages.some(message => message.text === '字段解释已返回。'));
    assert.equal(f.counts().writes, 1);
    await assert.rejects(f.team.steerChatInput(started.task.id, { messageId: randomUUID() }, f.roomId), /待处理/);
  } finally { leaderHold.release(); await f.cleanup(); }
});

test('群聊插队意图保存失败不停止进程、不改变待处理顺序或由后续tick误派发', async () => {
  const hold = gate(); let aborted = false;
  const f = await fixture({ failSteerIntent: true, coordinator: () => report({ coordinationReply: { action: 'replan', text: '阶段结束后调整' } }), writer: async context => {
    context.signal.addEventListener('abort', () => { aborted = true; }); await hold.promise;
    return report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '保留原执行' } });
  } });
  try {
    const started = await f.startGroup(); await wait(() => f.counts().writes, count => count === 1);
    await f.team.chat({ taskId: started.task.id, objective: '第一条补充', attachmentIds: [], requestId: 'first' });
    const queued = await f.team.chat({ taskId: started.task.id, objective: '第二条补充', attachmentIds: [], requestId: 'second' });
    const before = queued.task.chat!.pendingInputs.map(item => item.id);
    await assert.rejects(f.team.steerChatInput(started.task.id, { requestId: 'second' }, f.roomId), /意图持久化失败/);
    await new Promise(resolve => setTimeout(resolve, 150));
    const after = f.team.getTask(started.task.id);
    assert.equal(aborted, false); assert.equal(after.chat!.steering, undefined);
    assert.deepEqual(after.chat!.pendingInputs.map(item => item.id), before);
    assert.equal(after.nodes.some(node => node.pauseRequested), false);
    assert.equal(f.counts().writes, 1);
  } finally { hold.release(); await f.cleanup(); }
});

test('群聊插队等待原执行确实停止，同条幂等且不接受替换，旧协调完成不能再暂停或派发', async () => {
  const finishStop = gate(); let aborts = 0;
  const f = await fixture({ writer: async context => {
    await new Promise<void>(resolve => context.signal.addEventListener('abort', () => { aborts++; resolve(); }, { once: true }));
    await finishStop.promise;
    return report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '停止时保留结果' } });
  }, coordinator: async context => {
    await new Promise<void>(resolve => context.signal.aborted ? resolve() : context.signal.addEventListener('abort', () => resolve(), { once: true }));
    return report({ coordinationReply: { action: 'pause', text: '已过期的暂停决定' } });
  }, planner: (_context, turn) => turn === 1 ? report({ taskPlan: plan() }) : report({ conversationReply: { text: '已优先回答', resumeWorkflow: false } }) });
  try {
    const started = await f.startGroup(); await wait(() => f.counts().writes, count => count === 1);
    await f.team.chat({ taskId: started.task.id, objective: '保留普通消息', attachmentIds: [], requestId: 'normal' });
    await f.team.chat({ taskId: started.task.id, objective: '优先回答我', attachmentIds: [], requestId: 'priority' });
    const selected = await f.team.steerChatInput(started.task.id, { requestId: 'priority' }, f.roomId);
    assert.equal(selected.chat!.steering!.phase, 'stopping'); assert.equal(f.counts().plans, 1);
    const duplicate = await f.team.steerChatInput(started.task.id, { requestId: 'priority' }, f.roomId);
    assert.equal(duplicate.chat!.steering!.inputId, selected.chat!.steering!.inputId); assert.equal(aborts, 1);
    await assert.rejects(f.team.steerChatInput(started.task.id, { requestId: 'normal' }, f.roomId), /上一条插队消息/);
    assert.deepEqual(f.team.getTask(started.task.id).chat!.pendingInputs.map(input => input.requestId), ['priority', 'normal']);
    finishStop.release();
    const done = await wait(() => f.team.getTask(started.task.id), task => task.chat!.messages.some(message => message.text === '已优先回答'));
    assert.equal(done.chat!.paused, false); assert.equal(f.counts().writes, 1); assert.equal(aborts, 1);
    assert.equal(done.chat!.messages.some(message => message.text === '已过期的暂停决定'), false);
  } finally { finishStop.release(); await f.cleanup(); }
});

test('群聊插队路由以原始requestId精确关联当前room输入并拒绝非法identity与跨room消息', async () => {
  const leaderHold = gate();
  const f = await fixture({ coordinator: () => report({ coordinationReply: { action: 'replan', text: '阶段结束后调整' } }), writer: async context => {
    await new Promise<void>(resolve => context.signal.aborted ? resolve() : context.signal.addEventListener('abort', () => resolve(), { once: true }));
    return report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '保留现场' } });
  }, planner: async (_context, turn) => {
    if (turn === 1) return report({ taskPlan: plan() });
    await leaderHold.promise; return report({ conversationReply: { text: '已优先解释', resumeWorkflow: false } });
  } });
  const group = await createAgentGroupChat(path.join(f.root, 'group'), f.runtime, { profiles: f.team.profiles.read, automatic: f.team });
  try {
    const started = await group.send({ text: '把value改为2并验证', requestId: 'room-start', workspacePath: f.source, accessMode: 'workspace' });
    await wait(() => f.counts().writes, count => count === 1);
    await group.send({ roomId: started.room.id, text: '先解释字段', requestId: 'original-request', attachmentIds: ['image'], accessMode: 'workspace' });
    const before = await wait(() => group.detail(started.room.id), value => !!value.collaboration?.task.chat!.pendingInputs.some(input => input.requestId === `group:${started.room.id}:original-request`));
    const messageId = before.collaboration!.task.chat!.pendingInputs.find(input => input.requestId === `group:${started.room.id}:original-request`)!.id;
    let body: unknown = { requestId: 'original-request' }, status = 0, response: unknown;
    const routes = createAgentGroupChatRoutes(group, { port: 5288, body: async () => body,
      json: (_response, code, value) => { status = code; response = value; } });
    const url = new URL(`http://localhost:5288/api/agent-runtimes/group-chat/rooms/${started.room.id}/messages/steer`);
    const request = { method: 'POST', headers: { 'x-delivery-confirmed': 'yes', origin: 'http://localhost:5288' } } as unknown as IncomingMessage;
    await routes(request, {} as ServerResponse, url);
    assert.equal(status, 200);
    const result = response as ReturnType<typeof group.detail>;
    assert.equal(result.collaboration!.task.chat!.steering!.inputId, messageId);
    assert.equal(result.collaboration!.task.chat!.steering!.requestId, `group:${started.room.id}:original-request`);
    await group.steerMessage(started.room.id, { messageId });
    await assert.rejects(group.steerMessage(started.room.id, { requestId: `group:${started.room.id}:original-request` }), /不属于/);
    for (const invalid of [{}, { messageId, requestId: 'original-request' }, { requestId: 'original-request', accessMode: 'full' }]) {
      body = invalid; await assert.rejects(routes(request, {} as ServerResponse, url));
    }
    const another = await group.send({ text: '另一个房间', requestId: 'second-room' });
    await assert.rejects(group.steerMessage(another.room.id, { messageId }), /待处理/);
    assert.equal(f.counts().writes, 1);
  } finally { leaderHold.release(); await group.close(); await f.cleanup(); }
});

for (const processing of [false, true]) test(`群聊插队不再派发被跳过阶段${processing ? '已领取' : '未领取'}的待答问题，保留原问题和已答历史`, async () => {
  const leaderHold = gate();
  const f = await fixture({ coordinator: async context => {
    await new Promise<void>(resolve => context.signal.aborted ? resolve() : context.signal.addEventListener('abort', () => resolve(), { once: true }));
    return report({ coordinationReply: { action: 'replan', text: '旧协调结果' } });
  }, writer: async context => {
    await new Promise<void>(resolve => context.signal.aborted ? resolve() : context.signal.addEventListener('abort', () => resolve(), { once: true }));
    return report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '停止并保留现场' } });
  }, planner: async (_context, turn) => {
    if (turn === 1) return report({ taskPlan: plan() });
    await leaderHold.promise; return report({ conversationReply: { text: '优先回答新消息', resumeWorkflow: false } });
  }, analyst: () => report({ answer: '这条旧问题不该再执行' }) });
  try {
    const started = await f.startGroup(); await wait(() => f.counts().writes, count => count === 1);
    await f.team.chat({ taskId: started.task.id, objective: '先解释新字段', attachmentIds: [], requestId: 'priority' });
    const writer = f.team.getTask(started.task.id).nodes.find(node => node.stage === 'implement')!;
    const original = { workflowId: started.task.id, nodeId: `${writer.id}:${writer.attempt}`, type: 'ask' as const,
      from: { kind: 'profile' as const, profileId: 'engineer' }, to: { kind: 'profile' as const, profileId: 'analyst' }, blocking: true };
    const answered = await f.team.ledger.send({ ...original, text: '已经回答的历史问题', dedupeKey: 'old-answered' });
    await f.team.ledger.answer(answered.id, { from: { kind: 'profile', profileId: 'analyst' }, text: '保留已有答案', dedupeKey: 'old-answer' });
    const pending = await f.team.ledger.send({ ...original, text: '旧实施阶段等待其他成员答疑', dedupeKey: 'old-pending' });
    if (processing) await f.team.ledger.claim(started.task.id, { kind: 'profile', profileId: 'analyst' });
    await f.team.steerChatInput(started.task.id, { requestId: 'priority' }, f.roomId);
    const selected = await wait(() => f.team.getTask(started.task.id), task => f.counts().plans === 2 && task.chat!.steering?.phase === 'processing');
    assert.equal(selected.nodes.find(node => node.id === writer.id)!.status, 'skipped');
    assert.equal(selected.nodes.some(node => node.answerTo === pending.id), false);
    const history = f.team.ledger.messages(started.task.id);
    assert.equal(history.find(message => message.id === pending.id)!.processing, 'expired');
    assert.equal(history.find(message => message.id === pending.id)!.body.text, '旧实施阶段等待其他成员答疑');
    assert.equal(history.find(message => message.id === answered.id)!.processing, 'answered');
    assert.ok(history.some(message => message.type === 'back' && message.body.text === '保留已有答案'));
    const leader = selected.nodes.find(node => node.chatInputId === selected.chat!.steering!.inputId && !node.purpose)!;
    const current = await f.team.ledger.send({ ...original, nodeId: `${leader.id}:${leader.attempt}`, text: '新阶段的正常问题', dedupeKey: 'new-question' });
    const next = await f.team.ledger.claim(selected.id, { kind: 'profile', profileId: 'analyst' });
    assert.equal(next!.id, current.id);
  } finally { leaderHold.release(); await f.cleanup(); }
});

test('状态查询立即使用真实节点事实，保留原目标与预算，不消耗新的模型调用', async () => {
  const hold = gate();
  const f = await fixture({ writer: async context => { await hold.promise; await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), 'export const value = 2;\n'); return report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '已改' } }); } });
  try {
    const started = await f.start(); await wait(() => f.counts().writes, value => value === 1);
    const before = f.team.getTask(started.task.id), count = f.calls.length;
    const value = await f.team.chat({ taskId: started.task.id, objective: '现在进度怎么样？', attachmentIds: [], requestId: 'status' });
    assert.equal(f.calls.length, count); assert.equal(value.task.objective, before.objective); assert.equal(value.task.budgetLimit, before.budgetLimit);
    const reply = value.task.chat!.messages.find(item => item.id.startsWith('status-reply:'))!;
    assert.match(reply.text, /工程实现正在处理/); assert.equal(reply.hostGenerated, true); assert.equal(reply.provider, undefined);
    assert.equal(value.task.chat!.pendingInputs.length, 0);
  } finally { hold.release(); await f.cleanup(); }
});

for (const accessMode of ['full', 'workspace'] as const) test(`执行中补充通过独立协调目录及时送到原运行，保留 ${accessMode} 且不重复实现`, async () => {
  const hold = gate(); const deliveries: string[] = []; let target = '';
  const f = await fixture({ coordinator: async context => {
    const writer = f.calls.find(run => run.team?.nodeId === target)!;
    assert.equal(context.run.mode, 'agent'); assert.equal(context.run.accessMode, accessMode);
    assert.notEqual(context.run.workspacePath, writer.workspacePath);
    assert.match(context.run.workspacePath, /team-coordination-workspaces/);
    assert.ok(context.attachmentReadDirectories?.includes(writer.workspacePath));
    assert.equal(await fs.readFile(path.join(writer.workspacePath, 'src/value.js'), 'utf8'), 'export const value = 1;\n');
    assert.ok(context.run.teamContext?.includes(`当前候选目录：${writer.workspacePath}`));
    await fs.mkdir(path.join(context.run.workspacePath, '.delivery-artifacts'), { recursive: true });
    await fs.writeFile(path.join(context.run.workspacePath, '.delivery-artifacts/coordination-note.txt'), '已核对原导出名称');
    return report({ coordinationReply: { action: 'steer', targetNodeId: target, text: '模型声称已经全部完成' } });
  }, writer: async context => {
    target = context.run.team!.nodeId; context.onSteer?.(async input => { deliveries.push(input.text); });
    await hold.promise; await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), 'export const value = 2;\n');
    return report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '已按范围完成' } });
  } });
  try {
    const started = await f.start(accessMode); await wait(() => target, Boolean);
    const message = { taskId: started.task.id, objective: '补充：保留原来的导出名称', attachmentIds: [], requestId: 'steer' };
    await f.team.chat(message); await f.team.chat(message);
    const delivered = await wait(() => f.team.getTask(started.task.id), value => value.chat?.coordination?.phase === 'delivered');
    assert.equal(deliveries.length, 1); assert.match(deliveries[0], /补充：保留原来的导出名称/); assert.equal(delivered.chat!.pendingInputs.length, 0);
    assert.equal(delivered.chat!.messages.some(item => item.text === '模型声称已经全部完成'), false);
    assert.equal(delivered.objective, started.task.objective);
    const coordinator = delivered.nodes.find(node => node.purpose === 'coordinate')!;
    const logs = delivered.artifacts?.find(item => item.nodeId === coordinator.id && item.kind === 'logs');
    assert.ok(logs, '协调会话生成的证据必须归档');
    hold.release(); const done = await wait(() => f.team.getTask(started.task.id), value => value.state === 'completed');
    assert.equal(f.counts().plans, 1); assert.equal(f.counts().writes, 1); assert.equal(done.chat!.messages.filter(item => item.kind === 'delivery').length, 1);
  } finally { hold.release(); await f.cleanup(); }
});

test('执行中的负责人可向工程岗位求证，回答后续接原协调节点和用户补充', async () => {
  const writerHold = gate(), answerHold = gate();
  const supplement = '补充：请核对导出名称是否来自当前实现。';
  const questionText = '请只核对当前实现的导出名称。';
  const answerText = '已核对源文件，当前导出名称为 value。';
  const observed = '导出名称已由工程核对，继续当前安排。';
  let coordinationTurns = 0, writerId = '', answerId = '';
  const f = await fixture({
    coordinator: context => {
      assert.equal(context.run.accessMode, 'workspace');
      assert.ok(context.run.teamContext?.includes(`本次原始补充：${supplement}`));
      assert.match(context.run.teamContext || '', /在 coordinationReply 内使用 questionTo 指定接收方，可选 [^\n]*\bengineer\b/);
      assert.doesNotMatch(context.run.teamContext || '', /在顶层输出 questions:\[/);
      if (++coordinationTurns === 1) return report({ coordinationReply: { action: 'ask', questionTo: 'engineer', text: questionText } });
      assert.ok(context.run.teamContext?.includes(answerText));
      assert.ok(context.resumeSessionId, '沿用原协调会话');
      return report({ coordinationReply: { action: 'observe', text: observed } });
    },
    writer: async context => {
      writerId = context.run.id;
      await writerHold.promise;
      await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), 'export const value = 2;\n');
      return report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '已按原范围完成' } });
    },
    answer: async context => {
      assert.equal(context.run.team?.profileId, 'engineer');
      assert.equal(context.run.accessMode, 'workspace');
      assert.match(context.run.workspacePath, /team-answer-workspaces/);
      assert.ok(context.run.teamContext?.includes(questionText));
      answerId = context.run.id;
      await answerHold.promise;
      return report({ answer: answerText });
    },
  });
  try {
    const { task: started } = await f.startGroup();
    await wait(() => writerId, Boolean);
    const input = { taskId: started.id, objective: supplement, attachmentIds: [], requestId: 'coordinator-ask-engineer' };
    await f.team.chat(input); await f.team.chat(input);
    await wait(() => answerId, Boolean);
    const waiting = f.team.getTask(started.id), coordinator = waiting.nodes.find(node => node.purpose === 'coordinate')!;
    assert.equal(coordinator.status, 'waiting_input');
    assert.equal(waiting.nodes.find(node => node.stage === 'implement')?.runId, writerId);
    assert.equal(f.runtime.isRunActive(writerId), true);
    assert.notEqual(f.runtime.getRun(answerId)?.workspacePath, f.runtime.getRun(writerId)?.workspacePath);
    const question = f.team.ledger.messages(started.id).find(item => item.type === 'ask')!;
    assert.deepEqual(question.from, { kind: 'profile', profileId: 'leader' });
    assert.deepEqual(question.to, { kind: 'profile', profileId: 'engineer' });
    assert.equal(question.processing, 'processing');
    answerHold.release();
    const observedTask = await wait(() => f.team.getTask(started.id), task => task.chat!.messages.some(message => message.text === observed));
    assert.equal(observedTask.nodes.find(node => node.id === coordinator.id)?.attempt, 2);
    assert.equal(observedTask.nodes.filter(node => node.purpose === 'coordinate').length, 1);
    assert.equal(observedTask.nodes.filter(node => node.purpose === 'answer').length, 1);
    assert.equal(f.runtime.isRunActive(writerId), true);
    assert.equal(f.counts().writes, 1);
    const messages = f.team.ledger.messages(started.id);
    assert.equal(messages.find(item => item.id === question.id)?.processing, 'answered');
    assert.equal(messages.find(item => item.type === 'back' && item.answerTo === question.id)?.body.text, answerText);
    assert.equal(messages.some(item => item.type === 'ask' && item.to.kind === 'user'), false);
    writerHold.release();
    await wait(() => f.team.getTask(started.id), task => task.state === 'completed');
    assert.equal(f.counts().plans, 1);
    assert.equal(f.counts().writes, 1);
  } finally { answerHold.release(); writerHold.release(); await f.cleanup(); }
});

test('送达后的服务落盘失败不重插补充或重复派发写入，保留待核对状态', async () => {
  const hold = gate(); let target = '', deliveries = 0;
  const f = await fixture({ failFinalReceipt: true, coordinator: () => report({ coordinationReply: { action: 'steer', targetNodeId: target, text: '送补充' } }), writer: async context => {
    target = context.run.team!.nodeId; context.onSteer?.(async () => { deliveries++; }); await hold.promise;
    await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), 'export const value = 2;\n');
    return report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '已改' } });
  } });
  try {
    const started = await f.start(); await wait(() => target, Boolean);
    await f.team.chat({ taskId: started.task.id, objective: '保留原导出名', attachmentIds: [], requestId: 'delivery-failure' });
    await wait(() => f.counts().failedWrites, value => value === 1);
    hold.release(); await wait(() => f.runtime.teamRuns(started.task.id).some(run => f.runtime.isRunActive(run.id)), value => !value);
    await f.team.chat({ taskId: started.task.id, objective: '现在进度怎么样？', attachmentIds: [], requestId: 'readback' });
    const task = f.team.getTask(started.task.id);
    assert.equal(deliveries, 1); assert.equal(f.counts().writes, 1); assert.equal(task.state, 'needs_decision');
    assert.equal(task.chat!.pendingInputs.length, 0); assert.match(task.chat!.coordination!.text, /回执尚未确认/);
  } finally { hold.release(); await f.cleanup(); }
});

test('完整权限分析岗位结果不明时只诊断一次，不自动重放可能已执行的操作', async () => {
  let target = '';
  const f = await fixture({ planner: () => report({ taskPlan: plan({ needsAnalyst: true }) }),
    analyst: context => { target = context.run.team!.nodeId; throw new Error('临时读取失败'); },
    coordinator: () => report({ coordinationReply: { action: 'retry', targetNodeId: target, text: '重试读取' } }) });
  try {
    const started = await f.start();
    const failed = await wait(() => f.team.getTask(started.task.id), value => value.state === 'blocked' && value.chat?.coordination?.phase === 'needs_input');
    assert.match(failed.reason || '', /不能自动重复写入/);
    assert.equal(failed.chat!.autoRecoveryAttempts, 1); assert.equal(failed.budgetLimit, null);
    assert.equal(f.calls.filter(run => run.teamContext?.includes('本次诊断目标节点：')).length, 1);
    assert.equal(f.counts().writes, 0);
    await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(f.counts().analyses, 1);
  } finally { await f.cleanup(); }
});

test('诊断计划格式修正直接采集原运行并派发排查，不要求用户选岗位或重放原操作', async () => {
  let target = '', originalRunId = '';
  const criteria: AgentTaskPlan['acceptanceCriteria'] = [
    { id: 'AC-1', text: '只读排查当前value并提供原始证据', source: '用户原话', stage: 'verify' },
    { id: 'AC-2', text: '另设岗位独立审查排查结果', source: '推断：模型自行增加', stage: 'review' },
  ];
  const original = report({ taskPlan: plan({ templateId: 'diagnosis', allowedPaths: [], acceptanceCriteria: criteria }), questions: [] });
  const corrected = plan({ templateId: 'diagnosis', allowedPaths: [], acceptanceCriteria: criteria.slice(0, 1) });
  const f = await fixture({
    planner: context => { target = context.run.team!.nodeId; originalRunId = context.run.id; return original; },
    coordinator: context => {
      assert.match(context.run.teamContext || '', /可修复的计划报告：/);
      assert.match(context.run.teamContext || '', /诊断模板没有独立审查阶段/);
      assert.match(context.run.teamContext || '', /模型自行增加/);
      return report({ coordinationReply: { action: 'repair_plan', targetNodeId: target, text: '修正误加的流程，继续原排查。', taskPlan: corrected } });
    },
    writer: async context => {
      const actual = await fs.readFile(path.join(context.run.workspacePath, 'src/value.js'), 'utf8');
      assert.equal(actual, 'export const value = 1;\n');
      return report({ diagnosis: { summary: '只读排查完成', rootCause: '当前value为1', evidence: [actual], unverified: [], suggestions: [] } });
    },
  });
  try {
    const started = await f.team.chat({ objective: '只读排查value当前是什么，提供证据', attachmentIds: [], requestId: 'diagnose', workspacePath: f.source, accessMode: 'full' });
    const done = await wait(() => f.team.getTask(started.task.id), value => value.state === 'completed');
    assert.equal(done.objective, started.task.objective);
    assert.equal(f.counts().plans, 1); assert.equal(f.counts().writes, 1);
    assert.equal(f.calls.filter(run => run.team?.profileId === 'leader').length, 2);
    assert.ok(!done.nodes.some(node => ['verify', 'review'].includes(node.stage)));
    assert.equal(done.chat!.autoRecoveryAttempts, 1);
    const repaired = done.nodes.find(node => node.id === target)!;
    assert.equal(repaired.runId, originalRunId); assert.equal(repaired.attempt, 1); assert.equal(repaired.status, 'completed');
    assert.equal(f.runtime.teamRuns(done.id).find(run => run.id === originalRunId)?.result, original);
    assert.deepEqual(done.plan, corrected);
    assert.equal(repaired.planRepair?.runId, originalRunId);
    assert.equal(repaired.planRepair?.coordinatorRunId, done.nodes.find(node => node.purpose === 'coordinate')?.runId);
    assert.equal(repaired.planRepair?.result, repaired.result);
    assert.ok(done.artifacts?.some(item => item.kind === 'plan-repair'));
    const audit = done.artifacts!.find(item => item.kind === 'plan-repair')!;
    assert.match(await fs.readFile(audit.path, 'utf8'), /另设岗位独立审查排查结果/);
    assert.equal(await fs.readFile(path.join(f.source, 'src/value.js'), 'utf8'), 'export const value = 1;\n');
  } finally { await f.cleanup(); }
});

test('历史格式阻塞在用户重试后仅修复原计划，重新打开服务不自动派发', async () => {
  let target = '', originalRunId = '', coordinationCalls = 0;
  const corrected = plan({ templateId: 'diagnosis', allowedPaths: [], acceptanceCriteria: [{ id: 'AC-1', text: '只读检查value', source: '用户原话', stage: 'verify' }] });
  const original = report({ taskPlan: { ...corrected, acceptanceCriteria: [...corrected.acceptanceCriteria,
    { id: 'AC-2', text: '独立审查排查结果', source: '推断：模型自行增加', stage: 'review' }] } });
  const f = await fixture({
    planner: context => { target = context.run.team!.nodeId; originalRunId = context.run.id; return original; },
    coordinator: () => ++coordinationCalls === 1
      ? report({ coordinationReply: { action: 'observe', text: '旧版本未恢复格式错误。' } })
      : report({ coordinationReply: { action: 'repair_plan', targetNodeId: target, text: '仅修正已有计划报告。', taskPlan: corrected } }),
    writer: () => report({ diagnosis: { summary: '排查完成', rootCause: 'value为1', evidence: ['读取src/value.js'], unverified: [], suggestions: [] } }),
  });
  let runtime: Awaited<ReturnType<typeof createAgentRuntimeService>> | undefined, team: Awaited<ReturnType<typeof createAgentTeamService>> | undefined;
  try {
    const started = await f.team.chat({ objective: '只读排查value', attachmentIds: [], requestId: 'historical-plan', workspacePath: f.source, accessMode: 'full' });
    await wait(() => f.team.getTask(started.task.id), value => value.state === 'blocked' && value.chat?.coordination?.phase === 'needs_input');
    await f.team.close(); await f.runtime.close(); const callCount = f.calls.length;
    runtime = await createAgentRuntimeService(f.data, { adapters: f.adapters }); team = await createAgentTeamService(f.data, runtime);
    assert.equal(team.getTask(started.task.id).state, 'blocked'); assert.equal(f.calls.length, callCount);
    await team.decide(started.task.id, { action: 'retry', nodeId: target, requestId: 'retry-old-format' });
    const done = await wait(() => team!.getTask(started.task.id), value => value.state === 'completed');
    assert.equal(f.counts().plans, 1); assert.equal(f.counts().writes, 1); assert.equal(coordinationCalls, 2);
    const repaired = done.nodes.find(node => node.id === target)!;
    assert.equal(repaired.runId, originalRunId); assert.equal(repaired.attempt, 1);
    assert.equal(runtime.teamRuns(done.id).find(run => run.id === originalRunId)?.result, original);
    assert.equal(done.nodes.find(node => node.runId === repaired.planRepair?.coordinatorRunId)?.coordinationSource, 'manual');
    assert.equal(await fs.readFile(path.join(f.source, 'src/value.js'), 'utf8'), 'export const value = 1;\n');
  } finally { await team?.close(); await runtime?.close(); await f.cleanup(); }
});

test('计划修复仅还原同 ID 验收来源，文本、阶段、范围及待答问题仍须校验', () => {
  const original = plan({ allowedPaths: ['.delivery-artifacts/**', '/tmp/report/**'],
    acceptanceCriteria: [{ id: 'AC-1', text: '核对原始证据', source: '用户原话；本轮命令输出', stage: 'verify' }],
    questions: [{ id: 'Q-1', text: '确认测试环境', blocking: true }] });
  const repair = { ...original, allowedPaths: ['.delivery-artifacts/**'],
    acceptanceCriteria: original.acceptanceCriteria.map(item => ({ ...item, source: '修复器改写的来源' })) };
  const before = structuredClone(repair);
  const restored = restorePlanRepairSources(original, repair);
  assert.deepEqual(restored.acceptanceCriteria, original.acceptanceCriteria);
  assert.deepEqual(repair, before, '不修改修复器的原始报告');
  for (const criteria of [[], [{ ...repair.acceptanceCriteria[0], id: 'AC-other' }],
    [{ ...repair.acceptanceCriteria[0], text: '替换为其他验收' }], [{ ...repair.acceptanceCriteria[0], stage: 'review' as const }]]) {
    assert.throws(() => restorePlanRepairSources(original, { ...repair, acceptanceCriteria: criteria }));
  }
  assert.throws(() => restorePlanRepairSources(original, { ...repair, questions: [] }), /阻断问题/);
  assert.throws(() => restorePlanRepairSources({ ...original, allowedPaths: ['.delivery-artifacts/**'] }, { ...repair, allowedPaths: ['src/**'] }), /allowedPaths/);
  assert.throws(() => restorePlanRepairSources(original, { ...repair, allowedPaths: ['/tmp/report/**'] }), /相对路径/);
});

for (const retryTarget of ['plan', 'coordinator'] as const) test(`来源误改的已完成计划修复报告仅重新接收并暂停：${retryTarget}`, async () => {
  let target = '', coordinatorReport = '';
  const original = plan({ templateId: 'verification', allowedPaths: ['.delivery-artifacts/**', '/tmp/report/**'],
    acceptanceCriteria: [{ id: 'AC-1', text: '核对原始证据', source: '用户原话；本轮命令输出', stage: 'verify' }] });
  const repair = { ...original, allowedPaths: ['.delivery-artifacts/**'],
    acceptanceCriteria: original.acceptanceCriteria.map(item => ({ ...item, source: '修复器改写的来源' })) };
  const f = await fixture({ failPlanSourceReceipt: retryTarget === 'coordinator',
    planner: context => { target = context.run.team!.nodeId; return report({ taskPlan: original }); },
    coordinator: () => coordinatorReport = report({ coordinationReply: { action: 'repair_plan', targetNodeId: target, text: '仅修正路径格式', taskPlan: repair } }),
  });
  let reopened: Awaited<ReturnType<typeof createAgentTeamService>> | undefined;
  try {
    const started = await f.start();
    const blocked = await wait(() => f.team.getTask(started.task.id), task => task.state === 'blocked'
      && task.nodes.some(node => node.purpose === 'coordinate' && node.error === planRepairScopeError));
    const coordinator = blocked.nodes.find(node => node.purpose === 'coordinate')!, originalNode = blocked.nodes.find(node => node.id === target)!;
    const calls = f.calls.map(run => run.id), input = { action: 'retry' as const,
      nodeId: retryTarget === 'plan' ? target : coordinator.id, requestId: 'saved-plan-source-retry' };
    if (retryTarget === 'coordinator') {
      await assert.rejects(f.team.decide(blocked.id, input), /模拟计划重新接收保存失败/);
      const failed = f.team.getTask(blocked.id);
      assert.equal(failed.state, 'blocked'); assert.equal(failed.plan, undefined); assert.equal(failed.chat!.paused, true);
      assert.equal(failed.requestIds[input.requestId], undefined);
      assert.equal(failed.nodes.find(node => node.id === coordinator.id)!.error, planRepairScopeError);
      assert.equal(failed.nodes.find(node => node.id === target)!.planRepair, undefined);
      assert.deepEqual(f.calls.map(run => run.id), calls);
      const persisted = JSON.parse(await fs.readFile(path.join(f.data, 'team-tasks.json'), 'utf8')).tasks.find((task: { id: string }) => task.id === blocked.id);
      assert.equal(persisted.state, 'blocked'); assert.equal(persisted.plan, undefined); assert.equal(persisted.requestIds[input.requestId], undefined);
    }
    const result = await f.team.decide(blocked.id, input);
    assert.equal(result.state, 'waiting_input'); assert.equal(result.chat!.paused, true); assert.equal(result.chat!.resumeRequested, false);
    assert.equal(result.confirmedAt, undefined); assert.equal(result.confirmedBy, undefined);
    assert.deepEqual(result.plan!.acceptanceCriteria, original.acceptanceCriteria);
    assert.deepEqual(result.plan!.allowedPaths, ['.delivery-artifacts/**']);
    assert.equal(result.planRevision, 1); assert.equal(result.planHistory!.length, 1);
    assert.equal(result.nodes.length, blocked.nodes.length); assert.deepEqual(f.calls.map(run => run.id), calls);
    for (const prior of [originalNode, coordinator]) {
      const node = result.nodes.find(node => node.id === prior.id)!;
      assert.equal(node.status, 'completed'); assert.equal(node.runId, prior.runId); assert.equal(node.attempt, prior.attempt);
      assert.equal(node.receiptRunId, prior.runId);
    }
    assert.equal(f.runtime.getRun(originalNode.runId!)!.result, report({ taskPlan: original }));
    assert.equal(f.runtime.getRun(coordinator.runId!)!.result, coordinatorReport);
    const audit = result.artifacts!.find(item => item.kind === 'plan-repair')!;
    const saved = JSON.parse(await fs.readFile(audit.path, 'utf8'));
    assert.equal(saved.coordinatorResult, coordinatorReport); assert.equal(saved.originalResult, report({ taskPlan: original }));
    await f.team.close(); reopened = await createAgentTeamService(f.data, f.runtime);
    assert.equal(reopened.getTask(blocked.id).state, 'waiting_input'); assert.equal(reopened.getTask(blocked.id).chat!.paused, true);
    await reopened.decide(blocked.id, input);
    await assert.rejects(reopened.decide(blocked.id, { ...input, nodeId: coordinator.id, requestId: 'different-id-same-receipt' }), /已接收/);
    assert.deepEqual(f.calls.map(run => run.id), calls);
    assert.equal(await fs.readFile(path.join(f.source, 'src/value.js'), 'utf8'), 'export const value = 1;\n');
  } finally { await reopened?.close(); await f.cleanup(); }
});

test('已完成计划修复报告仍拒绝过期协调状态与未确认结束的运行', async () => {
  let target = '';
  const original = plan({ allowedPaths: ['src/**', '/tmp/report/**'] });
  const f = await fixture({ planner: context => { target = context.run.team!.nodeId; return report({ taskPlan: original }); },
    coordinator: () => report({ coordinationReply: { action: 'repair_plan', targetNodeId: target, text: '仅修正路径', taskPlan: {
      ...original, allowedPaths: ['src/**'], acceptanceCriteria: original.acceptanceCriteria.map(item => ({ ...item, source: '错误改写' })),
    } } }),
  });
  const getRun = f.runtime.getRun;
  let reopened: Awaited<ReturnType<typeof createAgentTeamService>> | undefined;
  try {
    const started = await f.start();
    const blocked = await wait(() => f.team.getTask(started.task.id), task => task.nodes.some(node => node.purpose === 'coordinate' && node.error === planRepairScopeError));
    const coordinator = blocked.nodes.find(node => node.purpose === 'coordinate')!, calls = f.calls.length;
    for (const id of [coordinator.runId!, blocked.nodes.find(node => node.id === target)!.runId!]) {
      f.runtime.getRun = runId => runId === id ? { ...getRun(runId)!, resultReady: false } : getRun(runId);
      await assert.rejects(f.team.decide(blocked.id, { action: 'retry', nodeId: coordinator.id, requestId: `unconfirmed:${id}` }), /不能仅重新接收计划/);
      f.runtime.getRun = getRun;
    }
    await f.team.close();
    // 与 receiveCoordination 完全相同：revision 存在时，缺失 AnswerId 也不能当作空串匹配。
    coordinator.coordinationPlanRevision = blocked.planRevision; coordinator.coordinationAnswerId = undefined;
    const file = path.join(f.data, 'team-tasks.json'), stored = JSON.parse(await fs.readFile(file, 'utf8'));
    stored.tasks = [blocked]; await fs.writeFile(file, JSON.stringify(stored));
    reopened = await createAgentTeamService(f.data, f.runtime);
    await assert.rejects(reopened.decide(blocked.id, { action: 'retry', nodeId: coordinator.id, requestId: 'stale-source-repair' }), /不能仅重新接收计划/);
    assert.equal(reopened.getTask(blocked.id).plan, undefined);
    assert.equal(reopened.getTask(blocked.id).nodes.find(node => node.id === coordinator.id)!.status, 'blocked');
    assert.equal(f.calls.length, calls);
  } finally { f.runtime.getRun = getRun; await reopened?.close(); await f.cleanup(); }
});

test('用户要求独立复核时修正为验证模板，保留审查验收并实际派发对应岗位', async () => {
  let target = '';
  const criteria: AgentTaskPlan['acceptanceCriteria'] = [
    { id: 'AC-1', text: '读取value并提供证据', source: '用户原话', stage: 'verify' },
    { id: 'AC-2', text: '独立复核证据', source: '用户原话：再独立复核', stage: 'review' },
  ];
  const corrected = plan({ templateId: 'verification', allowedPaths: [], acceptanceCriteria: criteria });
  const f = await fixture({
    planner: context => { target = context.run.team!.nodeId; return report({ taskPlan: { ...corrected, templateId: 'diagnosis' } }); },
    coordinator: () => report({ coordinationReply: { action: 'repair_plan', targetNodeId: target, text: '保留独立复核要求，使用验证流程。', taskPlan: corrected } }),
    verifier: async context => {
      assert.equal(await fs.readFile(path.join(context.run.workspacePath, 'src/value.js'), 'utf8'), 'export const value = 1;\n');
      return report({ validationEvidence: emptyDeliveryEvidence(), taskResult: { role: 'verifier', status: 'succeeded', summary: '已读取value', acceptance: [
        { id: 'AC-1', status: 'passed', evidence: '读取src/value.js：value为1' }, { id: 'AC-2', status: 'not_run', evidence: '等待独立复核' },
      ] } });
    },
    reviewer: async context => {
      assert.equal(await fs.readFile(path.join(context.run.workspacePath, 'src/value.js'), 'utf8'), 'export const value = 1;\n');
      return report({ taskResult: { role: 'reviewer', status: 'succeeded', verdict: 'approved', summary: '独立读取确认一致', findings: [],
        acceptance: [{ id: 'AC-2', status: 'passed', evidence: '独立读取src/value.js确认value为1，与验证证据一致' }] } });
    },
  });
  try {
    const started = await f.team.chat({ objective: '只读排查value，再独立复核证据', attachmentIds: [], requestId: 'independent-review', workspacePath: f.source, accessMode: 'full' });
    const done = await wait(() => f.team.getTask(started.task.id), value => value.state === 'completed');
    assert.equal(f.counts().plans, 1); assert.equal(f.counts().writes, 0);
    assert.deepEqual(done.plan?.acceptanceCriteria, criteria); assert.equal(done.plan?.templateId, 'verification');
    for (const role of ['verifier', 'reviewer']) assert.equal(f.calls.filter(run => run.team?.profileId === role).length, 1);
    assert.ok(!done.nodes.some(node => node.stage === 'implement'));
    assert.equal(await fs.readFile(path.join(f.source, 'src/value.js'), 'utf8'), 'export const value = 1;\n');
  } finally { await f.cleanup(); }
});

test('修正计划不能删除原有阻塞问题后自动派发', async () => {
  let target = '', originalRunId = '';
  const corrected = plan({ templateId: 'diagnosis', allowedPaths: [], acceptanceCriteria: [{ id: 'AC-1', text: '核对value', source: '用户原话', stage: 'verify' }] });
  const original = report({ taskPlan: { ...corrected,
    acceptanceCriteria: [...corrected.acceptanceCriteria, { id: 'AC-2', text: '额外独立审查', source: '推断：模型自行增加', stage: 'review' }],
    questions: [{ id: 'Q-1', text: '确认要核对的目标环境', blocking: true }],
  } });
  const f = await fixture({
    planner: context => { target = context.run.team!.nodeId; originalRunId = context.run.id; return original; },
    coordinator: () => report({ coordinationReply: { action: 'repair_plan', targetNodeId: target, text: '修正格式并继续排查', taskPlan: corrected } }),
  });
  try {
    const started = await f.team.chat({ objective: '只读核对value', attachmentIds: [], requestId: 'blocked-question', workspacePath: f.source, accessMode: 'full' });
    const blocked = await wait(() => f.team.getTask(started.task.id), value => value.state === 'blocked'
      && value.nodes.some(node => node.purpose === 'coordinate' && node.status === 'blocked'));
    assert.equal(f.counts().plans, 1); assert.equal(f.counts().writes, 0);
    assert.equal(blocked.plan, undefined);
    const originalNode = blocked.nodes.find(node => node.id === target)!;
    assert.equal(originalNode.status, 'blocked'); assert.equal(originalNode.attempt, 1); assert.equal(originalNode.planRepair, undefined);
    assert.equal(f.runtime.teamRuns(blocked.id).find(run => run.id === originalRunId)?.result, original);
    assert.ok(!blocked.artifacts?.some(item => item.kind === 'plan-repair'));
    assert.equal(await fs.readFile(path.join(f.source, 'src/value.js'), 'utf8'), 'export const value = 1;\n');
  } finally { await f.cleanup(); }
});

for (const invalidTarget of ['writer', 'unknown_plan', 'invalid_repair'] as const) test(`计划报告修正不能越过失败边界：${invalidTarget}`, async () => {
  let target = '';
  const invalidPlan = plan({ templateId: 'diagnosis', allowedPaths: [], acceptanceCriteria: [{ id: 'AC-1', text: '检查结果', source: '用户原话', stage: 'review' }] });
  const f = await fixture({
    planner: context => {
      if (invalidTarget !== 'writer') target = context.run.team!.nodeId;
      if (invalidTarget === 'unknown_plan') throw new Error('临时读取失败，未返回计划结果');
      return report({ taskPlan: invalidTarget === 'invalid_repair' ? invalidPlan : plan() });
    },
    writer: context => { target = context.run.team!.nodeId; return '已运行，但没有可校验的交付报告'; },
    coordinator: () => report({ coordinationReply: { action: 'repair_plan', targetNodeId: target, text: '尝试修正格式',
      taskPlan: invalidTarget === 'invalid_repair' ? invalidPlan : plan() } }),
  });
  try {
    const started = await f.start();
    const blocked = await wait(() => f.team.getTask(started.task.id), value => value.state === 'blocked'
      && value.nodes.some(node => node.purpose === 'coordinate' && node.status === 'blocked'));
    assert.equal(f.counts().plans, 1); assert.equal(f.counts().writes, invalidTarget === 'writer' ? 1 : 0);
    const originalNode = blocked.nodes.find(node => node.id === target)!;
    assert.equal(originalNode.status, 'blocked'); assert.equal(originalNode.attempt, 1); assert.equal(originalNode.planRepair, undefined);
    assert.ok(!blocked.artifacts?.some(item => item.kind === 'plan-repair'));
    assert.ok(!blocked.nodes.some(node => ['verify', 'review'].includes(node.stage) && node.status === 'completed'));
    assert.equal(await fs.readFile(path.join(f.source, 'src/value.js'), 'utf8'), 'export const value = 1;\n');
  } finally { await f.cleanup(); }
});

test('不同失败可再次自动诊断，用户明确重试后继续原任务', async () => {
  let target = '';
  const f = await fixture({ planner: () => report({ taskPlan: plan({ needsAnalyst: true }) }),
    analyst: (context, turn) => {
      target = context.run.team!.nodeId;
      if (turn <= 2) throw new Error(turn === 1 ? '临时读取失败' : '读取已恢复但报告暂未完整');
      return report({ requirementBrief: { facts: [], inferences: [], gaps: [], acceptanceCriteria: [], sources: [] } });
    }, coordinator: () => report({ coordinationReply: { action: 'retry', targetNodeId: target, text: '按新失败证据重试读取' } }) });
  try {
    const started = await f.start();
    for (let attempt = 1; attempt <= 2; attempt++) {
      await wait(() => f.team.getTask(started.task.id), value => value.state === 'blocked' && value.chat?.coordination?.phase === 'needs_input' && value.chat.autoRecoveryAttempts === attempt);
      assert.equal(f.counts().analyses, attempt);
      await f.team.decide(started.task.id, { action: 'retry', nodeId: target, requestId: `explicit-retry-${attempt}` });
    }
    const done = await wait(() => f.team.getTask(started.task.id), value => value.state === 'completed');
    assert.equal(done.chat!.autoRecoveryAttempts, 2); assert.equal(done.chat!.autoRecoveryKeys?.length, 2);
    assert.equal(f.counts().analyses, 3); assert.equal(f.counts().writes, 1);
  } finally { await f.cleanup(); }
});

test('已知业务阻塞由负责人调整安排后继续原目标，不重复已完成操作', async () => {
  const f = await fixture({ coordinator: () => report({ coordinationReply: { action: 'replan', text: '已核对可用本地资料，调整未完成部分' } }), writer: async (context, turn) => {
    if (turn === 1) return report({ taskResult: { role: 'implementer', status: 'blocked', summary: '当前资料路径需要负责人调整', blockers: ['需要改用已核实的现有资料'] } });
    assert.match(context.run.teamContext!, /把value改为2并验证/);
    await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), 'export const value = 2;\n');
    return report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '已完成原目标' } });
  } });
  try {
    const started = await f.start(); const done = await wait(() => f.team.getTask(started.task.id), value => value.state === 'completed');
    assert.equal(done.objective, started.task.objective); assert.equal(done.chat!.autoRecoveryAttempts, 1); assert.equal(done.budgetLimit, null);
    assert.equal(f.counts().plans, 2); assert.equal(f.counts().writes, 2);
  } finally { await f.cleanup(); }
});

for (const scenario of [
  { action: 'observe', status: 'failed' }, { action: 'ask', status: 'failed' },
  { action: 'retry', status: 'failed' }, { action: 'replan', status: 'failed' }, { action: 'replan', status: 'blocked' },
  { action: 'retry', status: 'blocked', incomplete: true }, { action: 'replan', status: 'blocked', incomplete: true },
  { action: 'retry', status: 'succeeded', summaryOnly: true }, { action: 'replan', status: 'succeeded', summaryOnly: true },
] as const) test(`附加门禁失败只诊断一次，${scenario.status}/${scenario.action}/${'incomplete' in scenario ? '缺证据' : '证据完整'}/${'summaryOnly' in scenario ? '汇总失败' : '具名失败'}不触发自动返工或绕过原计划`, async () => {
  let target = '', original = '';
  const f = await fixture({ verifier: context => {
    target = context.run.team!.nodeId;
    original = report({ validationEvidence: { ...emptyDeliveryEvidence(), tests: { status: 'failed', evidence: '附加脚本退出码1', sha: '' } },
      taskResult: { role: 'verifier', status: scenario.status, summary: '已确认范围通过，附加门禁未通过', blockers: ['L002 原始环境信息'], acceptance: [
        { id: 'AC-1', status: 'passed', evidence: 'incomplete' in scenario ? '' : '已核对value为2' },
        ...('summaryOnly' in scenario ? [] : [{ id: 'EXTRA-1', status: 'failed', evidence: 'L003 附加门禁原始证据' }]),
      ] } });
    return original;
  }, coordinator: context => {
    assert.ok(context.run.teamContext?.includes('summaryOnly' in scenario ? '附加脚本退出码1' : 'L003 附加门禁原始证据'));
    return report({ coordinationReply: { action: scenario.action, ...(scenario.action === 'retry' ? { targetNodeId: target } : {}), text: '负责人诊断结论或待确认问题' } });
  } });
  let reopened: Awaited<ReturnType<typeof createAgentTeamService>> | undefined;
  try {
    const started = await f.start();
    const blocked = await wait(() => f.team.getTask(started.task.id), value => value.chat?.coordination?.phase === 'needs_input');
    assert.equal(blocked.state, scenario.action === 'ask' ? 'waiting_input' : 'blocked');
    assert.equal(blocked.nodes.find(node => node.id === target)?.status, 'blocked');
    assert.equal(blocked.nodes.find(node => node.id === target)?.result, original);
    assert.equal(blocked.round, 0); assert.equal(blocked.planRevision, 1);
    assert.deepEqual(blocked.plan!.acceptanceCriteria, plan().acceptanceCriteria);
    assert.deepEqual(blocked.plan!.allowedPaths, ['src/**']);
    assert.equal(blocked.nodes.filter(node => node.stage === 'implement').length, 1);
    assert.equal(blocked.nodes.some(node => node.profileId === 'frontend' || node.stage === 'review'), false);
    assert.equal(blocked.chat!.autoRecoveryAttempts, 1);
    assert.equal(f.calls.filter(run => run.teamContext?.includes('本次诊断目标节点：')).length, 1);
    assert.equal(f.calls.filter(run => run.team?.profileId === 'verifier').length, 1);
    assert.deepEqual(f.counts(), { plans: 1, writes: 1, analyses: 0, failedWrites: 0 });
    if (['retry', 'replan'].includes(scenario.action)) {
      assert.match(blocked.reason || '', /附加门禁仍待诊断/); assert.match(blocked.reason || '', /负责人诊断结论或待确认问题/);
    }
    await wait(() => f.team.isIdle(), Boolean); await f.team.close();
    const count = f.calls.length;
    reopened = await createAgentTeamService(f.data, f.runtime);
    await wait(() => reopened!.isIdle(), Boolean);
    assert.equal(f.calls.length, count, '重新采集同一结果不能重复诊断或派发');
    assert.equal(reopened.getTask(started.task.id).nodes.find(node => node.id === target)?.result, original);
  } finally { await reopened?.close(); await f.cleanup(); }
});

test('升级读取历史blocked任务不自动拉起诊断或写入', async () => {
  const f = await fixture({ writer: () => { throw new Error('历史失败'); } });
  let runtime: Awaited<ReturnType<typeof createAgentRuntimeService>> | undefined, team: Awaited<ReturnType<typeof createAgentTeamService>> | undefined;
  try {
    const started = await f.start(); await wait(() => f.team.getTask(started.task.id), value => value.state === 'blocked');
    await f.team.close(); await f.runtime.close();
    const file = path.join(f.data, 'team-tasks.json'), data = JSON.parse(await fs.readFile(file, 'utf8'));
    const saved = data.tasks.find((item: { id: string }) => item.id === started.task.id);
    saved.state = 'blocked'; saved.reason = '历史失败';
    saved.chat.autoRecoveryAttempts = 1; delete saved.chat.autoRecoveryKeys; delete saved.chat.coordination;
    saved.nodes = saved.nodes.filter((node: { purpose?: string }) => node.purpose !== 'coordinate'); await fs.writeFile(file, JSON.stringify(data));
    const count = f.calls.length;
    runtime = await createAgentRuntimeService(f.data, { adapters: f.adapters }); team = await createAgentTeamService(f.data, runtime);
    assert.equal(team.getTask(started.task.id).state, 'blocked'); assert.equal(f.calls.length, count);
  } finally { await team?.close(); await runtime?.close(); await f.cleanup(); }
});

test('控制短语不会把否定暂停或普通说明误认为授权，直接收紧执行的自然句会暂停', () => {
  assert.equal(teamChatControl('先别改这个页面，我再补充一下'), 'pause');
  assert.equal(teamChatControl('不要暂停，继续处理这份资料'), undefined);
  assert.equal(teamChatControl('解释为什么要暂停'), undefined);
  assert.equal(teamChatControl('现在进度怎么样？'), 'status');
  assert.equal(teamChatControl('继续执行'), 'resume');
  assert.equal(teamChatControl('继续啊！'), 'resume');
  assert.equal(teamChatControl('继续呀'), 'resume');
  assert.equal(teamChatControl('继续解释这个问题'), undefined);
  assert.equal(teamChatControl('不要继续'), undefined);
  for (const text of ['你到底在干什么？', '怎么又派任务？', '为什么又启动 Agent？',
    '不是我就让你修复一个 本地 构建报错？你到底在干什么？',
    '什么意思 我就让你 修复 构建错误 你一直在干什么？？', '我只是让你改个按钮，你们到底在做什么？']) {
    assert.equal(teamChatControl(text), 'status', text);
  }
  for (const text of ['只修本地构建报错', '你到底在干什么？继续修复构建报错',
    '不是我就让你修复一个本地构建报错？你到底在干什么？现在重新执行', '在页面显示“你到底在干什么”']) {
    assert.equal(teamChatControl(text), undefined, text);
  }
});

test('任务完成后的范围追问返回已有结果，不创建任务、节点或模型调用', async () => {
  const f = await fixture();
  try {
    const started = await f.start();
    const before = await wait(() => f.team.getTask(started.task.id), value => value.state === 'completed');
    const calls = f.calls.length;
    const input = { taskId: before.id, objective: '不是我就让你修复一个 本地 构建报错？你到底在干什么？',
      attachmentIds: [], requestId: 'completed-scope-question' };
    const reply = await f.team.chat(input);
    assert.equal(reply.task.id, before.id);
    assert.equal(reply.task.state, 'completed');
    assert.equal(reply.task.objective, before.objective);
    assert.deepEqual(reply.task.nodes, before.nodes);
    assert.equal(reply.task.chat!.pendingInputs.length, 0);
    assert.equal(f.calls.length, calls);
    const receipt = reply.task.chat!.messages.find(item => item.id.startsWith('status-reply:'))!;
    assert.match(receipt.text, /已修改value/);
    assert.equal(receipt.hostGenerated, true);
    await f.team.chat(input);
    assert.equal(f.team.getTask(before.id).chat!.messages.filter(item => item.id.startsWith('status-reply:')).length, 1);
    assert.equal(f.calls.length, calls);
  } finally { await f.cleanup(); }
});

test('暂停后的普通咨询得到只读回复，重复暂停各有回执，继续啊只恢复一次未完成步骤', async () => {
  const f = await fixture({ coordinator: () => report({ coordinationReply: { action: 'observe', text: '表格整体易懂，建议把前置受阻解释为测试条件未满足。' } }),
    writer: async (context, turn) => {
      if (turn === 1) {
        await new Promise<void>(resolve => context.signal.aborted ? resolve() : context.signal.addEventListener('abort', () => resolve(), { once: true }));
        throw new Error('运行已停止');
      }
      else await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), 'export const value = 2;\n');
      return report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '已处理' } });
    } });
  try {
    const started = await f.start(); await wait(() => f.counts().writes, count => count === 1);
    for (const requestId of ['pause-once', 'pause-again', 'pause-again']) await f.team.chat({ taskId: started.task.id, objective: '暂停任务', attachmentIds: [], requestId });
    await wait(() => f.team.getTask(started.task.id), value => value.chat?.coordination?.phase === 'paused');
    await f.team.chat({ taskId: started.task.id, objective: '表格内容是否通俗易懂？', attachmentIds: [], requestId: 'read-only-followup' });
    const answered = await wait(() => f.team.getTask(started.task.id), value => value.chat!.messages.some(message => message.text.startsWith('表格整体易懂')) && value.chat?.coordination?.phase === 'paused');
    assert.equal(answered.chat!.paused, true); assert.equal(f.counts().writes, 1); assert.equal(f.counts().plans, 1);
    const pauses = answered.chat!.messages.filter(message => message.role === 'user' && message.text === '暂停任务');
    assert.equal(pauses.length, 2);
    for (const input of pauses) assert.equal(answered.chat!.messages.filter(message => message.hostGenerated && message.replyTo === input.id).length, 1);
    const input = { taskId: started.task.id, objective: '继续啊', attachmentIds: [], requestId: 'resume-colloquial' };
    await f.team.chat(input); await f.team.chat(input);
    const done = await wait(() => f.team.getTask(started.task.id), value => value.state === 'completed');
    assert.equal(done.chat!.paused, false); assert.equal(f.counts().writes, 2); assert.equal(f.counts().plans, 1);
    const resumed = done.chat!.messages.find(message => message.role === 'user' && message.text === '继续啊')!;
    assert.equal(done.chat!.messages.filter(message => message.hostGenerated && message.replyTo === resumed.id).length, 1);
  } finally { await f.cleanup(); }
});

test('多项计划问题等待时普通补充不自动答题，明确答案只关联指定问题并保留原话一次', async () => {
  const f = await fixture({ planner: () => report({ taskPlan: plan({ questions: [
    { id: 'Q-1', text: '第一项范围？', blocking: true }, { id: 'Q-2', text: '第二项目标？', blocking: true },
  ] }) }), coordinator: context => {
    const pending = JSON.parse(/待回答问题：([^\n]+)/.exec(context.run.teamContext!)![1]) as { id: string; text: string }[];
    assert.equal(context.run.mode, 'agent'); assert.equal(context.run.accessMode, 'full'); assert.doesNotMatch(context.run.teamContext!, /聊天执行约束：/);
    return context.run.teamContext!.includes('本次原始补充：第二项选择value为2')
      ? report({ coordinationReply: { action: 'answer', questionId: pending.find(item => item.text === '第二项目标？')!.id, text: '第二项明确' } })
      : report({ coordinationReply: { action: 'observe', text: '已记录补充，两个问题仍待确认。' } });
  } });
  try {
    const started = await f.start(); await wait(() => f.team.getTask(started.task.id), value => value.state === 'awaiting_plan');
    await f.team.chat({ taskId: started.task.id, objective: '补充：完成后告诉我改了哪些文件', attachmentIds: [], requestId: 'general-supplement' });
    const untouched = await wait(() => f.team.getTask(started.task.id), value => value.state === 'awaiting_plan' && value.nodes.some(node => node.purpose === 'coordinate' && node.status === 'completed'));
    assert.equal(untouched.chat!.messages.filter(message => message.replyTo).length, 0); assert.equal(untouched.planAnswers?.length || 0, 0);
    assert.equal(f.counts().plans, 1); assert.equal(f.counts().writes, 0);
    await f.team.chat({ taskId: started.task.id, objective: '第二项选择value为2', attachmentIds: [], requestId: 'answer-second' });
    const partial = await wait(() => f.team.getTask(started.task.id), value => value.chat!.messages.some(message => message.replyTo?.endsWith(':Q-2')));
    assert.equal(partial.chat!.messages.filter(message => message.replyTo).length, 1);
    assert.equal(partial.chat!.messages.filter(message => message.text === '第二项选择value为2').length, 1);
    assert.equal(partial.chat!.messages.some(message => message.replyTo?.endsWith(':Q-1')), false); assert.equal(f.counts().plans, 1);
  } finally { await f.cleanup(); }
});

test('岗位等待问题时用户改变方向交负责人重排，不把新要求作为旧问题答案', async () => {
  const f = await fixture({ coordinator: () => report({ coordinationReply: { action: 'replan', text: '按新方向调整后续安排' } }), writer: async (context, turn) => {
    if (turn === 1) return report({ questions: [{ to: 'user', text: '旧范围是否包含导出？', blocking: true }] });
    assert.match(context.run.teamContext!, /改为只处理value/);
    await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), 'export const value = 2;\n');
    return report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '按新方向完成' } });
  } });
  try {
    const started = await f.start(); const waiting = await wait(() => f.team.getTask(started.task.id), value => value.state === 'waiting_input');
    const old = waiting.nodes.find(node => node.stage === 'implement')!;
    await f.team.chat({ taskId: started.task.id, objective: '改为只处理value，导出留到以后', attachmentIds: [], requestId: 'new-direction' });
    const done = await wait(() => f.team.getTask(started.task.id), value => value.state === 'completed');
    assert.equal(f.team.ledger.messages(done.id).filter(message => message.type === 'back').length, 0);
    assert.equal(done.chat!.messages.some(message => message.text.startsWith('改为只处理') && message.replyTo), false);
    assert.equal(done.nodes.find(node => node.id === old.id)?.status, 'skipped'); assert.equal(f.counts().plans, 2); assert.equal(f.counts().writes, 2);
    assert.equal(done.objective, started.task.objective);
  } finally { await f.cleanup(); }
});

test('协调者引用失效或虚构问题时不代答任何问题，不启动实施', async () => {
  const f = await fixture({ planner: () => report({ taskPlan: plan({ questions: [{ id: 'Q-1', text: '当前范围？', blocking: true }] }) }),
    coordinator: () => report({ coordinationReply: { action: 'answer', questionId: 'unknown-question', text: '模型声称全部已答' } }) });
  try {
    const started = await f.start(); await wait(() => f.team.getTask(started.task.id), value => value.state === 'awaiting_plan');
    await f.team.chat({ taskId: started.task.id, objective: '只修改value', attachmentIds: [], requestId: 'invalid-question' });
    const task = await wait(() => f.team.getTask(started.task.id), value => value.chat?.coordination?.phase === 'needs_input');
    assert.equal(task.chat!.messages.filter(message => message.replyTo).length, 0); assert.equal(f.counts().writes, 0);
    assert.equal(task.chat!.messages.some(message => message.text === '模型声称全部已答'), false);
  } finally { await f.cleanup(); }
});

test('用户新计划先进入时迟到的自动诊断不能把状态改回blocked并卡死待执行计划', async () => {
  const hold = gate(); let coordinating: Context | undefined;
  const f = await fixture({ planner: (_context, turn) => report({ taskPlan: plan(turn > 1 ? { questions: [{ id: 'Q-1', text: '新的范围？', blocking: true }] } : {}) }),
    writer: () => { throw new Error('原步骤失败'); }, coordinator: async context => { coordinating = context; await hold.promise; return report({ coordinationReply: { action: 'observe', text: '原阻塞仍需处理' } }); } });
  try {
    const started = await f.start(); await wait(() => coordinating, Boolean);
    const run = f.runtime.getRun(coordinating!.run.id)!;
    const getRun = f.runtime.getRun, teamRuns = f.runtime.teamRuns, isActive = f.runtime.isRunActive;
    const completed = { ...run, status: 'completed' as const, resultReady: true, result: report({ coordinationReply: { action: 'observe', text: '原阻塞仍需处理' } }) };
    f.runtime.getRun = id => id === run.id ? completed : getRun(id);
    f.runtime.teamRuns = id => teamRuns(id).map(item => item.id === run.id ? completed : item);
    f.runtime.isRunActive = id => id === run.id ? false : isActive(id);
    try { await f.team.chat({ taskId: started.task.id, objective: '继续处理后续安排', attachmentIds: [], requestId: 'new-plan-before-receipt' }); }
    finally { f.runtime.getRun = getRun; f.runtime.teamRuns = teamRuns; f.runtime.isRunActive = isActive; }
    hold.release();
    const next = await wait(() => f.team.getTask(started.task.id), value => value.state === 'awaiting_plan');
    assert.equal(next.planRevision, 2); assert.equal(next.nodes.find(node => node.runId === run.id)?.status, 'skipped');
    assert.equal(f.counts().writes, 1);
  } finally { hold.release(); await f.cleanup(); }
});

test('执行中补充的附件立即交给协调者，消费后保留给后续岗位且上限校验不丢草稿', async () => {
  const hold = gate();
  const f = await fixture({ writer: async context => { await hold.promise; await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), 'export const value = 2;\n');
    return report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '已完成' } }); },
    coordinator: context => { assert.deepEqual(context.run.attachments?.map(item => item.id), ['new-reference']); return report({ coordinationReply: { action: 'observe', text: '补充资料已核对' } }); } });
  try {
    const started = await f.start(); await wait(() => f.counts().writes, value => value === 1);
    await f.team.chat({ taskId: started.task.id, objective: '补充资料供核对', attachmentIds: ['new-reference'], requestId: 'busy-attachment' });
    const handled = await wait(() => f.team.getTask(started.task.id), value => value.chat!.pendingInputs.length === 0 && value.nodes.some(node => node.purpose === 'coordinate' && node.status === 'completed'));
    assert.deepEqual(handled.attachmentIds, ['new-reference']);
    await wait(() => f.team.isIdle(), Boolean);
    const count = f.team.getTask(started.task.id).chat!.messages.length;
    const tooMany = { taskId: started.task.id, objective: '再补充', attachmentIds: ['a', 'b', 'c', 'd', 'e', 'f'], requestId: 'too-many' };
    await assert.rejects(f.team.chat(tooMany), /超过 6/); await assert.rejects(f.team.chat(tooMany), /超过 6/);
    assert.equal(f.team.getTask(started.task.id).chat!.messages.length, count);
    hold.release(); await wait(() => f.team.getTask(started.task.id), value => value.state === 'completed');
    assert.ok(f.calls.filter(run => ['verifier', 'reviewer'].includes(run.team?.profileId || '')).every(run => run.attachments?.some(item => item.id === 'new-reference')));
  } finally { hold.release(); await f.cleanup(); }
});

test('延迟处理替换附件的旧输入时，不再二次替换掉随后补充的新附件', async () => {
  const writerHold = gate(), coordinatorHold = gate(); let coordinations = 0;
  const plannedAttachments: string[][] = [];
  const f = await fixture({ planner: (context, turn) => {
    if (turn > 1) plannedAttachments.push((context.run.attachments || []).map(item => item.id));
    return report({ taskPlan: plan() });
  }, writer: async () => { await writerHold.promise; return report({ questions: [{ to: 'user', text: '请确认范围', blocking: true }] }); },
  coordinator: async () => { if (++coordinations === 1) await coordinatorHold.promise; return report({ coordinationReply: { action: 'replan', text: '按补充资料调整安排' } }); } });
  try {
    const started = await f.start(); await wait(() => f.counts().writes, value => value === 1);
    await f.team.chat({ taskId: started.task.id, objective: '替换旧附件并按此范围调整', attachmentIds: ['replacement'], requestId: 'replace-attachment' });
    await wait(() => coordinations, value => value === 1);
    await f.team.chat({ taskId: started.task.id, objective: '还有一份补充资料', attachmentIds: ['later-reference'], requestId: 'later-attachment' });
    coordinatorHold.release(); writerHold.release();
    await wait(() => plannedAttachments.length, value => value > 0);
    assert.deepEqual(plannedAttachments[0], ['replacement', 'later-reference']);
    assert.deepEqual(f.team.getTask(started.task.id).attachmentIds, ['replacement', 'later-reference']);
  } finally { coordinatorHold.release(); writerHold.release(); await f.cleanup(); }
});

test('暂停期间回答问题只记录答案，不恢复写入或空转，明确继续后完成', async () => {
  const f = await fixture({ planner: (_context, turn) => report({ taskPlan: plan(turn === 1 ? { questions: [{ id: 'Q-1', text: '目标值？', blocking: true }] } : {}) }),
    coordinator: context => { const pending = JSON.parse(/待回答问题：([^\n]+)/.exec(context.run.teamContext!)![1]) as { id: string }[];
      return report({ coordinationReply: { action: 'answer', questionId: pending[0].id, text: '记录答案' } }); } });
  try {
    const started = await f.start(); await wait(() => f.team.getTask(started.task.id), value => value.state === 'awaiting_plan');
    await f.team.chat({ taskId: started.task.id, objective: '暂停执行', attachmentIds: [], requestId: 'pause-before-answer' });
    await f.team.chat({ taskId: started.task.id, objective: '目标值选择2', attachmentIds: [], requestId: 'answer-while-paused' });
    const paused = await wait(() => f.team.getTask(started.task.id), value => value.chat!.messages.some(message => message.replyTo?.endsWith(':Q-1')) && value.chat?.coordination?.phase === 'paused');
    assert.equal(paused.chat!.paused, true); assert.equal(f.counts().writes, 0);
    await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(f.team.isIdle(), true);
    await f.team.chat({ taskId: started.task.id, objective: '继续执行', attachmentIds: [], requestId: 'resume-after-answer' });
    await wait(() => f.team.getTask(started.task.id), value => value.state === 'completed'); assert.equal(f.counts().writes, 1);
  } finally { await f.cleanup(); }
});

test('较新的精确回复生成计划后，迟到的旧消息重排不得覆盖更正或重放旧输入', async () => {
  const hold = gate(); let coordinated = false;
  const planInputs: string[] = [];
  const f = await fixture({ planner: (context, turn) => {
    planInputs.push(/本次用户输入：([^\n]+)/.exec(context.run.teamContext!)![1]);
    return report({ taskPlan: plan(turn === 1 ? { questions: [{ id: 'Q-1', text: '目标值？', blocking: true }] } : {}) });
  }, coordinator: async () => { coordinated = true; await hold.promise; return report({ coordinationReply: { action: 'replan', text: '按旧消息重新安排为value=3' } }); } });
  try {
    const started = await f.start();
    const waiting = await wait(() => f.team.getTask(started.task.id), value => value.state === 'awaiting_plan');
    const question = waiting.chat!.messages.find(message => message.id.endsWith(':Q-1'))!;
    await f.team.chat({ taskId: started.task.id, objective: '只处理value=3', attachmentIds: [], requestId: 'old-direction' });
    await wait(() => coordinated, Boolean);
    await f.team.answer(started.task.id, { correlationId: question.id, text: '更正：以这条回复为准，只处理value=2', requestId: 'new-answer' });
    hold.release();
    const done = await wait(() => f.team.getTask(started.task.id), value => value.state === 'completed');
    assert.deepEqual(planInputs, ['把value改为2并验证', '更正：以这条回复为准，只处理value=2']);
    assert.equal(done.nodes.find(node => node.purpose === 'coordinate')?.status, 'skipped');
    assert.equal(done.chat!.pendingInputs.length, 0); assert.equal(f.counts().writes, 1);
    assert.equal(done.chat!.messages.filter(message => message.text === '只处理value=3').length, 1);
    assert.equal(await fs.readFile(path.join(f.source, 'src/value.js'), 'utf8'), 'export const value = 2;\n');
  } finally { hold.release(); await f.cleanup(); }
});

test('部分问题收到新回复后重新核对旧输入，不丢失另一题答案或重复答题', async () => {
  const hold = gate(); let coordinations = 0;
  const f = await fixture({ planner: (_context, turn) => report({ taskPlan: plan(turn === 1 ? { questions: [
    { id: 'Q-1', text: '目标值？', blocking: true }, { id: 'Q-2', text: '修改范围？', blocking: true },
  ] } : {}) }), coordinator: async context => {
    const pending = JSON.parse(/待回答问题：([^\n]+)/.exec(context.run.teamContext!)![1]) as { id: string }[];
    if (++coordinations === 1) await hold.promise;
    return report({ coordinationReply: { action: 'answer', questionId: pending.find(question => question.id.endsWith(':Q-2'))!.id, text: '第二题范围明确' } });
  } });
  try {
    const started = await f.start();
    const waiting = await wait(() => f.team.getTask(started.task.id), value => value.state === 'awaiting_plan');
    await f.team.chat({ taskId: started.task.id, objective: '范围只修改value', attachmentIds: [], requestId: 'answer-second-before-first' });
    await wait(() => coordinations, value => value === 1);
    await f.team.answer(started.task.id, { correlationId: waiting.chat!.messages.find(message => message.id.endsWith(':Q-1'))!.id, text: '目标值为2', requestId: 'answer-first-later' });
    hold.release();
    const done = await wait(() => f.team.getTask(started.task.id), value => value.state === 'completed');
    assert.equal(coordinations, 2); assert.equal(f.counts().plans, 2); assert.equal(f.counts().writes, 1);
    assert.equal(done.chat!.messages.filter(message => message.replyTo?.endsWith(':Q-1')).length, 1);
    assert.equal(done.chat!.messages.filter(message => message.replyTo?.endsWith(':Q-2')).length, 1);
  } finally { hold.release(); await f.cleanup(); }
});

test('协调者追问得到精确回复后按新尝试更新快照，合法续作不会被旧水位拒绝', async () => {
  let coordinations = 0;
  const f = await fixture({ planner: (_context, turn) => report({ taskPlan: plan(turn === 1 ? { questions: [{ id: 'Q-1', text: '目标值？', blocking: true }] } : {}) }),
    coordinator: context => {
      if (++coordinations === 1) return report({ coordinationReply: { action: 'ask', text: '你是指目标值还是范围？' } });
      assert.match(context.run.teamContext!, /更正：目标值为2/);
      return report({ coordinationReply: { action: 'replan', text: '按明确回复安排目标值为2' } });
    } });
  try {
    const started = await f.start(); await wait(() => f.team.getTask(started.task.id), value => value.state === 'awaiting_plan');
    await f.team.chat({ taskId: started.task.id, objective: '就用2', attachmentIds: [], requestId: 'ambiguous-answer' });
    const waiting = await wait(() => f.team.getTask(started.task.id), value => value.nodes.some(node => node.purpose === 'coordinate' && node.status === 'waiting_input'));
    const question = waiting.chat!.messages.find(message => message.text === '你是指目标值还是范围？')!;
    await f.team.answer(started.task.id, { correlationId: question.id, text: '更正：目标值为2', requestId: 'clarify-coordinator' });
    const done = await wait(() => f.team.getTask(started.task.id), value => value.state === 'completed');
    assert.equal(coordinations, 2); assert.equal(f.counts().writes, 1);
    assert.equal(done.nodes.find(node => node.purpose === 'coordinate')?.status, 'completed');
  } finally { await f.cleanup(); }
});

for (const scenario of ['resume', 'question', 'newer-pause'] as const) {
  test(`重载暂停期间遗留的未派发消息：${scenario}，恢复原输入且不重复执行`, async () => {
    let coordinations = 0;
    const f = await fixture({ coordinator: context => {
      coordinations++;
      assert.equal(context.run.mode, 'agent'); assert.equal(context.run.accessMode, 'full');
      assert.match(context.run.teamContext!, /表格内容是否通俗易懂/);
      return report({ coordinationReply: { action: 'observe', text: '表格内容清楚，个别术语可以进一步解释。' } });
    }, writer: async (context, turn) => {
      if (turn === 1) {
        await new Promise<void>(resolve => context.signal.aborted ? resolve() : context.signal.addEventListener('abort', () => resolve(), { once: true }));
        throw new Error('运行已停止');
      }
      await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), 'export const value = 2;\n');
      return report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '已处理' } });
    } });
    let reopenedRuntime: Awaited<ReturnType<typeof createAgentRuntimeService>> | undefined;
    let reopenedTeam: Awaited<ReturnType<typeof createAgentTeamService>> | undefined;
    try {
      const started = await f.start(); await wait(() => f.counts().writes, count => count === 1);
      await f.team.chat({ taskId: started.task.id, objective: '暂停任务', attachmentIds: [], requestId: 'pause-before-reload' });
      await wait(() => f.team.getTask(started.task.id), value => value.chat?.coordination?.phase === 'paused');
      await f.team.close(); await f.runtime.close();

      // Recreate the exact old durable state: consumeChat removed the input, but its plan was never dispatched.
      const filename = path.join(f.data, 'team-tasks.json');
      const saved = JSON.parse(await fs.readFile(filename, 'utf8')) as { tasks: ReturnType<typeof f.team.getTask>[] };
      const task = saved.tasks.find(item => item.id === started.task.id)!;
      const inputId = randomUUID(), nodeId = randomUUID(), createdAt = new Date().toISOString();
      task.chat!.messages.push({ id: inputId, role: 'user', kind: 'message', nodeId, text: scenario === 'question' ? '表格内容是否通俗易懂？' : '继续啊', attachmentIds: [], createdAt });
      task.nodes.push({ id: nodeId, stage: 'plan', profileId: 'leader', status: 'pending', dependencies: [], attempt: 1,
        round: task.round, chatInputId: inputId, resumeState: 'waiting_input', createdAt, updatedAt: createdAt });
      task.chat!.lastInputId = inputId;
      if (scenario === 'newer-pause') task.chat!.messages.push({ id: randomUUID(), role: 'user', kind: 'message', text: '暂停任务',
        attachmentIds: [], createdAt: new Date(Date.parse(createdAt) + 1).toISOString() });
      await fs.writeFile(filename, JSON.stringify(saved));

      reopenedRuntime = await createAgentRuntimeService(f.data, { adapters: f.adapters });
      reopenedTeam = await createAgentTeamService(f.data, reopenedRuntime);
      const recovered = await wait(() => reopenedTeam!.getTask(task.id), value => scenario === 'resume' ? value.state === 'completed'
        : value.chat?.coordination?.phase === 'paused' && (scenario !== 'question' || value.chat.messages.some(message => message.text.startsWith('表格内容清楚'))));
      assert.equal(recovered.nodes.find(node => node.id === nodeId)?.status, 'skipped');
      assert.equal(recovered.nodes.find(node => node.id === nodeId)?.purpose, 'coordinate', '遗留空计划不能遮住原有效计划或问题');
      assert.equal(recovered.chat!.pendingInputs.length, 0);
      assert.equal(recovered.objective, started.task.objective);
      assert.equal(f.counts().plans, 1, '恢复输入不重复创建原计划');
      assert.equal(f.counts().writes, scenario === 'resume' ? 2 : 1, '只有最新明确继续才恢复已停止岗位一次');
      assert.equal(recovered.chat!.paused, scenario !== 'resume');
      assert.equal(coordinations, scenario === 'question' ? 1 : 0);
      if (scenario !== 'question') {
        const receipts = recovered.chat!.messages.filter(message => message.hostGenerated && message.replyTo === inputId);
        assert.equal(receipts.length, 1);
        assert.match(receipts[0].text, scenario === 'resume' ? /已收到继续请求/ : /仍保持暂停/);
      }

      await reopenedTeam.close(); await reopenedRuntime.close();
      reopenedRuntime = await createAgentRuntimeService(f.data, { adapters: f.adapters });
      reopenedTeam = await createAgentTeamService(f.data, reopenedRuntime);
      assert.equal(reopenedTeam.getTask(task.id).chat!.messages.filter(message => message.id === inputId).length, 1);
      assert.equal(f.counts().writes, scenario === 'resume' ? 2 : 1, '再次重载不能重放已处理输入或写入');
      assert.equal(coordinations, scenario === 'question' ? 1 : 0);
    } finally { await reopenedTeam?.close(); await reopenedRuntime?.close(); await f.cleanup(); }
  });
}
