import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  anchorFindingsToDiff,
  analyzeUnifiedDiff,
  buildCrossRoundFindingLedger,
  buildSmartCommitMessage,
  buildStructuredMergeRequestDescription,
  discoverRepositoryGuidelines,
  formatDiffTriageForPrompt,
  formatFindingLedgerForPrompt,
  formatInlineReviewChecklistMarkdown,
  formatRepositoryGuidelinesForPrompt,
  scanDiffHygieneIssues,
} from '../server/pr-review-intelligence.js';
import { createAgentRemoteDelivery } from '../server/agent-remote-delivery.js';
import { prepareProjectMergeRequest, updateProjectMergeRequestDescription } from '../server/project-merge-request.js';
import { executeProjectGitAction, readProjectGitSnapshot } from '../server/project-git.js';
import { deliverJiraDevMergeRequest } from '../server/jira-dev-automation-mr.js';
import { buildWorkflowContext, writeReviewMaterials } from '../server/agent-workflow.js';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import { createAgentTeamService } from '../server/agent-team-service.js';
import { emptyDeliveryEvidence } from '../shared/delivery-acceptance.js';
import { evaluateWorkflow, type AgentWorkflowRecord } from '../shared/agent-workflow.js';
import {
  buildTaskFlowReportSubmitEnvelope,
  buildTaskFlowReviewReport,
  formatReviewReportMarkdown,
} from '../shared/taskflow-review-bridge.js';
import type { AgentProvider, AgentRun, AgentRuntimeHealth } from '../shared/agent-runtime.js';

const exec = promisify(execFile);
const git = async (directory: string, ...args: string[]) => (await exec('git', ['-C', directory, ...args])).stdout.trim();

test('Diff 预筛：精确标注新文件行号、折叠锁文件并命中确定性高危规则', () => {
  const patch = [
    'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml',
    'index 1111111..2222222 100644',
    '--- a/pnpm-lock.yaml',
    '+++ b/pnpm-lock.yaml',
    '@@ -1,2 +1,4 @@',
    ' lockfileVersion: 9.0',
    '+  foo: 1.0.0',
    '+  bar: 2.0.0',
    'diff --git a/server/auth-guard.ts b/server/auth-guard.ts',
    'index 3333333..4444444 100644',
    '--- a/server/auth-guard.ts',
    '+++ b/server/auth-guard.ts',
    '@@ -10,4 +10,6 @@ export function checkAccess(req: Request) {',
    '   const header = req.headers.get("authorization");',
    '-  return Boolean(header);',
    '+  const api_secret = "fixture_credential_placeholder_99";',
    '+  return verifyToken(header, api_secret);',
    '+  // end',
    ' }',
  ].join('\n');

  const triage = analyzeUnifiedDiff(patch);
  assert.equal(triage.totals.files, 2);
  assert.equal(triage.totals.generatedFiles, 1);
  assert.equal(triage.totals.sourceFiles, 1);
  assert.equal(triage.totals.testFiles, 0);
  assert.deepEqual(triage.generatedPaths, ['pnpm-lock.yaml']);

  const secretRisk = triage.risks.find(item => item.category === 'secret-hygiene');
  assert.ok(secretRisk);
  assert.equal(secretRisk.file, 'server/auth-guard.ts');
  assert.equal(secretRisk.line, 11, '应精确计算新文件中的新增行号');

  const authRisk = triage.risks.find(item => item.category === 'auth-permission');
  assert.ok(authRisk);
  assert.equal(authRisk.line, 12);

  assert.match(triage.focusedPatch, /pnpm-lock\.yaml.*生成物\/锁文件已折叠/s);
  assert.match(triage.focusedPatch, /\s+11 \+   const api_secret =/);
  assert.match(triage.focusedPatch, /\s+12 \+   return verifyToken/);

  const promptText = formatDiffTriageForPrompt(triage);
  assert.match(promptText, /未检测到测试文件修改/);
  assert.match(promptText, /server\/auth-guard\.ts:11/);
});

test('超过 30 个文件的大改动自动聚类机械变换，保留非机械与高危例外全审', () => {
  const blocks: string[] = [];
  for (let i = 1; i <= 32; i += 1) {
    const name = `src/components/Item${String(i).padStart(2, '0')}.ts`;
    blocks.push([
      `diff --git a/${name} b/${name}`,
      'index 1111111..2222222 100644',
      `--- a/${name}`,
      `+++ b/${name}`,
      '@@ -1,2 +1,2 @@',
      '-import { oldHelper } from "../legacy";',
      '+import { newHelper } from "../modern";',
    ].join('\n'));
  }
  blocks.push([
    'diff --git a/server/custom-security.ts b/server/custom-security.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/server/custom-security.ts',
    '@@ -0,0 +1,3 @@',
    '+export function verifyToken(input: string) {',
    '+  return input.length > 10;',
    '+}',
  ].join('\n'));

  const triage = analyzeUnifiedDiff(blocks.join('\n'));
  assert.equal(triage.samplingPlan.triggered, true);
  assert.equal(triage.samplingPlan.totalFiles, 33);
  assert.ok(triage.samplingPlan.mandatoryFiles.includes('server/custom-security.ts'), '高危及独立非机械改动必须进入全审清单');
  assert.equal(triage.samplingPlan.clusters.length, 1);
  assert.equal(triage.samplingPlan.clusters[0]!.count, 32);
  assert.equal(triage.samplingPlan.sampledMechanicalFiles.length, 4, '32 个同类机械文件按 10% 向上取整抽样 4 个');
});

test('跨轮次审查账本：聚合重复未过问题并区分文件是否在本轮返工中改动', () => {
  const ledger = buildCrossRoundFindingLedger([
    {
      round: 0,
      reason: '审查退回',
      findings: [
        { id: 'F-1', severity: 'blocker', file: 'server/api.ts', line: 20, problem: '缺少空值校验', expectation: '增加空值返回 400' },
        { id: 'F-2', severity: 'major', file: 'server/db.ts', line: 45, problem: '未释放连接锁', expectation: 'finally 中释放锁' },
      ],
    },
    {
      round: 1,
      reason: '二次退回',
      findings: [
        { id: 'F-1b', severity: 'blocker', file: 'server/api.ts', line: 22, problem: '缺少空值校验', expectation: '增加空值返回 400' },
        { id: 'F-2', severity: 'major', file: 'server/db.ts', line: 45, problem: '未释放连接锁', expectation: 'finally 中释放锁' },
      ],
      failedCriteria: [{ id: 'AC-2', status: 'failed', evidence: '审查阶段契约未核验' }],
    },
  ], { modifiedSinceLastReview: ['server/db.ts'] });

  assert.ok(ledger);
  assert.equal(ledger.previousRound, 1);
  assert.equal(ledger.totalOpenFindings, 2);
  assert.equal(ledger.blockerCount, 1);
  assert.equal(ledger.untouchedFileFindings, 1);
  assert.equal(ledger.repeatedFindings, 2);

  const apiItem = ledger.items.find(item => item.file === 'server/api.ts')!;
  const dbItem = ledger.items.find(item => item.file === 'server/db.ts')!;
  assert.equal(apiItem.occurrences, 2);
  assert.equal(apiItem.fileState, 'unchanged_since_last_review');
  assert.equal(dbItem.fileState, 'modified_since_last_review');

  const prompt = formatFindingLedgerForPrompt(ledger);
  assert.match(prompt, /连续 2 轮未过/);
  assert.match(prompt, /该文件本轮未改动，重点核查是否漏修/);
  assert.match(prompt, /该文件本轮已修改，核验修复完整性与回归/);
  assert.match(prompt, /AC-2\(failed\)/);
});

test('MR 描述自动生成：Codeup 生成完整 Walkthrough 表格，GitHub/GitLab 生成安全长度预填 URL', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mr-walkthrough-')));
  t.after(() => fs.rm(root, { force: true, recursive: true }));
  const repo = path.join(root, 'repo');
  const remote = path.join(root, 'remote.git');
  const dataDirectory = path.join(root, 'data');
  await fs.mkdir(path.join(repo, 'server'), { recursive: true });
  await fs.mkdir(dataDirectory, { recursive: true });

  await git(repo, 'init', '-qb', 'main');
  await git(repo, 'config', 'user.name', 'Fixture');
  await git(repo, 'config', 'user.email', 'fixture@localhost');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(repo, 'server', 'service.ts'), 'export const v = 1;\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-qm', 'init');
  const baseSha = await git(repo, 'rev-parse', 'HEAD');
  await git(root, 'init', '--bare', '-q', remote);
  await git(repo, 'push', '-q', remote, 'main');

  const branchName = 'feature/APEX-88';
  const taskWorktree = path.join(root, 'task-worktree');
  await git(repo, 'worktree', 'add', '-qb', branchName, taskWorktree);
  await fs.writeFile(path.join(taskWorktree, 'server', 'service.ts'), 'export function verifyToken(t: string) { return Boolean(t); }\n');
  await fs.writeFile(path.join(taskWorktree, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  await git(taskWorktree, 'add', '.');
  await git(taskWorktree, 'commit', '-qm', 'feat: 增加令牌核验逻辑');
  const verifiedHead = await git(taskWorktree, 'rev-parse', 'HEAD');
  await git(taskWorktree, 'push', '-q', remote, `HEAD:refs/heads/${branchName}`);

  const ssh = path.join(root, 'ssh');
  await fs.writeFile(ssh, `#!/bin/sh\nexec git-upload-pack '${remote}'\n`, { mode: 0o700 });
  await git(repo, 'config', 'core.sshCommand', ssh);
  await git(repo, 'config', 'ssh.variant', 'ssh');
  const repoPath = '64ad9c6e702c0cacad9a2168/team/project';
  await git(repo, 'remote', 'add', 'origin', `git@codeup.aliyun.com:${repoPath}.git`);
  await git(repo, 'remote', 'add', 'gh', 'git@github.com:org/project.git');
  await fs.writeFile(path.join(dataDirectory, 'yunxiao-credentials.json'), JSON.stringify({ token: 'fixture-token' }));

  let postedBody: Record<string, unknown> | undefined;
  const fetcher: typeof fetch = async (url, init) => {
    const target = new URL(String(url));
    if (init?.method === 'POST') {
      postedBody = JSON.parse(String(init.body));
      return Response.json({
        localId: 9, sourceBranch: branchName, targetBranch: 'main', sourceProjectId: 123, targetProjectId: 123,
        detailUrl: `https://codeup.aliyun.com/${repoPath}/change/9`, status: 'UNDER_REVIEW',
        reviewers: [{ userId: 'u-1', name: '李四', username: 'lisi', memberType: 'USERS', state: 'active' }],
      });
    }
    if (target.pathname.endsWith('/members')) {
      return Response.json([{ userId: 'u-1', name: '李四', username: 'lisi', memberType: 'USERS', state: 'active' }]);
    }
    if (target.pathname.endsWith('/changeRequests/9')) {
      return Response.json({
        localId: 9, sourceBranch: branchName, targetBranch: 'main', sourceProjectId: 123, targetProjectId: 123,
        detailUrl: `https://codeup.aliyun.com/${repoPath}/change/9`, status: 'UNDER_REVIEW',
        reviewers: [{ userId: 'u-1' }],
      });
    }
    if (target.pathname.endsWith('/changeRequests')) return Response.json([]);
    return Response.json({ id: 123, pathWithNamespace: repoPath });
  };

  const preparedCodeup = await prepareProjectMergeRequest(
    { path: repo, remote: 'origin', sourceBranch: branchName, targetBranch: 'main' },
    { dataDirectory, fetcher },
  );
  assert.match(preparedCodeup.description, /### 变更概览/);
  assert.match(preparedCodeup.description, /### 改动文件 Walkthrough/);
  assert.match(preparedCodeup.description, /`server\/service\.ts`/);
  assert.match(preparedCodeup.description, /鉴权\/权限/);
  assert.match(preparedCodeup.description, /生成物\/锁文件变更：`pnpm-lock\.yaml`/);

  const customPrepared = await prepareProjectMergeRequest(
    { path: repo, remote: 'origin', sourceBranch: branchName, targetBranch: 'main', description: '手写自定义说明' },
    { dataDirectory, fetcher },
  );
  assert.equal(customPrepared.description, '手写自定义说明');

  const preparedGithub = await prepareProjectMergeRequest(
    { path: repo, remote: 'gh', sourceBranch: branchName, targetBranch: 'main' },
    { dataDirectory, fetcher },
  );
  const ghUrl = new URL(preparedGithub.url);
  assert.ok(preparedGithub.url.length < 4000, '浏览器跳转 URL 长度必须保持安全');
  assert.match(ghUrl.searchParams.get('body') || '', /### 变更概览/);
  assert.match(ghUrl.searchParams.get('body') || '', /`server\/service\.ts`/);

  const delivered = await deliverJiraDevMergeRequest({
    issue: { key: 'APEX-88', summary: '接入令牌检查', project: 'APEX', parent: null },
    settings: {
      autoCreateMergeRequest: true,
      reviewer: '李四',
      projectProfiles: [{
        id: 'p1', name: 'APEX', repositoryUrl: `https://codeup.aliyun.com/${repoPath}`,
        localPath: repo, runtimeCommand: 'pnpm dev', runtimeEnvironment: 'test', targetBranch: 'main',
        jiraProjects: [], components: [], labels: [],
      }],
    },
    sourceProjectPath: repo,
    workspacePath: taskWorktree,
    branchName,
    baseSha,
    verifiedHead,
  }, { dataDirectory, fetcher });

  assert.equal(delivered.status, 'created', delivered.message);
  const sentDesc = String(postedBody?.description || '');
  assert.match(sentDesc, /关联 Jira：APEX-88/);
  assert.match(sentDesc, new RegExp(`已验证并回读的源提交：${verifiedHead}`));
  assert.match(sentDesc, /### 改动文件 Walkthrough/);
  assert.match(sentDesc, /`server\/service\.ts`/);
});

test('标准工作流与高级团队流程：多轮审查自动生成预筛材料并注入跨轮次未决问题账本', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'review-ledger-flow-')));
  t.after(() => fs.rm(root, { force: true, recursive: true }));

  // 1. 验证 writeReviewMaterials 与 buildWorkflowContext 持久恢复能力
  const materialsDir = path.join(root, 'materials');
  const workflowRecord: AgentWorkflowRecord = {
    id: '22222222-2222-3333-4444-555555555555',
    templateId: 'engineering',
    parentConversationId: 'conv-1',
    objective: '加固权限检查',
    attachmentIds: [],
    acceptanceCriteria: [{ id: 'AC-1', text: '无权限返回 403' }],
    allowedPaths: ['server/**'],
    maxRounds: null,
    escalated: false,
    decisions: [],
    createdAt: '2026-11-14T00:00:00.000Z',
    updatedAt: '2026-11-14T00:00:00.000Z',
  };
  await writeReviewMaterials(materialsDir, {
    record: workflowRecord,
    diff: [
      'diff --git a/server/guard.ts b/server/guard.ts',
      '--- a/server/guard.ts',
      '+++ b/server/guard.ts',
      '@@ -1,2 +1,3 @@',
      ' export function guard() {',
      '+  return checkPermission();',
      ' }',
    ].join('\n'),
    changedFiles: [{ path: 'server/guard.ts', status: 'modified' }],
    implementationResult: '```delivery-report\n{"version":1,"taskResult":{"role":"implementer","status":"succeeded","summary":"ok"}}\n```',
    verificationResult: `\`\`\`delivery-report\n${JSON.stringify({
      version: 1,
      validationEvidence: { ...emptyDeliveryEvidence(), tests: { status: 'passed', evidence: 'ok', sha: '' } },
      taskResult: { role: 'verifier', status: 'succeeded', acceptance: [{ id: 'AC-1', status: 'passed', evidence: 'ok' }] },
    })}\n\`\`\``,
    verificationArtifacts: [],
    priorReviews: [{
      round: 0,
      step: 3,
      reason: '退回',
      findings: [{ id: 'F-9', severity: 'blocker', file: 'server/untouched.ts', line: 8, problem: '遗漏管理员越权检查', expectation: '补充角色判断' }],
    }],
    modifiedSinceLastReview: ['server/guard.ts'],
  });

  const savedLedger = JSON.parse(await fs.readFile(path.join(materialsDir, 'finding-ledger.json'), 'utf8'));
  assert.equal(savedLedger.items[0].latestId, 'F-9');
  assert.equal(savedLedger.items[0].fileState, 'unchanged_since_last_review');

  const reviewRun: AgentRun = {
    id: 'run-review-2', provider: 'claude', mode: 'agent', accessMode: 'full', model: 'claude-opus-5-5', reasoningEffort: 'high',
    objective: 'review', workspacePath: root, branch: 'feature/x', headSha: '', status: 'running', sessionId: '', pid: null,
    result: '', error: '', events: [], createdAt: '2026-11-14T00:00:00.000Z', updatedAt: '2026-11-14T00:00:00.000Z',
    task: { parentConversationId: 'conv-1', dependsOnConversationIds: [], role: 'reviewer', title: '审查', source: 'workflow',
      workflow: { id: workflowRecord.id, templateId: 'engineering', stage: 'review', round: 1, step: 6 } },
  };
  const builtContext = buildWorkflowContext({ record: workflowRecord, run: reviewRun, reviewMaterials: materialsDir });
  assert.match(builtContext, /Diff 预筛摘要/);
  assert.match(builtContext, /F-9 · blocker/);
  assert.match(builtContext, /server\/untouched\.ts:8/);

  // 2. 验证 createAgentTeamService 多轮返工自动把上一轮 findings 注入第二轮 reviewer
  const source = path.join(root, 'team-repo');
  const data = path.join(root, 'team-data');
  await fs.mkdir(path.join(source, 'src'), { recursive: true });
  await fs.writeFile(path.join(source, 'src/auth.ts'), 'export const check = () => false;\n');
  await fs.writeFile(path.join(source, '.gitignore'), '.delivery-artifacts/\n');
  await git(source, 'init', '-qb', 'main');
  await git(source, 'config', 'user.name', 'Fixture');
  await git(source, 'config', 'user.email', 'fixture@localhost');
  await git(source, 'config', 'commit.gpgsign', 'false');
  await git(source, 'add', '.');
  await git(source, 'commit', '-qm', 'init');

  const health = (provider: AgentProvider): AgentRuntimeHealth => ({
    provider, label: provider, binary: `/bin/${provider}`, version: '1.0', authenticated: true, ready: true, message: 'ok',
    modes: ['agent', 'ask', 'plan'],
    models: provider === 'codex'
      ? ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'].map(id => ({ id, label: id, efforts: ['low', 'medium', 'high'] }))
      : provider === 'claude'
        ? ['sonnet', 'opus', 'fable'].map(id => ({
          id,
          label: id === 'sonnet' ? 'Sonnet 5.5' : id === 'opus' ? 'Opus 5.5' : 'Fable 5.1',
          efforts: ['low', 'medium', 'high'],
        }))
        : [{ id: 'composer-2.5', label: 'Composer 2.5' }],
    defaultModel: '', writable: true, checkedAt: new Date().toISOString(),
  });

  const reviewerPrompts: string[] = [];
  let implCount = 0;
  let reviewCount = 0;
  const wrapReport = (payload: object) => `\`\`\`delivery-report\n${JSON.stringify({ version: 1, ...payload })}\n\`\`\``;
  const adapters: AgentRuntimeAdapter[] = (['codex', 'claude', 'cursor'] as const).map(provider => ({
    id: provider,
    health: async () => health(provider),
    execute: async context => {
      await context.onSession(`${provider}-${context.run.id}`);
      const role = context.run.team?.profileId;
      if (!role) return 'ok';
      if (role === 'leader') {
        return wrapReport({
          taskPlan: {
            templateId: 'engineering', reason: 'test', risk: 'medium',
            acceptanceCriteria: [{ id: 'AC-1', text: '鉴权生效', source: 'user' }],
            allowedPaths: ['src/**'], needsAnalyst: false, needsArchitect: false, questions: [], risks: [], ownership: [], shared: [],
          },
        });
      }
      if (role === 'engineer') {
        implCount += 1;
        await fs.writeFile(path.join(context.run.workspacePath, 'src/auth.ts'), `export const verifyToken = () => ${implCount};\n`);
        return wrapReport({ taskResult: { role: 'implementer', status: 'succeeded', summary: `第${implCount}次实现` } });
      }
      if (role === 'verifier') {
        return wrapReport({
          validationEvidence: { ...emptyDeliveryEvidence(), tests: { status: 'passed', evidence: 'ok', sha: '' } },
          taskResult: { role: 'verifier', status: 'succeeded', acceptance: [{ id: 'AC-1', status: 'passed', evidence: 'ok' }] },
        });
      }
      if (role === 'reviewer') {
        reviewCount += 1;
        reviewerPrompts.push(context.run.teamContext || '');
        if (reviewCount === 1) {
          return wrapReport({
            taskResult: {
              role: 'reviewer', status: 'succeeded', verdict: 'changes_requested', summary: '退回修复',
              findings: [{ id: 'F-AUTH-1', severity: 'blocker', file: 'src/auth.ts', line: 1, problem: '令牌过期未校验', expectation: '校验 exp 字段' }],
            },
          });
        }
        return wrapReport({ taskResult: { role: 'reviewer', status: 'succeeded', verdict: 'approved', summary: 'F-AUTH-1 已修复', findings: [] } });
      }
      throw new Error(`unexpected role ${role}`);
    },
  }));

  const runtime = await createAgentRuntimeService(data, { adapters });
  const team = await createAgentTeamService(data, runtime);
  try {
    const main = await runtime.start({ provider: 'codex', model: 'gpt-6.1-sol', mode: 'ask', objective: 'init', workspacePath: source });
    for (let i = 0; i < 200 && !runtime.getRun(main.id)?.resultReady; i += 1) await new Promise(r => setTimeout(r, 10));
    const created = await team.create(main.id, { objective: '更新鉴权逻辑', attachmentIds: [], requestId: 'req-1' });
    for (let i = 0; i < 300 && !['awaiting_plan', 'blocked'].includes(team.getTask(created.id).state); i += 1) await new Promise(r => setTimeout(r, 10));
    await team.plan(created.id, { expectedRevision: team.getTask(created.id).planRevision, action: 'confirm', requestId: 'req-2' });
    for (let i = 0; i < 500 && !['awaiting_acceptance', 'blocked', 'needs_decision'].includes(team.getTask(created.id).state); i += 1) {
      await new Promise(r => setTimeout(r, 15));
    }
    const finalTask = team.getTask(created.id);
    assert.equal(finalTask.state, 'awaiting_acceptance', finalTask.reason || '');
    assert.equal(reviewerPrompts.length, 2);
    assert.match(reviewerPrompts[0]!, /Diff 预筛摘要/);
    assert.match(reviewerPrompts[0]!, /鉴权\/权限\/会话边界/);
    assert.doesNotMatch(reviewerPrompts[0]!, /跨轮次审查状态追踪/);
    assert.match(reviewerPrompts[1]!, /跨轮次审查状态追踪/);
    assert.match(reviewerPrompts[1]!, /F-AUTH-1 · blocker/);
    assert.match(reviewerPrompts[1]!, /该文件本轮已修改，核验修复完整性与回归/);
  } finally {
    await team.close();
    await runtime.close();
  }
});

test('仓库工程规范自动发现：提取根目录与改动文件祖先目录约定，拒绝符号链接越界并注入审查材料', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'repo-guidelines-')));
  t.after(() => fs.rm(root, { force: true, recursive: true }));

  const workspace = path.join(root, 'workspace');
  const outsideFile = path.join(root, 'outside-secret.md');
  await fs.writeFile(outsideFile, 'SHOULD_NEVER_BE_READ');
  await fs.mkdir(path.join(workspace, 'server', 'payments'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'server', 'unrelated'), { recursive: true });

  await fs.writeFile(
    path.join(workspace, 'AGENTS.md'),
    '# 全局规范\n- 所有金额计算必须使用整数分（cents），禁止浮点数运算。\n- 历史遗留文案：只读独立审查。\n',
  );
  await fs.writeFile(
    path.join(workspace, 'server', 'payments', 'CLAUDE.md'),
    '# 支付模块规范\n- 幂等键（idempotencyKey）必须落库唯一索引。\n',
  );
  await fs.writeFile(
    path.join(workspace, 'server', 'unrelated', 'AGENTS.md'),
    '# 无关目录规范\n- 不应被本次审查加载。\n',
  );
  await fs.symlink(outsideFile, path.join(workspace, 'server', 'payments', 'best_practices.md'));

  const bundle = await discoverRepositoryGuidelines(workspace, ['server/payments/checkout.ts']);
  assert.deepEqual(bundle.files.map(item => item.path), ['AGENTS.md', 'server/payments/CLAUDE.md']);
  assert.doesNotMatch(bundle.markdown, /SHOULD_NEVER_BE_READ/);
  assert.doesNotMatch(bundle.markdown, /无关目录规范/);
  assert.doesNotMatch(bundle.markdown, /只读独立审查/, '旧版禁令短语应被安全清洗以防破坏团队提示词守卫');

  const promptSnippet = formatRepositoryGuidelinesForPrompt(bundle, { artifactHint: 'repo-guidelines.md' });
  assert.match(promptSnippet, /AGENTS\.md\[仓库全局\]/);
  assert.match(promptSnippet, /server\/payments\/CLAUDE\.md\[目录 server\/payments\/\*\*\]/);
  assert.match(promptSnippet, /整数分/);

  const materialsDir = path.join(root, 'review-materials');
  const workflowRecord: AgentWorkflowRecord = {
    id: '33333333-2222-3333-4444-555555555555',
    templateId: 'engineering',
    parentConversationId: 'conv-2',
    objective: '新增支付结算接口',
    attachmentIds: [],
    acceptanceCriteria: [{ id: 'AC-1', text: '使用整数分结算' }],
    allowedPaths: ['server/payments/**'],
    maxRounds: null,
    escalated: false,
    decisions: [],
    createdAt: '2026-11-15T00:00:00.000Z',
    updatedAt: '2026-11-15T00:00:00.000Z',
  };
  await writeReviewMaterials(materialsDir, {
    record: workflowRecord,
    diff: 'diff --git a/server/payments/checkout.ts b/server/payments/checkout.ts\n--- a/server/payments/checkout.ts\n+++ b/server/payments/checkout.ts\n@@ -1 +1,2 @@\n export const ok = true;\n+export const totalCents = 100;\n',
    changedFiles: [{ path: 'server/payments/checkout.ts', status: 'modified' }],
    implementationResult: '```delivery-report\n{"version":1,"taskResult":{"role":"implementer","status":"succeeded","summary":"ok"}}\n```',
    verificationResult: `\`\`\`delivery-report\n${JSON.stringify({
      version: 1,
      validationEvidence: { ...emptyDeliveryEvidence(), tests: { status: 'passed', evidence: 'ok', sha: '' } },
      taskResult: { role: 'verifier', status: 'succeeded', acceptance: [{ id: 'AC-1', status: 'passed', evidence: 'ok' }] },
    })}\n\`\`\``,
    verificationArtifacts: [],
    workspacePath: workspace,
  });

  const savedGuidelines = await fs.readFile(path.join(materialsDir, 'repo-guidelines.md'), 'utf8');
  assert.match(savedGuidelines, /幂等键（idempotencyKey）/);

  const reviewRun: AgentRun = {
    id: 'run-review-guidelines', provider: 'claude', mode: 'agent', accessMode: 'full', model: 'claude-opus-5-5', reasoningEffort: 'high',
    objective: 'review', workspacePath: workspace, branch: 'feature/pay', headSha: '', status: 'running', sessionId: '', pid: null,
    result: '', error: '', events: [], createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:00.000Z',
    task: { parentConversationId: 'conv-2', dependsOnConversationIds: [], role: 'reviewer', title: '审查', source: 'workflow',
      workflow: { id: workflowRecord.id, templateId: 'engineering', stage: 'review', round: 0, step: 3 } },
  };
  const contextText = buildWorkflowContext({ record: workflowRecord, run: reviewRun, reviewMaterials: materialsDir });
  assert.equal(contextText.match(/审查材料目录：(\S+?)（/)?.[1], materialsDir);
  assert.match(contextText, /仓库工程规范自动提示/);
  assert.match(contextText, /幂等键/);
});

test('本地合并预览风险预筛与 Codeup 合并请求说明增量同步', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mr-sync-triage-')));
  t.after(() => fs.rm(root, { force: true, recursive: true }));

  const repo = path.join(root, 'repo');
  const remote = path.join(root, 'remote.git');
  const dataDirectory = path.join(root, 'data');
  await fs.mkdir(path.join(repo, 'server'), { recursive: true });
  await fs.mkdir(dataDirectory, { recursive: true });

  await git(repo, 'init', '-qb', 'main');
  await git(repo, 'config', 'user.name', 'Fixture');
  await git(repo, 'config', 'user.email', 'fixture@localhost');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(repo, 'server', 'route.ts'), 'export const open = true;\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-qm', 'init');
  await git(root, 'init', '--bare', '-q', remote);
  await git(repo, 'push', '-q', remote, 'main');

  await git(repo, 'switch', '-qc', 'feature/sync-mr');
  await fs.writeFile(
    path.join(repo, 'server', 'route.ts'),
    'export function checkPermission(token: string) {\n  return verifyToken(token);\n}\n',
  );
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-qm', 'feat: 初版权限接口');
  await git(repo, 'push', '-q', remote, 'HEAD:refs/heads/feature/sync-mr');

  // 切回 main 预览本地合并风险预筛
  await git(repo, 'switch', '-q', 'main');
  const snapshot = await readProjectGitSnapshot(repo);
  const sourceStub = {
    readLocalProjects: async () => ({ projects: [], checkedAt: new Date().toISOString(), roots: [] }),
  } as unknown as Parameters<typeof executeProjectGitAction>[1];
  const previewResult = await executeProjectGitAction({
    action: 'merge-preview',
    path: repo,
    ref: 'refs/heads/feature/sync-mr',
    revision: snapshot.revision,
    expectedTargetBranch: 'main',
  }, sourceStub) as { preview: { triage?: { sourceFiles: number; missingTestsWarning: boolean; risks: { category: string }[] } } };

  assert.ok(previewResult.preview.triage);
  assert.equal(previewResult.preview.triage.sourceFiles, 1);
  assert.equal(previewResult.preview.triage.missingTestsWarning, true);
  assert.ok(previewResult.preview.triage.risks.some(item => item.category === 'auth-permission'));

  // 配置 Codeup 远端并模拟追加新提交后增量同步 MR 说明
  const ssh = path.join(root, 'ssh');
  await fs.writeFile(ssh, `#!/bin/sh\nexec git-upload-pack '${remote}'\n`, { mode: 0o700 });
  await git(repo, 'config', 'core.sshCommand', ssh);
  await git(repo, 'config', 'ssh.variant', 'ssh');
  const repoPath = '64ad9c6e702c0cacad9a2168/team/project';
  const repositoryUrl = `https://codeup.aliyun.com/${repoPath}`;
  await git(repo, 'remote', 'add', 'origin', `git@codeup.aliyun.com:${repoPath}.git`);
  await fs.writeFile(path.join(dataDirectory, 'yunxiao-credentials.json'), JSON.stringify({ token: 'fixture-token' }));

  await git(repo, 'switch', '-q', 'feature/sync-mr');
  await fs.mkdir(path.join(repo, 'test'), { recursive: true });
  await fs.writeFile(path.join(repo, 'test', 'route.test.ts'), 'export const tested = true;\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-qm', 'test: 补充权限接口单测');
  await git(repo, 'push', '-q', remote, 'HEAD:refs/heads/feature/sync-mr');

  let storedDescription = '旧版简短说明';
  let mrStatus = 'UNDER_REVIEW';
  const methods: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const target = new URL(String(url));
    const method = init?.method || 'GET';
    methods.push(method);
    if (method === 'PUT' && target.pathname.endsWith('/repositories/123/changeRequests/21')) {
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(Object.keys(body), ['description']);
      storedDescription = body.description;
      return Response.json({ result: true });
    }
    if (target.pathname.endsWith('/changeRequests/21')) {
      return Response.json({
        localId: 21,
        sourceBranch: 'feature/sync-mr',
        targetBranch: 'main',
        sourceProjectId: 123,
        targetProjectId: 123,
        detailUrl: `${repositoryUrl}/change/21`,
        title: '合并权限接口',
        status: mrStatus,
        description: storedDescription,
      });
    }
    if (target.pathname.endsWith('/changeRequests')) return Response.json([]);
    return Response.json({ id: 123, pathWithNamespace: repoPath });
  };

  const prepared = await prepareProjectMergeRequest(
    { path: repo, remote: 'origin', sourceBranch: 'feature/sync-mr', targetBranch: 'main' },
    { dataDirectory, fetcher },
  );
  assert.ok(prepared.triage);
  assert.equal(prepared.triage.testFiles, 1);
  assert.equal(prepared.triage.missingTestsWarning, false);

  const synced = await updateProjectMergeRequestDescription({
    path: repo,
    remote: 'origin',
    repositoryUrl,
    id: 21,
    sourceBranch: 'feature/sync-mr',
    targetBranch: 'main',
  }, { dataDirectory, fetcher });

  assert.equal(synced.request.id, 21);
  assert.match(synced.description, /`test\/route\.test\.ts`/);
  assert.match(synced.description, /补充权限接口单测/);
  assert.equal(storedDescription, synced.description);
  assert.deepEqual(methods.slice(-3), ['GET', 'PUT', 'GET']);

  // 内容未变化时再次同步不重复发送 PUT
  const putCountBefore = methods.filter(m => m === 'PUT').length;
  await updateProjectMergeRequestDescription({
    path: repo,
    remote: 'origin',
    repositoryUrl,
    id: 21,
    sourceBranch: 'feature/sync-mr',
    targetBranch: 'main',
  }, { dataDirectory, fetcher });
  assert.equal(methods.filter(m => m === 'PUT').length, putCountBefore);

  // 已合并状态拒绝写入
  mrStatus = 'MERGED';
  await assert.rejects(
    updateProjectMergeRequestDescription({
      path: repo,
      remote: 'origin',
      repositoryUrl,
      id: 21,
      sourceBranch: 'feature/sync-mr',
      targetBranch: 'main',
      description: '尝试覆盖已合并请求',
    }, { dataDirectory, fetcher }),
    /已结束/,
  );
});

test('工作流多轮审查收敛趋势推导与 TaskFlow report_submit 载荷约束校验', () => {
  const wfRecord: AgentWorkflowRecord = {
    id: '44444444-2222-3333-4444-555555555555',
    templateId: 'engineering',
    parentConversationId: 'main',
    objective: '修复并发竞争条件',
    attachmentIds: [],
    acceptanceCriteria: [{ id: 'AC-1', text: '锁释放幂等' }],
    allowedPaths: [],
    maxRounds: null,
    escalated: false,
    decisions: [],
    createdAt: '2026-11-15T00:00:00.000Z',
    updatedAt: '2026-11-15T00:00:00.000Z',
  };

  let seq = 0;
  const snap = (v: string) => ({ kind: 'git-tree' as const, value: v });
  const makeRun = (stage: 'implement' | 'verify' | 'review', step: number, round: number, payload: object, snapshotVal: string): AgentRun => ({
    id: `wf-run-${step}`,
    provider: stage === 'review' ? 'claude' : 'codex',
    mode: 'agent',
    accessMode: 'full',
    model: stage === 'review' ? 'claude-opus-5-5' : 'gpt-6.1-sol',
    reasoningEffort: 'high',
    objective: stage,
    workspacePath: '/ws',
    branch: 'feature/lock',
    headSha: '',
    status: 'completed',
    sessionId: 's',
    pid: null,
    result: `\`\`\`delivery-report\n${JSON.stringify({ version: 1, ...payload })}\n\`\`\``,
    resultReady: true,
    error: '',
    events: [],
    changedFiles: stage === 'implement' ? [{ path: 'server/lock.ts', status: 'modified' }] : [],
    workflowSnapshot: snap(snapshotVal),
    task: {
      parentConversationId: 'main',
      dependsOnConversationIds: [],
      role: stage === 'implement' ? 'worker' : stage === 'verify' ? 'verifier' : 'reviewer',
      title: stage,
      source: 'workflow',
      workflow: { id: wfRecord.id, templateId: 'engineering', stage, round, step },
    },
    createdAt: new Date(Date.UTC(2026, 10, 15, 0, 0, seq++)).toISOString(),
    updatedAt: '2026-11-15T00:00:00.000Z',
  });

  const implPayload = { taskResult: { role: 'implementer', status: 'succeeded', summary: 'done' } };
  const verifyPayload = {
    validationEvidence: { ...emptyDeliveryEvidence(), tests: { status: 'passed', evidence: 'ok', sha: '' } },
    taskResult: { role: 'verifier', status: 'succeeded', acceptance: [{ id: 'AC-1', status: 'passed', evidence: 'ok' }] },
  };

  const runs: AgentRun[] = [
    makeRun('implement', 1, 0, implPayload, 's0'),
    makeRun('verify', 2, 0, verifyPayload, 's0'),
    makeRun('review', 3, 0, {
      taskResult: {
        role: 'reviewer',
        status: 'succeeded',
        verdict: 'changes_requested',
        summary: '首轮发现 3 个问题',
        findings: [
          { id: 'F-1', severity: 'minor', file: 'server/lock.ts', line: 5, problem: '日志命名不统一', expectation: '统一前缀' },
          { id: 'F-2', severity: 'blocker', file: 'server/lock.ts', line: 18, problem: '异常分支未释放互斥锁。高并发下死锁', expectation: '移入 finally' },
          { id: 'F-3', severity: 'major', file: 'server/lock.ts', line: 30, problem: '超时未清理定时器', expectation: 'clearTimeout' },
        ],
      },
    }, 's0'),
  ];

  const afterR0 = evaluateWorkflow(wfRecord, runs).summary;
  assert.deepEqual(afterR0.reviewConvergence, {
    reviewRounds: 1,
    initialFindings: 3,
    latestFindings: 3,
    blockerRemaining: 1,
    trend: 'single',
  });
  assert.deepEqual(afterR0.steps[2]?.reviewStats, {
    verdict: 'changes_requested',
    blockerCount: 1,
    majorCount: 1,
    minorCount: 1,
    totalFindings: 3,
  });

  // 验证 TaskFlow report_submit 载荷转换与排序
  const envelope = buildTaskFlowReportSubmitEnvelope('job_review-2026', {
    result: runs[2]!.result,
    provider: 'claude',
    model: 'claude-opus-5-5',
    objective: wfRecord.objective,
    round: 0,
    snapshotValue: 's0-tree-hash',
  });
  assert.equal(envelope.jobId, 'job_review-2026');
  assert.equal(envelope.report.source, 'LOCAL_TOOL');
  assert.equal(envelope.report.tool, 'claude-code');
  assert.deepEqual(envelope.report.findings.map(item => item.severity), ['CRITICAL', 'WARN', 'INFO']);
  assert.equal(envelope.report.findings[0]?.location, 'server/lock.ts:18');
  assert.match(envelope.report.findings[0]?.title || '', /^\[F-2\] 异常分支未释放互斥锁$/);
  assert.ok(envelope.report.summary.length >= 1 && envelope.report.summary.length <= 8000);
  assert.throws(() => buildTaskFlowReportSubmitEnvelope('bad job id!', { result: runs[2]!.result }), /jobId 格式无效/);
  assert.equal(buildTaskFlowReviewReport({ result: runs[2]!.result, provider: 'codex' }).tool, 'codex-cli');

  const md = formatReviewReportMarkdown({
    result: runs[2]!.result,
    provider: 'claude',
    model: 'claude-opus-5-5',
    round: 0,
  });
  assert.match(md, /### 独立代码审查报告（退回修改）/);
  assert.match(md, /\[BLOCKER · F-2\]/);

  // 第 1 轮返工收敛到 1 个问题
  runs.push(
    makeRun('implement', 4, 1, implPayload, 's1'),
    makeRun('verify', 5, 1, verifyPayload, 's1'),
    makeRun('review', 6, 1, {
      taskResult: {
        role: 'reviewer',
        status: 'succeeded',
        verdict: 'changes_requested',
        summary: '死锁已修，仍余 1 项定时器清理',
        findings: [
          { id: 'F-3', severity: 'major', file: 'server/lock.ts', line: 32, problem: '超时未清理定时器', expectation: 'clearTimeout' },
        ],
      },
    }, 's1'),
  );
  const afterR1 = evaluateWorkflow(wfRecord, runs).summary;
  assert.deepEqual(afterR1.reviewConvergence, {
    reviewRounds: 2,
    initialFindings: 3,
    latestFindings: 1,
    blockerRemaining: 0,
    trend: 'converging',
  });

  // 第 2 轮返工清零并通过
  runs.push(
    makeRun('implement', 7, 2, implPayload, 's2'),
    makeRun('verify', 8, 2, verifyPayload, 's2'),
    makeRun('review', 9, 2, {
      taskResult: {
        role: 'reviewer',
        status: 'succeeded',
        verdict: 'approved',
        summary: '全部问题已解决',
        findings: [],
      },
    }, 's2'),
  );
  const afterR2 = evaluateWorkflow(wfRecord, runs).summary;
  assert.equal(afterR2.state, 'awaiting_acceptance');
  assert.deepEqual(afterR2.reviewConvergence, {
    reviewRounds: 3,
    initialFindings: 3,
    latestFindings: 0,
    blockerRemaining: 0,
    trend: 'clean',
  });
});

test('提交前体检与智能提交说明：识别冲突、脱敏密钥、敏感路径、.only 与 debugger，并生成中文说明', () => {
  const syntheticToken = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6'].join('');
  const syntheticPemHeader = ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' ');
  const patch = [
    'diff --git a/server/payment.ts b/server/payment.ts',
    'index 1111111..2222222 100644',
    '--- a/server/payment.ts',
    '+++ b/server/payment.ts',
    '@@ -10,2 +10,7 @@ export function charge() {',
    '   const amount = 100;',
    '+<<<<<<< HEAD',
    `+  const token = "${syntheticToken}";`,
    '+  debugger;',
    '+=======',
    '+>>>>>>> feature/pay',
    '   return amount;',
    'diff --git a/server/cert-loader.ts b/server/cert-loader.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/server/cert-loader.ts',
    '@@ -0,0 +1,2 @@',
    `+const pem = "${syntheticPemHeader}";`,
    '+export default pem;',
    'diff --git a/test/payment.test.ts b/test/payment.test.ts',
    'index 3333333..4444444 100644',
    '--- a/test/payment.test.ts',
    '+++ b/test/payment.test.ts',
    '@@ -1,2 +1,3 @@',
    ' import test from "node:test";',
    '+test.only("should charge", () => {});',
  ].join('\n');

  const warnings = scanDiffHygieneIssues(patch, ['.env.production', '.env.example', 'server/payment.ts', 'test/payment.test.ts']);
  assert.ok(warnings.some(item => item.category === 'sensitive-file' && item.file === '.env.production' && item.severity === 'blocker'));
  assert.ok(!warnings.some(item => item.file === '.env.example'));
  assert.ok(warnings.some(item => item.category === 'conflict-markers' && item.file === 'server/payment.ts' && item.line === 11));
  const secretHit = warnings.find(item => item.category === 'secret-leak' && item.file === 'server/payment.ts');
  assert.ok(secretHit);
  assert.equal(secretHit.line, 12);
  assert.ok(!secretHit.snippet?.includes(syntheticToken), '告警摘要必须对疑似令牌脱敏');
  assert.match(secretHit.snippet || '', /\[redacted\]/);
  assert.ok(warnings.some(item => item.category === 'secret-leak' && item.file === 'server/cert-loader.ts' && item.line === 1));
  assert.ok(warnings.some(item => item.category === 'debug-artifact' && item.file === 'server/payment.ts' && item.line === 13));
  assert.ok(warnings.some(item => item.category === 'test-focus' && item.file === 'test/payment.test.ts' && item.line === 2));

  const commitMsg = buildSmartCommitMessage({
    patch,
    files: [
      { path: 'src/views/PayView.vue', status: 'M' },
      { path: 'server/payment.ts', status: 'M' },
      { path: 'test/payment.test.ts', status: 'M' },
    ],
    branch: 'feature/APEX-655-pay-upgrade',
  });
  assert.match(commitMsg.subject, /^APEX-655：更新前后端实现与测试/);
  assert.match(commitMsg.subject, /PayView、payment/);
  assert.match(commitMsg.body, /\[M\] server\/payment\.ts \(\+5\/-0\)/);
});

test('本地 Git commit-assist：无锁检测未暂存/未跟踪与已暂存改动并生成中文提交建议', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-commit-assist-'));
  const sourceBackend = { readLocalProjects: async () => ({ projects: [] }) } as any;
  try {
    await git(root, 'init', '-q', '-b', 'feature/VMS-808-checkout');
    await git(root, 'config', 'user.name', 'Test User');
    await git(root, 'config', 'user.email', 'test@example.com');
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'checkout.ts'), 'export const total = 1;\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-qm', 'init');

    // 未暂存源码含 debugger + 未跟踪测试含 test.only + 敏感文件 .env.local
    await fs.writeFile(path.join(root, 'src', 'checkout.ts'), 'export const total = 2;\ndebugger;\n');
    await fs.mkdir(path.join(root, 'test'), { recursive: true });
    await fs.writeFile(path.join(root, 'test', 'checkout.test.ts'), 'import test from "node:test";\ntest.only("calc", () => {});\n');
    await fs.writeFile(path.join(root, '.env.local'), 'SECRET_VAL=123456\n');

    const unstagedRes = await executeProjectGitAction({ action: 'commit-assist', path: root }, sourceBackend) as any;
    assert.equal(unstagedRes.ok, true);
    assert.equal(unstagedRes.assist.scope, 'unstaged');
    assert.match(unstagedRes.assist.suggestedSubject, /^VMS-808：/);
    assert.ok(unstagedRes.assist.hygieneWarnings.some((w: any) => w.category === 'sensitive-file' && w.file === '.env.local'));
    assert.ok(unstagedRes.assist.hygieneWarnings.some((w: any) => w.category === 'debug-artifact' && w.file === 'src/checkout.ts'));
    assert.ok(unstagedRes.assist.hygieneWarnings.some((w: any) => w.category === 'test-focus' && w.file === 'test/checkout.test.ts'));

    // 清理风险并仅暂存干净改动后再次体检
    await fs.writeFile(path.join(root, 'src', 'checkout.ts'), 'export const total = 2;\n');
    await git(root, 'add', 'src/checkout.ts');
    const stagedRes = await executeProjectGitAction({ action: 'commit-assist', path: root }, sourceBackend) as any;
    assert.equal(stagedRes.assist.scope, 'staged');
    assert.equal(stagedRes.assist.fileCount, 1);
    assert.equal(stagedRes.assist.hygieneWarnings.length, 0);
    assert.equal(stagedRes.assist.triage.missingTestsWarning, true);
    assert.match(stagedRes.assist.suggestedSubject, /^VMS-808：更新前端实现（checkout）/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('群聊远端交付预检门禁：敏感与泄露文件自动取消默认推荐，冲突硬阻断且密钥须显式确认', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-hygiene-'));
  const repo = path.join(directory, 'repo');
  const bare = path.join(directory, 'remote.git');
  const sourceBackend = { readLocalProjects: async () => ({ projects: [] }) } as any;
  try {
    await fs.mkdir(repo, { recursive: true });
    await git(repo, 'init', '-q', '-b', 'feature/TEST-9');
    await git(repo, 'config', 'user.name', 'Fixture');
    await git(repo, 'config', 'user.email', 'fixture@localhost');
    await fs.mkdir(path.join(repo, 'src'), { recursive: true });
    await fs.mkdir(path.join(repo, 'server'), { recursive: true });
    await fs.writeFile(path.join(repo, 'src', 'View.vue'), '<template><div>v1</div></template>\n');
    await fs.writeFile(path.join(repo, 'server', 'secret-cfg.ts'), 'export const cfg = "safe";\n');
    await fs.writeFile(path.join(repo, 'server', 'conflict.ts'), 'export const ok = true;\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-qm', 'init');
    await git(directory, 'init', '--bare', '-q', bare);
    await git(repo, 'remote', 'add', 'origin', bare);
    const baseSha = await git(repo, 'rev-parse', 'HEAD');

    const fakeToken = ['glpat', '-', 'AbCdEfGhIjKlMnOpQrStUvWxYz12'].join('');
    await fs.writeFile(path.join(repo, 'src', 'View.vue'), '<template><div>v2</div></template>\n');
    await fs.writeFile(path.join(repo, 'server', 'secret-cfg.ts'), `export const cfg = "${fakeToken}";\n`);
    await fs.writeFile(path.join(repo, 'server', 'conflict.ts'), '<<<<<<< HEAD\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> main\n');

    const realRepo = await fs.realpath(repo);
    const roomId = '33333333-3333-4333-8333-333333333333';
    const taskId = '44444444-4444-4444-8444-444444444444';
    const runId = '55555555-5555-4555-8555-555555555555';
    const issue = { key: 'TEST-9', url: 'https://jira.example.test/browse/TEST-9', summary: '账单页改造' };
    const proj = { path: realRepo, workspacePath: realRepo, baseBranch: 'master', branchName: 'feature/TEST-9', baseSha };
    const detail = {
      room: {
        id: roomId,
        title: '群聊交付体检测试',
        workspacePath: realRepo,
        executionPath: realRepo,
        paused: false,
        cursorTrustPaths: [],
        createdAt: '2026-11-15T01:00:00Z',
        updatedAt: '2026-11-15T01:05:00Z',
        source: { taskId, workflow: 'requirement', title: issue.summary, issueKey: issue.key, issueUrl: issue.url, projects: [proj] },
        rounds: [{
          id: '66666666-6666-4666-8666-666666666666',
          requestId: 'req-1',
          requestHash: 'hash-1',
          text: '改造账单页',
          attachmentIds: [],
          accessMode: 'workspace',
          state: 'completed',
          createdAt: '2026-11-15T01:00:00Z',
          updatedAt: '2026-11-15T01:05:00Z',
          turns: [{
            id: '77777777-7777-4777-8777-777777777777',
            member: { id: 'fe', name: '前端开发', capability: 'write', enabled: true, instructions: '' },
            runId,
            status: 'completed',
            attempt: 1,
            result: '',
            error: '',
            updatedAt: '2026-11-15T01:05:00Z',
          }],
        }],
      },
      runs: [{
        id: runId,
        workspacePath: realRepo,
        status: 'completed',
        result: '',
        changedFiles: [
          { path: 'src/View.vue', status: 'modified' },
          { path: 'server/secret-cfg.ts', status: 'modified' },
          { path: 'server/conflict.ts', status: 'modified' },
        ],
      }],
    } as any;
    const taskRecord = {
      taskId,
      workflow: 'requirement',
      projects: [proj],
      projectPath: realRepo,
      sourceProjectPath: realRepo,
      branchName: 'feature/TEST-9',
      baseSha,
      sourceIssue: issue,
      issueSnapshot: issue,
    } as any;

    const service = await createAgentRemoteDelivery({
      directory: path.join(directory, 'state'),
      find: () => detail,
      task: async () => taskRecord,
      source: sourceBackend,
      publishComment: async () => ({ url: issue.url, verified: true }),
      publishDesign: async () => { throw new Error('unused'); },
    });
    try {
      const preview = await service.preview(roomId);
      const p0 = preview.projects[0]!;
      assert.equal(p0.files.find(f => f.path === 'src/View.vue')?.recommended, true);
      assert.equal(p0.files.find(f => f.path === 'server/secret-cfg.ts')?.recommended, false, '命中密钥泄露的文件不应默认勾选');
      assert.equal(p0.files.find(f => f.path === 'server/conflict.ts')?.recommended, false, '含未解冲突标记的文件不应默认勾选');
      assert.match(p0.message, /^TEST-9：更新账单页改造前端实现（View）/);

      // 冲突标记即使传 confirmHygiene 也硬阻断
      await assert.rejects(
        service.submit(roomId, {
          requestId: '88888888-8888-4888-8888-888888888881',
          fingerprint: preview.fingerprint,
          kind: 'git',
          projectId: '0',
          files: ['server/conflict.ts'],
          message: 'TEST-9：尝试提交冲突文件',
          confirmHygiene: true,
        }),
        /未解决的合并冲突标记/,
      );

      // 疑似密钥未显式确认时拦截
      await assert.rejects(
        service.submit(roomId, {
          requestId: '88888888-8888-4888-8888-888888888882',
          fingerprint: preview.fingerprint,
          kind: 'git',
          projectId: '0',
          files: ['src/View.vue', 'server/secret-cfg.ts'],
          message: 'TEST-9：提交测试假令牌',
        }),
        /命中敏感凭据或高风险密钥提示/,
      );

      // 人工核对为测试夹具并显式传入 confirmHygiene: true 后放行
      const submitted = await service.submit(roomId, {
        requestId: '88888888-8888-4888-8888-888888888883',
        fingerprint: preview.fingerprint,
        kind: 'git',
        projectId: '0',
        files: ['src/View.vue', 'server/secret-cfg.ts'],
        message: 'TEST-9：更新账单页与测试夹具配置',
        confirmHygiene: true,
      });
      assert.equal(submitted.status, 'completed');
    } finally {
      await service.close();
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('审查发现精确 Diff 行锚定与返工上下文注入：生成 suggestion 修复清单并向返工阶段注入代码片段', async () => {
  const diffPatch = [
    'diff --git a/server/order.ts b/server/order.ts',
    'index 1111111..2222222 100644',
    '--- a/server/order.ts',
    '+++ b/server/order.ts',
    '@@ -20,3 +20,5 @@ export async function submitOrder(id: string) {',
    '   const order = await loadOrder(id);',
    '+  if (!order.paid) return { ok: true };',
    '+  await markShipped(order.id);',
    '   return { ok: true };',
  ].join('\n');

  const findings = [
    {
      id: 'F-1',
      severity: 'blocker' as const,
      file: 'server/order.ts',
      line: 21,
      problem: '未支付订单直接返回 ok:true 会绕过支付校验',
      expectation: '应抛出业务异常或返回 ok:false：\n```suggestion\n  if (!order.paid) return { ok: false, reason: "UNPAID" };\n```',
    },
    {
      id: 'F-2',
      severity: 'minor' as const,
      file: 'docs/README.md',
      line: 0,
      problem: '未同步说明新增错误码 UNPAID',
      expectation: '补充接口返回码文档',
    },
  ];

  const anchored = anchorFindingsToDiff(findings, diffPatch);
  assert.equal(anchored[0]?.anchorKind, 'diff-line');
  assert.equal(anchored[0]?.matchedNewLine, 21);
  assert.match(anchored[0]?.codeExcerpt || '', /21 \+   if \(!order\.paid\) return \{ ok: true \};/);
  assert.equal(anchored[0]?.suggestedCode, '  if (!order.paid) return { ok: false, reason: "UNPAID" };');
  assert.equal(anchored[1]?.anchorKind, 'repo-file');

  const checklistMd = formatInlineReviewChecklistMarkdown({
    findings,
    patch: diffPatch,
    objective: '修复订单发货校验',
    round: 1,
    snapshotValue: 'abcdef1234567890',
  });
  assert.match(checklistMd, /#### `server\/order\.ts`/);
  assert.match(checklistMd, /L21 · Diff 变更行锚定/);
  assert.equal(checklistMd.match(/```suggestion/g)?.length, 1, '不应重复输出 suggestion 代码块');
  assert.match(checklistMd, /  ```suggestion\n    if \(!order\.paid\) return \{ ok: false, reason: "UNPAID" \};\n  ```/);

  // 验证 buildWorkflowContext 在返工阶段自动从上一轮审查材料目录读取 diff.patch 并注入精确行锚定代码片段
  const reviewDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-rework-anchor-'));
  try {
    await fs.writeFile(path.join(reviewDir, 'diff.patch'), diffPatch);
    const wfRecord: AgentWorkflowRecord = {
      id: 'wf-rework-1',
      templateId: 'engineering',
      parentConversationId: 'conv-root',
      workspacePath: '/tmp/ws',
      objective: '修复订单发货校验',
      acceptanceCriteria: [{ id: 'AC-1', text: '未支付订单禁止发货' }],
      allowedPaths: ['server/'],
      round: 1,
      maxRounds: 2,
      escalated: false,
      createdAt: '2026-11-15T01:00:00.000Z',
      updatedAt: '2026-11-15T01:05:00.000Z',
    };
    const reworkRun = {
      id: 'run-rework-4',
      conversationId: 'conv-impl',
      provider: 'codex',
      model: 'gpt-5.4',
      mode: 'agent',
      accessMode: 'full',
      workspacePath: '/tmp/ws',
      objective: wfRecord.objective,
      status: 'running',
      createdAt: '2026-11-15T01:06:00.000Z',
      updatedAt: '2026-11-15T01:06:00.000Z',
      events: [],
      result: '',
      error: '',
      task: {
        parentConversationId: 'conv-root',
        profileId: 'engineer',
        workflow: { id: wfRecord.id, templateId: 'engineering', stage: 'implement', step: 4, round: 1 },
      },
    } as unknown as AgentRun;

    const contextPrompt = buildWorkflowContext({
      record: wfRecord,
      run: reworkRun,
      feedback: {
        outcome: 'failed',
        reason: '审查退回修改',
        stage: '独立审查',
        findings,
        failedCriteria: [],
      },
      feedbackReviewMaterials: reviewDir,
    });
    assert.match(contextPrompt, /返工精确行锚定参考/);
    assert.match(contextPrompt, /server\/order\.ts:21（Diff 变更行锚定）/);
    assert.match(contextPrompt, /if \(!order\.paid\) return \{ ok: true \};/);
  } finally {
    await fs.rm(reviewDir, { recursive: true, force: true });
  }
});
