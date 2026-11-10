import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { AgentRun } from '../shared/agent-runtime.js';
import { emptyDeliveryEvidence } from '../shared/delivery-acceptance.js';
import type { AutomationSettings, JiraIssue } from '../shared/hub.js';
import type { JiraDevLaunch } from '../shared/jira-dev.js';
import { jiraDevVerificationFingerprint } from '../server/agent-runtime.js';
import { createJiraDevAutomation } from '../server/jira-dev-automation.js';
import type { JiraDevTaskRecord } from '../server/jira-dev/index.mjs';

const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]) => exec('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args]);
const origin = 'git@codeup.aliyun.com:org/project/web.git';
const key = 'TEST-123';
const url = `https://jira.example.test/browse/${key}`;
const taskId = '18cfecf3-01d0-49be-b150-92259e4a7581';
const start = '2026-11-10T01:20:00.000Z';
const done = '2026-11-10T01:21:00.000Z';
function report(head = '', tests: 'passed' | 'failed' = 'passed') {
  const validationEvidence = emptyDeliveryEvidence();
  validationEvidence.tests = { status: tests, evidence: '定向测试命令与结果', sha: '' };
  validationEvidence.browser = { status: 'not_applicable', evidence: '本次仅修改构建校验', sha: '' };
  return ['```delivery-report', JSON.stringify({
    version: 1, jiraDevDelivery: { issueKey: key, status: 'passed', verifiedHead: head }, validationEvidence,
  }), '```'].join('\n');
}
async function fixture(mergeRequest: boolean, workflow: JiraDevTaskRecord['workflow']) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jira-dev-automation-')));
  const source = path.join(directory, 'source'), worktree = path.join(directory, 'worktree');
  await fs.mkdir(source);
  await git(source, 'init', '-b', 'master');
  await fs.writeFile(path.join(source, 'src.ts'), 'export const value = 0;\n');
  await git(source, 'add', 'src.ts');
  await git(source, 'commit', '-m', 'baseline');
  await git(source, 'remote', 'add', 'origin', origin);
  const baseSha = (await git(source, 'rev-parse', 'HEAD')).stdout.trim();
  const branchName = `feature/${key}`;
  await git(source, 'worktree', 'add', '-b', branchName, worktree);
  const issue = { key, url, summary: '修复校验', description: '', project: 'TEST', components: [], labels: [] } as unknown as JiraIssue;
  const sourceIssue = { key, url, summary: issue.summary };
  const task: JiraDevTaskRecord = { taskId, workflow, key, issueUrl: url, source: url, details: '', sourceIssue,
    sourceProjectPath: source, projectPath: worktree, baseSha, branchName, baseBranch: 'master',
    ...(workflow === 'requirement' ? { requirementPlan: { taskId, sourceKind: 'frontend', status: 'applied', items: [] } } : {}) };
  const launch: JiraDevLaunch = { status: 'started', runtime: { provider: 'codex', model: '', reasoningEffort: '', accessMode: 'workspace' },
    workspacePath: worktree, baseSha, runId: 'run', error: '', startedAt: start };
  const settings: AutomationSettings = { enabled: true, dailyTime: '09:00', dailyTimes: ['09:00'], maxDispatchPerRun: 1,
    autoCreateCodex: false, autoTransitionJira: true, autoCreateMergeRequest: mergeRequest, jiraDevAutomationApproved: false,
    startStatus: '开发中', completedStatus: '已完成', targetBranch: 'master', reviewer: 'Reviewer',
    projectProfiles: [{ id: 'web', name: 'Web', repositoryUrl: origin, localPath: source, targetBranch: 'master',
      runtimeEnvironment: 'test', runtimeCommand: 'pnpm dev', jiraProjects: ['TEST'], components: [], labels: [] }] };
  let run = { id: 'run', mode: 'agent', workspacePath: worktree, status: 'running', createdAt: start, updatedAt: start } as AgentRun;
  const calls: string[] = [];
  const options: Parameters<typeof createJiraDevAutomation>[0] = {
    directory: path.join(directory, 'data'), readSettings: async () => settings, readIssue: async () => issue,
    readTask: async () => task, readRun: async () => run,
    advance: async (_issue, targetStatus, phase, beforeWrite) => {
      await beforeWrite();
      calls.push(phase);
      return { status: 'updated', currentStatus: targetStatus };
    },
    mergeRequest: async (_input, beforeWrite) => {
      await beforeWrite();
      calls.push('mr');
      return { status: 'created', message: '已创建', url: 'https://codeup.example.test/mr/1' };
    },
  };
  return { directory, worktree, task, launch, settings, calls, options,
    finish: async (result: string, id: string) => {
      run = { ...run, id, status: 'completed', resultReady: true, updatedAt: done, result,
        jiraDevVerification: [await jiraDevVerificationFingerprint(worktree, key)] };
    },
  };
}
async function idle(automation: Awaited<ReturnType<typeof createJiraDevAutomation>>) {
  for (let attempt = 0; attempt < 100 && !automation.isIdle(); attempt++) await setTimeout(20);
  assert(automation.isIdle());
}

test('需求开发按已确认策略先回读开始状态，再验证、创建 MR 和推进完成，重启不重复写入', async () => {
  const f = await fixture(true, 'requirement');
  let automation = await createJiraDevAutomation(f.options);
  try {
    assert.equal(await automation.prepare(f.task, f.launch), undefined);
    await automation.activate(f.task, f.launch);
    assert.deepEqual(f.calls, []);
    f.settings.jiraDevAutomationApproved = true;
    assert.equal((await automation.prepare(f.task, f.launch))?.git?.targetBranch, 'master');
    await automation.activate(f.task, f.launch);
    await idle(automation);
    assert.deepEqual(f.calls, ['start']);
    await fs.writeFile(path.join(f.worktree, 'src.ts'), 'export const value = 1;\n');
    await git(f.worktree, 'commit', '-am', 'TEST-123: 更新校验');
    const head = (await git(f.worktree, 'rev-parse', 'HEAD')).stdout.trim();
    await f.finish(report(head, 'failed'), 'run');
    automation.refresh(taskId);
    await idle(automation);
    assert.equal(automation.status(taskId)?.verification?.status, 'blocked');
    assert.deepEqual(f.calls, ['start']);
    await f.finish(report(head), 'run-2');
    automation.refresh(taskId);
    await idle(automation);
    assert.deepEqual(f.calls, ['start', 'mr', 'complete']);
    assert.match(automation.status(taskId)?.mergeRequest?.url || '', /mr\/1$/);
    await automation.close();
    automation = await createJiraDevAutomation(f.options);
    await automation.activate(f.task, f.launch);
    await idle(automation);
    assert.deepEqual(f.calls, ['start', 'mr', 'complete']);
  } finally { await automation.close(); await fs.rm(f.directory, { recursive: true, force: true }); }
});

test('Jira 修复只推进当前验证版本，验证后改动及撤销授权都会拦截完成流转', async () => {
  const f = await fixture(false, 'jira');
  const automation = await createJiraDevAutomation(f.options);
  try {
    f.settings.jiraDevAutomationApproved = true;
    assert.deepEqual(await automation.prepare(f.task, f.launch), { report: true });
    await automation.activate(f.task, f.launch);
    await idle(automation);
    await f.finish(report(), 'run');
    await fs.writeFile(path.join(f.worktree, 'src.ts'), 'export const value = 2;\n');
    automation.refresh(taskId);
    await idle(automation);
    assert.match(automation.status(taskId)?.verification?.message || '', /验证版本不一致/);
    assert.deepEqual(f.calls, ['start']);
    await f.finish(report(), 'run-2');
    f.settings.jiraDevAutomationApproved = false;
    automation.refresh(taskId);
    await idle(automation);
    assert.deepEqual(f.calls, ['start']);
  } finally { await automation.close(); await fs.rm(f.directory, { recursive: true, force: true }); }
});
