import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error 旧后端使用无全量类型声明的 ESM JavaScript。
const core = await import('../server/jira-backend/automation-core.mjs');
// @ts-expect-error 纯路由模块使用 ESM JavaScript。
const routing = await import('../server/jira-backend/automation-project-routing.mjs');
// @ts-expect-error 仓库身份模块使用 ESM JavaScript。
const { repositoryIdentity } = await import('../server/jira-dev/repository-groups.mjs');

const profile = (id = 'app', overrides: Record<string, unknown> = {}) => ({
  id, name: id === 'app' ? 'App' : id.toUpperCase(),
  repositoryUrl: `git@example.test:business/${id}.git`, localPath: '',
  runtimeCommand: `pnpm dev:${id}`, runtimeEnvironment: `${id}-test`, targetBranch: `${id}-test`,
  jiraProjects: [], components: [], labels: [], ...overrides,
});
const issue = (overrides: Record<string, unknown> = {}) => ({
  key: 'OPAY-90', project: 'OPAY', components: [], labels: [],
  summary: '完成前端功能开发', description: '', url: 'https://jira.test/browse/OPAY-90',
  status: '开发中', statusCategory: '处理中', issueType: '任务', subtasks: [], parent: null, ...overrides,
});
const workspace = (id = 'app', overrides: Record<string, unknown> = {}) => ({
  path: `/work/${id}/OPAY-90`, folderName: 'OPAY-90', branch: 'feature/OPAY-90',
  remoteUrl: `https://example.test/business/${id}.git`, projectId: id,
  clean: true, ...overrides,
});
const settings = (profiles = [profile()], overrides: Record<string, unknown> = {}) => ({
  ...core.DEFAULT_AUTOMATION_SETTINGS, projectProfiles: profiles, ...overrides,
});
const resolve = (item = issue(), projects: unknown[] = [], config = settings()) => routing.resolveAutomationProject(item, projects, config);

test('旧设置仅迁移独立 profile，空规则不匹配任何 Jira；显式空列表不回退', () => {
  const migrated = core.sanitizeAutomationSettings({ repositoryUrl: profile().repositoryUrl });
  assert.equal(migrated.projectProfiles.length, 1);
  assert.deepEqual(migrated.projectProfiles[0].jiraProjects, []);
  assert.equal(resolve(issue(), [], migrated).status, 'unmatched');
  assert.equal(resolve(issue(), [workspace()], migrated).profile.id, 'legacy-default');
  const changedGlobals = core.sanitizeAutomationSettings({ runtimeCommand: 'wrong-global-command' }, migrated);
  assert.equal(changedGlobals.projectProfiles[0].runtimeCommand, migrated.projectProfiles[0].runtimeCommand);
  const empty = core.sanitizeAutomationSettings({ projectProfiles: [] }, migrated);
  assert.deepEqual(empty.projectProfiles, []);
  assert.equal(resolve(issue(), [workspace()], empty).status, 'unmatched');
  assert.throws(() => core.sanitizeAutomationSettings({ projectProfiles: [profile(), profile()] }), /ID/);
});

test('精确事项工作区匹配 SSH/HTTPS 仓库身份，不偏向 APEX、不混淆 key 前缀', () => {
  const config = settings([profile(), profile('apex')]);
  const app = workspace();
  assert.equal(resolve(issue(), [app], config).profile.id, 'app');
  assert.equal(resolve(issue(), [workspace('app', { path: '/work/OPAY-900', folderName: 'OPAY-900', branch: 'feature/OPAY-900' })], config).status, 'unmatched');
  assert.equal(core.matchIssueWorkspace(issue(), [app, workspace('apex', { repository: 'thor-admin2.0' })]), null);
  const multi = resolve(issue(), [app, workspace('apex', { repository: 'thor-admin2.0' })], config);
  assert.equal(multi.status, 'ambiguous');
  assert.deepEqual(multi.candidates.map((p: { id: string }) => p.id).sort(), ['apex', 'app']);
  assert.equal(resolve(issue(), [workspace('unknown')], config).status, 'unmatched');
});

test('明确子事项工作区优先父事项；只存在父事项时可匹配但跨仓库仍待选择', () => {
  const child = issue({ key: 'OPAY-91', parent: { key: 'OPAY-90' } });
  const app = workspace('app', { path: '/work/app/OPAY-91', folderName: 'OPAY-91', branch: 'feature/OPAY-91' });
  assert.equal(resolve(child, [workspace('apex'), app], settings([profile(), profile('apex')])).profile.id, 'app');
  assert.equal(resolve(child, [workspace()], settings()).profile.id, 'app');
  assert.equal(resolve(child, [workspace(), workspace('apex')], settings([profile(), profile('apex')])).status, 'ambiguous');
});

test('描述显式仓库 ID、URL、名称精确匹配；跨仓库和未配置声明不会被规则覆盖', () => {
  const config = settings([profile(), profile('apex')]);
  for (const description of [
    `Repository ID: ${repositoryIdentity(profile().repositoryUrl).repositoryId}`,
    'Repository ID: app', '*Repository ID:* app', '### Repository ID: app', '**Repository URL**: https://example.test/business/app.git',
    '普通正文\\nRepository ID: app',
    '仓库：App', '仓库名称：app', '仓库地址：[App](https://example.test/business/app.git)',
  ]) assert.equal(resolve(issue({ description }), [], config).profile?.id, 'app', description);
  assert.equal(resolve(issue({ description: '仓库：app、apex' }), [], config).status, 'ambiguous');
  assert.equal(resolve(issue({ description: '项目范围：app、apex（共 2 个项目）' }), [], config).status, 'ambiguous');
  const adf = { type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: '正文' }, { type: 'hardBreak' }, { type: 'text', text: 'Repository ID: app' },
  ] }] };
  assert.equal(resolve(issue({ description: adf }), [], config).profile.id, 'app');
  assert.equal(resolve(issue({ description: 'Repository URL: https://example.test/business/unknown.git' }), [], settings([profile('apex', { jiraProjects: ['OPAY'] })])).status, 'unmatched');
  assert.equal(resolve(issue({ description: '仓库：App' }), [workspace('apex')], config).status, 'ambiguous');
  assert.equal(resolve(issue({ description: '仓库：App' }), [], settings([profile(), profile('apex', { jiraProjects: ['OPAY'] })])).status, 'ambiguous');
  assert.equal(resolve(issue({ description: '正文提到 app，但没有声明仓库' }), [], config).status, 'unmatched');
  assert.equal(resolve(issue({ description: '未支持的行内声明 Repository ID: app' }), [], settings([profile('apex', { jiraProjects: ['OPAY'] })])).status, 'unmatched');
});

test('匹配规则维度之间 AND，维度内 OR，不凭 key 前缀推断系统', () => {
  const config = settings([profile('app', {
    jiraProjects: ['OPAY', 'VMS'], components: ['App', '10305'], labels: ['mobile', 'offline'],
  }), profile('pc', { jiraProjects: ['PC'] })]);
  const match = issue({ components: [{ id: '10305', name: '设备' }], labels: ['offline'] });
  assert.equal(resolve(match, [], config).profile.id, 'app');
  assert.equal(resolve({ ...match, project: { key: 'VMS' } }, [], config).profile.id, 'app');
  assert.equal(resolve({ ...match, labels: [] }, [], config).status, 'unmatched');
  assert.equal(resolve({ ...match, project: 'OTHER' }, [], config).status, 'unmatched');
  assert.equal(resolve(issue({ key: 'APEX-90', project: 'APEX' }), [], config).status, 'unmatched');
  assert.equal(resolve(issue(), [], settings([profile('app', { jiraProjects: ['OPAY'] }), profile('apex', { jiraProjects: ['OPAY'] })])).status, 'ambiguous');
});

test('路由不完整不继承全局命令，来源目录不冒充已创建的事项工作区', () => {
  for (const field of ['repositoryUrl', 'runtimeCommand', 'runtimeEnvironment', 'targetBranch']) {
    const config = settings([profile('app', { jiraProjects: ['OPAY'], [field]: '' })]);
    const result = resolve(issue(), [], config);
    assert.equal(result.status, 'incomplete', field);
    assert.equal(core.buildAutomationPlan([issue()], [], [], config)[0].dispatchable, false);
  }
  const config = settings([profile('app', { localPath: '/work/app', jiraProjects: ['OPAY'] })]);
  assert.equal(resolve(issue(), [], config).workspace, null);
  assert.equal(resolve(issue(), [], config).status, 'matched');
  assert.equal(resolve(issue(), [workspace('apex', { path: '/work/app', folderName: 'app', branch: 'main' })], config).status, 'incomplete');
  assert.equal(resolve(issue(), [], settings([profile('app', { localPath: './app', jiraProjects: ['OPAY'] })])).status, 'incomplete');
});

test('只派发完整唯一项目；按该项目目标分支核查已合入并隔离旧目标差异数据', () => {
  const config = settings([profile('app', { jiraProjects: ['OPAY'] })]);
  assert.equal(core.buildAutomationPlan([issue()], [], [], config)[0].dispatchable, true);
  assert.equal(core.buildAutomationPlan([issue()], [], [], settings())[0].dispatchable, false);
  const oldTarget = workspace('app', { remoteBranchesContainingHead: ['origin/i18n-test'],
    commitsAheadTarget: 3, diffFileCount: 5, gitEvidenceTargetBranch: 'i18n-test',
    upstream: 'origin/feature/OPAY-90', ahead: 0, headCommitMessage: 'OPAY-90: 开发完成' });
  const oldPlan = core.buildAutomationPlan([issue()], [oldTarget], [], config)[0];
  assert.equal(oldPlan.targetBranch, 'app-test');
  assert.equal(oldPlan.localAlreadyDone, false);
  assert.equal(oldPlan.deliveryOnly, false);
  assert.equal(oldPlan.workspaceEvidence.codePresent, false);
  assert.equal(core.buildAutomationPlan([issue()], [{ ...oldTarget, remoteBranchesContainingHead: ['origin/app-test'] }], [], config)[0].localAlreadyDone, true);
});

test('保存路由是领取与重建提示词的唯一项目来源，旧任务和变更配置必须重新核对', () => {
  const config = settings([profile('app', { jiraProjects: ['OPAY'] })], { autoCreateMergeRequest: true });
  const item = core.buildAutomationPlan([issue()], [workspace()], [], config)[0];
  const job = { id: item.jobId, issueKey: item.issue.key, issueUrl: item.issue.url,
    summary: item.issue.summary, category: 'implementation', projectRouting: item.projectRouting,
    workspacePath: '/wrong/old/global/workspace' };
  assert.equal(routing.automationProjectRoutingProblem(item.projectRouting, config), '');
  const prompt = core.buildCodexPromptFromJob(job, config);
  for (const expected of ['business/app.git', 'pnpm dev:app', 'app-test', '/work/app/OPAY-90']) assert.ok(prompt.includes(expected), expected);
  for (const forbidden of ['apex-jira-feature-development', 'apex-MM', 'thor-admin2.0', 'pnpm dev:i18n-test', '/wrong/old/global/workspace']) assert.ok(!prompt.includes(forbidden), forbidden);
  assert.match(core.buildCodexPromptFromJob({ ...job, projectRouting: undefined }, config), /暂不可执行/);
  const changed = settings([profile('app', { jiraProjects: ['OPAY'], runtimeCommand: 'pnpm dev:changed' })]);
  assert.match(routing.automationProjectRoutingProblem(item.projectRouting, changed), /变更/);
  assert.match(core.buildCodexPromptFromJob(job, changed), /暂不可执行/);
  const badWorkspace = { ...item.projectRouting, workspace: workspace('apex') };
  assert.match(routing.automationProjectRoutingProblem(badWorkspace, config), /仓库不一致/);
  const design = core.buildCodexPrompt({ ...item, category: 'design' }, config);
  assert.ok(!design.includes('Apex'));
  assert.ok(!design.includes('apex-frontend'));
});

test('实施和验证续作沿用原环境账号的持续登录授权，不逐次确认且不扩大外部写入', () => {
  const config = settings([profile('app', { jiraProjects: ['OPAY'] })], {
    loginKeychainAccount: 'fixture-user', loginKeychainService: 'fixture-login',
  });
  const item = core.buildAutomationPlan([issue()], [workspace()], [], config)[0];
  for (const category of ['implementation', 'verification']) {
    const prompt = core.buildCodexPrompt({ ...item, category }, config);
    assert.match(prompt, /原任务、环境和账号范围内持续有效/);
    assert.match(prompt, /续聊、重试或恢复执行时沿用，必要登录和会话续期无需逐次确认/);
    assert.match(prompt, /缺少真实授权、目标环境或账号发生变化，或确需验证码等用户交互时才询问/);
    assert.doesNotMatch(prompt, /取得用户针对该登录动作的确认/);
    assert.match(prompt, /命令行参数/);
    assert.match(prompt, /禁止.*日志/);
    assert.match(prompt, /登录授权不扩大提交、推送或外部业务写入范围/);
    assert.match(prompt, /完成实现与验证，但不要提交、推送或创建合并请求/);
  }
});
