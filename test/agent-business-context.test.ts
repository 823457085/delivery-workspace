import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRun } from '../shared/agent-runtime.js';
import type { CatchupRequirement, JiraIssue, Job, LocalProject, MergeItem } from '../shared/hub.js';
import type { AgentBusinessSnapshot } from '../src/features/agent-workbench/agent-business-context.js';
import { buildAgentBusinessContext, buildAgentBusinessMentions } from '../src/features/agent-workbench/agent-business-context.js';
import type { AgentConversation } from '../src/features/agent-workbench/conversation.js';

function conversation(objective: string, workspacePath = '/repo/admin', branch = 'feature/APEX-263'): AgentConversation {
  const run: AgentRun = { id: 'run-1', provider: 'codex', mode: 'agent', accessMode: 'workspace', model: 'gpt-test', reasoningEffort: 'high', objective,
    workspacePath, branch, headSha: 'abc', status: 'completed', sessionId: 'session-1', pid: null, result: '', error: '', events: [],
    createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:01:00.000Z' };
  return { id: run.id, title: objective, updatedAt: run.updatedAt, runs: [run], latest: run, source: 'workspace', loaded: true };
}

const issue: JiraIssue = { key: 'APEX-263', url: 'https://jira.example/APEX-263', summary: '新增支付渠道筛选', status: '进行中',
  statusCategory: 'indeterminate', issueType: '需求', priority: 'Medium', project: 'APEX', projectName: 'Apex', assignee: '测试负责人',
  fixVersions: ['v3.0.0.9'], created: '', updated: '2026-09-17T00:00:00.000Z', dueDate: null, startDate: null, endDate: null,
  resolutionDate: null, parent: null, subtasks: [] };

test('无项目会话允许追平记录尚无 session，不白屏也不关联无关任务', () => {
  const requirement = { id: 'REQ-001', session: null } as unknown as CatchupRequirement;
  const snapshot = { catchup: { requirements: [requirement] }, issues: [issue] } as AgentBusinessSnapshot;
  const current = conversation('你好', '/sessions/new', '');
  current.latest.sourceWorkspacePath = '';
  const result = buildAgentBusinessContext(current, snapshot);
  assert.equal(result.project, undefined);
  assert.deepEqual(result.catchup, []);
  assert.deepEqual(result.jiraIssues, []);
  const explicit = buildAgentBusinessContext(conversation('检查 REQ-001', '/sessions/new', ''), snapshot);
  assert.deepEqual(explicit.catchup, [requirement]);
  assert.deepEqual(explicit.jiraIssues, []);
});

const project: LocalProject = { projectId: 'apex-admin', projectName: 'admin', displayName: 'Apex 重构', suggestedDisplayName: 'Apex 重构',
  repository: 'admin', path: '/repo/admin', displayPath: '/repo/admin', relativePath: 'admin', rootPath: '/repo', rootLabel: 'repo', folderName: 'admin',
  branch: 'feature/APEX-263', upstream: 'origin/feature/APEX-263', clean: true, changed: 0, staged: 0, modified: 0, untracked: 0,
  detached: false, ahead: 0, behind: 0, webUrl: '', remoteUrl: '' };

test('APEX 重构项目任务独立展示主任务和子任务，不冒充当前会话任务或交付', () => {
  const parent = { ...issue, key: 'DEMO-934', summary: '【APEX重构】完成 Admin BFF 全量联调交付',
    subtasks: [{ key: 'DEMO-938', summary: '国家区域配置', status: '开发中', statusCategory: '处理中' }] };
  const done = { ...parent, key: 'DEMO-548', status: '已完成', statusCategory: '完成', subtasks: [] };
  const child = { ...issue, key: 'DEMO-948', summary: '【APEX重构】交付验收', parent: { key: parent.key } };
  const snapshot: AgentBusinessSnapshot = { refactorRepository: 'example-team/admin', issues: [done, child, parent, issue], projects: {
    projects: [{ ...project, repository: 'example-team/admin' }], roots: [],
    directoryCount: 1, durationMs: 1, limited: false, unreadableCount: 0,
  } };
  const context = buildAgentBusinessContext(conversation('检查工作台'), snapshot);
  assert.deepEqual(context.refactorIssues, [parent, done]);
  assert.deepEqual([context.jiraIssues, context.jobs, context.catchup, context.merges], [[], [], [], []]);
  assert.deepEqual(buildAgentBusinessContext(conversation('检查', '/repo/unrelated'), snapshot).refactorIssues, []);
});

test('会话只按精确 Jira 标识和工作区关联业务上下文', () => {
  const context = buildAgentBusinessContext(conversation('继续开发 APEX-263'), { issues: [issue], projects: { projects: [project], roots: [],
    directoryCount: 1, durationMs: 1, limited: false, unreadableCount: 0 } });
  assert.deepEqual(context.jiraIssues.map(item => item.key), ['APEX-263']);
  assert.equal(context.project?.projectId, 'apex-admin');
  assert.deepEqual(buildAgentBusinessContext(conversation('查看 APEX-2630'), { issues: [issue] }).jiraIssues, []);
});

test('会话关联任务保留来源子任务和状态，不使用旧的全局待办筛选', () => {
  const parent = { ...issue, subtasks: [
    { key: 'APEX-264', summary: '待执行子任务', status: '待开始', statusCategory: 'todo' },
    { key: 'APEX-265', summary: '完成的子任务', status: '已完成', statusCategory: 'done' },
  ] };
  const context = buildAgentBusinessContext(conversation('检查 APEX-263'), { issues: [parent, { ...issue, key: 'APEX-266' }] });
  assert.deepEqual(context.jiraIssues, [parent]);
  assert.deepEqual(context.jiraIssues[0]?.subtasks, parent.subtasks);
});

test('显式项目引用支持仓库来源类型的复合 ID', () => {
  const complexProject = { ...project, projectId: 'git.example.test:example-team/example-repository' };
  const context = buildAgentBusinessContext(conversation(`@项目:${complexProject.projectId} 检查项目`, '/unrelated'), {
    projects: { projects: [complexProject], roots: [], directoryCount: 1, durationMs: 1, limited: false, unreadableCount: 0 },
  });
  assert.equal(context.project?.projectId, complexProject.projectId);
});

test('接口页只响应显式 @接口 引用，不根据普通文案猜测', () => {
  const page = { id: 'country-config', menu: '系统配置', title: '国家基础配置', routes: ['/country'], operations: [] };
  assert.equal(buildAgentBusinessContext(conversation('检查国家基础配置'), { pages: [page] }).interfacePage, undefined);
  assert.equal(buildAgentBusinessContext(conversation('@接口:country-config 检查报错'), { pages: [page] }).interfacePage?.page.id, 'country-config');
});

test('Agent 接口页进度只统计人工审核确认，不使用旧联调状态', () => {
  const page = { id: 'settings', menu: '系统配置', title: '平台功能设置', routes: ['/SystemConfig/GlobalConfig/PlatformSetting'], operations: [
    { operationId: 'exampleList', method: 'GET', path: '/api/v1/examples/list', summary: '地址格式', contractStatus: '未标记', stageId: '02', stageTitle: '系统配置' },
  ] };
  const record = { evidence: '真实环境请求与页面回读', blocker: '', confirmedAt: '', updatedAt: '' };
  const pending = buildAgentBusinessContext(conversation('@接口:settings 检查联调'), { pages: [page], review: { 'example-1': record } });
  assert.deepEqual(pending.interfacePage?.progress, { total: 1, confirmed: 0, blocked: 0 });
  const confirmed = buildAgentBusinessContext(conversation('@接口:settings 检查联调'), { pages: [page], review: { 'example-1': { ...record, confirmedAt: '2026-09-22T00:00:00.000Z' } } });
  assert.equal(confirmed.interfacePage?.progress?.confirmed, 1);
  const custom = buildAgentBusinessContext(conversation('@接口:settings 检查联调'), { pages: [page], catalog: [{ path: '/api/v1/examples/list', id: 'custom-interface' }], review: { 'custom-interface': { ...record, confirmedAt: '2026-09-22T00:00:00.000Z' } } });
  assert.equal(custom.interfacePage?.progress?.confirmed, 1);
});

test('合入记录按需求 ID 关联，业务选择项写入稳定引用', () => {
  const merge: MergeItem = { requirementId: 'REQ-008', title: '授权平台预处理', jiraKey: 'DEMO-577', status: '待审核', merged: false,
    sourceBranch: 'feature/REQ-008', deliveryWorkspacePath: '/other', sessionWorkspacePath: '/other', pipeline: { threadId: '', clientThreadId: '' } } as MergeItem;
  const snapshot = { issues: [issue], projects: { projects: [project], roots: [], directoryCount: 1, durationMs: 1, limited: false,
    unreadableCount: 0 }, merge: { source: { checkedAt: '', targetFresh: true, remoteChecked: true }, target: { branch: '', localSha: '', remoteSha: '', url: '' },
    summary: {}, revision: 1, items: [merge], mergeRules: [], pipeline: { status: '', currentRequirementId: '', result: '', error: '', updatedAt: '' } } };
  const context = buildAgentBusinessContext(conversation('@合入:REQ-008 查看证据'), snapshot);
  assert.deepEqual(context.merges.map(item => item.requirementId), ['REQ-008']);
  const mentions = buildAgentBusinessMentions(snapshot);
  assert.equal(mentions.find(item => item.id === 'jira:APEX-263')?.value, '@Jira:APEX-263');
  assert.equal(mentions.find(item => item.id === 'merge:REQ-008')?.value, '@合入:REQ-008');
});

test('共享工作区和分支不会将其他会话的执行、追平、合入记录带入右栏', () => {
  const current = conversation('检查页面样式');
  const snapshot: AgentBusinessSnapshot = {
    automation: { jobs: [{ id: 'job-other', issueKey: 'APEX-263', workspacePath: '/repo/admin', branch: current.latest.branch,
      threadId: 'other-session', clientThreadId: '' } as Job] } as AgentBusinessSnapshot['automation'],
    catchup: { requirements: [{ id: 'REQ-008', session: { jiraKey: 'APEX-263', workspacePath: '/repo/admin',
      branch: current.latest.branch, threadId: 'other-session', clientThreadId: '' } } as CatchupRequirement] } as AgentBusinessSnapshot['catchup'],
    merge: { items: [{ requirementId: 'REQ-008', jiraKey: 'APEX-263', deliveryWorkspacePath: '/repo/admin',
      sessionWorkspacePath: '/repo/admin', sourceBranch: current.latest.branch,
      pipeline: { threadId: 'other-session', clientThreadId: '' } } as MergeItem] } as AgentBusinessSnapshot['merge'],
    issues: [issue],
  };
  const unrelated = buildAgentBusinessContext(current, snapshot);
  assert.deepEqual([unrelated.jobs, unrelated.catchup, unrelated.merges, unrelated.jiraIssues], [[], [], [], []]);
  const explicit = buildAgentBusinessContext(conversation('请检查 APEX-263'), snapshot);
  assert.deepEqual([explicit.jobs.length, explicit.catchup.length, explicit.merges.length], [1, 1, 1]);
  assert.deepEqual(explicit.jiraIssues.map(item => item.key), ['APEX-263']);
});

test('会话身份关联可回读任务，且同时检查正式和临时会话 ID', () => {
  const snapshot: AgentBusinessSnapshot = {
    automation: { jobs: [{ id: 'job-1', issueKey: 'APEX-263', threadId: 'migrated-session', clientThreadId: 'session-1' } as Job,
      { id: 'job-2', issueKey: 'APEX-264', threadId: 'run-1', clientThreadId: '' } as Job] } as AgentBusinessSnapshot['automation'],
    issues: [issue, { ...issue, key: 'APEX-264', status: '已完成', statusCategory: 'done' }, { ...issue, key: 'APEX-265' }],
  };
  const result = buildAgentBusinessContext(conversation('继续检查'), snapshot);
  assert.deepEqual(result.jobs.map(item => item.id), ['job-1', 'job-2']);
  assert.deepEqual(result.jiraIssues.map(item => [item.key, item.status]), [['APEX-263', '进行中'], ['APEX-264', '已完成']]);
  assert.deepEqual(buildAgentBusinessContext(undefined, snapshot).jiraIssues, []);
});

test('一个会话展示全部明确引用的 Jira，空合入 ID 不会匹配', () => {
  const snapshot: AgentBusinessSnapshot = {
    issues: [issue, { ...issue, key: 'APEX-264' }, { ...issue, key: 'APEX-265' }],
    merge: { items: [{ requirementId: '', jiraKey: '', pipeline: { threadId: '', clientThreadId: '' } } as MergeItem] } as AgentBusinessSnapshot['merge'],
  };
  const result = buildAgentBusinessContext(conversation('APEX-263 和 APEX-264 一起检查'), snapshot);
  assert.deepEqual(result.jiraIssues.map(item => item.key), ['APEX-263', 'APEX-264']);
  assert.deepEqual(result.merges, []);
});
