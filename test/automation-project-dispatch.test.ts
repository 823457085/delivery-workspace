import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { automationSubtaskKeys, isAutomationSubtaskJob, isJiraSubtask } from '../shared/automation-policy.mjs';
import type { AutomationProjectProfile, AutomationSettings, JiraIssue, Job, PlanItem } from '../shared/hub';
// @ts-expect-error 原后端 ESM 模块没有全量类型声明。
const core = await import('../server/jira-backend/automation-core.mjs');

type StoredJob = Partial<Job> & Pick<Job, 'id' | 'issueKey' | 'status'> & Record<string, unknown>;
interface State { settings: AutomationSettings; jobs: StoredJob[]; plan: PlanItem[] }
const profile = (id = 'app', overrides: Partial<AutomationProjectProfile> = {}): AutomationProjectProfile => ({
  id, name: id.toUpperCase(), repositoryUrl: `git@example.test:business/${id}.git`, localPath: '',
  runtimeCommand: `pnpm dev:${id}`, runtimeEnvironment: `${id}-test`, targetBranch: `${id}-test`,
  jiraProjects: [id === 'app' ? 'OPAY' : 'APEX'], components: [], labels: [], ...overrides,
});
const issue = (): JiraIssue => ({
  key: 'OPAY-90', summary: '完成前端功能开发', description: '', url: 'https://jira.test/browse/OPAY-90',
  project: 'OPAY', projectName: '海外业务', status: '开发中', statusCategory: '处理中', issueType: '任务',
  priority: '', assignee: '', fixVersions: [], created: '', updated: '', dueDate: null,
  startDate: null, endDate: null, resolutionDate: null, parent: null, subtasks: [], components: [], labels: [],
});
const workspace = () => ({ path: '/work/app/OPAY-90', displayPath: '/work/app/OPAY-90', folderName: 'OPAY-90',
  branch: 'feature/OPAY-90', remoteUrl: 'https://example.test/business/app.git', projectId: 'app', clean: true });
const settings = (profiles = [profile(), profile('apex')]): AutomationSettings => core.sanitizeAutomationSettings({
  enabled: true, autoCreateCodex: true, projectProfiles: profiles,
});

// 只加载真实状态入口；不导入启动 HTTP 服务、定时巡检或 Jira 客户端的模块。
const source = await readFile(new URL('../server/jira-backend/server.mjs', import.meta.url), 'utf8');
function section(start: string, end: string) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `入口源码存在：${start}`);
  return source.slice(from, to);
}
const entrypoints = [
  section('function compactAutomationPlan(', 'function synchronizeAutomationJobs('),
  section('function synchronizeAutomationJobs(', 'async function transitionJiraIssue('),
  section('async function claimAutomationJobs(', 'async function updateAutomationJob('),
  section('async function previewAutomationProjects(', 'async function readAutomationArtifact('),
].join('\n');
function fixture(state: State = { settings: settings(), jobs: [], plan: [] }) {
  const localProjects = [workspace()];
  const calls = { mutations: 0, stateReads: 0, localReads: [] as boolean[] };
  const context = { ...core, isJiraSubtask, automationSubtaskKeys, isAutomationSubtaskJob,
    mutateAutomationState: (fn: (value: State) => unknown) => { calls.mutations++; return fn(state); },
    readAutomationState: async () => { calls.stateReads++; return state; },
    getLocalProjects: async (force: boolean) => { calls.localReads.push(force); return { projects: localProjects }; },
  };
  const entries = runInNewContext(`${entrypoints}\n({ synchronizeAutomationJobs, claimAutomationJobs, previewAutomationProjects });`, context) as {
    synchronizeAutomationJobs(state: State, issues: JiraIssue[], projects: ReturnType<typeof workspace>[]): { enqueued: number };
    claimAutomationJobs(limit: number): Promise<StoredJob[]>;
    previewAutomationProjects(input: { settings: Partial<AutomationSettings> }): Promise<{ source: string; issueCount: number; plan: PlanItem[] }>;
  };
  return { state, localProjects, calls,
    sync: (projects = localProjects) => entries.synchronizeAutomationJobs(state, [issue()], projects),
    claim: () => entries.claimAutomationJobs(10), preview: entries.previewAutomationProjects };
}

test('真实同步保存 App 路由，领取使用该路由配置而非全局 Apex 或旧工作区', async () => {
  const f = fixture();
  assert.equal(f.sync().enqueued, 1);
  const job = f.state.jobs[0]!;
  assert.equal(job.status, 'pending'); assert.equal(job.projectRouting?.profile?.id, 'app');
  assert.equal(job.workspacePath, '/work/app/OPAY-90');
  const savedRoute = structuredClone(job.projectRouting);
  job.workspacePath = '/wrong/legacy-apex';
  const claimed = await f.claim();
  assert.equal(claimed.length, 1); assert.equal(claimed[0], job);
  assert.equal(job.status, 'dispatching'); assert.equal(job.attempts, 1); assert.ok(job.claimedAt);
  assert.deepEqual(job.projectRouting, savedRoute);
  for (const value of ['business/app.git', 'pnpm dev:app', 'app-test', '/work/app/OPAY-90']) assert.ok(job.prompt?.includes(value), value);
  for (const value of ['thor-admin2.0', 'pnpm dev:i18n-test', '/wrong/legacy-apex']) assert.ok(!job.prompt?.includes(value), value);
});

test('旧 pending 队列缺少路由时退回待选择，不按全局默认仓库领取', async () => {
  const state: State = { settings: core.sanitizeAutomationSettings({ enabled: true, autoCreateCodex: true }), plan: [], jobs: [{
    id: 'OPAY-90:implementation', issueKey: 'OPAY-90', issueUrl: issue().url, summary: issue().summary,
    category: 'implementation', status: 'pending', attempts: 0, workspacePath: '/legacy/apex', prompt: '旧 Apex 提示词',
  }] };
  const f = fixture(state), job = state.jobs[0]!;
  assert.equal((await f.claim()).length, 0);
  assert.equal(job.status, 'waiting'); assert.match(job.error || '', /未保存.*项目路由/);
  assert.equal(job.prompt, ''); assert.equal(job.attempts, 0); assert.equal(job.claimedAt, undefined);
});

for (const change of ['删除', '修改'] as const) test(`项目配置${change}后旧 pending 任务等待重新核对，不继承新配置`, async () => {
  const f = fixture(); f.sync(); const job = f.state.jobs[0]!;
  const originalRoute = structuredClone(job.projectRouting);
  f.state.settings = settings(change === '删除' ? [profile('apex')] : [profile('app', { runtimeCommand: 'pnpm dev:changed' }), profile('apex')]);
  assert.equal((await f.claim()).length, 0);
  assert.equal(job.status, 'waiting'); assert.match(job.error || '', /配置已变更或删除/);
  assert.equal(job.prompt, ''); assert.equal(job.attempts, 0);
  assert.deepEqual(job.projectRouting, originalRoute);
});

test('已领取和已交付任务在后续同步中保留原路由、提示词与执行工作区', () => {
  for (const status of ['dispatching', 'dispatched', 'running', 'review', 'completed']) {
    const f = fixture(); f.sync(); const job = f.state.jobs[0]!;
    job.status = status; job.claimedAt = new Date().toISOString();
    const before = structuredClone(job);
    f.state.settings = settings([profile('apex', { jiraProjects: ['OPAY'] })]);
    f.sync([]);
    assert.deepEqual(structuredClone(job), before, status);
    assert.equal(f.state.plan[0]?.projectRouting?.profile?.id, 'apex');
    assert.equal(job.projectRouting?.profile?.id, 'app');
  }
});

test('项目匹配预览只读取已存 Jira 快照与本地目录，输入配置不写回状态', async () => {
  const state: State = { settings: settings([profile('apex', { jiraProjects: ['OPAY'] })]), jobs: [],
    plan: core.buildAutomationPlan([issue()], [], [], settings([profile('apex', { jiraProjects: ['OPAY'] })])) };
  const f = fixture(state), input = { settings: { projectProfiles: [profile()] } };
  const before = structuredClone(state), originalInput = structuredClone(input);
  const result = await f.preview(input);
  assert.equal(result.source, 'snapshot'); assert.equal(result.issueCount, 1);
  assert.equal(result.plan[0]?.issue.key, 'OPAY-90'); assert.equal(result.plan[0]?.projectRouting?.profile?.id, 'app');
  assert.equal(result.plan[0]?.dispatchable, true);
  assert.equal(f.calls.stateReads, 1); assert.deepEqual(f.calls.localReads, [false]); assert.equal(f.calls.mutations, 0);
  assert.deepEqual(state, before); assert.deepEqual(input, originalInput);
});

test('已启用研发预览时，不为代码实现项新排旧队列或领取旧 pending', async () => {
  const f = fixture();
  assert.equal(f.sync().enqueued, 1);
  const queued = f.state.jobs[0]!;
  f.state.settings = { ...f.state.settings, autoPrepareJiraDev: true };
  assert.equal(f.sync().enqueued, 0);
  assert.equal((await f.claim()).length, 0);
  assert.equal(queued.status, 'pending');

  const fresh = fixture({ settings: f.state.settings, jobs: [], plan: [] });
  assert.equal(fresh.sync().enqueued, 0);
  assert.equal(fresh.state.plan[0]?.dispatchable, true);
});

test('已确认自动研发策略后，代码实现不再通过旧队列排队或领取', async () => {
  const f = fixture();
  f.sync();
  f.state.settings = core.sanitizeAutomationSettings({ jiraDevAutomationApproved: true }, f.state.settings);
  assert.equal(f.sync().enqueued, 0);
  assert.equal((await f.claim()).length, 0);
  assert.equal(f.state.jobs[0]?.status, 'pending');

  f.state.settings = core.sanitizeAutomationSettings({ reviewer: '更新审核人' }, f.state.settings);
  assert.equal(f.state.settings.jiraDevAutomationApproved, false);
  assert.equal(f.state.settings.jiraDevAutomationRouted, true);
  assert.equal(f.state.settings.autoCreateCodex, true);
  assert.equal((await f.claim()).length, 0);
  const fresh = fixture({ settings: f.state.settings, jobs: [], plan: [] });
  assert.equal(fresh.sync().enqueued, 0);
  assert.equal(fresh.state.jobs.length, 0);
});

test('真实巡检入口只对新鲜 Jira 扫描生成研发预览并保存关联', async () => {
  const state = { settings: { ...settings(), autoPrepareJiraDev: true }, jobs: [], plan: [],
    lastRun: null, runs: [] };
  let source = 'jira';
  const delivered: { key: string; limit: number; mode: string }[] = [];
  let canContinue: (() => Promise<boolean>) | undefined;
  const entries = runInNewContext(`${section('let prepareJiraDevPreviews;', 'function runAutomationScan(').replace('export function', 'function')}
    ({ connectJiraDevPreviews, performAutomationScan });`, {
    ...core, URLSearchParams, readAutomationState: async () => state,
    buildJql: () => '', fetchJiraIssues: async () => ({ source, issues: [issue()] }),
    getLocalProjects: async () => ({ projects: [workspace()] }),
    ensureAutomationTaskSegments: async () => [], refreshAutomationGitEvidence: async () => undefined,
    mutateAutomationState: async (fn: (current: typeof state) => void) => fn(state),
    synchronizeAutomationJobs: () => ({ enqueued: 0 }), executeAutomationTransitions: async () => [],
    compactAutomationPlan: (plan: PlanItem[]) => plan,
  });
  entries.connectJiraDevPreviews(async (items: PlanItem[], limit: number, mode: string, mayStart?: () => Promise<boolean>) => {
    if (mayStart) canContinue = mayStart;
    delivered.push(...items.map(item => ({ key: item.issue.key, limit, mode })));
    return [{ issueKey: 'OPAY-90', taskId: 'existing-preview', workflow: 'requirement' }];
  });
  const scanned = await entries.performAutomationScan('schedule', '2026-11-09 08:30');
  assert.deepEqual(delivered, [{ key: 'OPAY-90', limit: state.settings.maxDispatchPerRun, mode: 'preview' }]);
  assert.equal(scanned.jiraDevPreviews?.[0]?.taskId, 'existing-preview');
  assert.equal(state.lastRun, scanned);
  source = 'cache';
  const cached = await entries.performAutomationScan();
  assert.equal(cached.jiraDevPreviews, undefined);
  assert.equal(delivered.length, 1);

  source = 'jira';
  state.settings.autoPrepareJiraDev = false;
  assert.equal((await entries.performAutomationScan()).jiraDevPreviews, undefined);
  state.settings.jiraDevAutomationApproved = true;
  assert.equal((await entries.performAutomationScan()).jiraDevPreviews?.length, 1);
  assert.equal(delivered.at(-1)?.mode, 'start');
  assert.equal(await canContinue?.(), true);
  state.settings.autoPrepareJiraDev = true;
  assert.equal(await canContinue?.(), false);
  await entries.performAutomationScan();
  assert.equal(delivered.at(-1)?.mode, 'preview');
  state.settings.autoPrepareJiraDev = false;
  state.settings.enabled = false;
  assert.equal((await entries.performAutomationScan()).jiraDevPreviews, undefined);
});
