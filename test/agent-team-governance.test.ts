import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { createAgentTeamGovernance, evaluationCheckArguments } from '../server/agent-team-governance.js';
import { createAgentUsageStore } from '../server/agent-usage.js';
import { createAgentCollaborationStore } from '../server/agent-collaboration.js';
import { defaultTeamProfileConfig, type TeamModelChoice } from '../shared/agent-team.js';
import { emptyAgentUsage } from '../shared/agent-usage.js';
import { emptyDeliveryEvidence } from '../shared/delivery-acceptance.js';
import { localWorkflowWorkspace } from '../server/agent-workflow.js';
import type { AdvancedTeamTask } from '../server/agent-team-service.js';
import type { AgentRun, AgentRuntimeHealth } from '../shared/agent-runtime.js';
import type { AgentDeliveryDraftSource } from '../server/agent-delivery-draft.js';

const exec = promisify(execFile);
const report = (value: unknown) => `\`\`\`delivery-report\n${JSON.stringify({ version: 1, ...value as object })}\n\`\`\``;
type Runtime = Parameters<typeof createAgentTeamGovernance>[1];

async function fixture(options: { badCandidate?: boolean; commands?: string[]; repairingChecks?: boolean; stagedReview?: boolean } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-governance-'));
  const source = path.join(directory, 'source'); await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'add.js'), 'export const add=(a,b)=>a-b;\n');
  await fs.writeFile(path.join(source, 'test.test.mjs'), options.repairingChecks
    ? "import fs from 'node:fs/promises';import test from 'node:test';import assert from 'node:assert/strict';await fs.writeFile('add.js','export const add=(a,b)=>a+b;\\n');const {add}=await import('./add.js');test('sum',()=>assert.equal(add(2,3),5));\n"
    : "import test from 'node:test';import assert from 'node:assert/strict';import {add} from './add.js';test('sum',()=>assert.equal(add(2,3),5));\n");
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test test.test.mjs' } }));
  await exec('git', ['-C', source, 'init', '-q', '-b', 'main']); await exec('git', ['-C', source, 'add', '.']);
  await exec('git', ['-C', source, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base']);
  const baseHead = (await exec('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim();
  const accepted = path.join(directory, 'accepted'); await exec('git', ['-C', source, 'worktree', 'add', '-b', 'feature/accepted', accepted, baseHead]);
  await fs.writeFile(path.join(accepted, 'add.js'), 'export const add=(a,b)=>a+b;\n');
  const config = defaultTeamProfileConfig(), snapshot = await localWorkflowWorkspace.version(accepted, []);
  const candidatePatch = await localWorkflowWorkspace.diff(accepted, baseHead);
  const task: AdvancedTeamTask = { id: 'task-1', parentConversationId: 'parent', sourceWorkspacePath: source, workspacePath: accepted,
    objective: '修复加法', attachmentIds: [], profileConfig: config, planRevision: 1, nodes: [], state: 'accepted', round: 0, maxRounds: 2,
    createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T01:00:00.000Z', budgetLimit: 100, reverifyCount: 0, requestIds: {}, baseHead, upgradedProfiles: [] };
  const validation = emptyDeliveryEvidence();
  validation.tests = { status: 'passed', evidence: 'npm test 退出码0', sha: '' };
  for (const kind of ['browser', 'remote', 'deployment'] as const) validation[kind] = { status: 'not_applicable', evidence: '本地函数修复范围不涉及该项', sha: '' };
  const currentSource = { runId: 'accepted-implementation', updatedAt: task.updatedAt };
  let draftSource: AgentDeliveryDraftSource | undefined = { taskId: task.id, objective: task.objective, candidate: snapshot,
    implementation: { runId: currentSource.runId, summary: '修复加法', files: ['add.js'] },
    verification: { runId: 'verify-original', candidate: snapshot, passed: true, evidence: validation, refs: ['/logs/test.log'] },
    reviews: [{ runId: 'review-original', candidate: snapshot, approved: true, summary: '审查批准', refs: ['/logs/review.json'] }],
    acceptance: { recordId: 'agent:accepted', revision: 1, source: currentSource, checks: validation, decision: 'accepted', summary: '人工验收通过', updatedAt: task.updatedAt }, currentSource };
  const ledger = await createAgentCollaborationStore(path.join(directory, 'data'));
  const usageStore = await createAgentUsageStore(path.join(directory, 'data'));
  const calls: { input: Parameters<Runtime['startTeamNode']>[0]; metadata: Parameters<Runtime['startTeamNode']>[1] }[] = [];
  const runs = new Map<string, AgentRun>();
  const runtime: Runtime = {
    health: async provider => ({ provider, ready: provider !== 'claude', authenticated: provider !== 'claude', writable: true, label: provider,
      binary: '/fake', version: 'test', message: provider === 'claude' ? 'fixture未就绪' : 'ready', checkedAt: new Date().toISOString(),
      modes: ['agent', 'ask', 'plan'], defaultModel: 'gpt-6.1-sol', models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'].map(id => ({ id, label: id,
        efforts: ['low', 'medium', 'high', 'xhigh'] })) } as AgentRuntimeHealth),
    subscribe: () => () => true, getRun: id => runs.get(id), teamRuns: taskId => [...runs.values()].filter(run => !taskId || run.team?.taskId === taskId),
    stop: async id => { const run = runs.get(id)!; run.status = 'cancelled'; return run; },
    startTeamNode: async (input, metadata) => {
      const old = [...runs.values()].find(run => run.team?.stageKey === metadata.team.stageKey); if (old) return old;
      calls.push({ input: structuredClone(input), metadata: structuredClone(metadata) });
      const profile = metadata.team.profileId;
      assert.equal(input.mode, 'agent');
      assert.equal(input.accessMode, task.accessMode ?? 'full');
      let result = '';
      if (profile === 'engineer') {
        assert.notEqual(input.workspacePath, source); assert.notEqual(input.workspacePath, accepted);
        assert.equal(await fs.readFile(path.join(input.workspacePath, 'add.js'), 'utf8'), 'export const add=(a,b)=>a-b;\n');
        const broken = options.badCandidate && input.model === 'gpt-6-astra';
        await fs.writeFile(path.join(input.workspacePath, 'add.js'), broken ? 'export const add=(a,b)=>a-b; // still wrong\n' : 'export const add=(a,b)=>a+b;\n');
        result = report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '完成' } });
      } else if (profile === 'verifier') {
        const material = metadata.team.artifactDirectories![0];
        const log = await fs.readFile(path.join(material, 'check-1.log'), 'utf8');
        assert.match(log, /npm test\nexitCode=[01]/);
        await fs.mkdir(path.join(input.workspacePath, '.delivery-artifacts'), { recursive: true });
        await fs.writeFile(path.join(input.workspacePath, '.delivery-artifacts', 'verifier.log'), log);
        result = report({ validationEvidence: validation, taskResult: { role: 'verifier', status: 'succeeded', acceptance: [{ id: 'AC-1', status: 'passed', evidence: log },
          ...(options.stagedReview ? [{ id: 'AC-3', status: 'not_run', evidence: '等待独立复审' }] : [])] } });
      } else if (profile === 'reviewer') {
        assert.equal(input.mode, 'agent');
        assert.equal(await fs.readFile(path.join(input.workspacePath, 'add.js'), 'utf8'), 'export const add=(a,b)=>a+b;\n');
        assert.equal(metadata.context.includes('gpt-6.1-sol'), false, '盲审不带作者模型');
        assert.equal(metadata.context.includes('gpt-6-astra'), false, '盲审不带作者模型');
        result = report({ taskResult: { role: 'reviewer', status: 'succeeded', verdict: 'approved', findings: [],
          acceptance: options.stagedReview ? [{ id: 'AC-3', status: 'passed', evidence: '读取候选与固定检查完成复审' }] : [] } });
      } else if (profile === 'reporter') {
        assert.equal(input.mode, 'agent'); assert.equal(input.model, 'gpt-6-luna');
        result = report({ deliveryDraft: { reason: '运算符错误', changes: ['修复运算符'], unverified: [], risks: [] } });
      } else if (profile === 'second_opinion') {
        assert.equal(input.mode, 'agent'); assert.match(metadata.context, /只读第二意见|第二意见/);
        result = report({ secondOpinion: { text: '独立核对边界，无需修改流程' } });
      } else assert.fail(`unexpected profile ${profile}`);
      const now = new Date().toISOString();
      const run: AgentRun = { id: randomUUID(), conversationId: randomUUID(), provider: input.provider, model: input.model || '', mode: input.mode,
        reasoningEffort: input.reasoningEffort || '', accessMode: input.accessMode ?? 'full', objective: input.objective, workspacePath: input.workspacePath,
        branch: '', headSha: baseHead, status: 'completed', resultReady: true, sessionId: '', pid: null, result, error: '', events: [],
        changedFiles: profile === 'engineer' ? [{ path: 'add.js', status: 'modified' }] : [], team: metadata.team, createdAt: now, updatedAt: now,
        usage: { ...emptyAgentUsage(input.provider), inputTokens: 20, outputTokens: 2 } };
      runs.set(run.id, run);
      await usageStore.upsert({ runId: run.id, workflowId: metadata.team.taskId, profileId: profile, provider: run.provider, model: run.model, createdAt: now, usage: run.usage! });
      return run;
    },
  };
  const team: Parameters<typeof createAgentTeamGovernance>[2] = { ledger, getTask: () => structuredClone(task), draftSource: async () => draftSource,
    evaluationSample: async (_id, profileId) => ({ id: 'sample-1', workflowId: task.id, status: 'accepted', sourcePath: source, baseHead,
      objective: task.objective, acceptanceCriteria: [{ id: 'AC-1', text: 'add(2,3)=5' },
        ...(options.stagedReview ? [{ id: 'AC-3', text: '完成独立复审', stage: 'review' as const }] : [])], allowedPaths: ['add.js'], rolePrompt: '只修加法并验证',
      verificationCommands: options.commands ?? (profileId === 'reviewer' ? [] : ['npm test']),
      ...(profileId === 'reviewer' ? { candidatePatch, candidatePatchHash: createHash('sha256').update(candidatePatch).digest('hex'), candidate: snapshot } : {}) }) };
  const governance = await createAgentTeamGovernance(path.join(directory, 'data'), runtime, team, { usageStore, timeoutMs: 1000 });
  return { directory, source, accepted, calls, task, governance, runtime, runs, team, usageStore, setBlocked: () => { task.state = 'blocked'; draftSource = undefined; }, cleanup: async () => {
    await governance.close(); await usageStore.close(); await fs.rm(directory, { recursive: true, force: true });
  } };
}
async function waitForEvaluation(governance: Awaited<ReturnType<typeof createAgentTeamGovernance>>, id: string) {
  for (let index = 0; index < 500; index += 1) { const record = governance.evaluations.get(id); if (record.status === 'completed' || record.status === 'failed') return record;
    await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('eval timeout');
}
const models: [TeamModelChoice, TeamModelChoice] = [{ provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high' },
  { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high' }];

test('评测保留验收阶段，由独立复审补齐验证时尚未执行的审查项', async () => {
  const value = await fixture({ stagedReview: true });
  try {
    const record = await value.governance.createEvaluation({ taskIds: ['task-1'], profileId: 'engineer', models, requestId: 'eval-stages', confirmed: true });
    const done = await waitForEvaluation(value.governance, record.id);
    assert.equal(done.samples[0].acceptanceCriteria[1].stage, 'review');
    assert.ok(done.variants.every(variant => variant.result?.passed), JSON.stringify(done.variants));
    for (const variant of done.variants) assert.deepEqual(variant.result?.acceptance.find(item => item.id === 'AC-3'), {
      id: 'AC-3', status: 'passed', evidence: '读取候选与固定检查完成复审',
    });
  } finally { await value.cleanup(); }
});

test('治理runner实际启动隔离实现/验证/盲审，运行固定检查，保留源版本与默认配置', async () => {
  const value = await fixture();
  try {
    const before = JSON.stringify(value.task.profileConfig);
    const record = await value.governance.createEvaluation({ taskIds: ['task-1'], profileId: 'engineer', models, requestId: 'eval-request-1', confirmed: true });
    const done = await waitForEvaluation(value.governance, record.id);
    assert.equal(done.status, 'completed', JSON.stringify(done.variants)); assert.ok(done.variants.every(variant => variant.result?.passed));
    assert.deepEqual(value.calls.map(call => call.metadata.team.profileId), ['engineer', 'verifier', 'reviewer', 'engineer', 'verifier', 'reviewer']);
    assert.deepEqual(value.calls.filter(call => call.metadata.team.profileId === 'reviewer').map(call => call.input.model), ['gpt-6-astra', 'gpt-6.1-sol']);
    assert.ok(value.calls.every(call => call.metadata.team.stageKey.includes('attempt-1')));
    assert.equal(JSON.stringify(value.task.profileConfig), before);
    assert.equal(await fs.readFile(path.join(value.source, 'add.js'), 'utf8'), 'export const add=(a,b)=>a-b;\n');
    assert.equal(await fs.readFile(path.join(value.accepted, 'add.js'), 'utf8'), 'export const add=(a,b)=>a+b;\n');
    assert.deepEqual(await fs.readdir(path.join(value.directory, 'data/evaluation-workspaces')), []);
    assert.deepEqual(await fs.readdir(path.join(value.directory, 'data/evaluation-verification')), []);
    const duplicate = await value.governance.createEvaluation({ taskIds: ['task-1'], profileId: 'engineer', models, requestId: 'eval-request-1', confirmed: true });
    assert.equal(duplicate.id, record.id); assert.equal(value.calls.length, 6);
    assert.ok(value.team.ledger.snapshot().intents.every(intent => intent.settled));
  } finally { await value.cleanup(); }
});

test('审查岗位成对评测重放已验收候选，每变体只调用一次审查且两个实现率不适用', async () => {
  const value = await fixture();
  try {
    const before = await fs.readFile(path.join(value.source, '.git', 'index'));
    const record = await value.governance.createEvaluation({ taskIds: ['task-1'], profileId: 'reviewer', models, requestId: 'eval-reviewer', confirmed: true });
    const done = await waitForEvaluation(value.governance, record.id);
    assert.equal(done.status, 'completed', JSON.stringify(done.variants));
    assert.deepEqual(value.calls.map(call => call.metadata.team.profileId), ['reviewer', 'reviewer']);
    assert.deepEqual(value.calls.map(call => call.input.model), models.map(model => model.model));
    const snapshots = await Promise.all(done.variants.map(async variant => {
      assert.equal(variant.result?.reviewApproved, true);
      const manifest = variant.result!.evidence.find(file => file.endsWith('candidate-manifest.json'))!;
      return JSON.parse(await fs.readFile(manifest, 'utf8'));
    }));
    assert.deepEqual(snapshots[0], snapshots[1]);
    assert.equal(snapshots[0].candidate.value, done.samples[0].candidate!.value);
    assert.ok(value.governance.evaluations.metrics(record.id).every(metric => metric.firstPassRate === null && metric.acceptanceRate === null));
    assert.equal(value.team.ledger.snapshot().budgets[`eval:${record.id}`].usedRuns, 2);
    assert.equal(await fs.readFile(path.join(value.source, 'add.js'), 'utf8'), 'export const add=(a,b)=>a-b;\n');
    assert.equal(await fs.readFile(path.join(value.accepted, 'add.js'), 'utf8'), 'export const add=(a,b)=>a+b;\n');
    assert.deepEqual(await fs.readFile(path.join(value.source, '.git', 'index')), before);
  } finally { await value.cleanup(); }
});

test('宿主真实退出码优先于模型声称通过；没有固定检查的实现样本不调用模型', async () => {
  const value = await fixture({ badCandidate: true });
  try {
    const created = await value.governance.createEvaluation({ taskIds: ['task-1'], profileId: 'engineer', models, requestId: 'eval-bad', confirmed: true });
    const done = await waitForEvaluation(value.governance, created.id);
    assert.equal(done.variants[0].result?.passed, true);
    assert.equal(done.variants[1].result?.verificationPassed, false, await fs.readFile(done.variants[1].result!.evidence.find(file => file.endsWith('check-1.log'))!, 'utf8'));
    assert.equal(done.variants[1].result?.passed, false);
    assert.equal(value.calls.filter(call => call.metadata.team.profileId === 'reviewer').length, 1);
  } finally { await value.cleanup(); }
  const empty = await fixture({ commands: [] });
  try { await assert.rejects(empty.governance.createEvaluation({ taskIds: ['task-1'], profileId: 'engineer', models, requestId: 'eval-empty', confirmed: true }), /缺少固定检查/); assert.equal(empty.calls.length, 0); }
  finally { await empty.cleanup(); }
  for (const unsafe of ['git push origin main', 'npm test; git push', 'node --test ../../outside.mjs', 'npm --prefix /tmp test', 'git diff --check --output=/tmp/out', 'npx eslint --fix .']) assert.throws(() => evaluationCheckArguments(unsafe));
});

test('交付整理实际调用完整权限Luna；阻塞任务第二意见可用且同requestId持久幂等', async () => {
  const value = await fixture();
  try {
    const draft = await value.governance.drafts.generate('task-1');
    assert.match(draft.text, /修复运算符/); assert.match(draft.text, /\/logs\/test.log/);
    assert.equal(value.calls.filter(call => call.metadata.team.profileId === 'reporter').length, 1);
    assert.equal(value.calls[0].input.accessMode, 'full');
    value.setBlocked();
    const [first, duplicate] = await Promise.all([value.governance.secondOpinion('task-1', 'opinion-request'), value.governance.secondOpinion('task-1', 'opinion-request')]);
    assert.equal(first.id, duplicate.id); assert.equal(first.readOnly, true);
    assert.equal(value.calls.filter(call => call.metadata.team.profileId === 'second_opinion').length, 1);
    assert.equal(value.task.state, 'blocked');
    assert.equal((await value.governance.secondOpinion('task-1', 'opinion-request')).id, first.id);
    await assert.rejects(value.governance.drafts.generate('task-1'), /尚未全部通过/);
    assert.equal(value.team.ledger.snapshot().budgets['task-1'].usedRuns, 2);
  } finally { await value.cleanup(); }
});

test('治理草稿、第二意见和独立审查评测继承任务显式工作区权限', async () => {
  const value = await fixture();
  try {
    value.task.accessMode = 'workspace';
    await value.governance.drafts.generate('task-1', 'workspace-draft');
    await value.governance.secondOpinion('task-1', 'workspace-opinion');
    const evaluation = await value.governance.createEvaluation({ taskIds: ['task-1'], profileId: 'reviewer', models, requestId: 'workspace-review', confirmed: true });
    const done = await waitForEvaluation(value.governance, evaluation.id);
    assert.equal(done.status, 'completed');
    assert.deepEqual(value.calls.map(call => call.metadata.team.profileId), ['reporter', 'second_opinion', 'reviewer', 'reviewer']);
    assert.ok(value.calls.every(call => call.input.mode === 'agent' && call.input.accessMode === 'workspace'));
  } finally { await value.cleanup(); }
});

test('评测恢复先核对进程，新的attempt不会命中旧副本的完成结果或覆盖旧日志', async () => {
  const value = await fixture(); let restarted: Awaited<ReturnType<typeof createAgentTeamGovernance>> | undefined;
  try {
    const record = await value.governance.createEvaluation({ taskIds: ['task-1'], profileId: 'engineer', models, requestId: 'eval-recovery', confirmed: true });
    const completed = await waitForEvaluation(value.governance, record.id);
    assert.equal(completed.status, 'completed', JSON.stringify(completed.variants));
    const oldLog = completed.variants[0].result!.evidence.find(file => file.endsWith('check-1.log'))!;
    const oldContent = await fs.readFile(oldLog, 'utf8');
    await value.governance.close();
    const file = path.join(value.directory, 'data/agent-evaluations.json'), saved = JSON.parse(await fs.readFile(file, 'utf8'));
    saved.records[0].status = 'running'; saved.records[0].variants[0].status = 'running'; await fs.writeFile(file, JSON.stringify(saved));
    restarted = await createAgentTeamGovernance(path.join(value.directory, 'data'), value.runtime, value.team, { usageStore: value.usageStore, timeoutMs: 1000 });
    const previousRun = [...value.runs.values()].find(run => run.team?.stageKey.includes(completed.variants[0].id))!;
    previousRun.status = 'running';
    await assert.rejects(restarted.evaluations.run(record.id, { confirmedResume: true }), /仍在运行/);
    assert.equal(value.calls.length, 6);
    previousRun.status = 'interrupted';
    await assert.rejects(restarted.evaluations.run(record.id, { confirmedResume: true }), /尚未核对/);
    previousRun.status = 'completed';
    const resumed = await restarted.evaluations.run(record.id, { confirmedResume: true });
    assert.equal(resumed.status, 'completed', JSON.stringify(resumed.variants)); assert.equal(resumed.variants[0].attempt, 2);
    assert.equal(value.calls.length, 9, '只重做未核对变体的三个节点，已完成另一变体不重放');
    assert.ok(value.calls.slice(6).every(call => call.metadata.team.stageKey.includes('attempt-2')));
    assert.equal(await fs.readFile(oldLog, 'utf8'), oldContent);
    assert.ok(resumed.variants[0].attemptHistory?.length);
    assert.notEqual(resumed.variants[0].result!.evidence.find(file => file.endsWith('check-1.log')), oldLog);
  } finally { await restarted?.close(); await value.cleanup(); }
});

test('交付整理明确失败后同请求不重复计费，新的人工重试请求可恢复', async () => {
  const value = await fixture();
  const start = value.runtime.startTeamNode;
  let fail = true;
  value.runtime.startTeamNode = async (input, metadata) => {
    const run = await start(input, metadata);
    if (metadata.team.profileId === 'reporter' && fail) { fail = false; run.status = 'failed'; run.error = 'CLI 暂时不可用'; }
    return run;
  };
  try {
    await assert.rejects(value.governance.drafts.generate('task-1', 'draft-request-a'), /暂时不可用/);
    await assert.rejects(value.governance.drafts.generate('task-1', 'draft-request-a'), /暂时不可用/);
    assert.equal(value.calls.length, 1);
    const draft = await value.governance.drafts.generate('task-1', 'draft-request-b');
    assert.match(draft.text, /修复运算符/); assert.equal(value.calls.length, 2);
    assert.equal((await value.governance.drafts.generate('task-1', 'draft-request-c')).revision, draft.revision);
    assert.equal(value.calls.length, 2, '同源已成功稿不会被重试或自动生成覆盖');
  } finally { await value.cleanup(); }
});

test('测试脚本自动修复副本后即使退出0也不能证明原候选通过', async () => {
  const value = await fixture({ badCandidate: true, repairingChecks: true });
  try {
    const created = await value.governance.createEvaluation({ taskIds: ['task-1'], profileId: 'engineer', models, requestId: 'eval-repairing', confirmed: true });
    const done = await waitForEvaluation(value.governance, created.id);
    assert.equal(done.variants[0].result?.passed, true);
    assert.equal(done.variants[1].result?.verificationPassed, false);
    assert.ok(done.variants[1].result?.evidence.some(file => file.endsWith('verification-source-changed.log')));
  } finally { await value.cleanup(); }
});
