import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { agentRoleProfiles, codexFallbackFor, reviewChoiceFor, teamTemplateLineup } from '../shared/agent-roles.js';
import { agentCliFailureMessage, isAgentQuotaExhaustedError } from '../server/agent-runtime.js';
import { evaluateImplementation, evaluateReview, evaluateVerification, scopeViolations } from '../shared/agent-task-result.js';
import { applyWorkflowDecision, evaluateWorkflow, type AgentWorkflowRecord } from '../shared/agent-workflow.js';
import { emptyDeliveryEvidence, readDeliveryEvidenceReport } from '../shared/delivery-acceptance.js';
import { readJiraHandoffReport } from '../shared/jira-fix-handoff.js';
import { requirementProgressReportSchema } from '../shared/requirement-development.js';
import type { AgentRun, AgentWorkflowStage } from '../shared/agent-runtime.js';
import { localWorkflowWorkspace } from '../server/agent-workflow.js';

const exec = promisify(execFile);
const report = (value: unknown) => `结果说明\n\n\`\`\`delivery-report\n${JSON.stringify(value)}\n\`\`\`\n`;
const implemented = (status = 'succeeded') => report({ version: 1, taskResult: { role: 'implementer', status, summary: '完成' } });
const passedEvidence = () => ({ ...emptyDeliveryEvidence(), tests: { status: 'passed', evidence: 'npm test 退出码 0', sha: '' } });
const verified = (acceptance: { id: string; status: string }[], tests = passedEvidence()) => report({ version: 1, validationEvidence: tests,
  taskResult: { role: 'verifier', status: 'succeeded', acceptance: acceptance.map(item => ({ ...item, evidence: '实测' })) } });
const reviewed = (verdict: string, findings: { id: string; severity: string }[] = []) => report({ version: 1,
  taskResult: { role: 'reviewer', status: 'succeeded', verdict, findings: findings.map(item => ({ ...item, file: 'server/a.ts', line: 3, problem: '问题', expectation: '期望' })) } });

test('岗位配置：所有岗位使用执行模式，保留独立审查路由', () => {
  for (const profile of Object.values(agentRoleProfiles)) assert.equal(profile.mode, 'agent');
  assert.equal(agentRoleProfiles.engineer.provider, 'codex');
  assert.equal(agentRoleProfiles.engineer.model, 'gpt-6.1-sol');
  assert.equal(agentRoleProfiles.frontend.model, 'claude-sonnet-5-5');
  assert.equal(agentRoleProfiles.verifier.reasoningEffort, 'medium');
  assert.equal(reviewChoiceFor('codex').model, 'claude-opus-5-5');
  assert.equal(reviewChoiceFor('claude').model, 'gpt-6-astra');
  for (const provider of ['codex', 'claude', 'cursor'] as const) assert.notEqual(reviewChoiceFor(provider).provider, provider);
  assert.deepEqual(teamTemplateLineup('frontend').map(item => item.choice.model), ['claude-sonnet-5-5', 'gpt-6.1-sol', 'gpt-6-astra']);
});

test('允许范围按 glob 做事后检查，生成的产物链接不算越界', () => {
  const files = [{ path: 'server/runtime/a.ts', status: 'modified' as const }, { path: 'shared/agent-roles.ts', status: 'added' as const },
    { path: 'shared/types.ts', status: 'modified' as const }, { path: 'src/x.vue', status: 'modified' as const },
    { path: '/tmp/report.html', status: 'generated' as const }];
  assert.deepEqual(scopeViolations(files, ['server/**', 'shared/agent-*.ts']), ['shared/types.ts', 'src/x.vue']);
  assert.deepEqual(scopeViolations(files, []), []);
  assert.deepEqual(scopeViolations([{ path: 'src/a/b.vue', status: 'modified' }], ['src/']), []);
});

test('结果判定只认 delivery-report 中的 taskResult，不根据文字推断完成', () => {
  const changed = [{ path: 'server/a.ts', status: 'modified' as const }];
  assert.equal(evaluateImplementation('已全部完成，测试通过', changed, true, []).outcome, 'blocked');
  assert.equal(evaluateImplementation(implemented('failed'), changed, true, []).outcome, 'blocked');
  assert.match(evaluateImplementation(implemented(), [], false, []).reason, /没有任何代码改动/);
  assert.match(evaluateImplementation(implemented(), [{ path: 'src/x.vue', status: 'modified' }], true, ['server/**']).reason, /src\/x\.vue/);
  assert.equal(evaluateImplementation(implemented(), changed, true, ['server/**']).outcome, 'passed');

  const criteria = [{ id: 'AC-1' }, { id: 'AC-2' }];
  assert.equal(evaluateVerification(verified([{ id: 'AC-1', status: 'passed' }, { id: 'AC-2', status: 'passed' }]), criteria).outcome, 'passed');
  const failed = evaluateVerification(verified([{ id: 'AC-1', status: 'failed' }, { id: 'AC-2', status: 'passed' }]), criteria);
  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(failed.failedCriteria.map(item => item.id), ['AC-1']);
  assert.equal(evaluateVerification(verified([{ id: 'AC-1', status: 'passed' }]), criteria).outcome, 'blocked');
  assert.equal(evaluateVerification(verified([{ id: 'AC-1', status: 'passed' }, { id: 'AC-2', status: 'not_run' }]), criteria).outcome, 'blocked');
  const unassignedFailure = evaluateVerification(verified(criteria.map(item => ({ ...item, status: 'passed' })),
    { ...passedEvidence(), tests: { status: 'failed', evidence: 'npm test 退出码 1', sha: '' } }), criteria);
  assert.equal(unassignedFailure.outcome, 'blocked');
  assert.equal(unassignedFailure.requiresDiagnosis, true);
  assert.deepEqual(unassignedFailure.failedCriteria, [{ id: 'tests', status: 'failed', evidence: 'npm test 退出码 1' }]);
  assert.equal(evaluateVerification(report({ version: 1, taskResult: { role: 'verifier', status: 'succeeded' } }), []).outcome, 'blocked');

  assert.equal(evaluateReview(reviewed('approved')).outcome, 'passed');
  assert.equal(evaluateReview(reviewed('approved', [{ id: 'F-1', severity: 'blocker' }])).outcome, 'failed');
  assert.equal(evaluateReview(reviewed('changes_requested', [{ id: 'F-1', severity: 'major' }])).findings.length, 1);
  assert.equal(evaluateReview(reviewed('blocked')).outcome, 'blocked');
});

test('无改动结果须覆盖全部验收项并提供成功检查，才可交给独立验证', () => {
  const criteria = [{ id: 'AC-1' }];
  const result = { role: 'implementer', status: 'succeeded', summary: '目标已满足，无需修改',
    acceptance: [{ id: 'AC-1', status: 'passed', evidence: '实际版本核对记录' }],
    selfTests: [{ command: 'git rev-parse HEAD', exitCode: 0 }] };
  const evaluate = (extra: object = {}) => evaluateImplementation(report({ version: 1, taskResult: { ...result, ...extra } }), [], false, [], criteria);
  assert.equal(evaluate().outcome, 'passed');
  for (const extra of [{ acceptance: [] }, { acceptance: [{ id: 'AC-1', status: 'passed', evidence: '' }] },
    { acceptance: [{ id: 'AC-1', status: 'not_run', evidence: '未运行' }] }, { selfTests: [] },
    { selfTests: [{ command: 'check', exitCode: 1 }] }, { blockers: ['仍有阻塞'] }]) {
    assert.equal(evaluate(extra).outcome, 'blocked');
  }
});

test('带 taskResult 的报告仍能被验收、Jira 交接和需求进度读取', () => {
  const taskResult = { role: 'verifier', status: 'succeeded' };
  assert.equal(readDeliveryEvidenceReport(report({ version: 1, validationEvidence: passedEvidence(), taskResult }))?.tests.status, 'passed');
  const draft = { cause: '原因', impact: '影响', suggestion: '建议', conclusion: '结论' };
  assert.deepEqual(readJiraHandoffReport(report({ version: 1, jiraHandoff: draft, taskResult })), draft);
  const stage = { status: 'pending', evidence: '' };
  assert.equal(requirementProgressReportSchema.safeParse({ version: 1, taskResult, requirementProgress: { issueKeys: [],
    stages: { intake: stage, tasks: stage, design: stage, development: stage, verification: stage, handoff: stage } } }).success, true);
});

const record = (overrides: Partial<AgentWorkflowRecord> = {}): AgentWorkflowRecord => ({
  id: '11111111-2222-3333-4444-555555555555', templateId: 'engineering', parentConversationId: 'main', objective: '修复', attachmentIds: [],
  acceptanceCriteria: [{ id: 'AC-1', text: '接口返回正确' }], allowedPaths: [], maxRounds: 2, escalated: false, decisions: [],
  createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z', ...overrides });
let clock = 0;
const run = (stage: AgentWorkflowStage, step: number, round: number, result: string, extra: Partial<AgentRun> = {}): AgentRun => ({
  id: `run-${step}-${clock}`, provider: stage === 'review' ? 'claude' : 'codex', mode: 'agent', accessMode: 'full',
  model: 'm', reasoningEffort: 'high', objective: stage, workspacePath: '/ws', branch: '', headSha: '', status: 'completed', sessionId: 's', pid: null,
  result, error: '', events: [], resultReady: true, changedFiles: stage === 'implement' ? [{ path: 'server/a.ts', status: 'modified' }] : [],
  task: { parentConversationId: 'main', dependsOnConversationIds: [], role: stage === 'implement' ? 'worker' : stage === 'verify' ? 'verifier' : 'reviewer',
    title: stage, source: 'workflow', workflow: { id: record().id, templateId: 'engineering', stage, round, step } },
  createdAt: new Date(Date.UTC(2026, 9, 26, 0, 0, clock++)).toISOString(), updatedAt: '2026-10-26T00:00:00.000Z', ...extra });
const version = (value: string) => ({ kind: 'git-tree' as const, value });

test('流程推导：实现 → 计算版本 → 验证 → 审查 → 版本一致才进入待验收', () => {
  const implement = run('implement', 1, 0, implemented());
  let evaluation = evaluateWorkflow(record(), [implement]);
  assert.deepEqual(evaluation.needsSnapshot, { runId: implement.id, stage: 'implement' });
  implement.workflowSnapshot = version('t1');
  evaluation = evaluateWorkflow(record(), [implement]);
  assert.deepEqual(evaluation.next, { stage: 'verify', round: 0, step: 2, reason: '实现完成' });
  const verify = run('verify', 2, 0, verified([{ id: 'AC-1', status: 'passed' }]), { workflowSnapshot: version('t1') });
  assert.equal(evaluateWorkflow(record(), [implement, verify]).next?.stage, 'review');
  const review = run('review', 3, 0, reviewed('approved'));
  assert.equal(evaluateWorkflow(record(), [implement, verify, review]).needsSnapshot?.stage, 'review');
  review.workflowSnapshot = version('t2');
  const stale = evaluateWorkflow(record(), [implement, verify, review]);
  assert.deepEqual([stale.summary.state, stale.next?.stage, stale.next?.round], ['verifying', 'verify', 0]);
  review.workflowSnapshot = version('t1');
  const done = evaluateWorkflow(record(), [implement, verify, review]);
  assert.equal(done.summary.state, 'awaiting_acceptance');
  assert.equal(done.next, undefined);
  assert.deepEqual(done.summary.actions, ['takeover', 'cancel']);
});

test('流程推导：旧记录的返工上限不再生效，持续返工；运行中断仍不自动重试', () => {
  const steps: AgentRun[] = [];
  let step = 0;
  for (let round = 0; round <= 25; round += 1) {
    steps.push(run('implement', ++step, round, implemented(), { workflowSnapshot: version(`t${round}`) }));
    steps.push(run('verify', ++step, round, verified([{ id: 'AC-1', status: 'passed' }]), { workflowSnapshot: version(`t${round}`) }));
    steps.push(run('review', ++step, round, reviewed('changes_requested', [{ id: 'F-1', severity: 'major' }]), { workflowSnapshot: version(`t${round}`) }));
    const evaluation = evaluateWorkflow(record(), steps);
    assert.equal(evaluation.summary.maxRounds, null);
    assert.equal(evaluation.summary.state, 'reworking');
    assert.deepEqual([evaluation.next?.stage, evaluation.next?.round, evaluation.next?.step], ['implement', round + 1, step + 1]);
    assert.deepEqual(evaluation.summary.actions, ['takeover', 'cancel']);
    assert.throws(() => applyWorkflowDecision(record(), evaluation, 'retry', 'request-2', 'now'), /不能执行此操作/);
  }
  const interrupted = evaluateWorkflow(record(), [run('implement', 1, 0, '', { status: 'interrupted', error: '服务重启' })]);
  assert.equal(interrupted.summary.state, 'blocked');
  assert.equal(interrupted.next, undefined);
  assert.ok(interrupted.summary.actions.includes('retry'));
  const errored = evaluateWorkflow(record({ dispatchError: { step: 2, message: '副本创建失败', at: 'now' } }),
    [run('implement', 1, 0, implemented(), { workflowSnapshot: version('t') })]);
  assert.match(errored.summary.reason, /副本创建失败/);
  assert.equal(errored.next, undefined);
  assert.equal(evaluateWorkflow(record({ closed: { action: 'cancel', at: 'now' } }), steps).summary.state, 'cancelled');
});

test('审查期间候选版本多次变化，持续重新验证并只接受同一版本证据', () => {
  const steps = [run('implement', 1, 0, implemented(), { workflowSnapshot: version('t0') })];
  for (let revision = 1; revision <= 6; revision += 1) {
    steps.push(run('verify', revision * 2, 0, verified([{ id: 'AC-1', status: 'passed' }]), { workflowSnapshot: version(`t${revision - 1}`) }));
    steps.push(run('review', revision * 2 + 1, 0, reviewed('approved'), { workflowSnapshot: version(`t${revision}`) }));
    const evaluation = evaluateWorkflow(record(), steps);
    assert.equal(evaluation.summary.state, 'verifying');
    assert.deepEqual([evaluation.next?.stage, evaluation.next?.round], ['verify', 0]);
  }
  steps.at(-1)!.workflowSnapshot = steps.at(-2)!.workflowSnapshot;
  assert.equal(evaluateWorkflow(record(), steps).summary.state, 'awaiting_acceptance');
});

test('验证副本复制未提交、新增、删除和被忽略的文件；计算版本不改动真实索引', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-copy-'));
  const repository = path.join(root, 'repo');
  const copy = path.join(root, 'copy');
  const git = (...args: string[]) => exec('git', ['-C', repository, ...args]);
  try {
    await fs.mkdir(path.join(repository, 'node_modules', 'pkg'), { recursive: true });
    await git('init', '-q');
    await fs.writeFile(path.join(repository, '.gitignore'), 'node_modules/\n.env*\n');
    await fs.writeFile(path.join(repository, 'kept.ts'), 'old\n');
    await fs.writeFile(path.join(repository, 'removed.ts'), 'remove me\n');
    await git('add', '.');
    await git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
    await fs.writeFile(path.join(repository, 'kept.ts'), 'new\n');
    await fs.rm(path.join(repository, 'removed.ts'));
    await fs.writeFile(path.join(repository, 'added.ts'), 'added\n');
    await fs.writeFile(path.join(repository, '.env.local'), 'TOKEN=test\n');
    await fs.writeFile(path.join(repository, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n');
    const statusBefore = (await git('status', '--porcelain')).stdout;
    const source = await localWorkflowWorkspace.version(repository, []);
    assert.equal((await git('status', '--porcelain')).stdout, statusBefore, '计算版本不能暂存任何文件');
    await localWorkflowWorkspace.createCopy(repository, copy, []);
    assert.equal(await fs.readFile(path.join(copy, 'kept.ts'), 'utf8'), 'new\n');
    assert.equal(await fs.readFile(path.join(copy, 'added.ts'), 'utf8'), 'added\n');
    await assert.rejects(fs.access(path.join(copy, 'removed.ts')));
    assert.equal(await fs.readFile(path.join(copy, '.env.local'), 'utf8'), 'TOKEN=test\n');
    assert.equal(await fs.readFile(path.join(copy, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'module.exports = 1\n');
    assert.deepEqual(await localWorkflowWorkspace.version(copy, []), { ...source, head: source.head });
    // 验证在副本中写缓存和产物，不影响实现工作区的版本。
    await fs.mkdir(path.join(copy, '.delivery-artifacts'), { recursive: true });
    await fs.writeFile(path.join(copy, '.delivery-artifacts', 'test.log'), 'ok');
    await fs.writeFile(path.join(copy, 'cache.tmp'), 'cache');
    const artifacts = await localWorkflowWorkspace.collectArtifacts(copy, path.join(root, 'artifacts'));
    assert.deepEqual(artifacts, ['test.log']);
    await localWorkflowWorkspace.removeCopy(copy, repository);
    await assert.rejects(fs.access(copy));
    assert.deepEqual(await localWorkflowWorkspace.version(repository, []), source);
    assert.equal((await git('worktree', 'list')).stdout.trim().split('\n').length, 1, '副本 worktree 已移除');
    assert.match(await localWorkflowWorkspace.diff(repository, (await git('rev-parse', 'HEAD')).stdout.trim()), /added\.ts/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Git 副本保留未跟踪的嵌套仓库目录与独立元数据，版本校验不误阻塞', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-nested-repo-'));
  const repository = path.join(root, 'repo'), copy = path.join(root, 'copy');
  const relative = path.join('outputs', 'proto-repo');
  const nested = path.join(repository, relative);
  const git = (directory: string, ...args: string[]) => exec('git', ['-C', directory, ...args]);
  try {
    await fs.mkdir(nested, { recursive: true });
    await git(repository, 'init', '-q');
    await fs.writeFile(path.join(repository, 'value.js'), 'export const value = 1;\n');
    await git(repository, 'add', 'value.js');
    await git(repository, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
    await git(nested, 'init', '-q');
    await fs.writeFile(path.join(nested, 'schema.proto'), 'message Example {}\n');
    await git(nested, 'add', '.');
    await git(nested, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'nested');
    const source = await localWorkflowWorkspace.version(repository, []);
    const indexBefore = await fs.readFile(path.join(repository, '.git', 'index'));
    await localWorkflowWorkspace.createCopy(repository, copy, []);
    assert.deepEqual(await localWorkflowWorkspace.version(copy, []), source);
    const nestedCopy = path.join(copy, relative);
    assert.equal(await fs.readFile(path.join(nestedCopy, 'schema.proto'), 'utf8'), 'message Example {}\n');
    await fs.writeFile(path.join(nestedCopy, 'schema.proto'), 'message Changed {}\n');
    await git(nestedCopy, 'config', 'copy.probe', 'independent');
    assert.equal(await fs.readFile(path.join(nested, 'schema.proto'), 'utf8'), 'message Example {}\n');
    await assert.rejects(git(nested, 'config', '--get', 'copy.probe'));
    assert.deepEqual(await fs.readFile(path.join(repository, '.git', 'index')), indexBefore);
    assert.deepEqual(await localWorkflowWorkspace.version(repository, []), source);
  } finally { await localWorkflowWorkspace.removeCopy(copy, repository); await fs.rm(root, { recursive: true, force: true }); }
});

test('临时索引保留 racy-clean 时间边界，同尺寸同时间源码改写仍进入候选版本', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-racy-index-'));
  const repository = path.join(root, 'repo'), copy = path.join(root, 'copy');
  const git = (...args: string[]) => exec('git', ['-C', repository, ...args]);
  try {
    await fs.mkdir(repository); await git('init', '-q');
    await git('config', 'core.trustctime', 'false');
    await git('config', 'core.checkstat', 'minimal');
    const file = path.join(repository, 'value.js'), timestamp = 946684800;
    await fs.writeFile(file, 'a-b\n'); await fs.utimes(file, timestamp, timestamp);
    await git('add', '.'); await git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
    const baseTree = (await git('rev-parse', 'HEAD^{tree}')).stdout.trim();
    const indexPath = path.join(repository, '.git', 'index');
    // 固定同秒边界，避免回归测试依赖执行速度：真实索引应强制重算此文件。
    await fs.utimes(indexPath, timestamp, timestamp);
    await fs.writeFile(file, 'a+b\n'); await fs.utimes(file, timestamp, timestamp);
    const indexBefore = await fs.readFile(indexPath), statBefore = await fs.stat(indexPath);
    const candidate = await localWorkflowWorkspace.version(repository, []);
    assert.notEqual(candidate.value, baseTree, '复制索引不能因新 mtime 而把改写误判为干净');
    assert.deepEqual(await fs.readFile(indexPath), indexBefore);
    assert.equal((await fs.stat(indexPath)).mtimeMs, statBefore.mtimeMs);
    await localWorkflowWorkspace.createCopy(repository, copy, []);
    assert.equal(await fs.readFile(path.join(copy, 'value.js'), 'utf8'), 'a+b\n');
    assert.equal((await localWorkflowWorkspace.version(copy, [])).value, candidate.value);
  } finally { await localWorkflowWorkspace.removeCopy(copy, repository); await fs.rm(root, { recursive: true, force: true }); }
});

test('Git 验证副本独立复制实现者的被忽略产物，不从依赖来源补回', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-artifact-copy-'));
  const repository = path.join(root, 'repo');
  const copy = path.join(root, 'copy');
  const dependencies = path.join(root, 'dependencies');
  const artifactPath = (workspace: string, name = '') => path.join(workspace, '.delivery-artifacts', name);
  const git = (...args: string[]) => exec('git', ['-C', repository, ...args]);
  try {
    await fs.mkdir(repository, { recursive: true });
    await git('init', '-q');
    await fs.writeFile(path.join(repository, '.gitignore'), '.delivery-artifacts/\n');
    await git('add', '.');
    await git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
    await fs.mkdir(artifactPath(repository), { recursive: true });
    await fs.writeFile(artifactPath(repository, 'before.log'), 'original failure\n');
    await fs.writeFile(artifactPath(repository, 'after.log'), 'implementation passed\n');
    await fs.mkdir(artifactPath(dependencies), { recursive: true });
    await fs.writeFile(artifactPath(dependencies, 'foreign.log'), 'unrelated evidence\n');

    await localWorkflowWorkspace.createCopy(repository, copy, [dependencies]);
    assert.equal(await fs.readFile(artifactPath(copy, 'before.log'), 'utf8'), 'original failure\n');
    assert.equal(await fs.readFile(artifactPath(copy, 'after.log'), 'utf8'), 'implementation passed\n');
    assert.equal((await fs.lstat(artifactPath(copy))).isSymbolicLink(), false);
    await assert.rejects(fs.access(artifactPath(copy, 'foreign.log')));
    await fs.writeFile(artifactPath(copy, 'before.log'), 'verifier output\n');
    assert.equal(await fs.readFile(artifactPath(repository, 'before.log'), 'utf8'), 'original failure\n');
    await localWorkflowWorkspace.removeCopy(copy, repository);

    await fs.rm(artifactPath(repository), { recursive: true });
    await localWorkflowWorkspace.createCopy(repository, copy, [dependencies]);
    await assert.rejects(fs.access(artifactPath(copy)), '源工作区没有产物时，不应读取其他来源的产物');
    await localWorkflowWorkspace.removeCopy(copy, repository);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('非 Git 工作区按登记改动计算版本，副本整体克隆', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-plain-'));
  const workspace = path.join(root, 'plain');
  const copy = path.join(root, 'copy');
  try {
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'src', 'a.ts'), 'a\n');
    const before = await localWorkflowWorkspace.version(workspace, ['src/a.ts']);
    assert.equal(before.kind, 'changed-files');
    await localWorkflowWorkspace.createCopy(workspace, copy, []);
    assert.deepEqual(await localWorkflowWorkspace.version(copy, ['src/a.ts']), before);
    await fs.writeFile(path.join(workspace, 'src', 'a.ts'), 'changed\n');
    assert.notEqual((await localWorkflowWorkspace.version(workspace, ['src/a.ts'])).value, before.value);
    await assert.rejects(localWorkflowWorkspace.version(workspace, ['../outside.ts']), /越出工作区/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Claude 额度错误可识别；改用 Codex 时审查避开实现者用过的模型', () => {
  for (const diagnostic of ['Claude AI usage limit reached|1761460000', "You've hit your session limit · resets 3pm", 'API Error: 429 rate_limit_error']) {
    assert.equal(isAgentQuotaExhaustedError(agentCliFailureMessage('claude', 1, diagnostic)), true, diagnostic);
  }
  assert.equal(isAgentQuotaExhaustedError(agentCliFailureMessage('claude', 1, 'not logged in')), false);
  assert.equal(isAgentQuotaExhaustedError(agentCliFailureMessage('claude', 1, 'segmentation fault')), false);
  assert.deepEqual(codexFallbackFor(agentRoleProfiles.frontend), { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high' });
  assert.equal(codexFallbackFor(reviewChoiceFor('codex'), ['gpt-6.1-sol']).model, 'gpt-6-astra');
  assert.equal(codexFallbackFor(reviewChoiceFor('codex'), ['gpt-6-astra']).model, 'gpt-6.1-sol');
});

test('已存在的 ignored 或未忽略产物日志不进入候选树，也不使Git快照失败', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-reserved-logs-'));
  try {
    await exec('git', ['-C', root, 'init', '-q', '-b', 'main']);
    await fs.writeFile(path.join(root, 'code.js'), 'code');
    await fs.writeFile(path.join(root, '.gitignore'), '.delivery-artifacts/\n');
    await exec('git', ['-C', root, 'add', '.']);
    await exec('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', 'base']);
    const before = await localWorkflowWorkspace.version(root, []);
    await fs.mkdir(path.join(root, '.delivery-artifacts')); await fs.writeFile(path.join(root, '.delivery-artifacts/test.log'), 'log');
    assert.deepEqual(await localWorkflowWorkspace.version(root, []), before);
    await fs.writeFile(path.join(root, '.gitignore'), '');
    const unignored = await localWorkflowWorkspace.version(root, []);
    await fs.writeFile(path.join(root, '.delivery-artifacts/test.log'), 'new log');
    assert.deepEqual(await localWorkflowWorkspace.version(root, []), unignored);
    const files = await exec('git', ['-C', root, 'ls-tree', '-r', '--name-only', unignored.value]);
    assert.doesNotMatch(files.stdout, /delivery-artifacts/);
    assert.doesNotMatch((await exec('git', ['-C', root, 'ls-files'])).stdout, /delivery-artifacts/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
