import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import { createAgentTeamService } from '../server/agent-team-service.js';
import { CodexDesktopTurnUnconfirmedError } from '../server/codex-desktop-turn.js';
import { emptyDeliveryEvidence } from '../shared/delivery-acceptance.js';
import type { AgentProvider, AgentRun, AgentRuntimeHealth } from '../shared/agent-runtime.js';
import type { AgentTaskPlan } from '../shared/agent-task-plan.js';

type Context = Parameters<AgentRuntimeAdapter['execute']>[0];
const report = (value: object) => `\`\`\`delivery-report\n${JSON.stringify({ version: 1, ...value })}\n\`\`\``;
const exec = promisify(execFile);
const plan = (extra: Partial<AgentTaskPlan> = {}): AgentTaskPlan => ({ templateId: 'engineering', reason: '按用户目标修复', risk: 'medium',
  acceptanceCriteria: [{ id: 'AC-1', text: 'value为2', source: '用户原话' }], allowedPaths: ['src/**'], needsAnalyst: false, needsArchitect: false,
  questions: [], risks: [], ownership: [], shared: [], ...extra });
const health = (provider: AgentProvider): AgentRuntimeHealth => ({ provider, label: provider, binary: 'fixture', version: 'fixture', ready: true, authenticated: true,
  message: 'ready', modes: ['agent', 'ask', 'plan'], writable: true, defaultModel: '', checkedAt: new Date().toISOString(),
  models: provider === 'codex' ? ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'].map(id => ({ id, label: id, efforts: ['low', 'medium', 'high'] }))
    : provider === 'cursor' ? [{ id: 'composer-2.5', label: 'Composer' }]
      : [{ id: 'sonnet', label: 'Sonnet 5.5', efforts: ['high'] }, { id: 'opus', label: 'Opus 5.5', efforts: ['high'] }] });
async function waitFor<T>(read: () => T, predicate: (item: T) => boolean) {
  for (let i = 0; i < 1000; i++) { const value = read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(`等待超时：${JSON.stringify(read())}`);
}
async function fixture(leader: (context: Context, turn: number, source: string) => string | Promise<string>, implementation?: (context: Context) => Promise<string>, git = false,
  recoveryOptions: Pick<NonNullable<Parameters<typeof createAgentRuntimeService>[1]>, 'readCodexDesktopSnapshot' | 'codexSessionSource'> = {}, autoBindWorkspace = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-team-chat-')), data = path.join(root, 'data'), source = path.join(root, 'source');
  await fs.mkdir(path.join(source, 'src'), { recursive: true }); await fs.writeFile(path.join(source, 'src/value.js'), 'export const value = 1;\n');
  if (git) {
    await exec('git', ['-C', source, 'init', '-q', '-b', 'main']); await exec('git', ['-C', source, 'add', '.']);
    await exec('git', ['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', '临时聊天基线夹具']);
  }
  let turns = 0; const calls: AgentRun[] = [];
  const adapters = (['codex', 'claude', 'cursor'] as const).map(provider => ({ id: provider, health: async () => health(provider), execute: async (context: Context) => {
    await context.onSession(context.resumeSessionId || `${provider}:${context.run.id}`); calls.push(structuredClone(context.run));
    if (!context.run.team) return '前一轮完成的方案';
    if (context.run.team?.profileId === 'leader') {
      if (context.run.teamContext?.includes('本次诊断目标节点：')) {
        const pending = JSON.parse(/待回答问题：([^\n]+)/.exec(context.run.teamContext)?.[1] || '[]') as { id: string }[];
        if (pending.length) return report({ coordinationReply: { action: 'answer', questionId: pending[0].id, text: '本次原话回答了指定问题。' } });
      }
      if (context.run.teamContext?.includes('本次诊断目标节点：') && !context.run.teamContext.includes('本次诊断目标节点：无')) {
        return report({ coordinationReply: { action: 'observe', text: '已核对当前阻塞，执行岗位结果仍需处理。' } });
      }
      const output = await leader(context, ++turns, source);
      if (context.run.teamContext?.includes('本次诊断目标节点：') && output.includes('"taskPlan"')) {
        return report({ coordinationReply: { action: 'observe', text: '补充已核对，继续原范围。' } });
      }
      return output;
    }
    if (context.run.team?.profileId === 'engineer') {
      if (implementation) return implementation(context);
      await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), 'export const value = 2;\n');
      return report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '已修改value' } });
    }
    if (context.run.team?.profileId === 'verifier') return report({ validationEvidence: emptyDeliveryEvidence(),
      taskResult: { role: 'verifier', status: 'succeeded', summary: '实际夹具检查通过', acceptance: [{ id: 'AC-1', status: 'passed', evidence: '文件内容为2' }] } });
    if (context.run.team?.profileId === 'reviewer') return report({ taskResult: { role: 'reviewer', status: 'succeeded', verdict: 'approved', summary: '已独立核对', findings: [] } });
    throw new Error(`unexpected role ${context.run.team?.profileId}`);
  } }));
  const runtime = await createAgentRuntimeService(data, { adapters, ...recoveryOptions, resolveAttachments: async ids => ids.map(id => ({
    attachment: { id, name: `${id}.txt`, mimeType: 'text/plain', size: 1, url: `/api/agent-runtimes/attachments/${id}`, createdAt: new Date().toISOString() }, filePath: path.join(source, 'src/value.js'),
  })) }), team = await createAgentTeamService(data, runtime, { readWorkspaceCandidates: autoBindWorkspace ? async () => [source] : async () => [] });
  return { root, data, source, runtime, team, adapters, calls, done: (id: string) => waitFor(() => team.getTask(id), task => ['completed', 'awaiting_acceptance', 'blocked', 'needs_decision', 'waiting_input', 'awaiting_plan'].includes(task.state)),
    cleanup: async () => { await team.close(); await runtime.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

test('同岗位先诊断再实施不复用已清理副本，旧错误目录重试也回到持久工作区', async () => {
  for (const legacyRetry of [false, true]) {
    let engineerCalls = 0;
    const f = await fixture((_context, turn) => report({ taskPlan: plan({ templateId: turn === 1 ? 'diagnosis' : 'engineering' }) }), async context => {
      engineerCalls += 1;
      if (engineerCalls === 1) return report({ diagnosis: { summary: 'value为1', rootCause: '尚未修改', evidence: ['读取src/value.js'], unverified: [], suggestions: ['改为2'] } });
      if (legacyRetry && engineerCalls === 2) throw new Error('夹具模拟启动失败');
      await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), 'export const value = 2;\n');
      return report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '已修改value' } });
    }, true);
    let reopenedRuntime: Awaited<ReturnType<typeof createAgentRuntimeService>> | undefined;
    let reopenedTeam: Awaited<ReturnType<typeof createAgentTeamService>> | undefined;
    try {
      const started = await f.team.chat({ objective: '先诊断', attachmentIds: [], requestId: 'diagnose', workspacePath: f.source });
      const diagnosed = await f.done(started.task.id);
      assert.equal(diagnosed.state, 'completed', diagnosed.reason || '');
      const diagnosticPath = diagnosed.nodes.find(node => node.stage === 'diagnose')!.workspacePath!;
      assert.equal(await fs.access(diagnosticPath).then(() => true, () => false), false, '诊断副本已按流程清理');
      const continued = await f.team.chat({ objective: '修复并验证', attachmentIds: [], requestId: 'implement', taskId: diagnosed.id, parentRunId: started.runId });
      let done = await f.done(continued.task.id);
      if (legacyRetry) {
        assert.equal(done.state, 'blocked');
        const implementation = done.nodes.find(node => node.stage === 'implement')!;
        const durableWorkspace = implementation.workspacePath;
        await f.team.close(); await f.runtime.close();
        const file = path.join(f.data, 'team-tasks.json'), saved = JSON.parse(await fs.readFile(file, 'utf8'));
        const task = saved.tasks.find((item: { id: string }) => item.id === done.id);
        const node = task.nodes.find((item: { id: string }) => item.id === implementation.id);
        task.workspacePath = durableWorkspace;
        node.workspacePath = diagnosticPath; node.runId = undefined; node.receiptRunId = undefined;
        node.leaseToken = undefined; node.leaseOwner = undefined;
        task.reason = node.error = `ENOENT: realpath '${diagnosticPath}'`;
        await fs.writeFile(file, JSON.stringify(saved));
        reopenedRuntime = await createAgentRuntimeService(f.data, { adapters: f.adapters });
        reopenedTeam = await createAgentTeamService(f.data, reopenedRuntime);
        await reopenedTeam.decide(done.id, { action: 'retry', nodeId: node.id, requestId: 'retry-legacy-directory' });
        done = await waitFor(() => reopenedTeam!.getTask(done.id), task => ['completed', 'blocked'].includes(task.state));
        assert.equal(done.workspacePath, durableWorkspace, '保留已存在的候选工作区');
      }
      assert.equal(done.state, 'completed', done.reason || '');
      assert.notEqual(done.workspacePath, diagnosticPath);
      assert.equal(done.workspacePath, await fs.realpath(f.source));
      assert.equal(await fs.readFile(path.join(done.workspacePath!, 'src/value.js'), 'utf8'), 'export const value = 2;\n');
      assert.equal(await fs.readFile(path.join(f.source, 'src/value.js'), 'utf8'), 'export const value = 2;\n');
      assert.equal(engineerCalls, legacyRetry ? 3 : 2);
    } finally { await reopenedTeam?.close(); await reopenedRuntime?.close(); await f.cleanup(); }
  }
});

test('桌面观察超时后只核对原轮次，补收晚到改动并自动完成后续岗位', async () => {
  const turnId = '22222222-2222-4222-8222-222222222222';
  let nativeRun: AgentRun, complete = false;
  const f = await fixture(() => report({ taskPlan: plan() }), async context => {
    nativeRun = context.run; await context.onTurn!(turnId);
    throw new CodexDesktopTurnUnconfirmedError('未确认桌面端本轮结束，正在核对原会话；未自动重复发送。');
  }, false, {
    codexSessionSource: { listSessions: async () => [], session: async () => { throw new Error('没有持久化完成记录'); } },
    readCodexDesktopSnapshot: async id => ({ id, hostId: 'local', resumeState: 'resumed', turns: [{ id: turnId,
      status: complete ? 'completed' : 'inProgress', items: [{ type: 'agentMessage', text: report({ taskResult: {
        role: 'implementer', status: 'succeeded', summary: '原轮次已修改value' } }) }] }] }),
  });
  try {
    const started = await f.team.chat({ objective: '修复value并验证', attachmentIds: [], requestId: 'desktop-recovery', workspacePath: f.source });
    await waitFor(() => f.team.getTask(started.task.id), task => task.state === 'needs_reconciliation');
    await f.runtime.reconcileRecovery();
    assert.equal(nativeRun!.recovery?.state, 'active');
    await waitFor(() => f.team.getTask(started.task.id), task => task.state === 'running');
    assert.equal(nativeRun!.error, '');
    assert.equal(f.calls.filter(run => run.team?.profileId === 'engineer').length, 1);
    await fs.writeFile(path.join(nativeRun!.workspacePath, 'src/value.js'), 'export const value = 2;\n');
    complete = true;
    const done = await f.done(started.task.id);
    assert.equal(done.state, 'completed', done.reason || '');
    assert.equal(nativeRun!.changedFiles?.some(file => file.path === 'src/value.js'), true);
    assert.equal(nativeRun!.recovery?.workspaceBefore, undefined);
    assert.deepEqual(f.calls.map(run => run.team?.profileId), ['leader', 'engineer', 'verifier', 'reviewer']);
  } finally { await f.cleanup(); }
});

test('历史已消费的桌面超时失败在重启核对后接续流程，不重新执行工程岗位', async () => {
  const turnId = '22222222-2222-4222-8222-222222222222';
  const f = await fixture(() => report({ taskPlan: plan() }), async context => {
    await context.onTurn!(turnId);
    await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), 'export const value = 2;\n');
    throw new Error('未确认桌面端本轮结束，请检查原会话；未自动重复发送。状态读取超时');
  });
  let runtime: Awaited<ReturnType<typeof createAgentRuntimeService>> | undefined;
  let team: Awaited<ReturnType<typeof createAgentTeamService>> | undefined;
  try {
    const started = await f.team.chat({ objective: '修复value并验证', attachmentIds: [], requestId: 'desktop-old-failure', workspacePath: f.source });
    const failed = await f.done(started.task.id);
    assert.equal(failed.state, 'blocked');
    const node = failed.nodes.find(item => item.stage === 'implement')!;
    assert.equal(node.receiptRunId, node.runId);
    await f.team.close(); await f.runtime.close();
    // 真实长会话保留旧轮阻塞节点；它们不能阻止当前轮恢复。
    const taskFile = path.join(f.data, 'team-tasks.json');
    const savedTasks = JSON.parse(await fs.readFile(taskFile, 'utf8'));
    const savedTask = savedTasks.tasks.find((item: { id: string }) => item.id === started.task.id);
    savedTask.round += 1;
    for (const item of savedTask.nodes) item.round = savedTask.round;
    savedTask.nodes.push({ ...node, id: '11111111-1111-4111-8111-111111111111', round: 0, runId: undefined,
      receiptRunId: undefined, error: '旧轮已处理的业务阻塞' });
    await fs.writeFile(taskFile, JSON.stringify(savedTasks));
    runtime = await createAgentRuntimeService(f.data, { adapters: f.adapters, readCodexDesktopSnapshot: async id => ({
      id, hostId: 'local', resumeState: 'resumed', turns: [{ id: turnId, status: 'completed', items: [{ type: 'agentMessage',
        text: report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '原轮次完成' } }) }] }],
    }) });
    team = await createAgentTeamService(f.data, runtime);
    await runtime.reconcileRecovery();
    const done = await waitFor(() => team!.getTask(started.task.id), task => ['completed', 'blocked'].includes(task.state));
    assert.equal(done.state, 'completed', done.reason || '');
    assert.equal(f.calls.filter(run => run.team?.profileId === 'engineer').length, 1);
    assert.equal(done.nodes.find(item => item.stage === 'implement')?.runId, node.runId);
  } finally { await team?.close(); await runtime?.close(); await f.cleanup(); }
});

test('聊天你好无需项目、零实施；重复请求去重，后续直答保持主会话且真实用户文本只存一次', async () => {
  const f = await fixture((_context, turn) => report({ conversationReply: { text: turn === 1 ? '你好，请直接说目标。' : '这是进一步的说明。' } }));
  try {
    const input = { objective: '你好', attachmentIds: [], requestId: 'hello-1' };
    const started = await f.team.chat(input), done = await f.done(started.task.id);
    assert.equal(done.state, 'completed'); assert.equal(done.chat?.workspaceBound, false);
    const reply = done.chat!.messages.find(message => message.role === 'assistant' && message.kind === 'message')!;
    assert.equal(reply.provider, f.calls[0].provider); assert.equal(reply.model, f.calls[0].model);
    assert.equal(done.chat!.messages.find(message => message.role === 'user')!.provider, undefined);
    assert.equal(done.nodes.some(node => node.stage === 'implement'), false);
    assert.match(f.calls[0].workspacePath, /chat-workspaces/); assert.equal(f.calls[0].mode, 'agent');
    assert.equal(f.calls[0].conversationId, started.conversationId);
    await f.team.chat(input); assert.equal(f.calls.length, 1);
    const next = await f.team.chat({ objective: '再解释一下', attachmentIds: [], requestId: 'hello-2', taskId: started.task.id }); await f.done(next.task.id);
    assert.notEqual(next.task.id, started.task.id);
    assert.deepEqual(f.team.getTask(next.task.id).chat!.messages.filter(m => m.role === 'user').map(m => m.text), ['再解释一下']);
    assert.match(f.calls[1].teamContext!, /你好/);
    assert.equal(f.calls.length, 2); assert.equal(f.calls[1].conversationId, started.conversationId);
    assert.equal(f.team.getTask(next.task.id).chat!.messages.some(m => m.text === '这是进一步的说明。'), true);
  } finally { await f.cleanup(); }
});

test('Leader误把继续执行请求当聊天回复时，宿主重新生成计划并继续派发岗位', async () => {
  const f = await fixture((_context, turn) => turn === 1
    ? report({ conversationReply: { text: '我会继续处理。', resumeWorkflow: true } })
    : report({ taskPlan: plan() }));
  try {
    const started = await f.team.chat({ objective: '修复value并验证', attachmentIds: [], requestId: 'resume-plan-1', workspacePath: f.source });
    const done = await f.done(started.task.id);
    assert.equal(done.state, 'completed', done.reason || '');
    assert.deepEqual(f.calls.map(run => run.team?.profileId), ['leader', 'leader', 'engineer', 'verifier', 'reviewer']);
    assert.equal(done.nodes.filter(node => node.stage === 'plan').length, 2);
  } finally { await f.cleanup(); }
});

test('Leader连续误回继续执行时，宿主停在等待回复而不留下空转运行状态', async () => {
  const f = await fixture(() => report({ conversationReply: { text: '我会继续处理。', resumeWorkflow: true } }));
  try {
    const started = await f.team.chat({ objective: '修复value并验证', attachmentIds: [], requestId: 'resume-loop-1', workspacePath: f.source });
    const waiting = await f.done(started.task.id);
    assert.equal(waiting.state, 'waiting_input');
    assert.match(waiting.reason || '', /未生成可执行计划/);
    assert.equal(waiting.nodes.some(node => node.stage === 'implement'), false);
  } finally { await f.cleanup(); }
});

test('Leader声称继续执行但未绑定项目时，不再把纯回复标记为完成', async () => {
  const f = await fixture(() => report({ conversationReply: { text: '请继续已有任务。', resumeWorkflow: true } }));
  try {
    const started = await f.team.chat({ objective: '继续修复工作台', attachmentIds: [], requestId: 'resume-workspace-1' });
    const waiting = await f.done(started.task.id);
    assert.equal(waiting.state, 'waiting_input');
    assert.match(waiting.reason || '', /项目绝对路径/);
    assert.equal(waiting.nodes.some(node => node.stage === 'implement'), false);
  } finally { await f.cleanup(); }
});

test('原生隔离父会话转聊天从含未提交成果的当前目录继续，保留原项目显示归属', async () => {
  const f = await fixture(async context => {
    assert.equal(await fs.readFile(path.join(context.run.workspacePath, 'src/value.js'), 'utf8'), 'export const value = 2;\n');
    return report({ taskPlan: plan() });
  }, async context => {
    assert.equal(await fs.readFile(path.join(context.run.workspacePath, 'src/value.js'), 'utf8'), 'export const value = 2;\n');
    await fs.appendFile(path.join(context.run.workspacePath, 'src/value.js'), '// 在父成果上继续\n');
    return report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '保留父成果并继续修改' } });
  }, true);
  try {
    const parent = await f.runtime.start({ provider: 'codex', model: 'gpt-6.1-sol', mode: 'ask', workspacePath: f.source, objective: '已有隔离任务', isolateWorkspace: true });
    await waitFor(() => f.runtime.getRun(parent.id), run => !!run?.resultReady);
    await fs.writeFile(path.join(parent.workspacePath, 'src/value.js'), 'export const value = 2;\n');
    const started = await f.team.chat({ objective: '在刚才成果上继续优化', attachmentIds: [], requestId: 'isolation-1', parentRunId: parent.id });
    const done = await f.done(started.task.id); assert.equal(done.state, 'completed', done.reason || '');
    assert.equal(done.sourceWorkspacePath, parent.workspacePath); assert.equal(done.chat!.projectWorkspacePath, await fs.realpath(f.source));
    assert.equal(await fs.readFile(path.join(f.source, 'src/value.js'), 'utf8'), 'export const value = 1;\n');
  } finally { await f.cleanup(); }
});

test('已验收任务后新目标冻结新task，基于已验收候选继续且不覆盖旧验收与目标', async () => {
  const f = await fixture(async (context, turn) => {
    if (turn === 1) return report({ taskPlan: plan() });
    assert.equal(await fs.readFile(path.join(context.run.workspacePath, 'src/value.js'), 'utf8'), 'export const value = 2;\n');
    return report({ conversationReply: { text: '已读取上次验收的value=2成果。' } });
  }, undefined, true);
  try {
    const first = await f.team.chat({ objective: '把value改为2', attachmentIds: [], requestId: 'accepted-1', workspacePath: f.source });
    const done = await f.done(first.task.id); assert.equal(done.state, 'completed', done.reason || '');
    const source = await f.team.acceptanceSource(done.id); assert.ok(source);
    const at = new Date().toISOString();
    await f.team.onAcceptance({ recordId: `team:${done.id}`, source, checks: emptyDeliveryEvidence(), decision: 'accepted', summary: '隔离测试中的人工验收记录', revision: 1, updatedAt: at });
    const old = f.team.getTask(done.id);
    const next = await f.team.chat({ objective: '解释刚才成果', attachmentIds: [], requestId: 'accepted-2', taskId: done.id });
    assert.equal((await f.done(next.task.id)).state, 'completed'); assert.notEqual(next.task.id, done.id);
    assert.equal(next.conversationId, first.conversationId); assert.equal(next.task.sourceWorkspacePath, done.workspacePath);
    assert.equal(next.task.chat!.projectWorkspacePath, await fs.realpath(f.source)); assert.deepEqual(f.team.getTask(done.id), old);
  } finally { await f.cleanup(); }
});

test('未绑定项目的暂停与继续不能绕过项目门禁', async () => {
  const f = await fixture((_context, turn) => turn === 1 ? report({ taskPlan: plan() }) : report({ conversationReply: { text: '项目指实际代码目录。' } }));
  try {
    const started = await f.team.chat({ objective: '修改value', attachmentIds: [], requestId: 'no-project-1' });
    assert.equal((await f.done(started.task.id)).state, 'waiting_input');
    await f.team.chat({ objective: '先别改，只解释一下项目', attachmentIds: [], requestId: 'no-project-2', taskId: started.task.id });
    await waitFor(() => f.team.getTask(started.task.id), task => task.nodes.filter(node => node.profileId === 'leader').every(node => node.status === 'completed'));
    await f.team.chat({ objective: '继续执行', attachmentIds: [], requestId: 'no-project-3', taskId: started.task.id });
    assert.equal(f.team.getTask(started.task.id).state, 'waiting_input'); assert.equal(f.calls.some(run => run.team?.profileId === 'engineer'), false);
  } finally { await f.cleanup(); }
});

test('岗位问题回复附加新资料时，续接worker收到旧资料与新资料且用户原文只存一次', async () => {
  let writes = 0;
  const oldId = '11111111-1111-4111-8111-111111111111', newId = '22222222-2222-4222-8222-222222222222';
  const f = await fixture(() => report({ taskPlan: plan() }), async context => {
    if (++writes === 1) return report({ questions: [{ to: 'user', text: '请补截图中的规则', blocking: true }] });
    assert.deepEqual(context.run.attachments!.map(item => item.id), [oldId, newId]);
    await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), 'export const value = 2;\n');
    return report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '已根据补充资料实现' } });
  });
  try {
    const started = await f.team.chat({ objective: '按资料修改value', attachmentIds: [oldId], requestId: 'attachment-1', workspacePath: f.source });
    assert.equal((await f.done(started.task.id)).state, 'waiting_input');
    await f.team.chat({ objective: '规则见新截图，保留原需求', attachmentIds: [newId], requestId: 'attachment-2', taskId: started.task.id });
    const done = await f.done(started.task.id); assert.equal(done.state, 'completed', done.reason || '');
    assert.deepEqual(done.attachmentIds, [oldId, newId]); assert.equal(done.chat!.messages.filter(message => message.role === 'user').length, 2);
  } finally { await f.cleanup(); }
});

test('首次原生会话转聊天传递真实父轮上下文，终态后新任务保留旧任务而不覆盖历史', async () => {
  const f = await fixture(context => {
    assert.match(context.run.teamContext!, /前一轮的真实用户要求/);
    assert.match(context.run.teamContext!, /前一轮完成的方案/);
    return report({ conversationReply: { text: '已根据前一轮上下文继续说明。' } });
  });
  try {
    const original = await f.runtime.start({ provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high', mode: 'ask', workspacePath: f.source, objective: '前一轮的真实用户要求' });
    await waitFor(() => f.runtime.getRun(original.id), run => !!run?.resultReady);
    const started = await f.team.chat({ objective: '按刚才方案继续', attachmentIds: [], requestId: 'native-1', parentRunId: original.id });
    assert.equal((await f.done(started.task.id)).state, 'completed');
    assert.equal(started.conversationId, original.conversationId);
    assert.equal(f.calls.at(-1)!.task!.role, 'main'); assert.equal(f.calls.at(-1)!.task!.parentConversationId, '');
  } finally { await f.cleanup(); }
});

test('聊天无阻塞的中/高风险本地计划自动执行，子岗位独立会话并持久化真实交接', async () => {
  for (const risk of ['medium', 'high'] as const) {
    const f = await fixture(() => report({ taskPlan: plan({ risk }) }));
    try {
      const started = await f.team.chat({ objective: '修改value为2', attachmentIds: [], requestId: 'execute-1', workspacePath: f.source });
      const done = await f.done(started.task.id); assert.equal(done.state, 'completed', done.reason || '');
      assert.equal(done.confirmedBy, 'auto');
      assert.deepEqual(f.calls.map(run => run.team?.profileId), ['leader', 'engineer', 'verifier', 'reviewer']);
      for (const run of f.calls.slice(1)) assert.notEqual(run.conversationId, started.conversationId);
      assert.ok(done.chat!.messages.some(m => m.profileId === 'engineer' && m.text === '已修改value'));
      assert.ok((await f.team.room(done.id)).messages.some(m => m.type === 'handoff' && m.from.kind === 'profile' && m.from.profileId === 'engineer'));
    } finally { await f.cleanup(); }
  }
});

test('普通Git聊天在选定项目实施，保留已有本地改动并在独立副本验证', async () => {
  const f = await fixture(() => report({ taskPlan: plan() }), undefined, true);
  try {
    const selected = path.join(f.root, 'selected-project');
    await fs.symlink(f.source, selected, 'dir');
    await fs.writeFile(path.join(f.source, 'src/local.js'), '// 用户已有未提交内容\n');
    const head = (await exec('git', ['-C', f.source, 'rev-parse', 'HEAD'])).stdout.trim();
    const started = await f.team.chat({ objective: '把value改为2并验证', attachmentIds: [], requestId: 'selected-git-project', workspacePath: selected });
    const done = await f.done(started.task.id);
    assert.equal(done.state, 'completed', done.reason || '');
    const source = await fs.realpath(f.source);
    assert.equal(done.workspacePath, source);
    assert.equal(f.calls.find(run => run.team?.profileId === 'engineer')?.workspacePath, source);
    assert.equal(f.calls.find(run => run.team?.profileId === 'reviewer')?.workspacePath, source);
    const verifier = f.calls.find(run => run.team?.profileId === 'verifier')!;
    assert.notEqual(verifier.workspacePath, source, '验证继续使用独立副本');
    assert.equal(await fs.access(verifier.workspacePath).then(() => true, () => false), false, '验证副本按流程清理');
    assert.equal(await fs.readFile(path.join(source, 'src/value.js'), 'utf8'), 'export const value = 2;\n');
    assert.equal(await fs.readFile(path.join(source, 'src/local.js'), 'utf8'), '// 用户已有未提交内容\n');
    assert.equal((await exec('git', ['-C', source, 'branch', '--show-current'])).stdout.trim(), 'main');
    assert.equal((await exec('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim(), head);
    assert.ok(done.chat!.messages.some(message => message.kind === 'delivery' && message.text.includes(`成果位置：${source}`)));
  } finally { await f.cleanup(); }
});

test('自动团队聊天保留用户工作区权限，负责人实现验证审查均使用Agent模式', async () => {
  const f = await fixture(() => report({ taskPlan: plan({ risk: 'medium' }) }));
  try {
    const started = await f.team.chat({ objective: '按工作区权限修改value', attachmentIds: [], requestId: 'access-mode-workspace', accessMode: 'workspace', workspacePath: f.source });
    const done = await f.done(started.task.id);
    assert.equal(done.accessMode, 'workspace');
    assert.equal(f.calls.find(call => call.team?.profileId === 'engineer')?.accessMode, 'workspace');
    assert.deepEqual(f.calls.map(call => call.team?.profileId), ['leader', 'engineer', 'verifier', 'reviewer']);
    assert.ok(f.calls.every(call => call.mode === 'agent' && call.accessMode === 'workspace'));
  } finally { await f.cleanup(); }
});

test('团队聊天结果自动完成，后续消息无需人工验收直接新建任务', async () => {
  const f = await fixture((_context, turn) => turn === 1
    ? report({ taskPlan: plan() })
    : report({ conversationReply: { text: '已读取上一轮结果并继续说明。' } }), undefined, true);
  try {
    const first = await f.team.chat({ objective: '把value改为2', attachmentIds: [], requestId: 'auto-result-1', workspacePath: f.source });
    const done = await f.done(first.task.id);
    assert.equal(done.state, 'completed', done.reason || '');
    assert.equal(done.confirmedBy, 'auto');
    assert.equal((await f.team.acceptanceSource(done.id))?.active, false);

    const next = await f.team.chat({ objective: '解释刚才成果', attachmentIds: [], requestId: 'auto-result-2', taskId: done.id });
    const nextDone = await f.done(next.task.id);
    assert.equal(nextDone.state, 'completed', nextDone.reason || '');
    assert.notEqual(next.task.id, done.id);
    assert.equal(f.team.getTask(done.id).state, 'completed');
    assert.equal(f.calls.filter(run => run.team?.profileId === 'leader').length, 2);
  } finally { await f.cleanup(); }
});

test('原生结束标记早于改动采集时保持节点running，宿主结果就绪前不派发验证', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(() => report({ taskPlan: plan() }), async context => {
    const run = f.runtime.getRun(context.run.id)!;
    // Model the real runtime window between adapter completion and asynchronous changed-file collection.
    run.status = 'completed'; run.result = report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '原生已返回，宿主尚在采集' } });
    await gate;
    await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), 'export const value = 2;\n');
    return run.result;
  });
  try {
    const input = { objective: '修改value为2', attachmentIds: [], requestId: 'finalization-1', workspacePath: f.source };
    const started = await f.team.chat(input);
    await waitFor(() => f.calls, calls => calls.some(run => run.team?.profileId === 'engineer'));
    await f.team.chat(input); // Serialize behind dispatch, without submitting another user turn.
    const implementation = f.team.getTask(started.task.id).nodes.find(node => node.stage === 'implement')!;
    assert.equal(implementation.status, 'running'); assert.equal(f.runtime.getRun(implementation.runId!)!.resultReady, false);
    assert.equal(f.calls.some(run => run.team?.profileId === 'verifier'), false);
    const isRunActive = f.runtime.isRunActive;
    f.runtime.isRunActive = () => false; // Persist can remain pending after the active-process entry is removed.
    try {
      const queued = await f.team.chat({ objective: '补充：继续保留value目标', attachmentIds: [], requestId: 'finalization-persist', taskId: started.task.id });
      assert.equal(queued.task.chat!.pendingInputs.length, 1, '落盘未就绪时保留补充，不提前重新派发执行岗位');
      assert.equal(f.calls.some(run => run.team?.profileId === 'verifier'), false);
    } finally { f.runtime.isRunActive = isRunActive; }
    release(); const done = await f.done(started.task.id); assert.equal(done.state, 'completed', done.reason || '');
    assert.equal(f.calls.filter(run => run.team?.profileId === 'verifier').length, 1, '不可因提前采集空改动快照再重复验证');
  } finally { release(); await f.cleanup(); }
});

test('删除协作会话清理同会话全部团队任务和运行，持久化后不再重建，保留其他会话', async () => {
  const f = await fixture(() => report({ conversationReply: { text: '已回答。' } }));
  try {
    const first = await f.team.chat({ objective: '解释value', attachmentIds: [], requestId: 'delete-team-first' });
    await f.done(first.task.id);
    const next = await f.team.chat({ objective: '继续解释', attachmentIds: [], requestId: 'delete-team-next', taskId: first.task.id });
    await f.done(next.task.id);
    const other = await f.team.chat({ objective: '另一会话', attachmentIds: [], requestId: 'delete-team-other' });
    await f.done(other.task.id);
    assert.equal(next.conversationId, first.conversationId);
    const target = { id: first.conversationId, source: 'workspace' as const };
    const missing = { id: 'missing', source: 'workspace' as const };
    assert.deepEqual(await f.team.removeConversations([target, missing, target]), {
      removed: [target], failures: [{ ...missing, message: '找不到该 Agent 会话' }],
    });
    assert.deepEqual(f.team.list().map(task => task.id), [other.task.id]);
    assert.equal(f.runtime.teamRuns(first.task.id).length, 0);
    assert.equal(f.runtime.teamRuns(next.task.id).length, 0);
    assert.ok(f.runtime.getRun(other.runId));
    const stored = JSON.parse(await fs.readFile(path.join(f.data, 'team-tasks.json'), 'utf8'));
    assert.deepEqual(stored.tasks.map((task: { id: string }) => task.id), [other.task.id]);
    assert.equal(await fs.readFile(path.join(f.source, 'src/value.js'), 'utf8'), 'export const value = 1;\n');
  } finally { await f.cleanup(); }
});

test('删除多轮已完成工程会话跳过已清理验证目录和已转移租约，保留工作区成果', async () => {
  const f = await fixture(() => report({ taskPlan: plan() }));
  try {
    const first = await f.team.chat({ objective: '修改value', attachmentIds: [], requestId: 'delete-completed-first', workspacePath: f.source });
    const done = await f.done(first.task.id);
    assert.equal(done.state, 'completed', done.reason || '');
    const verifiedPath = done.nodes.find(node => node.stage === 'verify')!.workspacePath!;
    assert.equal(await fs.access(verifiedPath).then(() => true, () => false), false);
    await fs.writeFile(path.join(f.source, 'src/value.js'), 'export const value = 1;\n');
    const next = await f.team.chat({ objective: '继续修改value', attachmentIds: [], requestId: 'delete-completed-next', taskId: first.task.id });
    const nextDone = await f.done(next.task.id);
    assert.equal(nextDone.state, 'completed', nextDone.reason || '');
    assert.equal(next.conversationId, first.conversationId);
    assert.deepEqual(await f.team.removeConversation(first.conversationId), { deleted: 8 });
    assert.equal(f.team.list().length, 0);
    assert.equal(f.runtime.teamRuns(first.task.id).length, 0);
    assert.equal(f.runtime.teamRuns(next.task.id).length, 0);
    assert.ok(f.team.ledger.snapshot().leases.every(lease => lease.state === 'released'));
    assert.equal(await fs.readFile(path.join(f.source, 'src/value.js'), 'utf8'), 'export const value = 2;\n');
  } finally { await f.cleanup(); }
});

test('删除运行中的协作会话等待退出并释放租约，不派发后续验证审查', async () => {
  let aborted = false;
  const f = await fixture(() => report({ taskPlan: plan() }), async context => {
    await new Promise<void>(resolve => context.signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
    return report({ taskResult: { role: 'implementer', status: 'blocked', summary: '已停止' } });
  });
  try {
    const started = await f.team.chat({ objective: '修改value', attachmentIds: [], requestId: 'delete-running-team', workspacePath: f.source });
    await waitFor(() => f.calls, calls => calls.some(run => run.team?.profileId === 'engineer'));
    assert.deepEqual(await f.team.removeConversation(started.conversationId), { deleted: 2 });
    assert.equal(aborted, true);
    assert.equal(f.team.list().length, 0);
    assert.equal(f.runtime.teamRuns(started.task.id).length, 0);
    assert.deepEqual(f.calls.map(run => run.team?.profileId), ['leader', 'engineer']);
    assert.ok(f.team.ledger.snapshot().leases.every(lease => lease.state === 'released'));
    assert.equal(await fs.readFile(path.join(f.source, 'src/value.js'), 'utf8'), 'export const value = 1;\n');
  } finally { await f.cleanup(); }
});

test('未绑定项目时执行计划转聊天询问，用户提供路径后继续，不把空目录当业务项目', async () => {
  const f = await fixture(() => report({ taskPlan: plan() }));
  try {
    const first = await f.team.chat({ objective: '修改value为2', attachmentIds: [], requestId: 'unbound-1' });
    const waiting = await f.done(first.task.id); assert.equal(waiting.state, 'waiting_input');
    assert.equal(f.calls.length, 1); assert.ok(waiting.chat!.messages.some(m => m.kind === 'question' && /项目/.test(m.text)));
    await f.team.chat({ objective: f.source, attachmentIds: [], requestId: 'bind-1', taskId: waiting.id });
    const done = await f.done(waiting.id); assert.equal(done.state, 'completed', done.reason || '');
    assert.equal(done.chat!.workspaceBound, true); assert.equal(done.sourceWorkspacePath, await fs.realpath(f.source));
  } finally { await f.cleanup(); }
});

test('Leader已通过本机检查找到唯一项目时，宿主自动绑定而不再要求用户重复选择', async () => {
  for (const reply of ['structured', 'legacy-text'] as const) {
    const f = await fixture((_context, turn, source) => turn === 1
      ? report({ conversationReply: reply === 'structured'
        ? { text: '已找到唯一项目，可以继续执行。', resumeWorkflow: true, workspacePath: source }
        : { text: `目录已找到，无需你再查找。请让宿主绑定此修复项目：${source}`, resumeWorkflow: true } })
      : report({ taskPlan: plan() }), undefined, false, {}, true);
    try {
      const started = await f.team.chat({ objective: '继续修复value', attachmentIds: [], requestId: `model-bind-${reply}` });
      const done = await f.done(started.task.id);
      assert.equal(done.state, 'completed', `${reply}: ${done.reason || ''}`);
      assert.equal(done.chat?.workspaceBound, true);
      assert.equal(done.sourceWorkspacePath, await fs.realpath(f.source));
      assert.equal(f.calls.filter(run => run.team?.profileId === 'leader').length, 2);
    } finally { await f.cleanup(); }
  }
});

test('未绑定聊天的执行计划可携带已发现项目，一轮规划后完成实施验证审查', async () => {
  const f = await fixture((_context, _turn, source) => report({ workspacePath: source, taskPlan: plan() }), undefined, true, {}, true);
  try {
    const started = await f.team.chat({ objective: '修复value并验证', attachmentIds: [], requestId: 'plan-workspace' });
    const done = await f.done(started.task.id);
    assert.equal(done.state, 'completed', done.reason || '');
    assert.equal(done.chat?.projectWorkspacePath, await fs.realpath(f.source));
    assert.deepEqual(f.calls.map(run => run.team?.profileId), ['leader', 'engineer', 'verifier', 'reviewer']);
    assert.equal(f.calls[0].mode, 'agent');
    assert.ok(f.calls[0].teamContext?.includes(await fs.realpath(f.source)), 'Leader能看到宿主已发现的候选目录');
    assert.equal(await fs.readFile(path.join(done.workspacePath!, 'src/value.js'), 'utf8'), 'export const value = 2;\n');
    assert.equal(done.workspacePath, await fs.realpath(f.source));
    assert.equal(await fs.readFile(path.join(f.source, 'src/value.js'), 'utf8'), 'export const value = 2;\n', '确认绑定的项目直接保留实施成果');
  } finally { await f.cleanup(); }
});

test('执行计划不能绑定清单外路径，也不能仅因只有一个候选就自动选项目', async () => {
  for (const known of [false, true]) {
    const f = await fixture((_context, _turn, source) => report({ ...(known ? {} : { workspacePath: source }), taskPlan: plan() }), undefined, false, {}, known);
    try {
      const started = await f.team.chat({ objective: '修改value', attachmentIds: [], requestId: `unverified-plan-${known}` });
      const waiting = await f.done(started.task.id);
      assert.equal(waiting.state, 'waiting_input');
      assert.equal(waiting.chat?.workspaceBound, false);
      assert.equal(f.calls.some(run => run.team?.profileId === 'engineer'), false);
    } finally { await f.cleanup(); }
  }
});

test('计划绑定已发现项目后仍保留产品阻塞问题', async () => {
  const f = await fixture((_context, _turn, source) => report({ workspacePath: source,
    taskPlan: plan({ questions: [{ id: 'Q-1', text: '使用哪个值？', blocking: true }] }) }), undefined, false, {}, true);
  try {
    const started = await f.team.chat({ objective: '修改value', attachmentIds: [], requestId: 'bound-product-question' });
    const waiting = await f.done(started.task.id);
    assert.equal(waiting.state, 'awaiting_plan');
    assert.equal(waiting.chat?.workspaceBound, true);
    assert.equal(waiting.plan?.questions[0].text, '使用哪个值？');
    assert.equal(f.calls.some(run => run.team?.profileId === 'engineer'), false);
  } finally { await f.cleanup(); }
});

test('计划阻塞问题直接在聊天回复，重新计划后自动执行', async () => {
  const f = await fixture((_context, turn) => report({ taskPlan: plan(turn === 1 ? { questions: [{ id: 'Q-1', text: '使用哪个值？', blocking: true }] } : {}) }));
  try {
    const started = await f.team.chat({ objective: '修改value', attachmentIds: [], requestId: 'question-1', workspacePath: f.source });
    const waiting = await f.done(started.task.id); assert.equal(waiting.state, 'awaiting_plan');
    await f.team.chat({ objective: '使用2', attachmentIds: [], requestId: 'answer-1', taskId: waiting.id });
    const done = await f.done(waiting.id); assert.equal(done.state, 'completed', done.reason || '');
    assert.match(f.calls.find(run => run.team?.profileId === 'leader' && run.id !== started.runId)!.teamContext!, /使用2/);
    assert.equal(done.chat!.messages.filter(m => m.role === 'user').length, 2);
  } finally { await f.cleanup(); }
});

test('计划问题误用顶层to字段时，宿主归一化后仍可回答并继续执行', async () => {
  const f = await fixture((_context, turn) => report({ taskPlan: plan(turn === 1
    ? { questions: [{ to: 'user', text: '使用哪个值？', blocking: true }] } as unknown as Partial<AgentTaskPlan>
    : {}) }));
  try {
    const started = await f.team.chat({ objective: '修改value', attachmentIds: [], requestId: 'legacy-question-1', workspacePath: f.source });
    const waiting = await f.done(started.task.id);
    assert.equal(waiting.state, 'awaiting_plan');
    assert.deepEqual(waiting.plan?.questions, [{ id: 'Q-1', text: '使用哪个值？', blocking: true }]);
    const done = await f.team.chat({ objective: '使用2', attachmentIds: [], requestId: 'legacy-question-2', taskId: waiting.id });
    assert.equal((await f.done(done.task.id)).state, 'completed');
  } finally { await f.cleanup(); }
});

test('实施中咨询由完整权限负责人在独立目录回复，显式升级不改变正在执行岗位的权限', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture((_context, turn) => turn === 1 ? report({ taskPlan: plan() }) : report({ conversationReply: { text: '当前只修改value，随后会验证。', resumeWorkflow: true } }), async context => {
    await gate; await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), 'export const value = 2;\n');
    return report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '已修改value' } });
  });
  try {
    const started = await f.team.chat({ objective: '修改value为2', attachmentIds: [], requestId: 'queue-1', accessMode: 'workspace', workspacePath: f.source });
    await waitFor(() => f.calls, calls => calls.some(run => run.team?.profileId === 'engineer'));
    const queued = await f.team.chat({ objective: '解释当前处理范围', attachmentIds: [], requestId: 'queue-2', accessMode: 'full', taskId: started.task.id });
    await waitFor(() => f.calls, calls => calls.filter(run => run.team?.profileId === 'leader').length === 2);
    const coordinator = f.calls.filter(run => run.team?.profileId === 'leader')[1];
    assert.equal(coordinator.mode, 'agent'); assert.equal(coordinator.accessMode, 'full');
    assert.notEqual(coordinator.workspacePath, f.calls.find(run => run.team?.profileId === 'engineer')?.workspacePath);
    assert.equal(queued.task.accessMode, 'full');
    assert.equal(f.calls.find(run => run.team?.profileId === 'engineer')?.accessMode, 'workspace');
    release(); const done = await f.done(started.task.id); assert.equal(done.state, 'completed', done.reason || '');
    assert.deepEqual(f.calls.map(run => run.team?.profileId), ['leader', 'engineer', 'leader', 'verifier', 'reviewer']);
    assert.equal(done.chat!.pendingInputs.length, 0); assert.equal(done.chat!.messages.filter(m => m.role === 'user').length, 2);
  } finally { release(); await f.cleanup(); }
});

test('补充消息交Leader期间暂停旧pending验证，明确先别改时回复后仍暂停直到用户继续', async () => {
  let releaseWriter!: () => void, releaseLeader!: () => void;
  const writer = new Promise<void>(resolve => { releaseWriter = resolve; }), leader = new Promise<void>(resolve => { releaseLeader = resolve; });
  const f = await fixture(async (_context, turn) => {
    if (turn === 1) return report({ taskPlan: plan() });
    await leader; return report({ conversationReply: { text: '已说明本次范围，等你决定继续。', resumeWorkflow: true } });
  }, async context => {
    await writer; await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), 'export const value = 2;\n');
    return report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '本阶段已结束' } });
  });
  try {
    const started = await f.team.chat({ objective: '修改value为2', attachmentIds: [], requestId: 'pause-1', workspacePath: f.source });
    await waitFor(() => f.calls, calls => calls.some(run => run.team?.profileId === 'engineer'));
    await f.team.chat({ objective: '先别改代码，先解释一下范围', attachmentIds: [], requestId: 'pause-2', taskId: started.task.id });
    releaseWriter(); await waitFor(() => f.calls, calls => calls.filter(run => run.team?.profileId === 'leader').length === 2);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.calls.some(run => run.team?.profileId === 'verifier'), false, 'Leader尚未决策时不能并发验证/旧计划');
    releaseLeader(); const paused = await f.done(started.task.id);
    assert.equal(paused.state, 'waiting_input'); assert.equal(paused.chat!.paused, true);
    assert.equal(f.calls.some(run => run.team?.profileId === 'verifier'), false, '模型resumeWorkflow:true也不能绕过用户暂停');
    await f.team.chat({ objective: '继续执行', attachmentIds: [], requestId: 'pause-3', taskId: started.task.id });
    const done = await f.done(started.task.id); assert.equal(done.state, 'completed', done.reason || '');
  } finally { releaseWriter(); releaseLeader(); await f.cleanup(); }
});

test('同一节点连续两题直接聊天逐题回答，全部回答后才续接岗位', async () => {
  let writes = 0;
  const f = await fixture(() => report({ taskPlan: plan() }), async context => {
    if (++writes === 1) return report({ questions: [{ to: 'user', text: '第一题', blocking: true }, { to: 'user', text: '第二题', blocking: true }] });
    assert.match(context.run.teamContext!, /第一题答案/); assert.match(context.run.teamContext!, /第二题答案/);
    await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), 'export const value = 2;\n');
    return report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '已按回答实现' } });
  });
  try {
    const started = await f.team.chat({ objective: '修改value为2', attachmentIds: [], requestId: 'two-1', workspacePath: f.source });
    assert.equal((await f.done(started.task.id)).state, 'waiting_input');
    await f.team.chat({ objective: '第一题答案', attachmentIds: [], requestId: 'two-2', taskId: started.task.id });
    await waitFor(() => f.team.getTask(started.task.id), task => task.state === 'waiting_input' && task.chat!.messages.some(message => message.text === '第一题答案' && !!message.replyTo));
    assert.equal(writes, 1);
    await f.team.chat({ objective: '第二题答案', attachmentIds: [], requestId: 'two-3', taskId: started.task.id });
    const done = await f.done(started.task.id); assert.equal(done.state, 'completed', done.reason || ''); assert.equal(writes, 2);
  } finally { await f.cleanup(); }
});

test('blocked后的普通咨询不会把未解决任务误标完成，同目录消息不重设固定基线', async () => {
  const f = await fixture((_context, turn) => turn === 1 ? report({ taskPlan: plan() }) : report({ conversationReply: { text: '当前失败原因仍待处理。' } }), async () => { throw new Error('模拟实现失败'); });
  try {
    const started = await f.team.chat({ objective: '修改value为2', attachmentIds: [], requestId: 'blocked-1', workspacePath: f.source });
    const blocked = await waitFor(() => f.team.getTask(started.task.id), task => task.state === 'blocked' && f.team.isIdle()
      && !task.nodes.some(node => node.purpose === 'coordinate' && ['pending', 'queued', 'running'].includes(node.status)));
    const writes = f.calls.filter(run => run.team?.profileId === 'engineer').length;
    const baseline = blocked.baseSnapshot;
    await fs.writeFile(path.join(f.source, 'src/value.js'), '用户另外修改\n');
    await f.team.chat({ objective: '为什么卡住？', attachmentIds: [], requestId: 'blocked-2', taskId: started.task.id, workspacePath: f.source });
    await waitFor(() => f.team.getTask(started.task.id), task => task.nodes.filter(node => node.profileId === 'leader').every(node => node.status === 'completed'));
    const after = f.team.getTask(started.task.id); assert.equal(after.state, 'blocked'); assert.deepEqual(after.baseSnapshot, baseline);
    assert.equal(f.calls.filter(run => run.team?.profileId === 'engineer').length, writes, '状态咨询不能重派实现');
  } finally { await f.cleanup(); }
});

test('实施回报业务阻塞后重试先重新计划，确认问题后继续实现验证审查，重复重试不重复派发', async () => {
  let writes = 0;
  const f = await fixture((_context, turn) => report({ taskPlan: plan(turn === 2 ? {
    questions: [{ id: 'Q-1', text: '是否允许保留本地改动后合并指定分支？', blocking: true }],
  } : {}) }), async context => {
    if (++writes === 1) return report({ taskResult: { role: 'implementer', status: 'blocked', summary: '缺少分叉整合授权',
      blockers: ['需要确认保留本地改动的合并方案'] } });
    await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), 'export const value = 2;\n');
    return report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '按确认方案完成' } });
  });
  try {
    const started = await f.team.chat({ objective: '同步并保留本地改动', attachmentIds: [], requestId: 'business-block-1', workspacePath: f.source });
    const blocked = await f.done(started.task.id);
    assert.equal(blocked.state, 'blocked'); assert.equal(writes, 1);
    const failed = blocked.nodes.find(node => node.stage === 'implement')!;
    const input = { action: 'retry' as const, requestId: 'business-retry-1' };
    await f.team.decide(blocked.id, input);
    await f.team.decide(blocked.id, input);
    const waiting = await waitFor(() => f.team.getTask(blocked.id), task => task.state === 'awaiting_plan' && task.planRevision === 2);
    assert.equal(writes, 1);
    assert.equal(f.calls.filter(run => run.team?.profileId === 'leader' && !run.teamContext?.includes('本次诊断目标节点：')).length, 2);
    assert.equal(waiting.nodes.find(node => node.id === failed.id)?.runId, failed.runId);
    assert.equal(waiting.chat!.messages.filter(message => message.kind === 'question').length, 1);
    await f.team.chat({ objective: '允许保留本地改动后合并指定分支，不推送', attachmentIds: [], requestId: 'business-answer-1', taskId: blocked.id });
    const done = await waitFor(() => f.team.getTask(blocked.id), task => task.state === 'completed');
    assert.equal(writes, 2);
    assert.ok(done.nodes.some(node => node.stage === 'verify' && node.status === 'completed'));
    assert.ok(done.nodes.some(node => node.stage === 'review' && node.status === 'completed'));
    assert.equal(done.chat!.messages.filter(message => message.role === 'user' && message.text.startsWith('允许')).length, 1);
  } finally { await f.cleanup(); }
});

test('执行器失败仍重试原实施节点，不增加业务阻塞重规划', async () => {
  let writes = 0;
  const f = await fixture(() => report({ taskPlan: plan() }), async context => {
    if (++writes === 1) throw new Error('模拟临时执行器故障');
    await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), 'export const value = 2;\n');
    return report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '重试完成' } });
  });
  try {
    const started = await f.team.chat({ objective: '修改value', attachmentIds: [], requestId: 'transport-block-1', workspacePath: f.source });
    const blocked = await f.done(started.task.id); assert.equal(blocked.state, 'blocked');
    await f.team.decide(blocked.id, { action: 'retry', requestId: 'transport-retry-1' });
    await waitFor(() => f.team.getTask(blocked.id), task => task.state === 'completed');
    assert.equal(writes, 2);
    assert.equal(f.calls.filter(run => run.team?.profileId === 'leader' && !run.teamContext?.includes('本次诊断目标节点：')).length, 1);
  } finally { await f.cleanup(); }
});


test('聊天问题可乱序回复，准确关联原问题，答齐后只恢复原岗位一次', async () => {
  let writes = 0;
  const f = await fixture(() => report({ taskPlan: plan() }), async context => {
    if (++writes === 1) return report({ questions: [{ to: 'user', text: '第一题', blocking: true }, { to: 'user', text: '第二题', blocking: true }] });
    assert.match(context.run.teamContext!, /第一题答案/); assert.match(context.run.teamContext!, /第二题答案/);
    await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), 'export const value = 2;\n');
    return report({ taskResult: { role: 'implementer', status: 'succeeded' } });
  });
  try {
    const started = await f.team.chat({ objective: '修改value', attachmentIds: [], requestId: 'inline-start', workspacePath: f.source });
    const waiting = await f.done(started.task.id);
    const questions = waiting.chat!.messages.filter(message => message.kind === 'question');
    const second = { correlationId: questions[1].id, text: '第二题答案', requestId: 'inline-second' };
    await f.team.answer(waiting.id, second);
    await f.team.answer(waiting.id, second);
    assert.equal(f.team.getTask(waiting.id).state, 'waiting_input'); assert.equal(writes, 1);
    assert.equal(f.team.getTask(waiting.id).chat!.messages.filter(message => message.replyTo === questions[1].id).length, 1);
    await assert.rejects(f.team.answer(waiting.id, { ...second, requestId: 'inline-repeat' }), /已回答|过期/);
    await f.team.answer(waiting.id, { correlationId: questions[0].id, text: '第一题答案', requestId: 'inline-first' });
    const done = await f.done(waiting.id); assert.equal(done.state, 'completed'); assert.equal(writes, 2);
    assert.equal(f.calls.filter(run => run.team?.profileId === 'leader').length, 1, '不能把回答作为新需求重开计划');
    await assert.rejects(f.team.answer(waiting.id, { ...second, requestId: 'inline-closed' }), /已结束/);
  } finally { await f.cleanup(); }
});

test('计划多问题逐题保存不同答案，答齐才重新计划，旧问题不能再次回复', async () => {
  const f = await fixture((context, turn) => {
    if (turn === 1) return report({ taskPlan: plan({ questions: [{ id: 'Q-1', text: '目标值？', blocking: true }, { id: 'Q-2', text: '保留什么？', blocking: true }] }) });
    assert.match(context.run.teamContext!, /使用2/); assert.match(context.run.teamContext!, /保留注释/);
    return report({ taskPlan: plan() });
  });
  try {
    const started = await f.team.chat({ objective: '修改value', attachmentIds: [], requestId: 'plan-inline-start', workspacePath: f.source });
    const waiting = await f.done(started.task.id), questions = waiting.chat!.messages.filter(message => message.kind === 'question');
    await f.team.answer(waiting.id, { correlationId: questions[1].id, text: '保留注释', requestId: 'plan-inline-second' });
    assert.equal(f.team.getTask(waiting.id).state, 'awaiting_plan'); assert.equal(f.calls.length, 1);
    await f.team.answer(waiting.id, { correlationId: questions[0].id, text: '使用2', requestId: 'plan-inline-first' });
    const done = await f.done(waiting.id); assert.equal(done.state, 'completed');
    assert.deepEqual(done.planAnswers?.map(item => [item.questionId, item.text]), [['Q-1', '使用2'], ['Q-2', '保留注释']]);
    await assert.rejects(f.team.answer(waiting.id, { correlationId: questions[0].id, text: '使用3', requestId: 'plan-inline-expired' }), /已结束|过期/);
  } finally { await f.cleanup(); }
});
