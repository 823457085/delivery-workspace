import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createJiraDevTaskService } from '../server/jira-dev-tasks.js';
import { createJiraFixService } from '../server/jira-fix.js';
import { createRequirementDevelopmentService } from '../server/requirement-development.js';
import { createAgentRuntimeService, type AgentRuntimeAdapter } from '../server/agent-runtime.js';
import { createTaskWorkspace, sourceIdentity } from '../server/jira-dev/index.mjs';
import { jiraDevPrepareSchema } from '../shared/jira-dev.js';
import type { JiraIssue, PlanItem, ProjectsData } from '../shared/hub.js';
import type { AgentRun } from '../shared/agent-runtime.js';

const exec = promisify(execFile);
const site = 'https://jira.example.test';
const defect = { key: 'TEST-123', url: `${site}/browse/TEST-123`, summary: '列表筛选失效', description: '复现步骤', status: '待修复',
  project: { id: '1', key: 'TEST', name: '测试' }, fixVersions: [] };
const git = (cwd: string, ...args: string[]) => exec('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args]);

async function fixture(overrides: Partial<Parameters<typeof createJiraDevTaskService>[0]> = {}) {
  Object.assign(process.env, { CONFLUENCE_BASE_URL: 'https://confluence.example.test', DELIVERY_DESIGN_SPACE_KEY: 'DEMO',
    DELIVERY_DESIGN_PARENT_ID: '123', DELIVERY_DESIGN_PARENT_TITLE: '技术方案' });
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jira-dev-')));
  const origin = path.join(directory, 'origin.git'), project = path.join(directory, 'web');
  await exec('git', ['init', '--bare', '-b', 'master', origin]);
  await exec('git', ['clone', origin, project]);
  await git(project, 'commit', '--allow-empty', '-m', 'base');
  await git(project, 'push', 'origin', 'HEAD:master');
  await fs.writeFile(path.join(project, 'draft.txt'), '未提交改动需保留');
  const executed: AgentRun[] = [];
  const adapter: AgentRuntimeAdapter = { id: 'claude', health: async () => ({ provider: 'claude', label: 'Claude Code', binary: '', version: 'test',
    ready: true, authenticated: true, message: '', modes: ['agent'], accessModes: ['workspace', 'full'], models: [{ id: 'opus', label: 'Opus' }], defaultModel: '', writable: true, checkedAt: '' }),
  execute: async ({ run }) => { executed.push(run); return '已完成'; } };
  const codex: AgentRuntimeAdapter = { ...adapter, id: 'codex',
    health: async () => ({ ...await adapter.health(), provider: 'codex', label: 'Codex', models: [{ id: '', label: 'CLI 默认' }] }) };
  const runtime = await createAgentRuntimeService(path.join(directory, 'runtime'), { adapters: [adapter, codex] });
  const source = { readJiraFixIssue: async (key: string) => ({ key, url: `${site}/browse/${key}`, summary: defect.summary, project: 'TEST', projectName: '测试', status: '待修复', parent: null } as JiraIssue),
    readLocalProjects: async () => ({ projects: [] } as unknown as ProjectsData) };
  const jiraFix = await createJiraFixService(path.join(directory, 'jira-fix'), runtime, source);
  const requirements = await createRequirementDevelopmentService(path.join(directory, 'requirement-development'), runtime);
  const reads: string[] = [];
  const client = { readIssue: async (value: string) => { reads.push(value); return defect; },
    connection: async () => ({ site, account: { id: 'me', name: '我' } }) };
  const service = await createJiraDevTaskService({ dataDirectory: path.join(directory, 'jira-dev'), connectionDirectory: path.join(directory, 'connection'),
    runtime, adoptJiraFix: record => jiraFix.adopt(record), adoptRequirement: record => requirements.adopt(record),
    readHubIssue: source.readJiraFixIssue, jiraClient: async () => client as never, sourceIdentity: async value => sourceIdentity(value, site), ...overrides });
  return { directory, origin, project, runtime, jiraFix, requirements, service, executed, reads,
    close: async () => { await service.close(); await jiraFix.close(); await requirements.close(); await runtime.close(); await fs.rm(directory, { recursive: true, force: true }); } };
}
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('等待会话执行超时');
}

test('直接修复：预览不建工作区，确认后创建独立 worktree 并按所选 CLI 与模型在工作台启动，登记为 Jira 修复记录', async () => {
  const context = await fixture();
  try {
    const preview = await context.service.prepare({ workflow: 'jira', repairMode: 'direct', projectPath: context.project, source: 'TEST-123',
      baseBranch: 'origin/master', branchName: 'feature/TEST-123', details: '只修列表', useI18n: false });
    assert.equal(preview.repairMode, 'direct');
    assert.equal(preview.plan, undefined);
    assert.equal(preview.launch, undefined);
    assert.match(preview.prompt, /jira-dev-fix\/SKILL\.md/);
    assert.match(preview.prompt, /确认开始后，工作台会/);
    assert.match(preview.prompt, /useI18n=false/);
    assert.doesNotMatch(preview.prompt, /调用 create_jira_dev_workspace（/);
    assert.equal((await git(context.project, 'branch', '--list', 'feature/TEST-123')).stdout.trim(), '');

    const runtime = { provider: 'claude', model: 'opus', reasoningEffort: '', accessMode: 'full' } as const;
    const started = await context.service.start({ taskId: preview.taskId, runtime, confirmed: true });
    assert.equal(started.launch?.status, 'started', started.launch?.error || '');
    const workspacePath = started.launch!.workspacePath;
    assert.equal(path.dirname(workspacePath), `${context.project}-tasks`);
    assert.equal((await git(workspacePath, 'branch', '--show-current')).stdout.trim(), 'feature/TEST-123');
    assert.equal(await fs.readFile(path.join(context.project, 'draft.txt'), 'utf8'), '未提交改动需保留');
    assert.match(started.prompt, new RegExp(`独立 worktree ${JSON.stringify(workspacePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

    await waitFor(() => context.executed.length === 1);
    const run = context.executed[0]!;
    assert.equal(run.provider, 'claude'); assert.equal(run.model, 'opus'); assert.equal(run.accessMode, 'full');
    assert.equal(run.workspacePath, workspacePath);
    assert.equal(run.task?.sourceId, `jira-fix:${preview.taskId}`);
    assert.match(run.objective, /"jiraHandoff"/);

    const record = context.jiraFix.list().find(item => item.id === preview.taskId);
    assert.equal(record?.runId, started.launch?.runId);
    assert.equal(record?.input.issueKey, 'TEST-123');
    assert.equal(record?.input.branch, 'feature/TEST-123');

    const again = await context.service.start({ taskId: preview.taskId, runtime, confirmed: true });
    assert.equal(again.launch?.runId, started.launch?.runId);
    assert.equal(context.executed.length, 1);
    assert.equal((await context.service.list()).length, 1);
  } finally { await context.close(); }
});

test('需求开发：仅正文生成本地计划；含方案归档目录时须先确认，确认后登记为需求开发记录并要求阶段报告', async () => {
  const context = await fixture();
  try {
    const preview = await context.service.prepare({ workflow: 'requirement', projectPath: context.project, source: '', baseBranch: 'master',
      branchName: 'feature/device-filter', details: '【设备管理】新增设备筛选\n按状态筛选设备列表', sourceKind: 'product', businessModule: '设备管理' });
    assert.equal(preview.plan?.status, 'local');
    assert.ok(preview.plan?.designDestination);
    assert.equal(preview.plan?.designPublicationAuthorized, false);
    assert.match(preview.prompt, /jira-dev-requirement\/SKILL\.md/);
    const runtime = { provider: 'claude', model: 'opus', reasoningEffort: '', accessMode: 'workspace' } as const;
    await assert.rejects(context.service.start({ taskId: preview.taskId, confirmed: true, runtime }), /请先确认任务计划/);
    await assert.rejects(fs.stat(`${context.project}-tasks`));

    const applied = await context.service.apply({ taskId: preview.taskId, confirmed: true });
    assert.equal(applied.plan?.designPublicationAuthorized, true);
    const started = await context.service.start({ taskId: preview.taskId, confirmed: true, runtime });
    assert.equal(started.launch?.status, 'started', started.launch?.error || '');
    await waitFor(() => context.executed.length === 1);
    assert.equal(context.executed[0]!.task?.sourceId, `requirement:${preview.taskId}`);
    assert.match(context.executed[0]!.objective, /"requirementProgress"/);
    assert.match(context.executed[0]!.objective, /发布为下述已确认目录的本任务子页/);
    const record = context.requirements.list().find(item => item.id === preview.taskId);
    assert.equal(record?.input.branch, 'feature/device-filter');
    assert.equal(record?.input.confluenceParentUrl, applied.plan?.designDestination?.url);
  } finally { await context.close(); }
});

test('新建开发 Jira 的修复任务未在 Jira 登记前拒绝启动，不创建工作区', async () => {
  const context = await fixture();
  try {
    // 测试 Jira 不提供创建元数据，计划降级为本地草稿；修复必须登记前端任务后才能开始。
    const preview = await context.service.prepare({ workflow: 'jira', repairMode: 'create', projectPath: context.project, source: 'TEST-123',
      baseBranch: 'master', branchName: 'feature/TEST-123', details: '' });
    assert.equal(preview.repairMode, 'create');
    assert.equal(preview.plan?.status, 'local');
    await assert.rejects(context.service.start({ taskId: preview.taskId, confirmed: true, runtime: { provider: 'claude', model: 'opus', reasoningEffort: '', accessMode: 'workspace' } }),
      /无法在 Jira 登记/);
    await assert.rejects(fs.stat(`${context.project}-tasks`));
    assert.equal(context.executed.length, 0);
  } finally { await context.close(); }
});

test('多项目契约仅用于需求开发，最多十项，旧单项目请求保留', () => {
  const input = { workflow: 'requirement', projectPath: '/web', baseBranch: 'master', branchName: 'feature/test', details: '新增筛选' };
  assert.equal(jiraDevPrepareSchema.safeParse(input).success, true);
  assert.equal(jiraDevPrepareSchema.safeParse({ ...input, projects: [{ path: '/api', baseBranch: 'pre', branchName: 'feature/api' }] }).success, true);
  assert.equal(jiraDevPrepareSchema.safeParse({ ...input, workflow: 'jira', projects: [{ path: '/api', baseBranch: 'pre', branchName: 'feature/api' }] }).success, false);
  assert.equal(jiraDevPrepareSchema.safeParse({ ...input, projects: Array.from({ length: 11 }, (_, i) => ({ path: `/project-${i}`, baseBranch: 'master', branchName: 'feature/test' })) }).success, false);
  assert.equal(jiraDevPrepareSchema.safeParse({ ...input, developmentKey: 'TEST-698' }).success, false);
  assert.equal(jiraDevPrepareSchema.safeParse({ ...input, sourceKind: 'frontend', developmentKey: 'TEST-698' }).success, true);
  assert.equal(jiraDevPrepareSchema.safeParse({ ...input, sourceKind: 'frontend', developmentKey: 'https://other.test/browse/TEST-698' }).success, false);
});

test('已有前端任务可在表单或预览中只读选择，明确选择保留原需求和排期', async () => {
  const issue = (key: string, summary: string) => ({ ...defect, key, url: `${site}/browse/${key}`, summary,
    startDate: '2026-11-09', endDate: '2026-11-13', rawFields: { private: 'internal' } });
  const first = { ...issue('TEST-698', '前端开发 · 第一项'), issueType: { name: 'Task', subtask: false } };
  const second = { ...issue('TEST-825', '前端开发 · 第二项'), issueType: first.issueType, subtasks: [{ key: 'TEST-826' }] };
  const child = { ...issue('TEST-826', '实现列表筛选'), issueType: { name: 'Sub-task', subtask: true }, parent: { key: second.key } };
  const foreign = { ...first, key: 'TEST-999', url: 'https://other.example.test/browse/TEST-999' };
  const source = { ...issue('TEST-124', '产品需求'), issueType: { name: 'Story', subtask: false }, links: [first, second, foreign] };
  let issues = [first, second, foreign], searches = 0, writes = 0, lookupError = '';
  const write = () => { writes++; assert.fail('只读核对不得写入 Jira'); };
  const readIssue = async (reference: string) => {
    const found = [source, first, second, child].find(item => reference === item.key || reference === item.url);
    assert.ok(found);
    return found;
  };
  const client = {
    readIssue,
    findRequirementIssues: async ({ sourceIssue }: { sourceIssue: { key: string } }) => {
      searches++;
      if (lookupError) throw new Error(lookupError);
      return { sourceIssue: await readIssue(sourceIssue.key), issues };
    },
    readRequirementScheduleContext: async () => ({ issue: child, startField: 'start', fields: { start: { schema: { type: 'date' }, operations: ['set'] } } }),
    createRequirementIssue: write, updateRequirementDates: write, linkRequirementIssues: write,
  };
  const context = await fixture({ jiraClient: async () => client as never });
  try {
    const input = { workflow: 'requirement', sourceKind: 'frontend', source: source.key, details: '保留需求补充内容',
      projectPath: context.project, baseBranch: 'master', branchName: 'feature/jira-choice', schedules: { implementation: { startDate: '2026-11-10' } } };
    const choice = ({ key, url, summary }: typeof first) => ({ key, url, summary });
    assert.equal((await context.service.readIssue({ source: source.key })).developmentCandidates, undefined);
    assert.equal(searches, 0);
    const initial = await context.service.readIssue({ source: source.key, includeDevelopmentCandidates: true });
    assert.equal(initial.issue.key, source.key);
    assert.deepEqual(initial.developmentCandidates, [choice(first), choice(second)]);
    const direct = await context.service.readIssue({ source: second.key, includeDevelopmentCandidates: true });
    assert.deepEqual(direct.developmentCandidates, [choice(second)]);
    lookupError = '关联任务读取超时';
    const unavailable = await context.service.readIssue({ source: source.key, includeDevelopmentCandidates: true });
    assert.equal(unavailable.issue.key, source.key);
    assert.equal(unavailable.developmentCandidateError, lookupError);
    lookupError = '';
    source.links = [second, foreign];
    await assert.rejects(context.service.prepare({ ...input, developmentKey: first.key }), { statusCode: 409 });
    await assert.rejects(context.service.prepare({ ...input, developmentKey: foreign.key }), { statusCode: 409 });
    for (const filename of ['tasks.json', 'requirement-plans.json']) {
      await assert.rejects(fs.stat(path.join(context.directory, 'jira-dev', filename)), { code: 'ENOENT' });
    }
    source.links = [first, second, foreign];
    const beforePreview = searches;
    const preview = await context.service.prepare(input);
    const { taskId } = preview;
    assert.equal(preview.plan?.status, 'local');
    assert.deepEqual(preview.plan?.developmentCandidates, [choice(first), choice(second)]);
    assert.deepEqual(preview.plan?.items, []);
    assert.equal(searches, beforePreview + 1);

    for (const file of ['requirement-plans.json', 'tasks.json']) {
      const filename = path.join(context.directory, 'jira-dev', file);
      const [record] = JSON.parse(await fs.readFile(filename, 'utf8'));
      delete (record.requirementPlan || record).developmentCandidates;
      await fs.writeFile(filename, JSON.stringify([record]));
    }
    assert.equal((await context.service.task({ taskId })).plan?.developmentCandidates, undefined);
    assert.equal(searches, beforePreview + 1);

    source.links = [second, foreign];
    await assert.rejects(context.service.check({ taskId, developmentKey: first.key }), { statusCode: 409 });
    await assert.rejects(context.service.check({ taskId, developmentKey: foreign.key }), { statusCode: 409 });
    const refreshed = await context.service.check({ taskId });
    assert.equal(refreshed.plan?.status, 'local');
    assert.deepEqual(refreshed.plan?.developmentCandidates, [choice(second)]);

    const incomplete = await context.service.check({ taskId, developmentKey: second.key });
    assert.equal(incomplete.plan?.status, 'local');
    assert.match(incomplete.plan?.warning || '', /未完整读取/);
    assert.deepEqual(incomplete.plan?.items, []);
    assert.deepEqual(incomplete.plan?.developmentCandidates, [choice(second)]);

    issues = [...issues, child];
    const selected = await context.service.check({ taskId, developmentKey: second.key });
    assert.equal(selected.taskId, taskId);
    assert.equal(selected.plan?.status, 'ready', selected.plan?.warning);
    assert.equal(selected.plan?.sourceIssue?.key, source.key);
    assert.equal(selected.plan?.developmentIssue?.key, child.key);
    assert.equal(selected.plan?.developmentCandidates, undefined);
    assert.deepEqual(selected.plan?.items.map(item => item.key), [second.key, child.key]);
    assert.equal(selected.plan?.requiresConfirmation, true);
    assert.equal(selected.plan?.items[1]?.schedule?.startDate, '2026-11-10');
    assert.equal(selected.plan?.items[1]?.schedule?.previousStartDate, '2026-11-09');
    assert.deepEqual(selected.plan?.designDestination, preview.plan?.designDestination);
    assert.deepEqual(selected.projects, preview.projects);
    assert.equal(selected.projectPath, context.project);
    assert.equal(selected.branchName, 'feature/jira-choice');
    assert.equal((await context.service.deliveryTask(taskId)).details, '保留需求补充内容');
    assert.equal((await context.service.task({ taskId })).plan?.developmentIssue?.key, child.key);
    await assert.rejects(context.service.check({ taskId, developmentKey: second.key }), { statusCode: 409 });

    source.links = [first, second, foreign];
    const fromForm = await context.service.prepare({ ...input, developmentKey: second.key });
    assert.equal(fromForm.plan?.status, 'ready', fromForm.plan?.warning);
    assert.equal(fromForm.plan?.sourceIssue?.key, source.key);
    assert.deepEqual(fromForm.plan?.items.map(item => item.key), [second.key, child.key]);
    assert.deepEqual(fromForm.projects, preview.projects);
    assert.equal(fromForm.plan?.items[1]?.schedule?.startDate, '2026-11-10');
    assert.equal(writes, 0);
  } finally { await context.close(); }
});

test('多项目预览不建工作区；后续项目失败后重试复用前两个工作区并传递全部项目映射', async () => {
  const creations: string[] = [];
  let lastProject = '', failed = false;
  const context = await fixture({ workspaceCreator: async input => {
    if (input.projectPath === lastProject && !failed) { failed = true; throw new Error('第三项目暂不可用'); }
    creations.push(input.projectPath);
    return createTaskWorkspace(input);
  } });
  try {
    const api = path.join(context.directory, 'api'), common = path.join(context.directory, 'common');
    await exec('git', ['clone', context.origin, api]);
    await exec('git', ['clone', context.origin, common]);
    lastProject = common;
    await fs.writeFile(path.join(api, 'local.txt'), '来源项目改动');
    const projects = [{ path: context.project, baseBranch: 'master', branchName: 'feature/web-filter' },
      { path: api, baseBranch: 'master', branchName: 'feature/api-filter' },
      { path: common, baseBranch: 'master', branchName: 'feature/common-filter' }];
    const preview = await context.service.prepare({ workflow: 'requirement', projectPath: context.project, baseBranch: 'master',
      branchName: 'feature/web-filter', details: '【设备管理】跨项目筛选', businessModule: '设备管理', projects });
    assert.deepEqual(preview.projects, projects);
    assert.equal(creations.length, 0);
    for (const project of projects) assert.ok(preview.prompt.includes(project.path));
    await context.service.apply({ taskId: preview.taskId, confirmed: true });
    const runtime = { provider: 'claude', model: 'opus', reasoningEffort: '', accessMode: 'full' } as const;
    await assert.rejects(context.service.start({ taskId: preview.taskId, runtime: { ...runtime, accessMode: 'workspace' }, confirmed: true }),
      /多项目任务需要完全访问权限，请选择完全访问后开始/);
    assert.equal(creations.length, 0, '权限校验发生在创建任一工作区之前');
    const failedLaunch = await context.service.start({ taskId: preview.taskId, runtime, confirmed: true });
    assert.equal(failedLaunch.launch?.status, 'failed');
    assert.match(failedLaunch.launch!.error, /第三项目暂不可用/);
    assert.equal(context.executed.length, 0);
    assert.ok(failedLaunch.projects?.[1]?.workspacePath, '第二项目的工作区已持久化');
    const started = await context.service.start({ taskId: preview.taskId, runtime, confirmed: true });
    assert.equal(started.launch?.status, 'started', started.launch?.error);
    assert.deepEqual(creations, projects.map(project => project.path));
    assert.equal(started.projects?.[0]?.workspacePath, failedLaunch.projects?.[0]?.workspacePath);
    assert.equal(started.projects?.[1]?.workspacePath, failedLaunch.projects?.[1]?.workspacePath);
    await waitFor(() => context.executed.length === 1);
    for (const project of started.projects || []) {
      assert.ok(project.workspacePath && project.baseSha);
      assert.ok(context.executed[0]!.objective.includes(project.workspacePath!));
      assert.equal((await git(project.workspacePath!, 'branch', '--show-current')).stdout.trim(), project.branchName);
    }
    assert.equal(await fs.readFile(path.join(api, 'local.txt'), 'utf8'), '来源项目改动');
    assert.match(started.prompt, /全部来源检出只读/);
    assert.match(started.prompt, /没有逐项目证据时不得声称所有项目已验证通过/);
    assert.equal((await context.service.task({ taskId: preview.taskId })).projects?.length, 3);
  } finally { await context.close(); }
});

test('同仓库不同检出使用相同或前缀冲突的新分支时预览即拒绝，避免只创建一半工作区', async () => {
  const context = await fixture();
  try {
    const checkout = path.join(context.directory, 'checkout');
    await git(context.project, 'worktree', 'add', '-b', 'feature/existing-checkout', checkout, 'master');
    for (const branchName of ['feature/shared', 'feature/shared/child']) {
      await assert.rejects(context.service.prepare({ workflow: 'requirement', projectPath: context.project, baseBranch: 'master',
        branchName: 'feature/shared', details: '跨项目筛选', projects: [
          { path: context.project, baseBranch: 'master', branchName: 'feature/shared' }, { path: checkout, baseBranch: 'master', branchName },
        ] }), /同一仓库的不同检出不能使用相同或相互冲突的工作分支/);
    }
    await assert.rejects(fs.stat(`${context.project}-tasks`));
    await assert.rejects(fs.stat(`${checkout}-tasks`));
    assert.equal((await git(context.project, 'branch', '--list', 'feature/shared')).stdout.trim(), '');
  } finally { await context.close(); }
});

test('自动协作按固定请求编号启动团队、回读启动结果并恢复关联，不调用单 Agent 模型', async () => {
  const team = { teamTaskId: '11111111-1111-4111-8111-111111111111', conversationId: '22222222-2222-4222-8222-222222222222',
    runId: '33333333-3333-4333-8333-333333333333', runStatus: 'queued' as const };
  let known: typeof team | undefined, requestId = '', calls = 0, objective = '';
  const context = await fixture({
    startTeam: async input => { calls++; requestId = input.requestId; objective = input.objective; known = team; throw new Error('响应中断'); },
    findTeam: candidate => candidate === requestId ? known : undefined,
  });
  try {
    const api = path.join(context.directory, 'api');
    await exec('git', ['clone', context.origin, api]);
    const preview = await context.service.prepare({ workflow: 'requirement', projectPath: context.project, baseBranch: 'master',
      branchName: 'feature/team-filter', details: '【设备管理】设备筛选', businessModule: '设备管理', projects: [
        { path: context.project, baseBranch: 'master', branchName: 'feature/team-filter' }, { path: api, baseBranch: 'master', branchName: 'feature/team-api' },
      ] });
    await context.service.apply({ taskId: preview.taskId, confirmed: true });
    // 此执行器没有被测试运行时注册；自动协作必须由岗位配置路由，不能启动该单模型。
    const runtime = { collaborationMode: 'automatic', provider: 'antigravity', model: 'unused', reasoningEffort: '', accessMode: 'full' } as const;
    const started = await context.service.start({ taskId: preview.taskId, runtime, confirmed: true });
    assert.equal(started.launch?.status, 'started', started.launch?.error);
    assert.equal(started.launch?.teamTaskId, team.teamTaskId);
    assert.equal(started.launch?.conversationId, team.conversationId);
    assert.equal(started.launch?.runId, team.runId);
    assert.equal(requestId, `jira-dev:${preview.taskId}`);
    assert.match(objective, /"requirementProgress"/);
    assert.match(objective, /该主项目 worktree 只作为团队来源，保持只读/);
    assert.match(objective, /以团队为当前岗位派发的候选副本为准/);
    assert.doesNotMatch(objective, /仅在该目录实现与验证/);
    assert.equal(started.projects?.length, 2);
    for (const project of started.projects || []) assert.ok(project.workspacePath && objective.includes(project.workspacePath));
    assert.equal(context.executed.length, 0);
    assert.equal(context.requirements.list().find(record => record.id === preview.taskId)?.runId, team.runId);
    const again = await context.service.start({ taskId: preview.taskId, runtime, confirmed: true });
    assert.equal(again.launch?.teamTaskId, team.teamTaskId);
    assert.equal(calls, 1);
    const stored = JSON.parse(await fs.readFile(path.join(context.directory, 'jira-dev', 'launches.json'), 'utf8'));
    assert.equal(stored[preview.taskId].teamTaskId, team.teamTaskId);
    const restored = await createJiraDevTaskService({ dataDirectory: path.join(context.directory, 'jira-dev'), runtime: context.runtime,
      adoptJiraFix: record => context.jiraFix.adopt(record), adoptRequirement: record => context.requirements.adopt(record),
      findTeam: candidate => candidate === requestId ? known : undefined });
    try {
      const recovered = await restored.task({ taskId: preview.taskId });
      assert.equal(recovered.launch?.runStatus, 'queued');
      assert.equal((await restored.start({ taskId: preview.taskId, runtime, confirmed: true })).launch?.runId, team.runId);
    } finally { await restored.close(); }
  } finally { await context.close(); }
});

test('团队已创建但尚无负责人会话时保留可核对状态，禁止重复启动', async () => {
  const team = { teamTaskId: '11111111-1111-4111-8111-111111111111', conversationId: '22222222-2222-4222-8222-222222222222', runId: '' };
  let calls = 0;
  const context = await fixture({ startTeam: async () => { calls++; return team; }, findTeam: () => calls ? team : undefined });
  try {
    const preview = await context.service.prepare({ workflow: 'jira', repairMode: 'direct', projectPath: context.project, source: 'TEST-123',
      baseBranch: 'master', branchName: 'feature/team-repair', details: '只修筛选' });
    const runtime = { collaborationMode: 'automatic', provider: 'claude', model: 'opus', reasoningEffort: '', accessMode: 'full' } as const;
    const started = await context.service.start({ taskId: preview.taskId, runtime, confirmed: true });
    assert.equal(started.launch?.status, 'uncertain');
    assert.equal(started.launch?.teamTaskId, team.teamTaskId);
    await assert.rejects(context.service.start({ taskId: preview.taskId, runtime, confirmed: true }), /不会重复创建团队/);
    assert.equal(calls, 1);
    team.runId = '33333333-3333-4333-8333-333333333333';
    const recovered = await context.service.start({ taskId: preview.taskId, runtime, confirmed: true });
    assert.equal(recovered.launch?.status, 'started');
    assert.equal(recovered.launch?.runId, team.runId);
    assert.equal(calls, 1);
    assert.equal(context.executed.length, 0);
  } finally { await context.close(); }
});

test('巡检预览区分缺陷和开发，复用已有任务，且不建工作区或写 Jira', async () => {
  const feature = { ...defect, key: 'TEST-124', url: `${site}/browse/TEST-124`, summary: '新增列表筛选' };
  const client = {
    readIssue: async (source: string) => source.includes('124') ? feature : defect,
    connection: async () => ({ site, account: { id: 'me', name: '我' } }),
    findRequirementIssues: async () => ({ sourceIssue: feature, issues: [] }),
  };
  const context = await fixture({ jiraClient: async () => client as never });
  try {
    const remote = 'git@example.test:business/web.git';
    await git(context.project, 'remote', 'set-url', 'origin', remote);
    const item = (key: string, issueType: string, repositoryUrl = remote) => ({
      issue: { key, issueType, url: `${site}/browse/${key}`, summary: key },
      projectRouting: { status: 'matched', profile: { localPath: context.project, repositoryUrl, targetBranch: 'master' } },
    } as PlanItem);
    const items = [item(defect.key, 'Bug'), item(feature.key, 'Task')];
    const manual = await context.service.prepare({ workflow: 'jira', repairMode: 'direct', projectPath: context.project,
      source: defect.url, baseBranch: 'master', branchName: 'feature/TEST-123' });
    const [first, second] = await Promise.all([
      context.service.prepareAutomationPreviews(items, 1), context.service.prepareAutomationPreviews(items, 1),
    ]);
    assert.deepEqual(second, first);
    assert.equal(first.length, 2);
    assert.equal(first[0]?.taskId, manual.taskId);
    assert.equal(first[0]?.workflow, 'jira');
    assert.equal(first[1]?.workflow, 'requirement');
    const requirement = await context.service.task({ taskId: first[1]?.taskId });
    assert.equal(requirement.plan?.sourceKind, 'frontend');
    assert.equal(requirement.plan?.items.find(item => item.role === 'implementation')?.action, 'reuse');
    const wrongRepository = await context.service.prepareAutomationPreviews([item('TEST-125', 'Bug', 'git@example.test:another/web.git')], 1);
    assert.ok(wrongRepository[0]?.error);
    assert.equal(wrongRepository[0]?.taskId, undefined);
    const records = JSON.parse(await fs.readFile(path.join(context.directory, 'jira-dev', 'tasks.json'), 'utf8'));
    assert.equal(records.length, 2);
    assert.equal(context.executed.length, 0);
    await assert.rejects(fs.stat(`${context.project}-tasks`));
  } finally { await context.close(); }
});

test('自动研发使用既有 Jira 启动独立 Codex 任务，按派发限额续处理，重复巡检不会重开或覆盖人工预览', async () => {
  const feature = { ...defect, key: 'TEST-124', url: `${site}/browse/TEST-124`, summary: '新增列表筛选' };
  const manual = { ...defect, key: 'TEST-125', url: `${site}/browse/TEST-125` };
  let currentDefect = defect;
  const read = async (source: string) => source.includes('124') ? feature : source.includes('125') ? manual : currentDefect;
  const jiraWrites: string[] = [], launchIds: string[] = [];
  const jiraWrite = (name: string) => async () => { jiraWrites.push(name); throw new Error('不允许外部写入'); };
  const context = await fixture({
    jiraClient: async () => ({
      readIssue: read, findRequirementIssues: async ({ sourceIssue }: { sourceIssue: { url: string } }) => ({ sourceIssue: await read(sourceIssue.url), issues: [] }),
      createRequirementIssue: jiraWrite('create'), updateRequirementDates: jiraWrite('dates'), linkRequirementIssues: jiraWrite('link'),
    } as never),
    workspaceCreator: async ({ projectPath, baseBranch, branchName, taskName }) => {
      const workspacePath = path.join(path.dirname(projectPath), `test-worktree-${taskName}`);
      const baseSha = (await git(projectPath, 'rev-parse', 'HEAD')).stdout.trim();
      await git(projectPath, 'worktree', 'add', '-b', branchName, workspacePath, baseSha);
      return { sourcePath: projectPath, workspacePath, baseRef: `origin/${baseBranch}`, baseSha, branchName };
    },
    onLaunch: (_task, launch) => { launchIds.push(launch.runId); },
  });
  try {
    const remote = 'git@example.test:business/web.git';
    await git(context.project, 'remote', 'set-url', 'origin', remote);
    const items = [defect, feature, manual].map((issue, index) => ({
      issue: { ...issue, issueType: index === 1 ? 'Task' : 'Bug' },
      projectRouting: { status: 'matched', profile: { localPath: context.project, repositoryUrl: remote, targetBranch: 'master' } },
    } as unknown as PlanItem));
    const draft = await context.service.prepare({ workflow: 'jira', source: manual.url, projectPath: context.project, baseBranch: 'master', branchName: 'feature/TEST-125' });
    const previews = await context.service.prepareAutomationPreviews(items, 0);
    assert.ok(previews.every(row => !row.runId));
    assert.equal(context.executed.length, 0);
    const stopped = await context.service.prepareAutomationPreviews(items, 1, 'start', async () => false);
    assert.equal(stopped.find(row => row.issueKey === defect.key)?.launchStatus, 'blocked');
    await assert.rejects(fs.stat(path.join(context.directory, `test-worktree-${defect.key}`)));
    currentDefect = { ...defect, description: '已更新的复现范围' };
    const stale = await context.service.prepareAutomationPreviews(items, 1, 'start');
    const staleResult = stale.find(row => row.issueKey === defect.key);
    assert.equal(staleResult?.launchStatus, 'awaiting_confirmation');
    assert.match(staleResult?.error || '', /任务范围已更新/);
    assert.equal(staleResult?.runId, undefined);
    await assert.rejects(fs.stat(path.join(context.directory, `test-worktree-${defect.key}`)));
    const development = stale.find(row => row.issueKey === feature.key);
    assert.equal(development?.launchStatus, 'started', development?.error);
    currentDefect = defect;
    const first = await context.service.prepareAutomationPreviews(items, 1, 'start');
    assert.equal(first.find(row => row.issueKey === defect.key)?.launchStatus, 'started');
    assert.equal(first.find(row => row.issueKey === feature.key)?.launchStatus, 'existing');
    const second = await context.service.prepareAutomationPreviews(items, 1, 'start');
    assert.equal(second.find(row => row.issueKey === defect.key)?.launchStatus, 'existing');
    const preserved = second.find(row => row.issueKey === manual.key);
    assert.equal(preserved?.taskId, draft.taskId);
    assert.equal(preserved?.launchStatus, 'awaiting_confirmation');
    const plan = (await context.service.task({ taskId: development!.taskId })).plan;
    assert.equal(plan?.status, 'applied');
    assert.equal(plan?.designPublicationAuthorized, false);
    assert.deepEqual(jiraWrites, []);
    await waitFor(() => context.executed.length === 2 && launchIds.length === 2);
    assert.deepEqual(context.executed.map(run => run.provider), ['codex', 'codex']);
    assert.equal(context.jiraFix.list().length, 1);
    assert.equal(context.requirements.list().length, 1);
  } finally { await context.close(); }
});
