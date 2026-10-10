import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { automationSubtaskKeys, isAutomationSubtaskJob, isJiraSubtask } from '../shared/automation-policy.mjs';
import type { JiraIssue } from '../shared/hub';
// @ts-expect-error 原系统 ESM 模块没有全量类型声明。
const core = await import('../server/jira-backend/automation-core.mjs');

const issue = (overrides: Partial<JiraIssue> = {}): JiraIssue => ({
  key: 'OPAY-386', summary: '完成前端联调自测', description: '',
  url: '', priority: '', project: 'OPAY', projectName: '', assignee: '',
  fixVersions: [], created: '', updated: '', dueDate: null, startDate: null, endDate: null, resolutionDate: null,
  status: '开发中', statusCategory: '处理中', issueType: '任务', parent: null,
  subtasks: [], ...overrides,
});

test('按 Jira 关系或类型排除子任务，不使用标题猜测', () => {
  assert.equal(isJiraSubtask(issue({ parent: { key: 'OPAY-380' } })), true);
  for (const issueType of ['子任务', 'Sub-task', 'Subtask', 'Sub task']) {
    assert.equal(isJiraSubtask(issue({ issueType })), true);
  }
  assert.equal(isJiraSubtask(issue({ summary: '子任务汇总' })), false);
});

test('旧队列通过 parentKey 或执行计划识别子任务，筛选不删除历史', () => {
  const plan = [{ issue: issue({ parent: { key: 'OPAY-380' } }) },
    { issue: issue({ key: 'OPAY-380', subtasks: [{ key: 'OPAY-387', status: '开发中', statusCategory: '处理中' }] }) }];
  const jobs = [
    { issueKey: 'OPAY-386', status: 'blocked' },
    { issueKey: 'OPAY-387', status: 'pending' },
    { issueKey: 'OPAY-388', parentKey: 'OPAY-380', status: 'pending' },
    { issueKey: 'OPAY-380', status: 'pending' },
  ];
  const snapshot = structuredClone(jobs);
  const keys = automationSubtaskKeys(plan);
  assert.deepEqual(jobs.filter(job => !isAutomationSubtaskJob(job, keys)).map(job => job.issueKey), ['OPAY-380']);
  assert.deepEqual(jobs, snapshot);
});

test('子任务保留在计划但不可派发，普通任务仍可派发', () => {
  const plan = core.buildAutomationPlan([
    issue({ parent: { key: 'OPAY-380' } }),
    issue({ key: 'OPAY-390', summary: '完成前端功能开发' }),
  ]);
  assert.equal(plan.find((item: { issue: JiraIssue }) => item.issue.key === 'OPAY-386').dispatchable, false);
  assert.equal(plan.find((item: { issue: JiraIssue }) => item.issue.key === 'OPAY-390').dispatchable, true);
});

test('真实同步和领取入口不创建或领取子任务，历史记录不变', async () => {
  // 只加载两个纯状态入口，不启动 HTTP 服务、巡检或 Jira 写操作。
  const source = await readFile(new URL('../server/jira-backend/server.mjs', import.meta.url), 'utf8');
  const syncSource = source.slice(source.indexOf('function synchronizeAutomationJobs('), source.indexOf('async function transitionJiraIssue('));
  const claimSource = source.slice(source.indexOf('async function claimAutomationJobs('), source.indexOf('async function updateAutomationJob('));
  const child = issue({ parent: { key: 'OPAY-380' } });
  const state = { settings: { ...core.DEFAULT_AUTOMATION_SETTINGS, enabled: true, autoCreateCodex: true },
    jobs: [{ id: core.getAutomationJobId(child.key, 'verification'), issueKey: child.key, parentKey: 'OPAY-380', status: 'pending' }],
    plan: [] };
  const history = structuredClone(state.jobs);
  const context = { ...core, isJiraSubtask, automationSubtaskKeys, isAutomationSubtaskJob,
    compactAutomationPlan: (plan: unknown[]) => plan,
    mutateAutomationState: (fn: (value: typeof state) => unknown) => fn(state), state, child };
  runInNewContext(`${syncSource}\nsynchronizeAutomationJobs(state, [child], []);`, context);
  assert.deepEqual(state.jobs, history);
  const result = await runInNewContext(`${claimSource}\nclaimAutomationJobs(10);`, context);
  assert.equal(result.length, 0);
  assert.deepEqual(state.jobs, history);
  state.jobs.length = 0;
  runInNewContext(`${syncSource}\nsynchronizeAutomationJobs(state, [child], []);`, context);
  assert.equal(state.jobs.length, 0);
});
