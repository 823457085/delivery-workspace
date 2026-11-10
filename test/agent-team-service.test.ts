import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import { createAgentTeamService, type AdvancedTeamTask } from '../server/agent-team-service.js';
import { emptyDeliveryEvidence } from '../shared/delivery-acceptance.js';
import { readDeliveryReport } from '../shared/delivery-report.js';
import type { AgentRun, AgentRuntimeHealth, AgentProvider } from '../shared/agent-runtime.js';
import type { AgentTaskPlan, TeamTemplateId } from '../shared/agent-task-plan.js';

const exec = promisify(execFile);
type Context = Parameters<AgentRuntimeAdapter['execute']>[0];
const report = (value: unknown) => `\`\`\`delivery-report\n${JSON.stringify({ version: 1, ...value as object })}\n\`\`\``;
const isAnswerContext = (context = '') => context.includes('输出 {"version":1,"answer":');
const implemented = () => report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '已完成最小修改' } });
const reviewed = () => report({ taskResult: { role: 'reviewer', status: 'succeeded', verdict: 'approved', findings: [] } });
const verified = (ids: string[]) => report({ validationEvidence: { ...emptyDeliveryEvidence(), tests: { status: 'passed', evidence: 'node --test 退出码0', sha: '' } },
  taskResult: { role: 'verifier', status: 'succeeded', acceptance: ids.map(id => ({ id, status: 'passed', evidence: '真实夹具内容核验' })) } });
const verificationFailed = () => report({ validationEvidence: { ...emptyDeliveryEvidence(), tests: { status: 'failed', evidence: '接口校验失败，原始证据已保存', sha: '' } },
  taskResult: { role: 'verifier', status: 'failed', summary: '只读核对完成，业务验收未通过',
    acceptance: [{ id: 'AC-1', status: 'failed', evidence: '接口仍返回 service internal error' }], blockers: ['缺少专用测试数据及确认的测试通道'] } });
const plan = (templateId: TeamTemplateId = 'engineering', extra: Partial<AgentTaskPlan> = {}): AgentTaskPlan => ({ templateId, reason: '按用户目标选择', risk: 'medium',
  acceptanceCriteria: [{ id: 'AC-1', text: '目标文件使用新值', source: '用户原话' }], allowedPaths: ['src/**'], needsAnalyst: false, needsArchitect: false,
  questions: [], risks: [], ownership: [], shared: [], ...extra });
const health = (provider: AgentProvider, claudeReady = true): AgentRuntimeHealth => ({ provider, label: provider, binary: `/fixture/${provider}`, version: 'fixture',
  authenticated: provider !== 'claude' || claudeReady, ready: provider !== 'claude' || claudeReady, message: claudeReady ? 'ready' : '未登录', modes: ['agent', 'ask', 'plan'],
  models: provider === 'codex' ? ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'].map(id => ({ id, label: id, efforts: ['low', 'medium', 'high'] }))
    : provider === 'claude' ? ['sonnet', 'opus', 'fable'].map(id => ({ id, label: id === 'sonnet' ? 'Sonnet 5.5' : id === 'opus' ? 'Opus 5.5' : 'Fable 5.1', efforts: ['low', 'medium', 'high'] }))
      : [{ id: 'composer-2.5', label: 'Composer 2.5' }], defaultModel: '', writable: true, checkedAt: new Date().toISOString() });
async function waitFor<T>(read: () => T, predicate: (value: T) => boolean, label: string) {
  for (let index = 0; index < 1000; index += 1) { const value = read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(`等待超时 ${label}：${JSON.stringify(read())}`);
}
interface Handlers { implement?: (context: Context) => Promise<string>; verify?: (context: Context) => Promise<string>; review?: (context: Context) => Promise<string>; answer?: (context: Context) => Promise<string> }
async function fixture(value: AgentTaskPlan, options: { git?: boolean; claudeReady?: boolean; handlers?: Handlers; files?: Record<string, string> } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-team-service-'));
  const source = path.join(root, 'source'), data = path.join(root, 'data');
  await fs.mkdir(path.join(source, 'src'), { recursive: true }); await fs.mkdir(path.join(source, 'server'), { recursive: true });
  await fs.writeFile(path.join(source, 'src/value.js'), 'export const value = 1;\n');
  await fs.writeFile(path.join(source, 'server/value.js'), 'export const value = 1;\n');
  await fs.writeFile(path.join(source, '.gitignore'), '.delivery-artifacts/\n');
  for (const [name, content] of Object.entries(options.files || {})) { const target = path.join(source, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content); }
  if (options.git) {
    await exec('git', ['-C', source, 'init', '-q', '-b', 'main']); await exec('git', ['-C', source, 'add', '.']);
    await exec('git', ['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', '初始化临时团队夹具']);
  }
  const calls: { run: AgentRun; resume: string; context: string }[] = [];
  const adapters = (['codex', 'claude', 'cursor'] as const).map(provider => ({ id: provider, health: async () => health(provider, options.claudeReady !== false), execute: async (context: Context) => {
    await context.onSession(context.resumeSessionId || `${provider}-native-${context.run.id}`);
    calls.push({ run: structuredClone(context.run), resume: context.resumeSessionId || '', context: context.run.teamContext || '' });
    const profile = context.run.team?.profileId;
    if (!profile) return 'main complete';
    assert.doesNotMatch(context.run.teamContext || '', /本岗位只读|只读岗位不得写入|只读分析与计划，不改文件|当前未开放联网工具|只读独立审查|本轮只读判断/);
    const answering = isAnswerContext(context.run.teamContext);
    if (answering && options.handlers?.answer) return options.handlers.answer(context);
    if (profile === 'leader') return answering
      ? report({ answer: '已核对现有材料，测试证据位于 tests/login.json；继续原验证步骤' })
      : context.run.teamContext?.includes('本次诊断目标节点：')
      ? report({ coordinationReply: { action: 'observe', text: '当前阻塞已核对，保留原计划等待后续决定。' } })
      : report({ taskPlan: value });
    if (profile === 'analyst') return report({ requirementBrief: { facts: [{ text: '按用户目标实现', source: '用户原话' }], inferences: [], gaps: [], acceptanceCriteria: value.acceptanceCriteria, sources: ['用户原话'] } });
    if (profile === 'architect') return answering
      ? report({ answer: '架构已确认隔离方案' })
      : report({ technicalDesign: { decisions: [], contracts: [], tasks: [], sharedFiles: [], risks: [], rollback: [] } });
    if (profile === 'engineer' || profile === 'frontend' || profile === 'batch') {
      if (options.handlers?.implement) return options.handlers.implement(context);
      await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), 'export const value = 2;\n'); return implemented();
    }
    if (profile === 'verifier') {
      if (options.handlers?.verify) return options.handlers.verify(context);
      assert.equal(await fs.readFile(path.join(context.run.workspacePath, 'src/value.js'), 'utf8'), 'export const value = 2;\n');
      await fs.mkdir(path.join(context.run.workspacePath, '.delivery-artifacts'), { recursive: true });
      await fs.writeFile(path.join(context.run.workspacePath, '.delivery-artifacts/tests.log'), 'passed');
      return verified(value.acceptanceCriteria.map(item => item.id));
    }
    if (profile === 'reviewer') return options.handlers?.review ? options.handlers.review(context) : reviewed();
    throw new Error(`未知岗位 ${profile}`);
  } }));
  const runtime = await createAgentRuntimeService(data, { adapters });
  const main = await runtime.start({ provider: 'codex', model: 'gpt-6.1-sol', mode: 'ask', objective: 'main', workspacePath: source });
  await waitFor(() => runtime.getRun(main.id), run => !!run?.resultReady, 'main完成');
  const team = await createAgentTeamService(data, runtime);
  const create = async () => {
    const task = await team.create(main.id, { objective: '按计划修改文件', attachmentIds: [], requestId: 'create-1' });
    await waitFor(() => team.getTask(task.id), item => item.state === 'awaiting_plan' || item.state === 'blocked', '计划完成');
    return team.getTask(task.id);
  };
  const confirm = async (id: string) => team.plan(id, { expectedRevision: team.getTask(id).planRevision, action: 'confirm', requestId: 'confirm-1' });
  const done = (id: string) => waitFor(() => team.getTask(id), task => ['awaiting_acceptance', 'blocked', 'needs_decision'].includes(task.state), '流程结束');
  return { root, source: await fs.realpath(source), data, runtime, team, main, calls, adapters, create, confirm, done,
    cleanup: async () => { await team.close(); await runtime.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

test('诊断脚本在隔离工作区写入并由宿主归档，共享材料只作为输入', async () => {
  const f = await fixture(plan('diagnosis'), { git: true, handlers: { implement: async context => {
    assert.match(context.run.teamContext || '', /team-artifacts 及上游产物目录为只读材料/);
    const output = path.join(context.run.workspacePath, '.delivery-artifacts');
    assert.ok(context.run.teamContext?.includes(JSON.stringify(output)));
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, 'launch-visible-browser.mjs'), 'console.log("browser fixture");\n');
    return report({ diagnosis: { summary: '浏览器脚本已保存', rootCause: '夹具验证',
      evidence: ['隔离工作区保存浏览器脚本'], unverified: [], suggestions: [] } });
  } } });
  try {
    const task = await f.create(); await f.confirm(task.id);
    const done = await f.done(task.id);
    assert.equal(done.state, 'awaiting_acceptance', done.reason);
    const logs = done.artifacts!.find(item => item.kind === 'logs')!;
    const archive = JSON.parse(await fs.readFile(logs.path, 'utf8'));
    assert.ok(archive.files.includes('launch-visible-browser.mjs'));
    assert.equal(await fs.readFile(path.join(archive.directory, 'launch-visible-browser.mjs'), 'utf8'), 'console.log("browser fixture");\n');
    assert.equal(f.calls.filter(call => call.run.team?.profileId === 'engineer').length, 1);
  } finally { await f.cleanup(); }
});

test('历史 json 围栏格式阻塞重试只重新采集原结果，不重复实施，继续验证审查', async () => {
  const f = await fixture(plan(), { handlers: { implement: async context => {
    await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), 'export const value = 2;\n');
    return implemented().replace('```delivery-report', '```legacy-json');
  } } });
  let reopenedRuntime: Awaited<ReturnType<typeof createAgentRuntimeService>> | undefined;
  let reopenedTeam: Awaited<ReturnType<typeof createAgentTeamService>> | undefined;
  try {
    const task = await f.create(); await f.confirm(task.id);
    const blocked = await f.done(task.id), node = blocked.nodes.find(node => node.stage === 'implement')!;
    assert.equal(node.status, 'blocked');
    await f.team.close(); await f.runtime.close();
    // 模拟旧解析器已经持久化的 json 报告与格式阻塞状态。
    const runFile = path.join(f.data, 'agent-runs.json');
    const runs = JSON.parse(await fs.readFile(runFile, 'utf8')) as AgentRun[];
    runs.find(run => run.id === node.runId)!.result = implemented().replace('```delivery-report', '```json');
    await fs.writeFile(runFile, JSON.stringify(runs));
    reopenedRuntime = await createAgentRuntimeService(f.data, { adapters: f.adapters });
    reopenedTeam = await createAgentTeamService(f.data, reopenedRuntime);
    await reopenedTeam.decide(task.id, { action: 'retry', nodeId: node.id, requestId: 'reparse-json-report' });
    const done = await waitFor(() => reopenedTeam!.getTask(task.id), item => ['awaiting_acceptance', 'blocked'].includes(item.state), '原结果恢复');
    assert.equal(done.state, 'awaiting_acceptance', done.reason || '');
    const implementation = done.nodes.find(item => item.id === node.id)!;
    assert.equal(implementation.runId, node.runId); assert.equal(implementation.attempt, 1);
    assert.equal(f.calls.filter(call => call.run.team?.profileId === 'engineer').length, 1);
    assert.equal(f.calls.filter(call => call.run.team?.profileId === 'verifier').length, 1);
    assert.equal(f.calls.filter(call => call.run.team?.profileId === 'reviewer').length, 1);
  } finally { await reopenedTeam?.close(); await reopenedRuntime?.close(); await f.cleanup(); }
});

test('诊断证据结构兼容后仅重新采集原结果，保留未验证状态且不重复模型调用', async () => {
  const diagnosis = { summary: '本地核对完成', rootCause: '分支调用字段不同',
    evidence: [{ acceptanceId: 'AC-1', status: 'passed', finding: '本地源码存在差异', command: 'git diff branch -- src/value.js',
      exitCode: 0, output: '字段变化', sources: ['src/value.js:1'] }],
    baseline: { cwd: '/fixture/candidate', head: 'abc123', headState: 'DETACHED', comparisonRef: 'branch', comparisonCommit: 'def456', workingTree: '有未提交修改' },
    unverified: ['真实接口、浏览器、构建均未运行'], suggestions: ['核验契约后逐项修复'] };
  const f = await fixture(plan('diagnosis'), { handlers: { implement: async context => {
    assert.equal(context.run.team?.stageKey.includes(':') && context.run.teamContext?.includes('evidence 优先逐项使用字符串'), true);
    return report({ diagnosis: { ...diagnosis, evidence: [{ ...diagnosis.evidence[0], status: 'unknown_status' }] } });
  } } });
  let reopenedRuntime: Awaited<ReturnType<typeof createAgentRuntimeService>> | undefined;
  let reopenedTeam: Awaited<ReturnType<typeof createAgentTeamService>> | undefined;
  try {
    const task = await f.create(); await f.confirm(task.id);
    const blocked = await f.done(task.id), node = blocked.nodes.find(node => node.stage === 'diagnose')!;
    assert.equal(blocked.state, 'blocked'); assert.equal(node.status, 'blocked');
    assert.match(node.error || '', /岗位返回的结果格式不符合约定/); assert.doesNotMatch(node.error || '', /^\s*\[/);
    await f.team.close(); await f.runtime.close();
    // 模拟升级前已保存、因对象 evidence 和 baseline 被拒绝的完整诊断报告。
    const runFile = path.join(f.data, 'agent-runs.json'), runs = JSON.parse(await fs.readFile(runFile, 'utf8')) as AgentRun[];
    runs.find(run => run.id === node.runId)!.result = report({ diagnosis }); await fs.writeFile(runFile, JSON.stringify(runs));
    reopenedRuntime = await createAgentRuntimeService(f.data, { adapters: f.adapters }); reopenedTeam = await createAgentTeamService(f.data, reopenedRuntime);
    const calls = f.calls.length;
    await reopenedTeam.decide(task.id, { action: 'retry', nodeId: node.id, requestId: 'recapture-diagnosis' });
    const done = await waitFor(() => reopenedTeam!.getTask(task.id), item => ['awaiting_acceptance', 'blocked'].includes(item.state), '诊断结果恢复');
    assert.equal(done.state, 'awaiting_acceptance', done.reason || ''); assert.equal(f.calls.length, calls);
    const captured = done.nodes.find(item => item.id === node.id)!;
    assert.equal(captured.runId, node.runId); assert.equal(captured.attempt, node.attempt); assert.equal(captured.error, undefined);
    assert.deepEqual(done.diagnosis?.baseline, diagnosis.baseline); assert.deepEqual(done.diagnosis?.unverified, diagnosis.unverified);
    assert.match(done.diagnosis!.evidence[0], /报告状态：passed/); assert.match(done.diagnosis!.evidence[0], /退出码：0/);
    assert.equal(done.nodes.some(item => ['verify', 'review'].includes(item.stage)), false);
    assert.equal(await fs.readFile(path.join(f.source, 'src/value.js'), 'utf8'), 'export const value = 1;\n');
  } finally { await reopenedTeam?.close(); await reopenedRuntime?.close(); await f.cleanup(); }
});

for (const scenario of ['same', 'changed', 'invalid', 'altered', 'missing', 'tampered'] as const) test({
  same: '验证报告兼容后同候选仅重新采集原结果，保留运行身份并继续独立审查',
  changed: '验证报告兼容后候选已变化必须重新验证，不能复用旧通过结果',
  invalid: '验证报告仍无效时按原重试重新调用验证岗位',
  altered: '验证报告兼容后原验证修改过源码仍须重新验证',
  missing: '验证报告兼容后归档日志缺失必须重新验证',
  tampered: '验证报告兼容后归档清单哈希变化必须重新验证',
}[scenario], async () => {
  const acceptedBody = {
    ...(readDeliveryReport(verified(['AC-1'])) as Record<string, unknown>),
    validationEvidence: { ...emptyDeliveryEvidence(), tests: { status: 'passed', evidence: '原验证记录：退出码 0', sha: '' },
      build: { status: 'passed', command: 'pnpm build', exitCode: 0 } },
  };
  const accepted = report(acceptedBody);
  const rejected = report({ ...acceptedBody, validationEvidence: { ...acceptedBody.validationEvidence,
    tests: { ...acceptedBody.validationEvidence.tests, status: 'unknown_status' } } });
  let verifications = 0;
  const f = await fixture(plan(), { git: true, handlers: { verify: async context => {
    verifications += 1;
    assert.equal(await fs.readFile(path.join(context.run.workspacePath, 'src/value.js'), 'utf8'),
      `export const value = ${scenario === 'changed' && verifications > 1 ? 3 : 2};\n`);
    if (scenario === 'altered' && verifications === 1) await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), 'export const value = 99;\n');
    await fs.mkdir(path.join(context.run.workspacePath, '.delivery-artifacts'), { recursive: true });
    await fs.writeFile(path.join(context.run.workspacePath, '.delivery-artifacts/verification.log'), '原验证记录：退出码 0');
    return verifications === 1 ? rejected : accepted;
  } } });
  let reopenedRuntime: Awaited<ReturnType<typeof createAgentRuntimeService>> | undefined;
  let reopenedTeam: Awaited<ReturnType<typeof createAgentTeamService>> | undefined;
  try {
    const task = await f.create(); await f.confirm(task.id);
    const blocked = await f.done(task.id), node = blocked.nodes.find(item => item.stage === 'verify')!;
    assert.equal(blocked.state, 'blocked'); assert.equal(node.status, 'blocked'); assert.ok(node.snapshot);
    await assert.rejects(fs.access(f.calls.find(call => call.run.team?.profileId === 'verifier')!.run.workspacePath), '首次采集后验证副本已清理');
    assert.equal(f.calls.some(call => call.run.team?.profileId === 'reviewer'), false);
    await f.team.close(); await f.runtime.close();
    // 模拟旧宿主已因额外 build 字段拒绝、但原运行已完整保存的报告。
    const runFile = path.join(f.data, 'agent-runs.json'), runs = JSON.parse(await fs.readFile(runFile, 'utf8')) as AgentRun[];
    const saved = runs.find(run => run.id === node.runId)!;
    assert.equal(saved.status, 'completed');
    if (scenario !== 'invalid') saved.result = accepted;
    await fs.writeFile(runFile, JSON.stringify(runs));
    if (scenario === 'changed') await fs.writeFile(path.join(blocked.workspacePath!, 'src/value.js'), 'export const value = 3;\n');
    if (scenario === 'missing' || scenario === 'tampered') {
      const logs = blocked.artifacts!.find(item => item.nodeId === node.id && item.kind === 'logs')!;
      const archive = JSON.parse(await fs.readFile(logs.path, 'utf8'));
      if (scenario === 'missing') await fs.rm(path.join(archive.directory, 'verification.log'));
      else await fs.appendFile(logs.path, ' ');
    }
    reopenedRuntime = await createAgentRuntimeService(f.data, { adapters: f.adapters });
    assert.equal(reopenedRuntime.getRun(node.runId!)?.resultReady, true);
    reopenedTeam = await createAgentTeamService(f.data, reopenedRuntime);
    await reopenedTeam.decide(task.id, { action: 'retry', nodeId: node.id, requestId: `recapture-verification-${scenario}` });
    const done = await waitFor(() => reopenedTeam!.getTask(task.id), item => ['awaiting_acceptance', 'blocked'].includes(item.state), '验证结果恢复');
    assert.equal(done.state, 'awaiting_acceptance', done.reason || '');
    const captured = done.nodes.find(item => item.id === node.id)!;
    assert.equal(captured.status, 'completed'); assert.equal(captured.error, undefined);
    if (scenario === 'same') {
      assert.equal(captured.runId, node.runId); assert.equal(captured.attempt, node.attempt);
      assert.deepEqual(captured.snapshot, node.snapshot); assert.equal(verifications, 1);
      const logs = done.artifacts!.find(item => item.nodeId === node.id && item.kind === 'logs')!;
      const archive = JSON.parse(await fs.readFile(logs.path, 'utf8'));
      assert.equal(await fs.readFile(path.join(archive.directory, 'verification.log'), 'utf8'), '原验证记录：退出码 0');
    } else {
      assert.notEqual(captured.runId, node.runId); assert.equal(captured.attempt, node.attempt + 1); assert.equal(verifications, 2);
      if (scenario === 'changed') assert.notEqual(captured.snapshot?.value, node.snapshot?.value);
    }
    assert.equal(f.calls.filter(call => call.run.team?.profileId === 'engineer').length, 1);
    assert.equal(f.calls.filter(call => call.run.team?.profileId === 'reviewer').length, 1);
    assert.equal(await fs.readFile(path.join(f.source, 'src/value.js'), 'utf8'), 'export const value = 1;\n');
  } finally {
    await reopenedTeam?.close(); await reopenedRuntime?.close(); await f.cleanup();
    for (const call of f.calls.filter(call => call.run.team?.profileId === 'verifier')) {
      const temporary = path.dirname(call.run.workspacePath);
      if (path.basename(temporary).startsWith('delivery-team-copy-')) await fs.rm(temporary, { recursive: true, force: true });
    }
  }
});

test('验证完成至审查启动之间仍有团队衔接，不能当作重启空闲窗口', async () => {
  const f = await fixture(plan());
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let reachedReview = false;
  const start = f.runtime.startTeamNode;
  f.runtime.startTeamNode = async (input, metadata) => {
    if (metadata.team.profileId === 'reviewer') { reachedReview = true; await held; }
    return start(input, metadata);
  };
  try {
    const task = await f.create();
    await f.confirm(task.id);
    await waitFor(() => reachedReview, Boolean, '审查派发前');
    await waitFor(() => f.runtime.isIdle(), Boolean, '验证进程退出');
    assert.equal(f.team.isIdle(), false, '原生进程空闲时团队仍在准备下一步');
    release();
    assert.equal((await f.done(task.id)).state, 'awaiting_acceptance');
    await waitFor(() => f.team.isIdle(), Boolean, '衔接结束');
    await assert.rejects(f.team.decide('missing', { action: 'retry', requestId: 'missing-retry' }));
    assert.equal(f.team.isIdle(), true, '失败请求也应释放衔接计数');
  } finally { release(); await f.cleanup(); }
});

test('测试通过后派发审查阶段验收，复审未执行仍阻塞，重试只恢复审查', async () => {
  const criteria: AgentTaskPlan['acceptanceCriteria'] = [
    { id: 'AC-1', text: '目标代码验证通过', source: '用户', stage: 'verify' },
    { id: 'AC-3', text: '完成正式独立复审', source: '用户', stage: 'review' },
  ];
  let reviews = 0;
  const f = await fixture(plan('engineering', { acceptanceCriteria: criteria }), { handlers: {
    verify: async context => {
      assert.match(context.run.teamContext || '', /stage=review项仅记录not_run/);
      return report({ validationEvidence: { ...emptyDeliveryEvidence(), tests: { status: 'passed', evidence: '代码检查通过', sha: '' } },
        taskResult: { role: 'verifier', status: 'succeeded', acceptance: [
          { id: 'AC-1', status: 'passed', evidence: '目标内容为2' }, { id: 'AC-3', status: 'not_run', evidence: '交接材料齐备，待独立复审' },
        ] } });
    },
    review: async context => {
      assert.match(context.run.teamContext || '', /须独立核验这些审查阶段验收项/);
      reviews += 1;
      return report({ taskResult: { role: 'reviewer', status: 'succeeded', verdict: 'approved',
        acceptance: [{ id: 'AC-3', status: reviews === 1 ? 'not_run' : 'passed', evidence: reviews === 1 ? '尚未核对日志' : '独立读取候选代码及验证日志完成' }] } });
    },
  } });
  try {
    const task = await f.create(); await f.confirm(task.id);
    const blocked = await f.done(task.id);
    assert.equal(blocked.state, 'blocked');
    assert.equal(blocked.nodes.find(node => node.stage === 'verify')?.status, 'completed');
    const reviewNode = blocked.nodes.find(node => node.stage === 'review')!;
    assert.equal(reviewNode.status, 'blocked');
    assert.match(blocked.reason || '', /审查验收标准未能验证.*AC-3/);
    await f.team.decide(task.id, { action: 'retry', nodeId: reviewNode.id, requestId: 'retry-review-stage' });
    assert.equal((await f.done(task.id)).state, 'awaiting_acceptance');
    assert.equal(f.calls.filter(call => call.run.team?.profileId === 'engineer').length, 1);
    assert.equal(f.calls.filter(call => call.run.team?.profileId === 'verifier').length, 1);
    assert.equal(reviews, 2);
  } finally { await f.cleanup(); }
});

test('高级工程流程确认前仅计划，确认后实现→副本验证→跨家族审查；重启不重复派发', async () => {
  const f = await fixture(plan(), { git: true });
  let reopenedRuntime: Awaited<ReturnType<typeof createAgentRuntimeService>> | undefined;
  let reopenedTeam: Awaited<ReturnType<typeof createAgentTeamService>> | undefined;
  try {
    const task = await f.create();
    assert.equal(task.state, 'awaiting_plan', task.reason || '');
    assert.deepEqual(f.calls.filter(call => call.run.team).map(call => call.run.team!.profileId), ['leader']);
    await f.confirm(task.id);
    const done = await f.done(task.id);
    assert.equal(done.state, 'awaiting_acceptance', done.reason || '');
    const calls = f.calls.filter(call => call.run.team);
    assert.deepEqual(calls.map(call => call.run.team!.profileId), ['leader', 'engineer', 'verifier', 'reviewer']);
    assert.ok(calls.every(call => call.run.mode === 'agent' && call.run.accessMode === 'full'));
    assert.notEqual(calls[1].run.workspacePath, f.source);
    assert.notEqual(calls[2].run.workspacePath, calls[1].run.workspacePath);
    assert.deepEqual([calls[3].run.provider, calls[3].run.model, calls[3].run.mode], ['claude', 'claude-opus-5-5', 'agent']);
    await assert.rejects(fs.access(calls[2].run.workspacePath));
    assert.equal(await fs.readFile(path.join(f.source, 'src/value.js'), 'utf8'), 'export const value = 1;\n');
    const before = (await f.team.room(task.id)).budget;
    assert.equal(before?.usedRuns, 4);
    const count = f.calls.length;
    await f.team.close(); await f.runtime.close();
    const stateFile = path.join(f.data, 'team-tasks.json'), state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    for (const profile of state.tasks.find((item: { id: string }) => item.id === task.id).profileConfig.profiles) {
      if (['leader', 'analyst', 'architect', 'reviewer', 'reporter', 'second_opinion'].includes(profile.id)) { profile.mode = 'ask'; profile.accessMode = 'workspace'; }
      if (profile.id === 'leader') profile.description = '旧版任务冻结的协调职责';
    }
    await fs.writeFile(stateFile, JSON.stringify(state));
    reopenedRuntime = await createAgentRuntimeService(f.data, { adapters: f.adapters });
    reopenedTeam = await createAgentTeamService(f.data, reopenedRuntime);
    assert.equal(reopenedTeam.getTask(task.id).state, 'awaiting_acceptance');
    assert.ok(reopenedTeam.getTask(task.id).profileConfig.profiles.every(profile => profile.mode === 'agent' && profile.accessMode === 'full'));
    assert.equal(reopenedTeam.getTask(task.id).profileConfig.profiles.find(profile => profile.id === 'leader')?.description, '旧版任务冻结的协调职责');
    assert.deepEqual(reopenedTeam.getTask(task.id).profileConfig.profiles.map(({ id, provider, model, reasoningEffort }) => ({ id, provider, model, reasoningEffort })),
      task.profileConfig.profiles.map(({ id, provider, model, reasoningEffort }) => ({ id, provider, model, reasoningEffort })));
    assert.equal(f.calls.length, count);
    assert.deepEqual((await reopenedTeam.room(task.id)).budget, before);
  } finally { await reopenedTeam?.close(); await reopenedRuntime?.close(); await f.cleanup(); }
});

test('历史运行次数和时限不再拦截，重启保留计数并支持超过两轮返工', async () => {
  let reviews = 0;
  const f = await fixture(plan(), { git: true, handlers: {
    review: async () => ++reviews <= 4 ? report({ taskResult: { role: 'reviewer', status: 'succeeded', verdict: 'changes_requested', findings: [
      { id: `F-${reviews}`, severity: 'major', file: 'src/value.js', line: 1, problem: `第${reviews}项需修正`, expectation: '继续修正并验证' }] } }) : reviewed(),
  } });
  let reopened: Awaited<ReturnType<typeof createAgentTeamService>> | undefined;
  try {
    const task = await f.create(); await f.team.close();
    const taskFile = path.join(f.data, 'team-tasks.json'), state = JSON.parse(await fs.readFile(taskFile, 'utf8'));
    const saved = state.tasks.find((item: { id: string }) => item.id === task.id);
    saved.createdAt = '2020-01-01T00:00:00.000Z'; saved.budgetLimit = 10; saved.maxRounds = 2;
    saved.profileConfig.options = { autoStartLowRisk: false, tokenLimits: { engineering: 1 }, lowQuotaPercent: 10, maxEscalations: 2 };
    await fs.writeFile(taskFile, JSON.stringify(state));
    const ledgerFile = path.join(f.data, 'collaboration-state.json'), ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
    ledger.budgets[task.id] = { usedRuns: 10, reservedRuns: 0, limit: 10 };
    await fs.writeFile(ledgerFile, JSON.stringify(ledger));
    reopened = await createAgentTeamService(f.data, f.runtime);
    assert.equal(reopened.getTask(task.id).maxRounds, null); assert.equal(reopened.getTask(task.id).budgetLimit, null);
    assert.equal(reopened.getTask(task.id).profileConfig.options.maxEscalations, null);
    assert.deepEqual(reopened.getTask(task.id).profileConfig.options.tokenLimits, {});
    await reopened.plan(task.id, { expectedRevision: task.planRevision, action: 'confirm', requestId: 'confirm-old-budget' });
    const done = await waitFor(() => reopened!.getTask(task.id), value => ['awaiting_acceptance', 'blocked', 'needs_decision'].includes(value.state), '跨旧限制完成');
    assert.equal(done.state, 'awaiting_acceptance', done.reason || ''); assert.equal(done.round, 4); assert.equal(reviews, 5);
    assert.equal(f.calls.filter(call => call.run.team).length, 16);
    assert.deepEqual((await reopened.room(task.id)).budget, { usedRuns: 25, reservedRuns: 0, limit: null });
    assert.equal(await fs.readFile(path.join(f.source, 'src/value.js'), 'utf8'), 'export const value = 1;\n');
  } finally { await reopened?.close(); await f.cleanup(); }
});

test('旧预算阻塞且没有启动原生运行的节点可重试，不重复已经完成的实现', async () => {
  const f = await fixture(plan()); let reopened: Awaited<ReturnType<typeof createAgentTeamService>> | undefined;
  try {
    const task = await f.create(); await f.confirm(task.id); const done = await f.done(task.id); await f.team.close();
    const taskFile = path.join(f.data, 'team-tasks.json'), state = JSON.parse(await fs.readFile(taskFile, 'utf8'));
    const saved = state.tasks.find((item: { id: string }) => item.id === task.id);
    const review = saved.nodes.find((node: { stage: string }) => node.stage === 'review');
    review.status = 'blocked'; review.error = '流程运行预算已用尽'; review.runId = undefined; review.receiptRunId = undefined; review.attempt += 1;
    saved.state = 'needs_decision'; saved.reason = review.error; saved.createdAt = '2020-01-01T00:00:00.000Z'; saved.budgetLimit = 10; saved.maxRounds = 2;
    await fs.writeFile(taskFile, JSON.stringify(state));
    const ledgerFile = path.join(f.data, 'collaboration-state.json'), ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
    ledger.budgets[task.id] = { usedRuns: 10, reservedRuns: 0, limit: 10 }; await fs.writeFile(ledgerFile, JSON.stringify(ledger));
    const count = f.calls.length; reopened = await createAgentTeamService(f.data, f.runtime);
    assert.equal(f.calls.length, count, '升级不自动派发历史阻塞任务');
    await reopened.decide(task.id, { action: 'retry', nodeId: review.id, requestId: 'retry-old-budget' });
    const resumed = await waitFor(() => reopened!.getTask(task.id), value => ['awaiting_acceptance', 'blocked'].includes(value.state), '旧预算阻塞恢复');
    assert.equal(resumed.state, 'awaiting_acceptance', resumed.reason || '');
    assert.equal(f.calls.filter(call => call.run.team?.profileId === 'engineer').length, 1);
    assert.equal(f.calls.filter(call => call.run.team?.profileId === 'verifier').length, 1);
    assert.equal((await reopened.room(task.id)).budget?.usedRuns, 11);
  } finally { await reopened?.close(); await f.cleanup(); }
});

test('立即重启暂停团队岗位不落成阻塞，恢复后继续并派发验证', async () => {
  let implementationRuns = 0;
  const f = await fixture(plan(), { git: true, handlers: {
    implement: async context => {
      implementationRuns += 1;
      if (implementationRuns === 1) {
        await new Promise<never>((_resolve, reject) => {
          const stop = () => reject(new Error('cancelled'));
          if (context.signal.aborted) stop(); else context.signal.addEventListener('abort', stop, { once: true });
        });
      }
      await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), 'export const value = 2;\n');
      return implemented();
    },
  } });
  let reopenedRuntime: Awaited<ReturnType<typeof createAgentRuntimeService>> | undefined;
  let reopenedTeam: Awaited<ReturnType<typeof createAgentTeamService>> | undefined;
  try {
    const task = await f.create(); await f.confirm(task.id);
    await waitFor(() => f.calls, calls => calls.some(call => call.run.team?.profileId === 'engineer'), '实现岗位运行');
    await f.runtime.prepareWorkspaceRestart();
    await waitFor(() => f.team.getTask(task.id), current => current.nodes.some(node => node.profileId === 'engineer' && node.status === 'running'), '暂停态保留为可恢复运行');
    const paused = f.team.getTask(task.id);
    const engineer = paused.nodes.find(node => node.profileId === 'engineer' && node.round === paused.round)!;
    assert.equal(engineer.status, 'running');
    assert.notEqual(paused.state, 'blocked');

    await f.team.close(); await f.runtime.close();
    reopenedRuntime = await createAgentRuntimeService(f.data, { adapters: f.adapters });
    reopenedTeam = await createAgentTeamService(f.data, reopenedRuntime);
    const done = await waitFor(() => reopenedTeam!.getTask(task.id), current => current.state === 'awaiting_acceptance' || current.state === 'blocked', '重启后恢复流程');
    assert.equal(done.state, 'awaiting_acceptance', done.reason || JSON.stringify(done.nodes.map(node => [node.profileId, node.status, node.error])));
    assert.equal(done.nodes.filter(node => node.profileId === 'verifier' && node.status === 'completed').length, 1);
    assert.equal(implementationRuns, 2, '恢复只续跑原实现岗位，不重复创建实现步骤');
  } finally { await reopenedTeam?.close(); await reopenedRuntime?.close(); await f.cleanup(); }
});

test('重新计划不设三次上限，超过三次仍可继续生成计划', async () => {
  const f = await fixture(plan());
  try {
    const task = await f.create();
    for (let index = 1; index <= 4; index += 1) {
      const current = f.team.getTask(task.id);
      assert.equal(current.state, 'awaiting_plan');
      await f.team.plan(task.id, { expectedRevision: current.planRevision, action: 'replan', requestId: `replan-${index}` });
      await waitFor(() => f.team.getTask(task.id), item => item.state === 'awaiting_plan', `第 ${index} 次重新计划完成`);
    }
    const updated = f.team.getTask(task.id);
    assert.equal(updated.replanCount, 4);
    assert.ok((updated.planHistory || []).length >= 5);
    assert.equal(updated.state, 'awaiting_plan');
  } finally { await f.cleanup(); }
});

test('计划确认前源 Git 内容或 HEAD 已变化时阻止实现派发，保留用户当前改动', async () => {
  for (const change of ['dirty', 'head'] as const) {
    const f = await fixture(plan(), { git: true });
    try {
      const task = await f.create();
      assert.equal(task.state, 'awaiting_plan');
      const newContent = `export const value = ${change === 'dirty' ? 88 : 99};\n`;
      await fs.writeFile(path.join(f.source, 'src/value.js'), newContent);
      if (change === 'head') {
        await exec('git', ['-C', f.source, 'add', 'src/value.js']);
        await exec('git', ['-C', f.source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', '模拟计划确认前用户更新临时源仓库']);
      }
      const currentHead = (await exec('git', ['-C', f.source, 'rev-parse', 'HEAD'])).stdout.trim();
      const currentStatus = (await exec('git', ['-C', f.source, 'status', '--porcelain'])).stdout;
      assert.equal(currentHead === task.baseHead, change === 'dirty');
      await f.confirm(task.id);
      const blocked = await f.done(task.id);
      assert.equal(blocked.state, 'blocked', `${change}：${blocked.reason || ''}`);
      assert.match(blocked.reason || '', /源工作区版本已变化|隔离副本版本不符/);
      assert.deepEqual(f.calls.filter(call => call.run.team).map(call => call.run.team!.profileId), ['leader'], '旧计划不得基于新的源代码启动实现');
      assert.equal(await fs.readFile(path.join(f.source, 'src/value.js'), 'utf8'), newContent);
      assert.equal((await exec('git', ['-C', f.source, 'rev-parse', 'HEAD'])).stdout.trim(), currentHead);
      assert.equal((await exec('git', ['-C', f.source, 'status', '--porcelain'])).stdout, currentStatus);
    } finally { await f.cleanup(); }
  }
});

test('含嵌套仓库的源目录明确重试版本不符时刷新基线并完成实现验证审查', async () => {
  const f = await fixture(plan(), { git: true });
  try {
    const nested = path.join(f.source, 'outputs', 'proto-repo');
    await exec('git', ['clone', '-q', '--local', '--no-hardlinks', f.source, nested]);
    const task = await f.create();
    await fs.writeFile(path.join(f.source, 'src/value.js'), 'export const value = 88;\n');
    await f.confirm(task.id);
    const blocked = await f.done(task.id);
    assert.equal(blocked.state, 'blocked', blocked.reason || '');
    assert.match(blocked.reason || '', /源工作区版本已变化|隔离副本版本不符/);

    await f.team.decide(task.id, { action: 'retry', requestId: 'retry-refresh-baseline' });
    const done = await waitFor(() => f.team.getTask(task.id), item => item.state === 'awaiting_acceptance', '刷新基线后完成流程');
    assert.equal(done.state, 'awaiting_acceptance');
    assert.equal(await fs.readFile(path.join(f.source, 'src/value.js'), 'utf8'), 'export const value = 88;\n');
    assert.deepEqual(f.calls.filter(call => call.run.team).map(call => call.run.team!.profileId), ['leader', 'engineer', 'verifier', 'reviewer']);
  } finally { await f.cleanup(); }
});

test('空问题数组表示无需提问，实现、验证和审查继续处理原结果', async () => {
  for (const location of ['report', 'taskResult']) {
    const withQuestions = (result: string) => {
      const value = readDeliveryReport(result) as Record<string, unknown>;
      return report(location === 'report' ? { ...value, questions: [] }
        : { ...value, taskResult: { ...value.taskResult as object, questions: [] } });
    };
    const f = await fixture(plan(), { handlers: {
      implement: async context => {
        await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), 'export const value = 2;\n');
        return withQuestions(implemented());
      },
      verify: async () => withQuestions(verified(['AC-1'])),
      review: async () => withQuestions(reviewed()),
    } });
    try {
      const task = await f.create(); await f.confirm(task.id);
      const done = await f.done(task.id);
      assert.equal(done.state, 'awaiting_acceptance', `${location}: ${done.reason || ''}`);
      assert.deepEqual(f.calls.filter(call => call.run.team).map(call => call.run.team!.profileId), ['leader', 'engineer', 'verifier', 'reviewer']);
      assert.equal((await f.team.room(task.id)).messages.some(message => message.type === 'ask'), false);
    } finally { await f.cleanup(); }
  }
});

test('空问题数组不会覆盖岗位回报的真实阻塞原因', async () => {
  const f = await fixture(plan(), { handlers: { implement: async () => report({ questions: [],
    taskResult: { role: 'implementer', status: 'blocked', summary: '审查执行器尚未切换', blockers: ['宿主尚未执行审查切换'] } }) } });
  try {
    const task = await f.create(); await f.confirm(task.id);
    const done = await f.done(task.id);
    assert.equal(done.state, 'blocked');
    assert.equal(done.reason, '实现岗位回报 blocked：宿主尚未执行审查切换');
    assert.equal(f.calls.some(call => call.run.team?.profileId === 'verifier'), false);
  } finally { await f.cleanup(); }
});

test('问题字段类型错误、内容无效或超出数量限制时仍阻止继续执行', async () => {
  for (const questions of [{}, [{ to: 'user', text: '' }], Array.from({ length: 4 }, () => ({ to: 'user', text: '确认规则', blocking: true }))]) {
    const f = await fixture(plan(), { handlers: { implement: async () => report({ questions,
      taskResult: { role: 'implementer', status: 'succeeded', summary: '不应放行' } }) } });
    try {
      const task = await f.create(); await f.confirm(task.id);
      const done = await f.done(task.id);
      assert.equal(done.state, 'blocked');
      assert.match(done.reason || '', /岗位返回的结果格式不符合约定/);
      assert.doesNotMatch(done.reason || '', /^\s*\[/);
      assert.equal(f.calls.some(call => call.run.team?.profileId === 'verifier'), false);
      assert.equal((await f.team.room(task.id)).messages.some(message => message.type === 'ask'), false);
    } finally { await f.cleanup(); }
  }
});

test('独立审查报告保留退回发现，等待用户回答后再运行同一审查节点', async () => {
  const finding = { id: 'F-1', severity: 'major', file: 'src/value.js', line: 1,
    problem: '此变更需要确认是否纳入本次范围', expectation: '由用户明确本次审查范围' };
  const questionText = '请确认是否保留这项现有改动？';
  const answerText = '确认保留，已纳入本次范围。';
  let reviews = 0;
  const f = await fixture(plan(), { handlers: { review: async context => {
    if (++reviews === 1) return report({ questions: [{ to: 'user', text: questionText, blocking: true }],
      taskResult: { role: 'reviewer', status: 'failed', verdict: 'changes_requested', findings: [finding] } });
    assert.ok(context.run.teamContext?.includes(answerText));
    return reviewed();
  } } });
  try {
    const task = await f.create(); await f.confirm(task.id);
    const waiting = await waitFor(() => f.team.getTask(task.id), item => ['waiting_input', 'blocked'].includes(item.state), '审查等待用户');
    assert.equal(waiting.state, 'waiting_input', waiting.reason);
    const review = waiting.nodes.find(node => node.stage === 'review')!;
    assert.equal(review.status, 'waiting_input');
    assert.equal(review.error, undefined);
    assert.equal(review.reviewUnit?.verdict, 'changes_requested');
    assert.deepEqual(review.reviewUnit?.findings, [finding]);
    const savedReports = await Promise.all(waiting.artifacts!.filter(item => item.nodeId === review.id && item.kind !== 'diff')
      .map(async item => JSON.parse(await fs.readFile(item.path, 'utf8'))));
    assert.ok(savedReports.some(item => item.taskResult?.findings?.some((value: { id: string }) => value.id === finding.id)), '原审查报告已归档');
    const room = await f.team.room(task.id);
    const question = room.messages.find(item => item.type === 'ask');
    assert.deepEqual(question?.from, { kind: 'profile', profileId: 'reviewer' });
    assert.deepEqual(question?.to, { kind: 'user' });
    assert.equal(question?.body.text, questionText);
    assert.equal(reviews, 1);
    const reviewPrompt = f.calls.find(call => call.run.team?.profileId === 'reviewer')!.context;
    const targets = /questions:\[\{to:"([^"]+)"/.exec(reviewPrompt)?.[1].split('|') || [];
    assert.ok(targets.includes('user') && targets.includes('engineer'));
    assert.equal(targets.includes('reviewer'), false);
    await f.team.answer(task.id, { correlationId: question!.id, text: answerText, requestId: 'answer-review-question' });
    const done = await f.done(task.id);
    assert.equal(done.state, 'awaiting_acceptance', done.reason);
    const nextReview = done.nodes.find(node => node.id === review.id)!;
    assert.equal(nextReview.reviewUnit?.verdict, 'approved');
    assert.equal(nextReview.attempt, 2);
    assert.notEqual(nextReview.runId, review.runId);
    assert.equal(reviews, 2);
    assert.equal(f.calls.filter(call => call.run.team?.profileId === 'engineer').length, 1);
    assert.equal(f.calls.filter(call => call.run.team?.profileId === 'verifier').length, 1);
    assert.ok((await f.team.room(task.id)).messages.some(item => item.type === 'back' && item.answerTo === question!.id));
  } finally { await f.cleanup(); }
});

test('审查向工程求证，工程追问验证，逐级答复后只续跑原审查', async () => {
  const reviewQuestion = '请说明值的来源，并核对实际验证日志。';
  const engineeringQuestion = '原始验证日志核对了哪个值？';
  const verificationAnswer = '验证日志的实际值为 2。';
  const engineeringAnswer = '实现来源为契约，验证岗位已核对值 2。';
  const finding = { id: 'F-1', severity: 'major', file: 'src/value.js', line: 1,
    problem: '缺少验证日志来源', expectation: '按原始日志核对' };
  let reviews = 0, engineeringAnswers = 0;
  let releaseVerification!: () => void;
  const held = new Promise<void>(resolve => { releaseVerification = resolve; });
  const f = await fixture(plan(), { handlers: {
    review: async context => {
      if (++reviews === 1) return report({ questions: [{ to: 'engineer', text: reviewQuestion, blocking: true }],
        taskResult: { role: 'reviewer', status: 'blocked', verdict: 'blocked', findings: [finding] } });
      assert.ok(context.run.teamContext?.includes(engineeringAnswer));
      return reviewed();
    },
    answer: async context => {
      if (context.run.team?.profileId === 'engineer') {
        assert.ok(context.run.teamContext?.includes(reviewQuestion));
        if (++engineeringAnswers === 1) return report({ questions: [{ to: 'verifier', text: engineeringQuestion, blocking: true }] });
        assert.ok(context.run.teamContext?.includes(verificationAnswer));
        return report({ answer: engineeringAnswer });
      }
      assert.equal(context.run.team?.profileId, 'verifier');
      assert.ok(context.run.teamContext?.includes(engineeringQuestion));
      await held;
      return report({ answer: verificationAnswer });
    },
  } });
  try {
    const task = await f.create(); await f.confirm(task.id);
    await waitFor(() => f.calls, calls => calls.some(call => call.run.team?.profileId === 'verifier' && isAnswerContext(call.context)), '验证答复已开始');
    const waiting = f.team.getTask(task.id), review = waiting.nodes.find(node => node.stage === 'review')!;
    assert.equal(review.status, 'waiting_input');
    assert.deepEqual(review.reviewUnit?.findings, [finding]);
    assert.equal(reviews, 1);
    assert.equal(waiting.nodes.find(node => node.profileId === 'engineer' && node.purpose === 'answer')?.status, 'waiting_input');
    releaseVerification();
    const done = await f.done(task.id);
    assert.equal(done.state, 'awaiting_acceptance', done.reason);
    const nextReview = done.nodes.find(node => node.id === review.id)!;
    assert.equal(nextReview.attempt, 2);
    assert.equal(nextReview.reviewUnit?.verdict, 'approved');
    assert.equal(reviews, 2);
    const answerNodes = done.nodes.filter(node => node.purpose === 'answer');
    assert.deepEqual(answerNodes.map(node => [node.profileId, node.stage, node.status, node.attempt]),
      [['engineer', 'report', 'completed', 2], ['verifier', 'report', 'completed', 1]]);
    for (const profile of ['engineer', 'verifier'] as const) {
      assert.equal(f.calls.filter(call => call.run.team?.profileId === profile && !isAnswerContext(call.context)).length, 1);
      assert.ok(answerNodes.find(node => node.profileId === profile)?.workspacePath);
      assert.notEqual(answerNodes.find(node => node.profileId === profile)?.workspacePath, done.workspacePath);
    }
    const messages = (await f.team.room(task.id)).messages;
    const profileKey = (participant: typeof messages[number]['from']) => participant.kind === 'profile' ? participant.profileId : 'user';
    const questions = messages.filter(item => item.type === 'ask');
    assert.deepEqual(questions.map(item => [profileKey(item.from), profileKey(item.to), item.processing]),
      [['reviewer', 'engineer', 'answered'], ['engineer', 'verifier', 'answered']]);
    assert.equal(messages.find(item => item.type === 'back' && item.answerTo === questions[0].id)?.body.text, engineeringAnswer);
    assert.equal(messages.find(item => item.type === 'back' && item.answerTo === questions[1].id)?.body.text, verificationAnswer);
  } finally { releaseVerification(); await f.cleanup(); }
});

test('群聊岗位拒绝缺席成员和指向同一实际成员的别名', async () => {
  for (const target of ['batch', 'verifier'] as const) {
    const f = await fixture(plan(), { handlers: { implement: async () => report({
      questions: [{ to: target, text: '请核对实施证据。', blocking: true }],
      taskResult: { role: 'implementer', status: 'blocked' },
    }) } });
    try {
      const binding = { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high' } as const;
      const started = await f.team.chat({ objective: '实施并核对证据', workspacePath: f.source, accessMode: 'workspace',
        attachmentIds: [], requestId: `missing-peer-${target}`, group: { roomId: randomUUID(), cursorTrustPaths: [],
          config: { revision: 1, name: '冻结团队', members: [
            { id: 'leader', name: '负责人', capability: 'read', instructions: '规划', enabled: true, binding, fallbackBinding: null },
            { id: 'engineer', name: '工程', capability: 'write', instructions: '实施', enabled: true, binding, fallbackBinding: null },
            { id: 'verifier', name: '验证', capability: 'verify', instructions: '验证', enabled: false, binding, fallbackBinding: null },
          ] } } });
      const done = await waitFor(() => f.team.getTask(started.task.id), value => value.nodes.some(node => node.stage === 'implement'
        && node.status === 'blocked'), '不派发缺席成员或自己');
      const blocked = done.nodes.find(node => node.stage === 'implement')!;
      assert.match(blocked.error || '', target === 'batch' ? /与当前岗位由同一成员承担/ : /本轮未启用.*成员/);
      assert.equal(done.nodes.some(node => node.purpose === 'answer'), false);
      assert.equal((await f.team.room(done.id)).messages.some(item => item.type === 'ask'), false);
      const prompt = f.calls.find(call => call.run.team?.profileId === 'engineer')!.context;
      const targets = /questions:\[\{to:"([^"]+)"/.exec(prompt)?.[1].split('|') || [];
      assert.ok(targets.includes('leader') && targets.includes('user'));
      assert.equal(targets.includes(target), false);
    } finally { await f.cleanup(); }
  }
});

test('重启后补领已经领取但还没有答复节点的岗位问题', async () => {
  let reviews = 0, answers = 0;
  const f = await fixture(plan(), { handlers: {
    review: async context => {
      if (++reviews === 1) return report({ questions: [{ to: 'user', text: '请核对原始材料。', blocking: true }],
        taskResult: { role: 'reviewer', status: 'blocked', verdict: 'blocked' } });
      assert.ok(context.run.teamContext?.includes('原始材料已核对。'));
      return reviewed();
    },
    answer: async context => {
      assert.equal(context.run.team?.profileId, 'engineer');
      answers += 1;
      return report({ answer: '原始材料已核对。' });
    },
  } });
  let reopenedRuntime: Awaited<ReturnType<typeof createAgentRuntimeService>> | undefined;
  let reopenedTeam: Awaited<ReturnType<typeof createAgentTeamService>> | undefined;
  try {
    const task = await f.create(); await f.confirm(task.id);
    await waitFor(() => f.team.getTask(task.id), value => value.state === 'waiting_input', '报告与问题均已接收');
    await f.team.close(); await f.runtime.close();
    const ledgerPath = path.join(f.data, 'collaboration-state.json');
    const state = JSON.parse(await fs.readFile(ledgerPath, 'utf8')) as { messages: Awaited<ReturnType<typeof f.team.room>>['messages'] };
    const ask = state.messages.find(message => message.workflowId === task.id && message.type === 'ask')!;
    // 模拟账本领取已落盘，但进程在保存答复节点之前中断。
    ask.to = { kind: 'profile', profileId: 'engineer' };
    ask.delivery = 'acknowledged'; ask.processing = 'processing';
    await fs.writeFile(ledgerPath, JSON.stringify(state));
    reopenedRuntime = await createAgentRuntimeService(f.data, { adapters: f.adapters });
    reopenedTeam = await createAgentTeamService(f.data, reopenedRuntime);
    const done = await waitFor(() => reopenedTeam!.getTask(task.id), value => ['awaiting_acceptance', 'blocked'].includes(value.state), '孤立问题恢复');
    assert.equal(done.state, 'awaiting_acceptance', done.reason);
    assert.equal(answers, 1);
    assert.equal(reviews, 2);
    assert.equal(done.nodes.filter(node => node.purpose === 'answer' && node.answerTo === ask.id).length, 1);
    assert.equal((await reopenedTeam.room(task.id)).messages.find(message => message.id === ask.id)?.processing, 'answered');
  } finally {
    await reopenedTeam?.close(); await reopenedRuntime?.close(); await f.cleanup();
  }
});

test('审查问题包含未授权接收方时，整组问题都不会派发', async () => {
  const f = await fixture(plan(), { handlers: { review: async () => report({
    questions: [{ to: 'user', text: '确认范围？', blocking: true }, { to: 'reviewer', text: '向自己确认审查结论？', blocking: true }],
    taskResult: { role: 'reviewer', status: 'failed', verdict: 'changes_requested' },
  }) } });
  try {
    const task = await f.create(); await f.confirm(task.id);
    const done = await f.done(task.id);
    const review = done.nodes.find(node => node.stage === 'review')!;
    assert.equal(done.state, 'blocked');
    assert.match(review.error || '', /不允许 reviewer 向 reviewer 提问/);
    const room = await f.team.room(task.id);
    assert.equal(room.messages.some(item => item.type === 'ask'), false);
    assert.equal(room.runs.filter(run => run.team?.profileId === 'reviewer').length, 1);
    assert.equal(done.nodes.some(node => node.purpose === 'answer'), false);
  } finally { await f.cleanup(); }
});

test('审查的非阻塞建议保留在原报告中，不等待回答或重跑审查', async () => {
  const question = { to: 'user', text: '后续是否统一命名？', blocking: false };
  const f = await fixture(plan(), { handlers: { review: async () => report({ questions: [question],
    taskResult: { role: 'reviewer', status: 'succeeded', verdict: 'approved' },
  }) } });
  try {
    const task = await f.create(); await f.confirm(task.id);
    const done = await f.done(task.id);
    assert.equal(done.state, 'awaiting_acceptance', done.reason);
    const review = done.nodes.find(node => node.stage === 'review')!;
    assert.equal(review.attempt, 1);
    assert.equal(f.calls.filter(call => call.run.team?.profileId === 'reviewer').length, 1);
    const archived = done.artifacts!.find(item => item.nodeId === review.id && item.kind === 'review')!;
    assert.deepEqual(JSON.parse(await fs.readFile(archived.path, 'utf8')).questions, [question]);
    assert.equal((await f.team.room(task.id)).messages.some(item => item.type === 'ask'), false);
  } finally { await f.cleanup(); }
});

test('实现提问等待用户，原文回答后续接原会话；重复回答不重复派发', async () => {
  let implementations = 0;
  const f = await fixture(plan(), { handlers: { implement: async context => {
    if (++implementations === 1) return report({ taskResult: { role: 'implementer', status: 'blocked', summary: '需要产品规则与架构契约' },
      questions: [{ to: 'user', text: '字段是否使用原始值？', blocking: true }, { to: 'architect', text: '请确认目录隔离契约', blocking: true }] });
    assert.match(context.run.teamContext || '', /架构已确认隔离方案/);
    assert.match(context.run.teamContext || '', /使用原始值 L0001/);
    await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), 'export const value = 2;\n');
    return implemented();
  } } });
  try {
    const task = await f.create(); await f.confirm(task.id);
    const waiting = await waitFor(() => f.team.getTask(task.id),
      item => item.nodes.some(node => node.purpose === 'answer' && node.status === 'completed') && ['waiting_input', 'blocked'].includes(item.state), '岗位已答且等待用户');
    assert.equal(waiting.state, 'waiting_input', waiting.reason || '');
    const room = await f.team.room(task.id);
    const question = room.messages.find(item => item.type === 'ask' && item.to.kind === 'user')!;
    assert.ok(question);
    assert.equal(f.calls.filter(call => call.run.team?.profileId === 'verifier').length, 0);
    const answer = { correlationId: question.id, text: '使用原始值 L0001', requestId: 'answer-user-1' };
    await f.team.answer(task.id, answer);
    const done = await f.done(task.id); assert.equal(done.state, 'awaiting_acceptance', done.reason || '');
    await f.team.answer(task.id, answer);
    assert.equal(implementations, 2);
    const implementationCalls = f.calls.filter(call => call.run.team?.profileId === 'engineer');
    assert.equal(implementationCalls[1].resume, implementationCalls[0].run.sessionId);
    assert.equal(implementationCalls[1].run.conversationId, implementationCalls[0].run.conversationId);
    assert.equal((await f.team.room(task.id)).messages.filter(item => item.type === 'back').length, 2);
  } finally { await f.cleanup(); }
});

test('验证向负责人补材料后恢复原步骤，不重复实施或把提问视为验证通过', async () => {
  let verifications = 0;
  const f = await fixture(plan(), { handlers: { verify: async context => {
    if (++verifications === 1) return report({ taskResult: { role: 'verifier', status: 'blocked', summary: '等待原始测试材料' },
      questions: [{ to: 'leader', text: '请确认已有测试账号与原始测试证据路径', blocking: true }] });
    assert.match(context.run.teamContext || '', /测试证据位于 tests\/login\.json/);
    assert.equal(await fs.readFile(path.join(context.run.workspacePath, 'src/value.js'), 'utf8'), 'export const value = 2;\n');
    return verified(['AC-1']);
  } } });
  try {
    const task = await f.create(); await f.confirm(task.id);
    const done = await f.done(task.id);
    assert.equal(done.state, 'awaiting_acceptance', done.reason || '');
    assert.equal(f.calls.filter(call => call.run.team?.profileId === 'engineer').length, 1);
    const verificationCalls = f.calls.filter(call => call.run.team?.profileId === 'verifier');
    assert.equal(verificationCalls.length, 2);
    assert.equal(verificationCalls[1].run.team?.nodeId, verificationCalls[0].run.team?.nodeId);
    assert.notEqual(verificationCalls[1].run.team?.stageKey, verificationCalls[0].run.team?.stageKey);
    assert.equal(f.calls.filter(call => call.run.team?.profileId === 'reviewer').length, 1);
    const messages = (await f.team.room(task.id)).messages;
    const question = messages.find(item => item.type === 'ask' && item.from.kind === 'profile' && item.from.profileId === 'verifier')!;
    assert.deepEqual(question.to, { kind: 'profile', profileId: 'leader' });
    assert.equal(question.processing, 'answered');
    assert.ok(messages.some(item => item.type === 'back' && item.answerTo === question.id));
    assert.equal(done.nodes.find(node => node.stage === 'verify')?.status, 'completed');
    assert.equal(done.nodes.find(node => node.stage === 'verify')?.attempt, 2);
  } finally { await f.cleanup(); }
});

for (const scenario of ['same', 'changed', 'altered', 'invalid', 'unrelated', 'failed', 'missing_snapshot'] as const) test({
  same: '旧验证提问路由拒绝仅重收原问题，保留运行和失败证据且重启重试不重复派发',
  changed: '旧验证提问恢复时当前候选已变化必须重新验证',
  altered: '旧验证提问恢复时原验证修改源码不能复用报告',
  invalid: '旧验证提问仍含非法路由时不能直接重收',
  unrelated: '普通业务验证阻塞不能冒充旧提问接收失败',
  failed: '旧验证原生运行失败不能仅重收问题',
  missing_snapshot: '旧验证缺少候选快照不能仅重收问题',
}[scenario], async () => {
  const waiting = (to: 'leader' | 'verifier' | 'user') => report({
    validationEvidence: { ...emptyDeliveryEvidence(), tests: { status: 'failed', evidence: '原接口检查失败，未完成真实联调', sha: '' } },
    taskResult: { role: 'verifier', status: 'blocked', summary: '等待材料，验证未通过',
      acceptance: [{ id: 'AC-1', status: 'blocked', evidence: '缺少可用测试材料' }], blockers: ['真实接口检查仍未通过'] },
    questions: [...(scenario === 'same' ? [{ to: 'user', text: '请提供测试环境', blocking: true }] : []),
      { to, text: '请确认已有测试材料的路径', blocking: true }],
  });
  let verifications = 0;
  const f = await fixture(plan(), { git: true, handlers: {
    verify: async context => {
      verifications++;
      if (verifications === 1 && scenario === 'altered') await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), 'export const value = 99;\n');
      // 用仍然非法的自问路由构造已持久化的旧状态。
      return waiting(verifications === 1 ? 'verifier' : 'user');
    },
    answer: async () => report({ questions: [{ to: 'user', text: '现有材料不足，请补充测试材料路径', blocking: true }] }),
  } });
  let reopenedRuntime: Awaited<ReturnType<typeof createAgentRuntimeService>> | undefined;
  let reopenedTeam: Awaited<ReturnType<typeof createAgentTeamService>> | undefined;
  try {
    const task = await f.create(); await f.confirm(task.id);
    const blocked = await f.done(task.id), original = blocked.nodes.find(node => node.stage === 'verify')!;
    assert.equal(original.status, 'blocked'); assert.match(original.error || '', /不允许 verifier 向 verifier 提问/);
    assert.equal(verifications, 1);
    await f.team.close(); await f.runtime.close();
    const runFile = path.join(f.data, 'agent-runs.json'), runs = JSON.parse(await fs.readFile(runFile, 'utf8')) as AgentRun[];
    const saved = runs.find(run => run.id === original.runId)!;
    saved.result = waiting(scenario === 'invalid' ? 'verifier' : 'leader');
    if (scenario === 'failed') { saved.status = 'failed'; saved.error = 'workspace routing discovery timed out'; }
    await fs.writeFile(runFile, JSON.stringify(runs));
    const taskFile = path.join(f.data, 'team-tasks.json'), state = JSON.parse(await fs.readFile(taskFile, 'utf8')) as { tasks: AdvancedTeamTask[] };
    const stored = state.tasks.find(item => item.id === task.id)!, node = stored.nodes.find(item => item.id === original.id)!;
    node.error = scenario === 'unrelated' ? '验证岗位回报 blocked：缺少测试材料' : '不允许 verifier 向 leader 提问';
    stored.reason = node.error;
    if (scenario === 'missing_snapshot') node.snapshot = undefined;
    await fs.writeFile(taskFile, JSON.stringify(state));
    if (scenario === 'changed') await fs.writeFile(path.join(blocked.workspacePath!, 'src/value.js'), 'export const value = 3;\n');
    reopenedRuntime = await createAgentRuntimeService(f.data, { adapters: f.adapters });
    reopenedTeam = await createAgentTeamService(f.data, reopenedRuntime);
    const decision = { action: 'retry' as const, nodeId: original.id, requestId: `recapture-questions-${scenario}` };
    await reopenedTeam.decide(task.id, decision);
    const waitingTask = await waitFor(() => reopenedTeam!.getTask(task.id), item => item.state === 'waiting_input'
      && (scenario !== 'same' || item.nodes.some(node => node.purpose === 'answer' && node.status === 'waiting_input')), '等待真实材料');
    const captured = waitingTask.nodes.find(item => item.id === original.id)!;
    assert.equal(waitingTask.state, 'waiting_input'); assert.equal(captured.status, 'waiting_input');
    assert.equal(f.calls.filter(call => call.run.team?.profileId === 'engineer').length, 1);
    assert.equal(f.calls.filter(call => call.run.team?.profileId === 'reviewer').length, 0);
    if (scenario === 'same') {
      assert.equal(captured.runId, original.runId); assert.equal(captured.attempt, original.attempt);
      assert.deepEqual(captured.snapshot, original.snapshot); assert.equal(verifications, 1);
      assert.equal(reopenedRuntime.getRun(original.runId!)?.result, saved.result);
      const messages = reopenedTeam.ledger.messages(task.id), calls = f.calls.length;
      const question = messages.find(item => item.type === 'ask' && item.from.kind === 'profile' && item.from.profileId === 'verifier'
        && item.to.kind === 'profile')!;
      assert.deepEqual(question.to, { kind: 'profile', profileId: 'leader' }); assert.notEqual(question.processing, 'answered');
      assert.equal(messages.filter(item => item.type === 'ask' && item.to.kind === 'user').length, 2);
      await reopenedTeam.decide(task.id, decision);
      await reopenedTeam.close(); reopenedTeam = await createAgentTeamService(f.data, reopenedRuntime);
      await reopenedTeam.decide(task.id, decision);
      assert.equal(f.calls.length, calls);
      assert.deepEqual(reopenedTeam.ledger.messages(task.id).filter(item => item.type !== 'progress'), messages.filter(item => item.type !== 'progress'));
      assert.equal(reopenedTeam.getTask(task.id).nodes.find(item => item.id === original.id)?.runId, original.runId);
    } else {
      assert.notEqual(captured.runId, original.runId); assert.equal(captured.attempt, original.attempt + 1); assert.equal(verifications, 2);
    }
  } finally { await reopenedTeam?.close(); await reopenedRuntime?.close(); await f.cleanup(); }
});

test('目标已满足且无代码改动时仍经过独立验证与审查，不把自报当最终完成', async () => {
  const f = await fixture(plan('engineering', { acceptanceCriteria: [{ id: 'AC-1', text: '版本已对齐且原文件保留', source: '用户原话' }] }), { git: true, handlers: {
    implement: async context => {
      const checked = await exec('git', ['-C', context.run.workspacePath, 'rev-parse', 'HEAD']);
      return report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '版本已对齐，无需修改',
        acceptance: [{ id: 'AC-1', status: 'passed', evidence: checked.stdout.trim() }],
        selfTests: [{ command: 'git rev-parse HEAD', exitCode: 0 }] } });
    },
    verify: async context => {
      assert.equal(await fs.readFile(path.join(context.run.workspacePath, 'src/value.js'), 'utf8'), 'export const value = 1;\n');
      return verified(['AC-1']);
    },
  } });
  try {
    const task = await f.create(); await f.confirm(task.id);
    const done = await f.done(task.id);
    assert.equal(done.state, 'awaiting_acceptance', done.reason || '');
    assert.deepEqual(f.calls.filter(call => call.run.team).map(call => call.run.team!.profileId), ['leader', 'engineer', 'verifier', 'reviewer']);
    assert.deepEqual(done.nodes.find(node => node.stage === 'implement')!.changedFiles, []);
  } finally { await f.cleanup(); }
});

test('Codex 实现可配置独立 Codex 完整权限审查，保存配置后真实派发该审查模型', async () => {
  const f = await fixture(plan(), { git: true });
  try {
    const config = f.team.profiles.read();
    config.reviewRouting.codex = { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high' };
    Object.assign(config.profiles.find(profile => profile.id === 'reviewer')!, config.reviewRouting.codex);
    await f.team.profiles.save({ ...config, expectedRevision: config.revision });
    const task = await f.create(); await f.confirm(task.id);
    const done = await f.done(task.id);
    assert.equal(done.state, 'awaiting_acceptance', done.reason || '');
    const engineer = f.calls.find(call => call.run.team?.profileId === 'engineer')!.run;
    const reviewer = f.calls.find(call => call.run.team?.profileId === 'reviewer')!.run;
    assert.deepEqual([reviewer.provider, reviewer.model, reviewer.mode, reviewer.task?.role], ['codex', 'gpt-6-astra', 'agent', 'reviewer']);
    assert.notEqual(reviewer.sessionId, engineer.sessionId);
    assert.notEqual(reviewer.conversationId, engineer.conversationId);
  } finally { await f.cleanup(); }
});

test('受阻审查改用 Codex 只重试当前节点，保留实现验证与冻结路由，重复请求不重复派发', async () => {
  const f = await fixture(plan(), { git: true, handlers: { review: async context => {
    if (context.run.provider === 'cursor') throw new Error('Cursor 未登录');
    return reviewed();
  } } });
  try {
    const config = f.team.profiles.read();
    config.reviewRouting.codex = { provider: 'cursor', model: 'composer-2.5', reasoningEffort: '' };
    Object.assign(config.profiles.find(profile => profile.id === 'reviewer')!, config.reviewRouting.codex);
    await f.team.profiles.save({ ...config, expectedRevision: config.revision });
    const task = await f.create(); await f.confirm(task.id);
    const blocked = await f.done(task.id);
    assert.equal(blocked.state, 'blocked');
    const review = blocked.nodes.find(node => node.stage === 'review')!;
    const upstream = blocked.nodes.filter(node => ['implement', 'verify'].includes(node.stage));
    const input = { action: 'retry_review_codex' as const, nodeId: review.id, requestId: 'review-with-codex-1' };
    await f.team.decide(task.id, input);
    const done = await f.done(task.id);
    assert.equal(done.state, 'awaiting_acceptance', done.reason || '');
    assert.deepEqual(done.nodes.filter(node => ['implement', 'verify'].includes(node.stage)), upstream);
    assert.deepEqual(done.profileConfig.reviewRouting, blocked.profileConfig.reviewRouting);
    assert.equal(f.team.profiles.read().revision, config.revision + 1);
    const reviews = f.calls.filter(call => call.run.team?.profileId === 'reviewer');
    assert.equal(reviews.length, 2);
    assert.deepEqual([reviews[1].run.provider, reviews[1].run.model, reviews[1].run.mode], ['codex', 'gpt-6-astra', 'agent']);
    assert.notEqual(reviews[1].run.sessionId, reviews[0].run.sessionId);
    assert.equal(reviews[1].run.team?.nodeId, review.id);
    assert.equal(done.nodes.find(node => node.id === review.id)?.attempt, 2);
    await f.team.decide(task.id, input);
    assert.equal(f.calls.filter(call => call.run.team?.profileId === 'reviewer').length, 2);
  } finally { await f.cleanup(); }
});

test('Codex 审查重试不能用于实施节点，执行器不可用时不重派也不改变原节点', async () => {
  const f = await fixture(plan(), { handlers: { review: async () => { throw new Error('审查失败'); } } });
  try {
    const task = await f.create(); await f.confirm(task.id);
    const blocked = await f.done(task.id);
    const engineer = blocked.nodes.find(node => node.stage === 'implement')!, review = blocked.nodes.find(node => node.stage === 'review')!;
    await assert.rejects(f.team.decide(task.id, { action: 'retry_review_codex', nodeId: engineer.id, requestId: 'wrong-review-node' }), /当前候选.*受阻.*审查/);
    const calls = f.calls.length, readHealth = f.runtime.health;
    const codex = await readHealth('codex');
    f.runtime.health = async () => ({ ...codex, ready: false, message: 'Codex 不可用' });
    await assert.rejects(f.team.decide(task.id, { action: 'retry_review_codex', nodeId: review.id, requestId: 'codex-not-ready' }), /未就绪/);
    f.runtime.health = readHealth;
    assert.equal(f.calls.length, calls);
    assert.deepEqual(f.team.getTask(task.id).nodes, blocked.nodes);
    assert.equal(f.team.getTask(task.id).requestIds['codex-not-ready'], undefined);
  } finally { await f.cleanup(); }
});

test('Cursor 审查额度耗尽自动用 Codex，只有实现同模型可用也启动独立审查会话', async () => {
  const f = await fixture(plan(), { git: true, handlers: { review: async context => {
    if (context.run.provider === 'cursor') throw new Error('Cursor CLI 额度已用尽');
    return reviewed();
  } } });
  try {
    const config = f.team.profiles.read();
    config.reviewRouting.codex = { provider: 'cursor', model: 'composer-2.5', reasoningEffort: '' };
    Object.assign(config.profiles.find(profile => profile.id === 'reviewer')!, config.reviewRouting.codex);
    await f.team.profiles.save({ ...config, expectedRevision: config.revision });
    const readHealth = f.runtime.health;
    f.runtime.health = async (provider, force) => {
      const value = await readHealth(provider, force);
      return provider === 'codex' ? { ...value, models: value.models.filter(model => model.id === 'gpt-6.1-sol') } : value;
    };
    const task = await f.create(); await f.confirm(task.id); const done = await f.done(task.id);
    assert.equal(done.state, 'awaiting_acceptance', done.reason || '');
    const reviews = f.calls.filter(call => call.run.team?.profileId === 'reviewer');
    assert.deepEqual(reviews.map(call => [call.run.provider, call.run.model]), [['cursor', 'composer-2.5'], ['codex', 'gpt-6.1-sol']]);
    assert.equal(reviews[1].resume, '');
    assert.notEqual(reviews[1].run.sessionId, f.calls.find(call => call.run.team?.profileId === 'engineer')!.run.sessionId);
    assert.equal(f.calls.filter(call => call.run.team?.profileId === 'engineer').length, 1);
  } finally { await f.cleanup(); }
});

test('跨轮恢复核验候选与产物，复用原计划实现验证，不改写历史轮次或重跑实现', async () => {
  for (const tamper of ['none', 'candidate', 'artifact'] as const) {
    let reviews = 0;
    const value = plan();
    const f = await fixture(value, { git: true, handlers: { review: async () => {
      if (++reviews === 1) throw new Error('审查失败');
      return reviewed();
    } } });
    try {
      const task = await f.team.create(f.main.id, { objective: '修复目标文件', attachmentIds: [], requestId: 'chat-create', interactionMode: 'chat' });
      const blocked = await f.done(task.id);
      const originalReview = blocked.nodes.find(node => node.stage === 'review')!;
      value.questions.push({ id: 'Q-1', text: '恢复审查入口？', blocking: true });
      await f.team.chat({ taskId: task.id, objective: '继续', attachmentIds: [], requestId: 'chat-continue' });
      await waitFor(() => f.team.getTask(task.id), task => task.state === 'awaiting_plan', '等待恢复计划');
      await f.team.plan(task.id, { expectedRevision: f.team.getTask(task.id).planRevision, action: 'replan', requestId: 'replan-after-review' });
      await waitFor(() => f.team.getTask(task.id), task => task.state === 'awaiting_plan', '重新计划完成');
      await waitFor(() => f.team.isIdle(), Boolean, '重新计划产物收集完成');
      const before = f.team.getTask(task.id);
      if (tamper === 'candidate') await fs.writeFile(path.join(before.workspacePath!, 'src/value.js'), 'changed after verification');
      if (tamper === 'artifact') await fs.writeFile(before.artifacts!.find(item => item.kind === 'verify')!.path, 'tampered');
      const input = { action: 'retry_review_codex' as const, nodeId: originalReview.id, requestId: 'recover-review' };
      if (tamper !== 'none') {
        await assert.rejects(f.team.decide(task.id, input), /候选版本已变化|哈希不一致/);
        assert.deepEqual(f.team.getTask(task.id), before);
        assert.equal(reviews, 1);
      } else {
        const chatInput = { taskId: task.id, objective: '改用 Codex 审查', attachmentIds: [], requestId: 'chat-recover-review' };
        await f.team.chat(chatInput); const done = await waitFor(() => f.team.getTask(task.id), item => ['completed', 'awaiting_acceptance'].includes(item.state), '流程结束');
        assert.equal(done.state, 'completed', done.reason || '');
        assert.deepEqual(done.nodes.slice(0, before.nodes.length), before.nodes);
        assert.equal(done.nodes.filter(node => node.round === done.round && node.stage === 'verify')[0].reusedFrom, blocked.nodes.find(node => node.stage === 'verify')!.id);
        assert.equal(f.calls.filter(call => call.run.team?.profileId === 'engineer').length, 1);
        assert.equal(f.calls.filter(call => call.run.team?.profileId === 'verifier').length, 1);
        await f.team.chat(chatInput); assert.equal(reviews, 2);
      }
    } finally { await f.cleanup(); }
  }
});

test('Claude 未就绪时高级前端流程自动切Codex，审查避开实现模型且记录原因', async () => {
  const f = await fixture(plan('frontend'), { claudeReady: false });
  try {
    const task = await f.create(); await f.confirm(task.id);
    const done = await f.done(task.id); assert.equal(done.state, 'awaiting_acceptance', done.reason || '');
    assert.match(done.providerFallback?.reason || '', /Claude/);
    const implementation = f.calls.find(call => call.run.team?.profileId === 'frontend')!.run;
    const reviewer = f.calls.find(call => call.run.team?.profileId === 'reviewer')!.run;
    assert.deepEqual([implementation.provider, implementation.model], ['codex', 'gpt-6.1-sol']);
    assert.deepEqual([reviewer.provider, reviewer.model, reviewer.mode], ['codex', 'gpt-6-astra', 'agent']);
    assert.equal(f.calls.some(call => call.run.provider === 'claude'), false);
  } finally { await f.cleanup(); }
});

test('真实Git前后端并行，集成统一候选后验证，两个跨模型审查单元全部通过才待验收', async () => {
  const value = plan('complex_delivery_parallel', { allowedPaths: ['src/**', 'server/**'],
    ownership: [{ owner: 'engineer', paths: ['server/**'] }, { owner: 'frontend', paths: ['src/**'] }] });
  const started = new Set<string>(); let release!: () => void;
  const both = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(value, { git: true, handlers: { implement: async context => {
    const profile = context.run.team!.profileId;
    started.add(profile); if (started.size === 2) release();
    await new Promise<void>((resolve, reject) => { void both.then(resolve); context.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
    await fs.writeFile(path.join(context.run.workspacePath, profile === 'engineer' ? 'server/value.js' : 'src/value.js'), 'export const value = 2;\n');
    return implemented();
  }, verify: async context => {
    assert.equal(await fs.readFile(path.join(context.run.workspacePath, 'server/value.js'), 'utf8'), 'export const value = 2;\n');
    assert.equal(await fs.readFile(path.join(context.run.workspacePath, 'src/value.js'), 'utf8'), 'export const value = 2;\n');
    return verified(['AC-1']);
  } } });
  try {
    const task = await f.create(); await f.confirm(task.id);
    const done = await f.done(task.id); assert.equal(done.state, 'awaiting_acceptance', done.reason || '');
    const impl = f.calls.filter(call => ['engineer', 'frontend'].includes(call.run.team?.profileId || ''));
    assert.equal(impl.length, 2); assert.notEqual(impl[0].run.workspacePath, impl[1].run.workspacePath);
    assert.ok(done.candidate?.final.tree);
    assert.equal(done.nodes.filter(node => node.stage === 'review' && node.status === 'completed').length, 2);
    const reviewChoices = f.calls.filter(call => call.run.team?.profileId === 'reviewer').map(call => `${call.run.provider}:${call.run.model}`).sort();
    assert.deepEqual(reviewChoices, ['claude:claude-opus-5-5', 'codex:gpt-6-astra']);
    const versions = done.nodes.filter(node => ['integrate', 'verify', 'review'].includes(node.stage)).map(node => node.snapshot?.value);
    assert.equal(new Set(versions).size, 1);
    assert.equal((await exec('git', ['-C', f.source, 'status', '--porcelain'])).stdout, '');
  } finally { release(); await f.cleanup(); }
});

test('Cursor批量规则由机器核对残留与例外，不一致不能进入验证', async () => {
  const value = plan('batch', { transformSpec: { rule: '把value改为2，legacy保留例外', examples: [{ before: 'value = 1', after: 'value = 2' }],
    include: ['src/**'], exclude: [], knownExceptions: ['src/legacy.js'], checks: [], residual: { kind: 'literal', pattern: 'value = 1', flags: 'g' } } });
  for (const correct of [false, true]) {
    const f = await fixture(value, { git: true, files: { 'src/legacy.js': 'export const value = 1;\n' }, handlers: { implement: async context => {
      await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), 'export const value = 2;\n');
      return report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '规则修改' }, batchResult: {
        changes: [{ path: 'src/value.js', summary: 'value改为2' }], exceptions: correct ? [{ path: 'src/legacy.js', reason: '计划登记的旧模块例外' }] : [] } });
    } } });
    try {
      const task = await f.create(); await f.confirm(task.id); const done = await f.done(task.id);
      if (correct) { assert.equal(done.state, 'awaiting_acceptance', done.reason || ''); assert.equal(done.batchResult?.exceptions.length, 1); }
      else { assert.equal(done.state, 'blocked'); assert.match(done.reason || '', /批量残留 1 与例外 0/); assert.equal(f.calls.some(call => call.run.team?.profileId === 'verifier'), false); }
      const implementation = f.calls.find(call => call.run.team?.profileId === 'batch')!.run;
      assert.deepEqual([implementation.provider, implementation.model, implementation.accessMode], ['cursor', 'composer-2.5', 'full']);
    } finally { await f.cleanup(); }
  }
});

test('Claude中途失败的越界改动不能被Codex重试的改动清单覆盖', async () => {
  let implementations = 0;
  const f = await fixture(plan('frontend'), { git: true, handlers: { implement: async context => {
    if (++implementations === 1) {
      await fs.writeFile(path.join(context.run.workspacePath, 'server/outside.js'), 'out of allowed scope\n');
      throw new Error('Claude Code 额度已用尽或触发速率限制，本轮未完成');
    }
    await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), 'export const value = 2;\n');
    return implemented();
  } } });
  try {
    const task = await f.create(); await f.confirm(task.id); const done = await f.done(task.id);
    assert.equal(done.state, 'blocked', '第一次Claude留下的越界文件必须继续阻止放行');
    assert.match(done.reason || '', /server\/outside\.js/);
    assert.equal(f.calls.some(call => call.run.team?.profileId === 'verifier'), false);
  } finally { await f.cleanup(); }
});

test('并行返工只修前端：重新集成与完整验证，工程审查文件未变则复用批准', async () => {
  const value = plan('complex_delivery_parallel', { allowedPaths: ['src/**', 'server/**'],
    ownership: [{ owner: 'engineer', paths: ['server/**'] }, { owner: 'frontend', paths: ['src/**'] }] });
  let frontendImplementations = 0, engineerReviews = 0, frontendReviews = 0;
  const f = await fixture(value, { git: true, handlers: {
    implement: async context => {
      const engineer = context.run.team!.profileId === 'engineer';
      if (!engineer) frontendImplementations += 1;
      await fs.writeFile(path.join(context.run.workspacePath, engineer ? 'server/value.js' : 'src/value.js'), `export const value = ${engineer ? 2 : frontendImplementations + 1};\n`);
      return implemented();
    },
    verify: async context => {
      assert.equal(await fs.readFile(path.join(context.run.workspacePath, 'server/value.js'), 'utf8'), 'export const value = 2;\n');
      return verified(['AC-1']);
    },
    review: async context => {
      if (context.run.provider === 'claude') { engineerReviews += 1; return reviewed(); }
      if (++frontendReviews === 1) {
        await new Promise(resolve => setTimeout(resolve, 20));
        return report({ taskResult: { role: 'reviewer', status: 'succeeded', verdict: 'changes_requested', findings: [
          { id: 'F-1', severity: 'major', file: 'src/value.js', line: 1, problem: '需要值3', expectation: '把值改为3' }] } });
      }
      return reviewed();
    },
  } });
  try {
    const task = await f.create(); await f.confirm(task.id); const done = await f.done(task.id);
    assert.equal(done.state, 'awaiting_acceptance', done.reason || '');
    assert.equal(done.round, 1);
    assert.equal(frontendImplementations, 2);
    assert.equal(f.calls.filter(call => call.run.team?.profileId === 'engineer').length, 1);
    assert.equal(engineerReviews, 1, '工程文件未变，不重复调用模型审查');
    assert.equal(frontendReviews, 2);
    assert.equal(done.nodes.filter(node => node.stage === 'verify').length, 2);
    assert.ok(done.candidate?.supersedes);
    const engineeringUnits = done.nodes.filter(node => node.stage === 'review' && node.reviewUnit?.authorProfileId === 'engineer');
    assert.equal(engineeringUnits.length, 2);
    assert.equal(engineeringUnits[1].status, 'completed');
    assert.match(engineeringUnits[1].reason || '', /沿用/);
  } finally { await f.cleanup(); }
});

test('同轮两个审查单元先后退回，只开启一轮返工并修到两个作者', async () => {
  const value = plan('complex_delivery_parallel', { allowedPaths: ['src/**', 'server/**'],
    ownership: [{ owner: 'engineer', paths: ['server/**'] }, { owner: 'frontend', paths: ['src/**'] }] });
  const implementationCount = { engineer: 0, frontend: 0 };
  const reviewCount = { engineer: 0, frontend: 0 };
  const f = await fixture(value, { git: true, handlers: {
    implement: async context => {
      const author = context.run.team!.profileId as 'engineer' | 'frontend';
      implementationCount[author] += 1;
      await fs.writeFile(path.join(context.run.workspacePath, author === 'engineer' ? 'server/value.js' : 'src/value.js'), `export const value = ${implementationCount[author] + 1};\n`);
      return implemented();
    },
    verify: async () => verified(['AC-1']),
    review: async context => {
      const author = context.run.provider === 'claude' ? 'engineer' : 'frontend';
      if (++reviewCount[author] > 1) return reviewed();
      if (author === 'frontend') await new Promise(resolve => setTimeout(resolve, 40));
      return report({ taskResult: { role: 'reviewer', status: 'succeeded', verdict: 'changes_requested', findings: [
        { id: `F-${author}`, severity: 'major', file: author === 'engineer' ? 'server/value.js' : 'src/value.js', line: 1,
          problem: '第一次实现值2需要改为3', expectation: '把对应文件值改为3' }] } });
    },
  } });
  try {
    const task = await f.create(); await f.confirm(task.id); const done = await f.done(task.id);
    assert.equal(done.state, 'awaiting_acceptance', done.reason || '');
    assert.equal(done.round, 1, '迟到的旧轮审查不应再消耗一个返工轮次');
    assert.deepEqual(implementationCount, { engineer: 2, frontend: 2 });
    assert.equal(await fs.readFile(path.join(done.workspacePath!, 'server/value.js'), 'utf8'), 'export const value = 3;\n');
    assert.equal(await fs.readFile(path.join(done.workspacePath!, 'src/value.js'), 'utf8'), 'export const value = 3;\n');
  } finally { await f.cleanup(); }
});

test('重启发现同stageKey多个原生Run时保持需要核对，不任选一条推进', async () => {
  const f = await fixture(plan());
  let reopenedRuntime: Awaited<ReturnType<typeof createAgentRuntimeService>> | undefined;
  let reopenedTeam: Awaited<ReturnType<typeof createAgentTeamService>> | undefined;
  try {
    const task = await f.create();
    await f.team.close(); await f.runtime.close();
    const runsPath = path.join(f.data, 'agent-runs.json');
    const runs = JSON.parse(await fs.readFile(runsPath, 'utf8')) as AgentRun[];
    const leader = runs.find(run => run.team?.taskId === task.id)!;
    runs.push({ ...leader, id: '00000000-0000-4000-8000-000000000099' });
    await fs.writeFile(runsPath, JSON.stringify(runs));
    const tasksPath = path.join(f.data, 'team-tasks.json');
    const saved = JSON.parse(await fs.readFile(tasksPath, 'utf8'));
    const record = saved.tasks.find((item: { id: string }) => item.id === task.id);
    record.state = 'planning'; record.plan = undefined; record.planRevision = 0; record.planHistory = [];
    record.nodes[0].status = 'running'; record.nodes[0].receiptRunId = undefined;
    await fs.writeFile(tasksPath, JSON.stringify(saved));
    const ledgerPath = path.join(f.data, 'collaboration-state.json');
    const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
    const intent = ledger.intents.find((item: { workflowId: string }) => item.workflowId === task.id);
    intent.state = 'intended'; intent.runId = undefined; intent.settled = false;
    ledger.budgets[task.id] = { reservedRuns: 1, usedRuns: 0, limit: 10 };
    await fs.writeFile(ledgerPath, JSON.stringify(ledger));
    const count = f.calls.length;
    reopenedRuntime = await createAgentRuntimeService(f.data, { adapters: f.adapters });
    reopenedTeam = await createAgentTeamService(f.data, reopenedRuntime);
    assert.equal(reopenedTeam.getTask(task.id).state, 'needs_reconciliation');
    assert.equal(reopenedTeam.getTask(task.id).nodes[0].status, 'needs_reconciliation');
    assert.equal(f.calls.length, count);
  } finally { await reopenedTeam?.close(); await reopenedRuntime?.close(); await f.cleanup(); }
});

test('调研方案审查绑定方案产物哈希，不派发业务代码验证', async () => {
  const f = await fixture(plan('research_design', { needsArchitect: true }), { handlers: { verify: async () => {
    assert.fail('调研方案只审查文档产物，不应派发代码验证');
  } } });
  try {
    const task = await f.create(); await f.confirm(task.id); const done = await f.done(task.id);
    assert.equal(done.state, 'awaiting_acceptance', done.reason || '');
    assert.equal(f.calls.some(call => call.run.team?.profileId === 'verifier'), false);
    const design = done.nodes.find(node => node.stage === 'architect')!;
    const review = done.nodes.find(node => node.stage === 'review')!;
    assert.equal(review.snapshot?.kind, 'changed-files');
    assert.equal(review.snapshot?.value, design.artifactHash);
    assert.deepEqual(f.calls.filter(call => call.run.team).map(call => call.run.team?.profileId), ['leader', 'analyst', 'architect', 'reviewer']);
    assert.ok(f.calls.filter(call => call.run.team).every(call => call.run.mode === 'agent' && call.run.accessMode === 'full'));
  } finally { await f.cleanup(); }
});

test('只读验证计划跳过实现节点，直接执行验证与独立审查', async () => {
  const value = plan('verification', { allowedPaths: [], ownership: [], shared: [], acceptanceCriteria: [
    { id: 'AC-VERIFY', text: '复测目标并保存真实证据', source: '用户复测要求', stage: 'verify' },
    { id: 'AC-REVIEW', text: '独立核对复测证据', source: '流程要求', stage: 'review' },
  ] });
  const f = await fixture(value, { handlers: {
    verify: async () => verified(['AC-VERIFY']),
    review: async () => report({ taskResult: { role: 'reviewer', status: 'succeeded', verdict: 'approved',
      acceptance: [{ id: 'AC-REVIEW', status: 'passed', evidence: '已独立核对复测证据' }], findings: [] } }),
  } });
  try {
    const task = await f.create(); await f.confirm(task.id); const done = await f.done(task.id);
    assert.equal(done.state, 'awaiting_acceptance', done.reason || '');
    assert.equal(done.nodes.some(node => node.stage === 'implement'), false);
    assert.deepEqual(f.calls.filter(call => call.run.team).map(call => call.run.team?.profileId), ['leader', 'verifier', 'reviewer']);
  } finally { await f.cleanup(); }
});

test('只读验证失败保留业务阻塞，不返工或自动审查，明确重试后才继续', async () => {
  let attempts = 0;
  const f = await fixture(plan('verification', { allowedPaths: [] }), { handlers: {
    verify: async () => ++attempts === 1 ? verificationFailed() : verified(['AC-1']),
  } });
  try {
    const task = await f.create(); await f.confirm(task.id); const blocked = await f.done(task.id);
    assert.equal(blocked.state, 'needs_decision'); assert.equal(blocked.round, 0);
    assert.match(blocked.reason || '', /缺少专用测试数据及确认的测试通道/);
    const verification = blocked.nodes.find(node => node.stage === 'verify')!;
    assert.equal(verification.status, 'blocked'); assert.equal(verification.result, verificationFailed());
    assert.equal(blocked.nodes.some(node => node.stage === 'implement'), false);
    await waitFor(() => f.team.isIdle(), Boolean, '只读失败静止');
    assert.deepEqual(f.calls.filter(call => call.run.team).map(call => call.run.team!.profileId), ['leader', 'verifier']);
    await f.team.decide(task.id, { action: 'retry', nodeId: verification.id, requestId: 'dependencies-ready' });
    const done = await f.done(task.id);
    assert.equal(done.state, 'awaiting_acceptance', done.reason); assert.equal(attempts, 2);
    assert.equal(done.nodes.filter(node => node.stage === 'verify').length, 1);
    assert.equal(f.calls.filter(call => call.run.team?.profileId === 'reviewer').length, 1);
  } finally { await f.cleanup(); }
});

test('工程计划迁移只读复测后，真实失败不复活历史作者且重复迁移幂等', async () => {
  const f = await fixture(plan('engineering', { reason: '只读复测，不实施代码修复', allowedPaths: [] }), { handlers: {
    implement: async () => report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '只读证据核对完成，无代码改动',
      acceptance: [{ id: 'AC-1', status: 'failed', evidence: '已知接口失败尚未修复' }], blockers: ['等待测试条件'] } }),
    verify: async () => verificationFailed(),
  } });
  try {
    const started = await f.team.chat({ objective: '只读复测现有结果，不实施代码修复', attachmentIds: [], requestId: 'read-only-retest', workspacePath: f.source });
    const blocked = await waitFor(() => f.team.getTask(started.task.id), item => item.state === 'needs_decision', '迁移后真实失败');
    assert.equal(blocked.plan!.templateId, 'verification'); assert.equal(blocked.round, 0);
    assert.equal(blocked.nodes.filter(node => node.stage === 'implement').length, 1);
    assert.equal(blocked.nodes.filter(node => node.stage === 'verify').length, 1);
    const author = blocked.nodes.find(node => node.stage === 'implement')!;
    assert.equal(author.status, 'skipped'); assert.equal(blocked.nodes.find(node => node.stage === 'verify')?.status, 'blocked');
    const revision = blocked.planRevision, historyCount = blocked.planHistory?.length, calls = f.calls.length;
    for (const requestId of ['repeat-migration-1', 'repeat-migration-2']) {
      await f.team.decide(blocked.id, { action: 'retry', nodeId: author.id, requestId });
    }
    const unchanged = f.team.getTask(blocked.id);
    assert.equal(unchanged.planRevision, revision); assert.equal(unchanged.planHistory?.length, historyCount);
    assert.equal(unchanged.plan!.reason.split('已自动切换为验证流程').length - 1, 1);
    assert.equal(unchanged.state, 'needs_decision'); assert.equal(unchanged.nodes.length, blocked.nodes.length);
    assert.equal(f.calls.length, calls); assert.equal(f.calls.some(call => call.run.team?.profileId === 'reviewer'), false);
    assert.equal(await fs.readFile(path.join(f.source, 'src/value.js'), 'utf8'), 'export const value = 1;\n');
  } finally { await f.cleanup(); }
});

test('只读验证的审查退回保留失败，不新增实现和验证', async () => {
  let reviews = 0;
  const f = await fixture(plan('verification'), { handlers: {
    verify: async () => verified(['AC-1']),
    review: async () => ++reviews === 1 ? report({ taskResult: { role: 'reviewer', status: 'failed', verdict: 'changes_requested',
      summary: '证据覆盖不完整，需补充接口原始响应', findings: [] } }) : reviewed(),
  } });
  try {
    const task = await f.create(); await f.confirm(task.id); const blocked = await f.done(task.id);
    assert.equal(blocked.state, 'needs_decision'); assert.equal(blocked.round, 0);
    const review = blocked.nodes.find(node => node.stage === 'review')!;
    assert.equal(review.status, 'blocked'); assert.match(blocked.reason || '', /证据覆盖不完整/);
    assert.equal(blocked.nodes.some(node => node.stage === 'implement'), false);
    assert.equal(blocked.nodes.filter(node => node.stage === 'verify').length, 1);
    await f.team.decide(task.id, { action: 'retry', nodeId: review.id, requestId: 'review-evidence-updated' });
    assert.equal((await f.done(task.id)).state, 'awaiting_acceptance');
    assert.equal(f.calls.filter(call => call.run.team?.profileId === 'verifier').length, 1); assert.equal(reviews, 2);
  } finally { await f.cleanup(); }
});

test('正常工程验证失败仍交原作者返工，再验证与审查', async () => {
  let attempts = 0;
  const f = await fixture(plan(), { handlers: { verify: async () => ++attempts === 1 ? verificationFailed() : verified(['AC-1']) } });
  try {
    const task = await f.create(); await f.confirm(task.id); const done = await f.done(task.id);
    assert.equal(done.state, 'awaiting_acceptance', done.reason); assert.equal(done.round, 1);
    assert.deepEqual(f.calls.filter(call => call.run.team).map(call => call.run.team!.profileId), ['leader', 'engineer', 'verifier', 'engineer', 'verifier', 'reviewer']);
  } finally { await f.cleanup(); }
});

test('返工来源在后续提问回答覆盖节点原因后仍原样持久化', async () => {
  let writes = 0, checks = 0;
  const f = await fixture(plan(), { handlers: {
    verify: async () => ++checks === 1 ? verificationFailed() : verified(['AC-1']),
    implement: async context => {
      if (++writes === 2) return report({ questions: [{ to: 'user', text: '确认原始字段？', blocking: true }] });
      await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), 'export const value = 2;\n'); return implemented();
    },
  } });
  try {
    const task = await f.create(); await f.confirm(task.id);
    const waiting = await waitFor(() => f.team.getTask(task.id), value => value.round === 1 && value.state === 'waiting_input', '返工问题');
    const rework = waiting.nodes.find(node => node.stage === 'implement' && node.round === 1)!;
    const original = rework.reworkReason;
    assert.ok(original); assert.equal(original, rework.reason); assert.match(JSON.parse(original).reason, /AC-1/);
    assert.equal(waiting.nodes.find(node => node.stage === 'implement' && node.round === 0)?.reworkReason, undefined);
    const question = (await f.team.room(task.id)).messages.find(message => message.type === 'ask' && message.to.kind === 'user')!;
    await f.team.answer(task.id, { correlationId: question.id, text: '使用原字段L003', requestId: 'answer-rework' });
    const done = await f.done(task.id), retained = done.nodes.find(node => node.id === rework.id)!;
    assert.equal(done.state, 'awaiting_acceptance'); assert.equal(retained.reworkReason, original);
    assert.equal(retained.reason, '问题已回答，按原文继续');
    const saved = JSON.parse(await fs.readFile(path.join(f.data, 'team-tasks.json'), 'utf8'));
    assert.equal(saved.tasks[0].nodes.find((node: { id: string }) => node.id === rework.id).reworkReason, original);
  } finally { await f.cleanup(); }
});

test('非聊天任务附加门禁失败保留blocked与原结果，不创建返工节点', async () => {
  const result = report({ validationEvidence: { ...emptyDeliveryEvidence(), tests: { status: 'failed', evidence: '附加脚本退出码1', sha: '' } },
    taskResult: { role: 'verifier', status: 'failed', summary: '原范围通过，附加门禁失败', acceptance: [
      { id: 'AC-1', status: 'passed', evidence: '原目标已核验' }, { id: 'EXTRA-1', status: 'failed', evidence: '附加失败原文L005' },
    ] } });
  const f = await fixture(plan(), { handlers: { verify: async () => result } });
  try {
    const task = await f.create(); await f.confirm(task.id); const blocked = await f.done(task.id);
    assert.equal(blocked.state, 'blocked'); assert.equal(blocked.round, 0);
    assert.equal(blocked.nodes.find(node => node.stage === 'verify')?.result, result);
    assert.equal(blocked.nodes.filter(node => node.stage === 'implement').length, 1);
    assert.deepEqual(f.calls.filter(call => call.run.team).map(call => call.run.team!.profileId), ['leader', 'engineer', 'verifier']);
  } finally { await f.cleanup(); }
});

test('新一轮不会派发遗留待执行验证和审查，也不会持续调度空转', async () => {
  const f = await fixture(plan()); let reopened: Awaited<ReturnType<typeof createAgentTeamService>> | undefined;
  try {
    const task = await f.create(); await f.confirm(task.id); await f.done(task.id); await f.team.close();
    const file = path.join(f.data, 'team-tasks.json'), state = JSON.parse(await fs.readFile(file, 'utf8'));
    const saved = state.tasks.find((item: { id: string }) => item.id === task.id);
    saved.round += 1; saved.state = 'running'; saved.reason = '新一轮正在处理';
    const staleIds = saved.nodes.filter((node: { stage: string }) => ['verify', 'review'].includes(node.stage)).map((node: Record<string, unknown>) => {
      node.status = 'pending'; delete node.runId; delete node.receiptRunId; delete node.intentId; return node.id;
    });
    await fs.writeFile(file, JSON.stringify(state)); const calls = f.calls.length;
    reopened = await createAgentTeamService(f.data, f.runtime);
    await waitFor(() => reopened!.isIdle(), Boolean, '旧节点无需继续调度');
    assert.equal(f.calls.length, calls);
    assert.ok(reopened.getTask(task.id).nodes.filter(node => staleIds.includes(node.id)).every(node => node.status === 'skipped'));
    assert.equal(reopened.getTask(task.id).state, 'running');
  } finally { await reopened?.close(); await f.cleanup(); }
});

test('旧轮审查迟到额度失败仅归档，不覆盖当前状态或另派备用模型', async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(plan(), { handlers: { review: async () => { await held; throw new Error('额度已用尽或触发速率限制'); } } });
  let reopened: Awaited<ReturnType<typeof createAgentTeamService>> | undefined;
  try {
    const task = await f.create(); await f.confirm(task.id);
    const reviewing = await waitFor(() => f.team.getTask(task.id), item => item.nodes.some(node => node.stage === 'review' && node.status === 'running'), '审查执行中');
    const review = reviewing.nodes.find(node => node.stage === 'review')!;
    await waitFor(() => f.calls, calls => calls.some(call => call.run.id === review.runId), '审查岗位实际开始');
    await f.team.close();
    const file = path.join(f.data, 'team-tasks.json'), state = JSON.parse(await fs.readFile(file, 'utf8'));
    const saved = state.tasks.find((item: { id: string }) => item.id === task.id);
    saved.round += 1; saved.state = 'running'; saved.reason = '当前轮正在处理';
    await fs.writeFile(file, JSON.stringify(state));
    reopened = await createAgentTeamService(f.data, f.runtime); const calls = f.calls.length;
    release();
    const after = await waitFor(() => reopened!.getTask(task.id), item => item.nodes.find(node => node.id === review.id)?.status === 'skipped', '旧轮失败归档');
    assert.equal(after.state, 'running'); assert.equal(after.reason, '当前轮正在处理');
    assert.equal(f.calls.length, calls); assert.equal(after.nodes.find(node => node.id === review.id)?.attempt, review.attempt);
    const archived = after.artifacts!.find(item => item.nodeId === review.id && item.kind === 'superseded')!;
    assert.match(await fs.readFile(archived.path, 'utf8'), /额度已用尽或触发速率限制/);
  } finally { release(); await reopened?.close(); await f.cleanup(); }
});

test('旧轮验证的中断和重启恢复通知不改当前任务，原运行结束前保留租约', async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(plan(), { handlers: { verify: async () => { await held; return verified(['AC-1']); } } });
  let reopened: Awaited<ReturnType<typeof createAgentTeamService>> | undefined;
  try {
    const task = await f.create(); await f.confirm(task.id);
    const verifying = await waitFor(() => f.team.getTask(task.id), item => item.nodes.some(node => node.stage === 'verify' && node.status === 'running'), '验证执行中');
    const verification = verifying.nodes.find(node => node.stage === 'verify')!;
    const run = f.runtime.getRun(verification.runId!)!;
    await waitFor(() => f.calls, calls => calls.some(call => call.run.id === run.id), '验证岗位实际开始');
    await f.team.close();
    const file = path.join(f.data, 'team-tasks.json'), state = JSON.parse(await fs.readFile(file, 'utf8'));
    const saved = state.tasks.find((item: { id: string }) => item.id === task.id);
    saved.round += 1; saved.state = 'blocked'; saved.reason = '当前轮等待自己的外部条件';
    await fs.writeFile(file, JSON.stringify(state));
    let notify!: Parameters<typeof f.runtime.subscribe>[0]; const subscribe = f.runtime.subscribe;
    f.runtime.subscribe = listener => { notify = listener; return subscribe(listener); };
    reopened = await createAgentTeamService(f.data, f.runtime); const calls = f.calls.length;
    const emit = async () => {
      const revision = reopened!.revision(); notify(0, run, true);
      await waitFor(() => reopened!.revision(), current => current > revision, '旧轮通知已保存');
      await waitFor(() => reopened!.isIdle(), Boolean, '旧轮通知处理结束');
      const current = reopened!.getTask(task.id);
      assert.equal(current.state, 'blocked'); assert.equal(current.reason, '当前轮等待自己的外部条件');
      assert.equal(current.nodes.find(node => node.id === verification.id)?.runId, run.id);
      assert.equal(f.runtime.isRunActive(run.id), true, '模拟原生执行尚未结束');
      assert.equal(reopened!.ledger.snapshot().leases.find(lease => lease.ownerRunId === run.id)?.state, 'active');
      assert.equal(f.calls.length, calls, '不重试、重派或切换执行器');
      return current.nodes.find(node => node.id === verification.id)!;
    };
    run.status = 'interrupted';
    assert.equal((await emit()).status, 'needs_reconciliation');
    run.recovery = { previousStatus: 'running', previousPid: null, state: 'active', checkedAt: new Date().toISOString(),
      nativeObservation: 'codex-desktop', message: '旧轮桌面执行仍在运行' };
    assert.equal((await emit()).status, 'running');
    run.status = 'cancelled'; run.pausedForEdit = true; run.resumeAfterWorkspaceRestart = true;
    assert.match((await emit()).reason || '', /工作台正在重启/);
    run.status = 'running'; run.pausedForEdit = false; run.resumeAfterWorkspaceRestart = undefined;
    run.workspaceRestartResumedAt = new Date().toISOString();
    assert.match((await emit()).reason || '', /重启完成/);
    run.status = 'interrupted'; run.recovery.state = 'needs-review';
    assert.equal((await emit()).status, 'needs_reconciliation');
    release();
    const after = await waitFor(() => reopened!.getTask(task.id), item => item.nodes.find(node => node.id === verification.id)?.status === 'skipped', '旧轮确认结束后归档');
    assert.equal(after.state, 'blocked'); assert.equal(after.reason, '当前轮等待自己的外部条件');
    assert.equal(reopened.ledger.snapshot().leases.find(lease => lease.ownerRunId === run.id)?.state, 'released');
    assert.equal(f.calls.length, calls);
  } finally { release(); await reopened?.close(); await f.cleanup(); }
});

test('旧轮终态归档失败只记录旧节点错误，不覆盖当前任务', async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(plan(), { handlers: { review: async () => { await held; return reviewed(); } } });
  let reopened: Awaited<ReturnType<typeof createAgentTeamService>> | undefined;
  try {
    const task = await f.create(); await f.confirm(task.id);
    const reviewing = await waitFor(() => f.team.getTask(task.id), item => item.nodes.some(node => node.stage === 'review' && node.status === 'running'), '审查执行中');
    const review = reviewing.nodes.find(node => node.stage === 'review')!;
    await waitFor(() => f.calls, calls => calls.some(call => call.run.id === review.runId), '审查岗位实际开始');
    await f.team.close();
    const file = path.join(f.data, 'team-tasks.json'), state = JSON.parse(await fs.readFile(file, 'utf8'));
    const saved = state.tasks.find((item: { id: string }) => item.id === task.id);
    saved.round += 1; saved.state = 'running'; saved.reason = '当前轮按原计划推进';
    await fs.writeFile(file, JSON.stringify(state));
    reopened = await createAgentTeamService(f.data, f.runtime); const calls = f.calls.length;
    // 仅破坏临时夹具的产物目录，模拟宿主无法归档旧轮结果。
    const artifacts = path.join(f.data, 'team-artifacts', task.id);
    await fs.rm(artifacts, { recursive: true }); await fs.writeFile(artifacts, 'not a directory');
    release();
    const after = await waitFor(() => reopened!.getTask(task.id), item => item.nodes.find(node => node.id === review.id)?.status === 'blocked', '记录旧轮归档错误');
    assert.match(after.nodes.find(node => node.id === review.id)?.error || '', /EEXIST|ENOTDIR/);
    assert.equal(after.state, 'running'); assert.equal(after.reason, '当前轮按原计划推进'); assert.equal(f.calls.length, calls);
  } finally { release(); await reopened?.close(); await f.cleanup(); }
});

test('旧结果中审查通过不能覆盖未通过的业务验证', async () => {
  const f = await fixture(plan('verification'), { handlers: { verify: async () => verified(['AC-1']) } });
  let reopened: Awaited<ReturnType<typeof createAgentTeamService>> | undefined;
  try {
    const task = await f.create(); await f.confirm(task.id); await f.done(task.id); await f.team.close();
    const file = path.join(f.data, 'team-tasks.json'), state = JSON.parse(await fs.readFile(file, 'utf8'));
    const saved = state.tasks.find((item: { id: string }) => item.id === task.id);
    saved.state = 'running'; saved.nodes.find((node: { stage: string }) => node.stage === 'verify').result = verificationFailed();
    await fs.writeFile(file, JSON.stringify(state)); const calls = f.calls.length;
    reopened = await createAgentTeamService(f.data, f.runtime);
    assert.ok(!['completed', 'awaiting_acceptance', 'accepted'].includes(reopened.getTask(task.id).state));
    assert.equal(f.calls.length, calls);
  } finally { await reopened?.close(); await f.cleanup(); }
});

test('审查期间候选代码变化后重新验证并重新审查，不被旧skipped审查卡住', async () => {
  let reviews = 0;
  const f = await fixture(plan(), { git: true, handlers: {
    verify: async () => verified(['AC-1']),
    review: async context => {
      if (++reviews <= 4) await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), `export const value = ${reviews + 2};\n`);
      return reviewed();
    },
  } });
  try {
    const task = await f.create(); await f.confirm(task.id);
    for (let count = 0; count < 500 && !['awaiting_acceptance', 'blocked', 'needs_decision'].includes(f.team.getTask(task.id).state); count += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const done = f.team.getTask(task.id);
    assert.equal(done.state, 'awaiting_acceptance', JSON.stringify({ state: done.state, reason: done.reason, nodes: done.nodes.map(node => [node.stage, node.status]) }));
    assert.equal(done.round, 0);
    assert.equal(done.nodes.filter(node => node.stage === 'verify').length, 5);
    assert.equal(reviews, 5);
    assert.equal(done.reverifyCount, 4);
    const verification = done.nodes.filter(node => node.stage === 'verify').at(-1)!;
    const currentReview = done.nodes.filter(node => node.stage === 'review').at(-1)!;
    assert.equal(verification.snapshot?.value, currentReview.snapshot?.value);
  } finally { await f.cleanup(); }
});

test('验证岗位修改测试或源码不能用通过报告放行', async () => {
  const f = await fixture(plan(), { git: true, handlers: { verify: async context => {
    await fs.writeFile(path.join(context.run.workspacePath, 'src/value.js'), 'export const value = 99;\n');
    return verified(['AC-1']);
  } } });
  try {
    const created = await f.create(); await f.confirm(created.id); const done = await f.done(created.id);
    assert.equal(done.state, 'blocked'); assert.match(done.reason || '', /验证岗位修改了源码或测试/);
    assert.equal(f.calls.some(call => call.run.team?.profileId === 'reviewer'), false);
  } finally { await f.cleanup(); }
});

test('取消运行节点后等待原生退出再释放租约，后续同目录不会被永久阻塞', async () => {
  const f = await fixture(plan(), { handlers: { implement: async context => {
    await new Promise<void>((_resolve, reject) => {
      const stop = () => reject(new Error('cancelled fixture'));
      if (context.signal.aborted) stop(); else context.signal.addEventListener('abort', stop, { once: true });
    });
    return implemented();
  } } });
  try {
    const created = await f.create(); await f.confirm(created.id);
    await waitFor(() => f.calls, calls => calls.some(call => call.run.team?.profileId === 'engineer'), '实现运行');
    await f.team.decide(created.id, { action: 'cancel', requestId: 'cancel-active' });
    await waitFor(() => f.team.ledger.snapshot().leases, leases => leases.every(lease => lease.state === 'released'), '进程退出后租约释放');
    assert.equal(f.team.getTask(created.id).state, 'cancelled');
    assert.equal(f.team.ledger.snapshot().budgets[created.id].reservedRuns, 0);
  } finally { await f.cleanup(); }
});
