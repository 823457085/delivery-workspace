import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import { emptyDeliveryEvidence } from '../shared/delivery-acceptance.js';
import { teamDeliveryEvidence } from '../shared/agent-workflow-evidence.js';
import type { AgentProvider, AgentRun, AgentRuntimeHealth, AgentUsageLimits, AgentWorkflowState } from '../shared/agent-runtime.js';

const exec = promisify(execFile);
const report = (value: unknown) => `完成\n\n\`\`\`delivery-report\n${JSON.stringify(value)}\n\`\`\`\n`;
const implemented = () => report({ version: 1, taskResult: { role: 'implementer', status: 'succeeded', summary: '已实现' } });
const verified = (ids: string[]) => report({ version: 1,
  validationEvidence: { ...emptyDeliveryEvidence(), tests: { status: 'passed', evidence: 'npm test 退出码 0', sha: '' } },
  taskResult: { role: 'verifier', status: 'succeeded', acceptance: ids.map(id => ({ id, status: 'passed', evidence: '实测通过' })) } });
const reviewed = (verdict: 'approved' | 'changes_requested') => report({ version: 1, taskResult: { role: 'reviewer', status: 'succeeded', verdict,
  findings: verdict === 'approved' ? [] : [{ id: 'F-1', severity: 'major', file: 'server/api.ts', line: 1, problem: '缺少边界处理', expectation: '补充空值处理' }] } });

const efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
function health(provider: AgentProvider, ready = true): AgentRuntimeHealth {
  const models = provider === 'codex'
    ? ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.6-sol'].map(id => ({ id, label: id, efforts: [...efforts], defaultEffort: 'high' as const }))
    : [{ id: 'sonnet', label: 'Sonnet 5.5', efforts: ['low', 'medium', 'high'] as ('low' | 'medium' | 'high')[] },
      { id: 'opus', label: 'Opus 5.5', efforts: ['low', 'medium', 'high'] as ('low' | 'medium' | 'high')[] }];
  return { provider, label: provider, binary: `/test/${provider}`, version: 'test', authenticated: ready, ready, message: ready ? 'ready' : '尚未登录',
    modes: ['agent', 'plan', 'ask'], models, defaultModel: '', writable: true, checkedAt: new Date().toISOString() };
}

type Handler = (run: AgentRun, context: Parameters<AgentRuntimeAdapter['execute']>[0]) => Promise<string> | string;
function harness(handlers: { main?: Handler; implement: Handler; verify: Handler; review: Handler },
  options: { claudeReady?: boolean; claudeUsage?: AgentUsageLimits; claudeQuotaFailures?: number } = {}) {
  const calls: { run: AgentRun; resumeSessionId: string; prompt: string }[] = [];
  let quotaFailures = options.claudeQuotaFailures || 0;
  const adapter = (provider: AgentProvider): AgentRuntimeAdapter => ({ id: provider, health: async () => health(provider, provider !== 'claude' || options.claudeReady !== false),
    execute: async context => {
      if (provider === 'claude' && quotaFailures > 0) {
        quotaFailures -= 1;
        calls.push({ run: structuredClone(context.run), resumeSessionId: context.resumeSessionId || '', prompt: context.run.workflowContext || '' });
        throw new Error('Claude Code 额度已用尽或触发速率限制，本轮未完成');
      }
      await context.onSession(`${provider}-session-${context.run.id.slice(0, 8)}`);
      calls.push({ run: structuredClone(context.run), resumeSessionId: context.resumeSessionId || '', prompt: context.run.workflowContext || '' });
      const stage = context.run.task?.workflow?.stage;
      return (stage ? handlers[stage] : handlers.main || (() => '主会话完成'))(context.run, context);
    } });
  return { calls, adapters: [adapter('codex'), adapter('claude')] };
}

async function waitFor<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, label: string) {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`等待超时：${label}`);
}

async function gitRepository(root: string) {
  const repository = path.join(root, 'repo');
  await fs.mkdir(path.join(repository, 'server'), { recursive: true });
  await exec('git', ['-C', repository, 'init', '-q', '-b', 'main']);
  await fs.writeFile(path.join(repository, 'server', 'api.ts'), 'export const api = 1;\n');
  await exec('git', ['-C', repository, 'add', '.']);
  await exec('git', ['-C', repository, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base']);
  return fs.realpath(repository);
}

const stateOf = (service: Awaited<ReturnType<typeof createAgentRuntimeService>>, id: string) => service.workflows().find(item => item.id === id)!;
const waitState = (service: Awaited<ReturnType<typeof createAgentRuntimeService>>, id: string, state: AgentWorkflowState) =>
  waitFor(() => stateOf(service, id), summary => summary?.state === state, `流程进入 ${state}`).catch(error => {
    assert.fail(`${error.message} ${JSON.stringify(service.workflows())}`);
  });

test('工程流程：Codex 实现、Codex 在副本中验证、Claude Opus 审查；退回后续接原会话返工，版本一致才待验收', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-flow-'));
  const directory = path.join(root, 'data');
  let reviews = 0;
  const { calls, adapters } = harness({
    implement: async run => {
      await fs.writeFile(path.join(run.workspacePath, 'server', 'api.ts'), `export const api = ${run.task!.workflow!.round + 2};\n`);
      return implemented();
    },
    verify: async run => {
      assert.ok(run.workspacePath.startsWith(await fs.realpath(path.join(directory, 'verify'))), '验证必须在一次性副本中运行');
      assert.match(await fs.readFile(path.join(run.workspacePath, 'server', 'api.ts'), 'utf8'), /api = \d/);
      await fs.writeFile(path.join(run.workspacePath, 'cache.tmp'), '测试缓存');
      await fs.mkdir(path.join(run.workspacePath, '.delivery-artifacts'), { recursive: true });
      await fs.writeFile(path.join(run.workspacePath, '.delivery-artifacts', 'test.log'), 'ok');
      return verified(['AC-1']);
    },
    review: () => (reviews += 1) === 1 ? reviewed('changes_requested') : reviewed('approved'),
  });
  const repository = await gitRepository(root);
  const service = await createAgentRuntimeService(directory, { adapters });
  try {
    const main = await service.start({ provider: 'codex', mode: 'agent', accessMode: 'full', model: 'gpt-5.6-sol', reasoningEffort: 'ultra',
      objective: '主任务', workspacePath: repository });
    await waitFor(() => service.dashboard(), dashboard => dashboard.runs.find(run => run.id === main.id)?.status === 'completed', '主会话完成');
    const { workflowId, firstRun } = await service.startTeamWorkflow(main.id, { templateId: 'engineering', objective: '修复接口',
      acceptanceCriteria: ['接口返回新值'], allowedPaths: ['server/**'], attachmentIds: [] });
    assert.deepEqual([firstRun.provider, firstRun.model, firstRun.reasoningEffort, firstRun.accessMode, firstRun.mode],
      ['codex', 'gpt-6.1-sol', 'high', 'full', 'agent']);
    assert.notEqual(firstRun.workspacePath, repository, 'Git 项目的实现在隔离 worktree 中进行');
    assert.match(firstRun.branch, /^feature\//, '团队实现分支遵循 feature/ 约定');
    const done = await waitState(service, workflowId, 'awaiting_acceptance');
    assert.deepEqual(done.steps.map(step => `${step.stage}:${step.round}:${step.outcome}`),
      ['implement:0:passed', 'verify:0:passed', 'review:0:failed', 'implement:1:passed', 'verify:1:passed', 'review:1:passed']);
    const reviewer = calls.find(call => call.run.task?.workflow?.stage === 'review')!.run;
    assert.deepEqual([reviewer.provider, reviewer.model, reviewer.reasoningEffort, reviewer.mode, reviewer.accessMode], ['claude', 'claude-opus-5-5', 'high', 'agent', 'full']);
    const verifier = calls.find(call => call.run.task?.workflow?.stage === 'verify')!.run;
    assert.deepEqual([verifier.provider, verifier.model, verifier.reasoningEffort], ['codex', 'gpt-6.1-sol', 'medium']);
    const rework = calls.filter(call => call.run.task?.workflow?.stage === 'implement')[1];
    assert.equal(rework.run.parentRunId, firstRun.id, '返工续接原实现会话');
    assert.equal(rework.resumeSessionId, `codex-session-${firstRun.id.slice(0, 8)}`);
    assert.match(rework.prompt, /F-1/);
    assert.match(rework.prompt, /缺少边界处理/);
    const reviewPrompt = calls.find(call => call.run.task?.workflow?.stage === 'review')!.prompt;
    assert.match(reviewPrompt, /Agent 完全访问/);
    assert.match(reviewPrompt, /文件、命令和网络工具/);
    assert.match(reviewPrompt, /若审查过程中修改了候选代码或测试/);
    assert.match(reviewPrompt, /完成重新验证和独立审查前不得批准/);
    assert.doesNotMatch(reviewPrompt, /只读，不修改任何文件/);
    const materials = reviewPrompt.match(/审查材料目录：(\S+?)（/)![1];
    assert.match(await fs.readFile(path.join(materials, 'diff.patch'), 'utf8'), /server\/api\.ts/);
    // 验证副本已删除，缓存没有进入实现工作区，产物已保存。
    assert.deepEqual(await fs.readdir(path.join(directory, 'verify')), []);
    await assert.rejects(fs.access(path.join(firstRun.workspacePath, 'cache.tmp')));
    const verifySteps = done.steps.filter(step => step.stage === 'verify').map(step => step.step);
    assert.equal(await fs.readFile(path.join(directory, 'workflow-artifacts', workflowId, `step-${verifySteps[0]}`, 'verify', 'test.log'), 'utf8'), 'ok');
    assert.equal(done.implementationConversationId, firstRun.id);
    assert.ok(done.snapshot?.value);
    const dashboard = await service.dashboard();
    assert.equal(dashboard.workflows?.find(item => item.id === workflowId)?.state, 'awaiting_acceptance');
    assert.equal(dashboard.runs.find(run => run.task?.workflow?.stage === 'verify')?.changedFiles?.length, 0, '副本内的缓存不算交付改动');
  } finally { await service.close(); await fs.rm(root, { recursive: true, force: true }); }
});

async function plainService(handlers: Parameters<typeof harness>[0], options: Parameters<typeof harness>[1] = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-plain-'));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(path.join(workspace, 'server'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'server', 'api.ts'), 'export const api = 1;\n');
  const directory = path.join(root, 'data');
  const { calls, adapters } = harness(handlers, options);
  const service = await createAgentRuntimeService(directory, { adapters,
    ...(options.claudeUsage ? { readProviderUsage: { claude: async () => options.claudeUsage! } } : {}) });
  const main = await service.start({ provider: 'codex', mode: 'agent', model: 'gpt-6.1-sol', objective: '主任务', workspacePath: workspace });
  await waitFor(() => service.dashboard(), dashboard => dashboard.runs.find(run => run.id === main.id)?.status === 'completed', '主会话完成');
  return { root, workspace: await fs.realpath(workspace), directory, calls, adapters, service, main,
    cleanup: async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); } };
}
const writeApi = (value: string) => async (run: AgentRun) => {
  await fs.writeFile(path.join(run.workspacePath, 'server', 'api.ts'), `export const api = ${value};\n`);
  return implemented();
};

test('前端流程：Claude Sonnet 实现由 Codex Astra 审查', async () => {
  const ready = await plainService({ implement: writeApi('3'), verify: () => verified([]), review: () => reviewed('approved') });
  try {
    const { workflowId, firstRun } = await ready.service.startTeamWorkflow(ready.main.id, { templateId: 'frontend', objective: '页面', attachmentIds: [],
      acceptanceCriteria: [], allowedPaths: [] });
    assert.deepEqual([firstRun.provider, firstRun.model, firstRun.reasoningEffort], ['claude', 'claude-sonnet-5-5', 'high']);
    const done = await waitState(ready.service, workflowId, 'awaiting_acceptance');
    assert.equal(done.providerFallback, undefined);
    const reviewer = ready.calls.find(call => call.run.task?.workflow?.stage === 'review')!.run;
    assert.deepEqual([reviewer.provider, reviewer.model, reviewer.mode, reviewer.accessMode], ['codex', 'gpt-6-astra', 'agent', 'full']);
    assert.match(ready.calls[1].prompt, /未提供验收标准/);
  } finally { await ready.cleanup(); }
});

test('Claude 未就绪：前端流程改由 Codex 实现，审查换用与实现者不同的 Codex 模型，并标明切换原因', async () => {
  const flow = await plainService({ implement: writeApi('2'), verify: () => verified([]), review: () => reviewed('approved') }, { claudeReady: false });
  try {
    const { workflowId, firstRun } = await flow.service.startTeamWorkflow(flow.main.id, { templateId: 'frontend', objective: '页面', attachmentIds: [],
      acceptanceCriteria: [], allowedPaths: [] });
    assert.deepEqual([firstRun.provider, firstRun.model, firstRun.accessMode], ['codex', 'gpt-6.1-sol', 'full']);
    const done = await waitState(flow.service, workflowId, 'awaiting_acceptance');
    assert.match(done.providerFallback!.reason, /Claude Code 未就绪/);
    const reviewer = flow.calls.find(call => call.run.task?.workflow?.stage === 'review')!;
    assert.deepEqual([reviewer.run.provider, reviewer.run.model, reviewer.run.mode, reviewer.run.accessMode], ['codex', 'gpt-6-astra', 'agent', 'full']);
    assert.match(reviewer.prompt, /同家族审查/);
    assert.equal(flow.calls.some(call => call.run.provider === 'claude'), false);
  } finally { await flow.cleanup(); }
});

test('Claude 额度窗口已用满：工程流程的审查改由 Codex Astra 承担，实现仍为 Codex Sol', async () => {
  const exhausted: AgentUsageLimits = { available: true, checkedAt: new Date().toISOString(),
    primary: { usedPercent: 100, remainingPercent: 0, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 } };
  const flow = await plainService({ implement: writeApi('8'), verify: () => verified([]), review: () => reviewed('approved') }, { claudeUsage: exhausted });
  try {
    const { workflowId } = await flow.service.startTeamWorkflow(flow.main.id, { templateId: 'engineering', objective: '修复', attachmentIds: [],
      acceptanceCriteria: [], allowedPaths: [] });
    const done = await waitState(flow.service, workflowId, 'awaiting_acceptance');
    assert.match(done.providerFallback!.reason, /额度已用尽（5 小时窗口/);
    assert.deepEqual(done.steps.map(step => `${step.stage}:${step.provider}:${step.model}`),
      ['implement:codex:gpt-6.1-sol', 'verify:codex:gpt-6.1-sol', 'review:codex:gpt-6-astra']);
  } finally { await flow.cleanup(); }
});

test('Claude 运行中额度用尽：同一步改由 Codex 重做，不计入返工轮数，后续 Claude 岗位保持 Codex', async () => {
  const flow = await plainService({ implement: writeApi('9'), verify: () => verified([]), review: () => reviewed('approved') }, { claudeQuotaFailures: 1 });
  try {
    const { workflowId, firstRun } = await flow.service.startTeamWorkflow(flow.main.id, { templateId: 'frontend', objective: '页面', attachmentIds: [],
      acceptanceCriteria: [], allowedPaths: [] });
    assert.equal(firstRun.provider, 'claude');
    const done = await waitState(flow.service, workflowId, 'awaiting_acceptance');
    assert.match(done.providerFallback!.reason, /第 1 步运行中/);
    assert.deepEqual(done.steps.map(step => `${step.step}.${step.stage}:${step.round}:${step.provider}:${step.model}`),
      ['1.implement:0:codex:gpt-6.1-sol', '2.verify:0:codex:gpt-6.1-sol', '3.review:0:codex:gpt-6-astra']);
    const implementations = flow.calls.filter(call => call.run.task?.workflow?.stage === 'implement').map(call => call.run.provider);
    assert.deepEqual(implementations, ['claude', 'codex']);
  } finally { await flow.cleanup(); }
});

test('缺少结果报告或改动越界时停在实现，不创建验证', async () => {
  const missing = await plainService({ implement: async run => { await writeApi('4')(run); return '已经全部完成了'; },
    verify: () => verified([]), review: () => reviewed('approved') });
  try {
    const { workflowId } = await missing.service.startTeamWorkflow(missing.main.id, { templateId: 'engineering', objective: '修复', attachmentIds: [],
      acceptanceCriteria: [], allowedPaths: [] });
    const summary = await waitState(missing.service, workflowId, 'blocked');
    assert.match(summary.reason, /delivery-report/);
    assert.equal(summary.steps.length, 1);
    assert.deepEqual(summary.actions, ['retry', 'takeover', 'cancel']);
  } finally { await missing.cleanup(); }
  const outside = await plainService({ implement: async run => {
    await fs.mkdir(path.join(run.workspacePath, 'src'), { recursive: true });
    await fs.writeFile(path.join(run.workspacePath, 'src', 'x.vue'), '<template />\n');
    return implemented();
  }, verify: () => verified([]), review: () => reviewed('approved') });
  try {
    const { workflowId } = await outside.service.startTeamWorkflow(outside.main.id, { templateId: 'engineering', objective: '修复', attachmentIds: [],
      acceptanceCriteria: [], allowedPaths: ['server/**'] });
    const summary = await waitState(outside.service, workflowId, 'blocked');
    assert.match(summary.reason, /src\/x\.vue/);
    assert.equal(await fs.readFile(path.join(outside.workspace, 'src', 'x.vue'), 'utf8'), '<template />\n', '越界文件不自动回滚');
  } finally { await outside.cleanup(); }
});

test('验证期间实现工作区被修改：审查前发现版本变化并重新验证，不计入返工轮数', async () => {
  let verifications = 0;
  let workspace = '';
  const flow = await plainService({ implement: writeApi('5'), review: () => reviewed('approved'),
    verify: async () => {
      if ((verifications += 1) <= 5) await fs.writeFile(path.join(workspace, 'server', 'api.ts'), `export const api = ${verifications + 5};\n`);
      return verified([]);
    } });
  workspace = flow.workspace;
  try {
    const { workflowId } = await flow.service.startTeamWorkflow(flow.main.id, { templateId: 'engineering', objective: '修复', attachmentIds: [],
      acceptanceCriteria: [], allowedPaths: [] });
    const summary = await waitState(flow.service, workflowId, 'awaiting_acceptance');
    assert.deepEqual(summary.steps.map(step => `${step.stage}:${step.round}`), ['implement:0', ...Array(6).fill('verify:0'), 'review:0']);
    assert.equal(verifications, 6);
  } finally { await flow.cleanup(); }
});

test('审查连续退回超过原返工和运行次数限制后，自动继续直到通过', async () => {
  let reviews = 0;
  const flow = await plainService({ implement: async run => writeApi(`${run.task!.workflow!.round + 2}`)(run), verify: () => verified(['AC-1']),
    review: () => reviewed(++reviews <= 6 ? 'changes_requested' : 'approved') });
  try {
    const { workflowId } = await flow.service.startTeamWorkflow(flow.main.id, { templateId: 'engineering', objective: '修复', attachmentIds: [],
      acceptanceCriteria: ['返回正确'], allowedPaths: [] });
    const done = await waitState(flow.service, workflowId, 'awaiting_acceptance');
    assert.equal(done.maxRounds, null);
    assert.equal(done.round, 6);
    assert.equal(done.steps.length, 21);
    assert.deepEqual(done.actions, ['takeover', 'cancel']);
    assert.equal(flow.calls.filter(call => call.run.task?.workflow?.stage === 'implement').length, 7);
    const cancelled = await flow.service.decideWorkflow(workflowId, 'cancel', 'request-cancel-1');
    assert.equal(cancelled.state, 'cancelled');
    const repeated = await flow.service.decideWorkflow(workflowId, 'cancel', 'request-cancel-1');
    assert.equal(repeated.state, 'cancelled');
    assert.equal(flow.calls.filter(call => call.run.task?.workflow?.stage === 'implement').length, 7, '重复决定不能再次派发');
  } finally { await flow.cleanup(); }
});

test('验证运行中服务重启：不重复派发；重试本步会新建副本并继续推进', async () => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  let verifications = 0;
  const handlers = { implement: writeApi('7'), review: () => reviewed('approved'),
    verify: async (_run: AgentRun, context: Parameters<AgentRuntimeAdapter['execute']>[0]) => {
      if ((verifications += 1) === 1) {
        await new Promise<void>((resolve, reject) => { context.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }); void hold.then(resolve); });
      }
      return verified([]);
    } };
  const flow = await plainService(handlers);
  let restarted: Awaited<ReturnType<typeof createAgentRuntimeService>> | undefined;
  try {
    const { workflowId } = await flow.service.startTeamWorkflow(flow.main.id, { templateId: 'engineering', objective: '修复', attachmentIds: [],
      acceptanceCriteria: [], allowedPaths: [] });
    await waitFor(() => verifications, count => count === 1, '验证开始');
    await flow.service.close();
    restarted = await createAgentRuntimeService(flow.directory, { adapters: harness(handlers).adapters });
    const summary = await waitState(restarted, workflowId, 'blocked');
    assert.deepEqual(summary.steps.map(step => step.stage), ['implement', 'verify']);
    await waitFor(() => fs.readdir(path.join(flow.directory, 'verify')), entries => entries.length === 0, '中断前的副本被回收');
    await restarted.decideWorkflow(workflowId, 'retry', 'request-retry-1');
    const done = await waitState(restarted, workflowId, 'awaiting_acceptance');
    assert.deepEqual(done.steps.map(step => step.stage), ['implement', 'verify', 'review']);
    assert.equal(verifications, 2);
  } finally {
    release();
    await restarted?.close();
    await fs.rm(flow.root, { recursive: true, force: true });
  }
});

test('Claude 写到一半后切换：保留附件、原生交接、实现会话和已写入内容', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-fallback-context-'));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(path.join(workspace, 'server'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'server', 'api.ts'), 'export const api = 1;\n');
  const attachments = [
    { attachment: { id: 'image-id', name: 'page.png', mimeType: 'image/png', size: 8, url: '/image' }, filePath: path.join(root, 'page.png') },
    { attachment: { id: 'file-id', name: 'requirement.md', mimeType: 'text/markdown', size: 2, url: '/file' }, filePath: path.join(root, 'requirement.md') },
  ];
  await fs.writeFile(attachments[0].filePath, 'image');
  await fs.writeFile(attachments[1].filePath, 'AC');
  const { calls, adapters } = harness({ implement: async (run, context) => {
    assert.equal(run.provider, 'codex');
    assert.deepEqual(run.attachments?.map(item => item.id), ['image-id', 'file-id']);
    assert.deepEqual(context.imagePaths, [attachments[0].filePath]);
    assert.deepEqual(context.fileAttachments, [{ name: 'requirement.md', path: attachments[1].filePath }]);
    assert.equal(await fs.readFile(path.join(run.workspacePath, 'server', 'partial.ts'), 'utf8'), 'partial');
    assert.equal(run.providerSwitch?.from, 'claude');
    assert.match(run.providerSwitch?.context || '', /页面原始目标/);
    return writeApi('11')(run);
  }, verify: () => verified([]), review: () => reviewed('approved') });
  const claude = adapters.find(adapter => adapter.id === 'claude')!;
  const execute = claude.execute;
  claude.execute = async context => {
    if (context.run.task?.workflow?.stage !== 'implement') return execute(context);
    await context.onSession('claude-partial-session');
    await fs.writeFile(path.join(context.run.workspacePath, 'server', 'partial.ts'), 'partial');
    throw new Error('Claude Code 额度已用尽或触发速率限制，本轮未完成');
  };
  const service = await createAgentRuntimeService(path.join(root, 'data'), { adapters,
    resolveAttachments: async ids => attachments.filter(item => ids.includes(item.attachment.id)) });
  try {
    const main = await service.start({ provider: 'codex', mode: 'agent', model: 'gpt-6.1-sol', objective: '主任务', workspacePath: workspace });
    await waitFor(() => service.dashboard(), data => data.runs.find(run => run.id === main.id)?.status === 'completed', '主任务');
    const { workflowId, firstRun } = await service.startTeamWorkflow(main.id, { templateId: 'frontend', objective: '页面原始目标',
      attachmentIds: attachments.map(item => item.attachment.id), acceptanceCriteria: [], allowedPaths: ['server/**'] });
    const done = await waitState(service, workflowId, 'awaiting_acceptance');
    const fallback = calls.find(call => call.run.task?.workflow?.stage === 'implement')!.run;
    assert.equal(fallback.parentRunId, firstRun.id);
    assert.equal(fallback.conversationId, firstRun.conversationId);
    assert.equal(done.implementationConversationId, firstRun.conversationId);
    assert.equal(fallback.task?.workflow?.round, 0);
    const data = await service.dashboard();
    const failed = data.runs.find(run => run.id === firstRun.id)!;
    assert.ok(failed.changedFiles?.some(file => file.path === 'server/partial.ts'));
  } finally { await service.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('旧流程重启移除数字上限，保留已经升级的模型和跨模型审查', async () => {
  let implementations = 0;
  const handlers = { implement: async (run: AgentRun) => {
    if (++implementations === 1) throw new Error('暂时不可用');
    return writeApi('3')(run);
  }, verify: () => verified([]), review: () => reviewed('approved') };
  const flow = await plainService(handlers, { claudeReady: false });
  let restarted: Awaited<ReturnType<typeof createAgentRuntimeService>> | undefined;
  try {
    const { workflowId } = await flow.service.startTeamWorkflow(flow.main.id, { templateId: 'engineering', objective: '修复',
      attachmentIds: [], acceptanceCriteria: [], allowedPaths: ['server/**'] });
    await waitState(flow.service, workflowId, 'blocked');
    await flow.service.close();
    const recordFile = path.join(flow.directory, 'agent-workflows.json');
    const records = JSON.parse(await fs.readFile(recordFile, 'utf8'));
    Object.assign(records.find((item: { id: string }) => item.id === workflowId), { maxRounds: 20, escalated: true });
    await fs.writeFile(recordFile, JSON.stringify(records));
    restarted = await createAgentRuntimeService(flow.directory, { adapters: harness(handlers, { claudeReady: false }).adapters });
    const blocked = await waitState(restarted, workflowId, 'blocked');
    assert.equal(blocked.maxRounds, null);
    assert.equal(blocked.escalated, true);
    await restarted.decideWorkflow(workflowId, 'retry', 'retry-historical-upgrade');
    const done = await waitState(restarted, workflowId, 'awaiting_acceptance');
    assert.equal(done.steps.filter(step => step.stage === 'implement').at(-1)?.model, 'gpt-6-astra');
    assert.equal(done.steps.filter(step => step.stage === 'review').at(-1)?.model, 'gpt-6.1-sol');
  } finally { await restarted?.close(); await flow.cleanup(); }
});

test('非 Git 项目把运行数据放在源码内时，验证副本放在外部且正常回收', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-nested-data-'));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(path.join(workspace, 'server'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'server', 'api.ts'), 'export const api = 1;\n');
  let copy = '';
  const { adapters } = harness({ implement: writeApi('12'), verify: async run => {
    copy = run.workspacePath;
    assert.equal(copy.startsWith(`${await fs.realpath(workspace)}${path.sep}`), false);
    assert.equal(await fs.readFile(path.join(copy, 'server', 'api.ts'), 'utf8'), 'export const api = 12;\n');
    return verified([]);
  }, review: () => reviewed('approved') });
  const service = await createAgentRuntimeService(path.join(workspace, '.data', 'agent-runtimes'), { adapters });
  try {
    const main = await service.start({ provider: 'codex', mode: 'agent', model: 'gpt-6.1-sol', objective: '主任务', workspacePath: workspace });
    await waitFor(() => service.dashboard(), data => data.runs.find(run => run.id === main.id)?.status === 'completed', '主任务');
    const { workflowId } = await service.startTeamWorkflow(main.id, { templateId: 'engineering', objective: '修复',
      attachmentIds: [], acceptanceCriteria: [], allowedPaths: ['server/**'] });
    await waitState(service, workflowId, 'awaiting_acceptance').catch(error => {
      assert.fail(`${error.message} ${JSON.stringify(service.workflows())}`);
    });
    await assert.rejects(fs.access(copy));
  } finally {
    await service.close();
    if (copy) await fs.rmdir(path.dirname(copy));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('实现启动失败且尚无原生会话：重试新建原生会话并保持实现会话归属', async () => {
  const flow = await plainService({ implement: writeApi('13'), verify: () => verified([]), review: () => reviewed('approved') });
  const codex = flow.adapters.find(adapter => adapter.id === 'codex')!;
  const execute = codex.execute;
  let failure = true;
  codex.execute = async context => {
    if (context.run.task?.workflow?.stage === 'implement' && failure) {
      failure = false;
      throw new Error('CLI 启动失败，尚未创建原生会话');
    }
    return execute(context);
  };
  try {
    const { workflowId, firstRun } = await flow.service.startTeamWorkflow(flow.main.id, { templateId: 'engineering', objective: '修复',
      attachmentIds: [], acceptanceCriteria: [], allowedPaths: ['server/**'] });
    const blocked = await waitState(flow.service, workflowId, 'blocked');
    assert.match(blocked.reason, /CLI 启动失败/);
    assert.equal((await flow.service.dashboard()).runs.find(run => run.id === firstRun.id)?.sessionId, '');
    await flow.service.decideWorkflow(workflowId, 'retry', 'retry-before-session');
    const done = await waitState(flow.service, workflowId, 'awaiting_acceptance');
    assert.equal(done.implementationConversationId, firstRun.conversationId);
    const retried = flow.calls.find(call => call.run.task?.workflow?.stage === 'implement')!;
    assert.equal(retried.resumeSessionId, '');
    assert.equal(retried.run.providerSwitch, undefined);
    assert.equal(retried.run.task?.workflow?.step, 1);
    assert.equal(retried.run.task?.workflow?.round, 0);
  } finally { await flow.cleanup(); }
});

test('待验收后在实现会话续聊：保留原三步，新增实现、验证和审查，旧证据不得预填', async () => {
  let implementations = 0, verifications = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const flow = await plainService({
    implement: async run => writeApi(`${++implementations + 1}`)(run),
    verify: async () => {
      verifications += 1;
      if (verifications === 2) await gate;
      return report({ version: 1, validationEvidence: { ...emptyDeliveryEvidence(),
        tests: { status: 'passed', evidence: `candidate-${verifications} npm test 退出码 0`, sha: '' } },
      taskResult: { role: 'verifier', status: 'succeeded', acceptance: [] } });
    }, review: () => reviewed('approved'),
  });
  try {
    const { workflowId, firstRun } = await flow.service.startTeamWorkflow(flow.main.id, { templateId: 'engineering', objective: '修复',
      attachmentIds: [], acceptanceCriteria: [], allowedPaths: ['server/**'] });
    const original = await waitState(flow.service, workflowId, 'awaiting_acceptance');
    const before = await flow.service.dashboard();
    assert.equal(teamDeliveryEvidence(before.runs.find(run => run.id === firstRun.id), before.runs, before.workflows)?.checks?.tests.evidence,
      'candidate-1 npm test 退出码 0');
    const continued = await flow.service.resume(firstRun.id, '继续修改实现');
    assert.equal(continued.conversationId, firstRun.conversationId);
    assert.equal(continued.task?.workflow?.step, 4);
    assert.equal(continued.task?.workflow?.round, 0);
    await waitFor(() => verifications, value => value === 2, '新的验证开始');
    const pending = await flow.service.dashboard();
    const pendingEvidence = teamDeliveryEvidence(pending.runs.find(run => run.id === continued.id), pending.runs, pending.workflows);
    assert.equal(pendingEvidence?.checks, undefined);
    assert.equal(pendingEvidence?.active, true);
    release();
    const completed = await waitState(flow.service, workflowId, 'awaiting_acceptance');
    assert.deepEqual(completed.steps.map(step => `${step.step}:${step.stage}`),
      ['1:implement', '2:verify', '3:review', '4:implement', '5:verify', '6:review']);
    assert.deepEqual(completed.steps.slice(0, 3).map(step => step.runId), original.steps.map(step => step.runId));
    assert.notEqual(completed.snapshot?.value, original.snapshot?.value);
    const after = await flow.service.dashboard();
    assert.equal(teamDeliveryEvidence(after.runs.find(run => run.id === continued.id), after.runs, after.workflows)?.checks?.tests.evidence,
      'candidate-2 npm test 退出码 0');
  } finally { release(); await flow.cleanup(); }
});
