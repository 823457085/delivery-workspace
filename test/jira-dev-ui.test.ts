import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { computed, effectScope, nextTick, reactive, ref, shallowRef, watch } from 'vue';
import { jiraDevNeedsApply, jiraDevStartBlocker } from '../shared/jira-dev.js';
import { agentProviderLabels, codexWorkbenchDefaults } from '../shared/agent-runtime.js';
import { chinaWorkingDates, splitWorkingDates } from '../shared/china-work-calendar.mjs';
import { childScopeTitles, requirementScopes, requirementSummary, requirementTitle } from '../shared/jira-dev-requirement-titles.mjs';
import { useAgentModelSelection } from '../src/features/agent-workbench/model-selection.js';

// 与现有 antigravity-ui 测试一致：执行真实 composable，网络与本机草稿使用内存替身。
function scriptCode(relative: string) {
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
  const tree = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return ts.transpileModule(tree.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(tree)).join('\n').replace(/^export /gm, ''),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
}
function taskFixture(saved?: unknown, workflow = 'requirement', context?: unknown) {
  const storage = new Map<string, string>();
  if (saved) storage.set(`qiyuan:jira-dev:${workflow}:v1`, JSON.stringify(saved));
  const requests: { action: string; body: any }[] = [];
  const responses = new Map<string, unknown>();
  const opened: string[] = [];
  const preview = { taskId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', workflow, title: 'UI fixture', prompt: '', projectPath: '/fixture/web',
    baseBranch: 'master', branchName: 'feature/ui', plan: { status: 'local', sourceKind: 'product', items: [] } };
  const dependencies = { computed, reactive, ref, shallowRef, watch, jiraDevNeedsApply, jiraDevStartBlocker, chinaWorkingDates, splitWorkingDates,
    childScopeTitles, requirementScopes, requirementSummary, requirementTitle, context, openRun: (id: string) => opened.push(id),
    ElMessage: { warning: () => {}, error: () => {} },
    localStorage: { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value) },
    fetch: async (url: string, input: { body?: string }) => {
      const action = url.split('/').at(-1)!;
      requests.push({ action, body: input.body ? JSON.parse(input.body) : undefined });
      const result = await Promise.resolve().then(() => responses.get(action) ?? preview);
      return { ok: true, json: async () => structuredClone(result) };
    } };
  const scope = effectScope();
  const state = scope.run(() => new Function(...Object.keys(dependencies), `${scriptCode('../src/features/jira-dev/useJiraDevTask.ts')}\nreturn useJiraDevTask('${workflow}', openRun, context);`)(...Object.values(dependencies)));
  return { state, requests, responses, storage, preview, opened, close: () => scope.stop() };
}

test('旧草稿含非法日期时返回校验提示而不抛异常，正常闰日仍可用', async () => {
  for (const date of ['2026-13-01', '2026-01-32', '2026-02-29', '0000-01-01']) {
    const context = taskFixture({ form: { projectPath: '/fixture/web', baseBranch: 'master', branchName: 'feature/date', details: '需求正文',
      schedules: { design: { startDate: date, endDate: '' } } } });
    try {
      assert.match(context.state.problem.value, /有效计划日期/);
      await context.state.prepare();
      assert.equal(context.requests.length, 0);
    } finally { context.close(); }
  }
  const dependencies = { computed, reactive, ref, shallowRef, watch };
  const valid = new Function(...Object.keys(dependencies), `${scriptCode('../src/features/jira-dev/useJiraDevTask.ts')}\nreturn validScheduleDate;`)(...Object.values(dependencies));
  assert.equal(valid('2028-02-29'), true);
  assert.equal(valid('2026-02-28'), true);
});

test('清空再选择项目会从已有 Jira 补默认工作分支，保留已选项目的手动值且预览提交实际值', async () => {
  const context = taskFixture();
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    const { state } = context;
    state.edit('source', 'APEX-562');
    state.selectProjects(['/fixture/old']);
    state.selectProjects([]);
    state.selectProjects(['/fixture/web', '/fixture/api']);
    assert.deepEqual(state.selectedProjects.value.map((item: any) => item.branchName), ['feature/APEX-562', 'feature/APEX-562']);
    state.editProject('/fixture/web', 'baseBranch', 'master');
    state.editProject('/fixture/api', 'baseBranch', 'develop');
    await state.prepare();
    const request = context.requests.find(item => item.action === 'prepare')!;
    assert.equal(request.body.branchName, 'feature/APEX-562');
    assert.deepEqual(request.body.projects.map((item: any) => item.branchName), ['feature/APEX-562', 'feature/APEX-562']);
    state.editProject('/fixture/web', 'branchName', 'feature/manual');
    state.editProject('/fixture/api', 'branchName', '');
    state.selectProjects(['/fixture/api', '/fixture/web', '/fixture/extra']);
    assert.deepEqual(state.selectedProjects.value.map((item: any) => item.branchName), ['', 'feature/manual', 'feature/manual']);
    assert.match(state.problem.value, /工作分支/);
    await nextTick();
    assert.equal(JSON.parse(context.storage.get('qiyuan:jira-dev:requirement:v1')!).form.branchName, '');
  } finally { context.close(); }
});

test('迟到的草稿恢复成功不能复活旧任务或锁住已编辑的新表单', async () => {
  const context = taskFixture({ taskId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    form: { projectPath: '/fixture/web', baseBranch: 'master', branchName: 'feature/old', details: '旧需求' } });
  let release!: (value: unknown) => void;
  context.responses.set('task', new Promise(resolve => { release = resolve; }));
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    context.state.edit('branchName', 'feature/new');
    context.state.edit('details', '新需求');
    release({ ...context.preview, plan: { status: 'applied', sourceKind: 'product', items: [] } });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(context.state.form.branchName, 'feature/new');
    assert.equal(context.state.taskId.value, '');
    assert.equal(context.state.task.value, undefined);
    assert.equal(context.state.locked.value, false);
  } finally { context.close(); }
});

test('迟到的草稿恢复失败不能清除新生成的任务预览', async () => {
  const context = taskFixture({ taskId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    form: { projectPath: '/fixture/web', baseBranch: 'master', branchName: 'feature/old', details: '旧需求' } });
  let reject!: (error: Error) => void;
  context.responses.set('task', new Promise((_resolve, fail) => { reject = fail; }));
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    context.state.edit('details', '新需求');
    const newId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    context.responses.set('prepare', { ...context.preview, taskId: newId });
    await context.state.prepare();
    reject(new Error('旧任务查询失败'));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(context.state.taskId.value, newId);
    assert.equal(context.state.task.value.taskId, newId);
    assert.equal(context.state.previewOpen.value, true);
  } finally { context.close(); }
});

test('切换 Jira 项目后旧版本查询失败不覆盖当前项目的版本和提示', async () => {
  const context = taskFixture(undefined, 'jira');
  let reject!: (error: Error) => void;
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    context.state.edit('source', 'APEX-562');
    context.state.edit('repairProject', 'OLD');
    context.responses.set('versions', new Promise((_resolve, fail) => { reject = fail; }));
    const old = context.state.loadVersions();
    await new Promise<void>(resolve => setImmediate(resolve));
    context.state.edit('repairProject', 'NEW');
    context.responses.set('versions', { projectKey: 'NEW', versions: [{ name: 'v2' }], truncated: false });
    await context.state.loadVersions();
    const status = context.state.versionStatus.value;
    reject(new Error('OLD timeout'));
    await old;
    assert.deepEqual(context.state.versions.value, ['v2']);
    assert.equal(context.state.versionStatus.value, status);
    assert.match(status, /NEW/);
  } finally { context.close(); }
});

test('海外需求带入来源、正文和多语言设置，需求间的开发草稿与原全局草稿隔离', async () => {
  const saved = { form: { source: 'APEX-100', details: '原全局草稿', projectPath: '/keep/web' } };
  const context = taskFixture(saved, 'requirement', { id: 'demand-1', source: 'APEX-999', details: '按原型实现并验收', useI18n: false });
  context.responses.set('issue', { issue: { key: 'APEX-999', summary: '跨系统需求' } });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(context.state.form.source, 'APEX-999'); assert.equal(context.state.form.details, '按原型实现并验收');
    assert.equal(context.state.form.useI18n, false); assert.equal(context.state.form.projectPath, '');
    assert.deepEqual(JSON.parse(context.storage.get('qiyuan:jira-dev:requirement:v1')!), saved);
    assert.ok(context.storage.has('qiyuan:jira-dev:requirement:v1:demand-1'));
    assert.deepEqual(context.requests.map(item => item.action), ['issue'], '仅只读加载来源，不自动创建或启动任务');
  } finally { context.close(); }
});

test('从海外需求继续已准备任务时恢复多项目配置，复用原 taskId', async () => {
  const context = taskFixture(undefined, 'requirement', { id: 'demand-2', source: '', details: '需求正文', useI18n: true,
    taskId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  context.responses.set('task', { ...context.preview, plan: { status: 'applied', sourceKind: 'product', items: [] },
    projects: [{ path: '/fixture/web', baseBranch: 'master', branchName: 'feature/ui' }, { path: '/fixture/app', baseBranch: 'pre', branchName: 'feature/app-ui' }] });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(context.state.taskId.value, context.preview.taskId); assert.equal(context.state.locked.value, true);
    assert.deepEqual(context.state.selectedProjects.value, [
      { path: '/fixture/web', baseBranch: 'master', branchName: 'feature/ui' }, { path: '/fixture/app', baseBranch: 'pre', branchName: 'feature/app-ui' },
    ]);
    assert.deepEqual(context.requests.map(item => item.action), ['task']);
  } finally { context.close(); }
});

test('恢复已有 Jira 的草稿时补齐空工作分支，实际预览提交默认值；手动清空后重新读取也可恢复', async () => {
  const context = taskFixture({ form: { source: 'https://jira.example.com/browse/APEX-562', projectPath: '/fixture/web', baseBranch: 'master', branchName: '' } });
  context.responses.set('issue', { issue: { key: 'APEX-562', summary: '账户管理' } });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    const { state } = context;
    assert.equal(state.form.branchName, 'feature/APEX-562');
    assert.equal(state.problem.value, '');
    assert.deepEqual(context.requests.map(item => item.action), ['issue'], '恢复时只读 Jira，不自动生成预览或启动');
    await state.prepare();
    const request = context.requests.find(item => item.action === 'prepare')!;
    assert.equal(request.body.branchName, 'feature/APEX-562');
    assert.equal(request.body.projects[0].branchName, 'feature/APEX-562');
    state.editProject('/fixture/web', 'branchName', '');
    assert.equal(state.problem.value, '请填写工作分支。');
    await state.readIssue();
    assert.equal(state.form.branchName, 'feature/APEX-562');
    await nextTick();
    assert.equal(JSON.parse(context.storage.get('qiyuan:jira-dev:requirement:v1')!).form.branchName, 'feature/APEX-562');
  } finally { context.close(); }
});

test('多项目草稿只补空白和未完成的默认分支，保留手动分支；更换 Jira 只跟随更新继承值', async () => {
  const context = taskFixture({ form: { source: 'APEX-562', projectPath: '/fixture/web', baseBranch: 'master', branchName: 'feature/custom-web',
    additionalProjects: [{ path: '/fixture/api', baseBranch: 'develop', branchName: ' ' },
      { path: '/fixture/shared', baseBranch: 'pre', branchName: 'feature/' }, { path: '/fixture/manual', baseBranch: 'main', branchName: 'feature/manual' }] } });
  context.responses.set('issue', { issue: { key: 'APEX-562', summary: '账户管理' } });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    const { state } = context;
    assert.deepEqual(state.selectedProjects.value.map((item: any) => item.branchName), [
      'feature/custom-web', 'feature/APEX-562', 'feature/APEX-562', 'feature/manual',
    ]);
    state.edit('source', 'APEX-563');
    assert.deepEqual(state.selectedProjects.value.map((item: any) => item.branchName), [
      'feature/custom-web', 'feature/APEX-563', 'feature/APEX-563', 'feature/manual',
    ]);
    assert.deepEqual(state.selectedProjects.value.map((item: any) => item.baseBranch), ['master', 'develop', 'pre', 'main']);
  } finally { context.close(); }
});

test('无有效 Jira 时不猜测工作分支，已确认的任务恢复后不改写分支', async () => {
  const local = taskFixture({ form: { projectPath: '/fixture/web', baseBranch: 'master', details: '仅有需求正文' } });
  const locked = taskFixture({ taskId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', form: { source: 'APEX-562', projectPath: '/fixture/web', baseBranch: 'master', branchName: '' } });
  locked.responses.set('task', { ...locked.preview, plan: { status: 'applied', sourceKind: 'product', items: [] } });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(local.state.form.branchName, '');
    assert.equal(local.state.problem.value, '请填写工作分支。');
    assert.equal(locked.state.locked.value, true);
    assert.equal(locked.state.form.branchName, '');
    assert.deepEqual(locked.requests.map(item => item.action), ['task']);
    await local.state.prepare();
    assert.equal(local.requests.length, 0);
  } finally { local.close(); locked.close(); }
});

test('项目候选按仓库归组，不展开重复工作区，保留已选目录且不合并同名不同仓库', () => {
  const projects = [
    { name: 'web', path: '/repo/web', checkouts: [{ path: '/repo/web' }, { path: '/repo/web-tasks/issue' }] },
    { name: 'web', path: '/other/web', checkouts: [{ path: '/other/web' }] },
    { name: 'bff', path: '/repo/bff' },
  ];
  const selected = ref<string[]>([]);
  const dependencies = { computed, reactive, shallowRef, watch, localStorage: { getItem: () => null },
    useQuery: () => ({ data: ref({ projects }), isFetching: ref(false), error: ref(null) }),
    jiraDevRequest: async () => { throw new Error('本检查不应请求接口'); }, selectedPaths: () => selected.value };
  const scope = effectScope();
  try {
    const state = scope.run(() => new Function(...Object.keys(dependencies),
      `${scriptCode('../src/features/jira-dev/useJiraDevProject.ts')}\nreturn useJiraDevProject(shallowRef(''), () => {}, selectedPaths);`)(...Object.values(dependencies)));
    assert.deepEqual(state.candidates.value, [
      { name: 'web', path: '/repo/web' }, { name: 'web', path: '/other/web' }, { name: 'bff', path: '/repo/bff' },
    ]);
    assert.equal(state.scanSummary.value, '发现 3 个项目');
    selected.value = ['/repo/web-tasks/issue', '/repo/bff', '/unscanned/project'];
    assert.deepEqual(state.candidates.value, [
      { name: 'web', path: '/repo/web-tasks/issue' }, { name: 'web', path: '/other/web' }, { name: 'bff', path: '/repo/bff' },
    ]);
    assert.deepEqual(selected.value, ['/repo/web-tasks/issue', '/repo/bff', '/unscanned/project']);
    selected.value = [];
    assert.equal(state.candidates.value[0].path, '/repo/web');
  } finally { scope.stop(); }
});

test('主任务日期选全即自动填写子任务；调整或清空主任务时同步刷新，无网络调用', async () => {
  const context = taskFixture();
  try {
    const { state } = context;
    state.editSchedule('parent', 'startDate', '2026-11-06');
    assert.equal(state.form.schedules.design.startDate, '');
    state.editSchedule('parent', 'endDate', '2026-11-12');
    assert.deepEqual({ ...state.form.schedules.design }, { startDate: '2026-11-06', endDate: '2026-11-06' });
    assert.deepEqual({ ...state.form.schedules.implementation }, { startDate: '2026-11-09', endDate: '2026-11-12' });
    state.editSchedule('parent', 'endDate', '2026-11-13');
    assert.equal(state.form.schedules.implementation.endDate, '2026-11-13');
    state.editSchedule('parent', 'startDate', '');
    assert.deepEqual({ ...state.form.schedules.design }, { startDate: '', endDate: '' });
    assert.deepEqual({ ...state.form.schedules.implementation }, { startDate: '', endDate: '' });
    assert.equal(context.requests.length, 0);
  } finally { context.close(); }
});

test('自动填日期跳过五一假期，官方周末补班可用；缺少年份日历时不发送预览请求', async () => {
  const context = taskFixture({ form: { projectPath: '/fixture/web', baseBranch: 'master', branchName: 'feature/ui', details: '开发账户管理' } });
  try {
    const { state } = context;
    state.editSchedule('parent', 'startDate', '2026-05-01');
    state.editSchedule('parent', 'endDate', '2026-05-11');
    assert.deepEqual({ ...state.form.schedules.design }, { startDate: '2026-05-06', endDate: '2026-05-06' });
    assert.deepEqual({ ...state.form.schedules.implementation }, { startDate: '2026-05-07', endDate: '2026-05-11' });
    state.editSchedule('parent', 'startDate', '2026-09-20');
    state.editSchedule('parent', 'endDate', '2026-09-20');
    assert.equal(state.form.schedules.design.startDate, '2026-09-20', '官方补班的周日按工作日处理');
    state.editSchedule('parent', 'endDate', '2027-01-08');
    state.editSchedule('parent', 'startDate', '2027-01-01');
    assert.equal(state.form.schedules.design.startDate, '');
    await state.prepare();
    assert.match(state.status.value, /2027.*日历/);
    assert.equal(context.requests.length, 0);
  } finally { context.close(); }
});

test('拆分排期先展示业务标题，生成预览后原样展示 Jira 核对返回的标题', async () => {
  const context = taskFixture({ form: { source: 'DEMO-101', projectPath: '/fixture/web', baseBranch: 'master', branchName: 'feature/ui' } });
  const issue = { key: 'DEMO-101', summary: '【账户管理】完善员工账户', startDate: '2026-11-06', endDate: '2026-11-13',
    description: '## 前端范围\n- 账户列表查询\n- 编辑账户表单' };
  context.responses.set('issue', { issue });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    const { state } = context;
    assert.deepEqual(state.childSchedules.value.map((row: { summary: string }) => row.summary), [
      '【账户管理】编写 完善员工账户 技术方案', '【账户管理】实现 账户列表查询', '【账户管理】实现 编辑账户表单',
    ]);
    assert.deepEqual(context.requests.map(item => item.action), ['issue']);
    context.responses.set('prepare', { ...context.preview, plan: { status: 'ready', sourceKind: 'product', items: [
      { role: 'parent', summary: '父任务' },
      { role: 'implementation', key: 'DEMO-102', action: 'reuse', summary: 'L1234 账户维护原始标题', workdays: 2,
        schedule: { startDate: '2026-11-09', endDate: '2026-11-10', changed: false } },
    ] } });
    await state.prepare();
    assert.deepEqual(state.childSchedules.value.map(({ key, summary }: { key: string; summary: string }) => [key, summary]), [
      ['DEMO-102', 'L1234 账户维护原始标题'],
    ]);
  } finally { context.close(); }
});

test('手工子任务排期保留，清空后恢复自动；预览提交主任务日期，由后台拆分', async () => {
  const context = taskFixture({ form: { projectPath: '/fixture/web', baseBranch: 'master', branchName: 'feature/ui', details: '实现账户管理' } });
  try {
    const { state } = context;
    state.editSchedule('parent', 'startDate', '2026-11-02');
    state.editSchedule('parent', 'endDate', '2026-11-13');
    state.editSchedule('design', 'endDate', '2026-11-04');
    assert.equal(state.form.schedules.implementation.startDate, '2026-11-05');
    state.editSchedule('parent', 'endDate', '2026-11-12');
    assert.equal(state.form.schedules.design.endDate, '2026-11-04');
    state.editSchedule('design', 'endDate', '');
    assert.equal(state.form.schedules.design.endDate, '2026-11-02');
    assert.equal(state.form.schedules.implementation.startDate, '2026-11-03');
    await state.prepare();
    const request = context.requests.find(item => item.action === 'prepare')!;
    assert.deepEqual(request.body.schedules.parent, { startDate: '2026-11-02', endDate: '2026-11-12' });
    assert.deepEqual(request.body.schedules.design, { startDate: '', endDate: '' });
  } finally { context.close(); }
});

test('草稿恢复和读取 Jira 后也自动填子任务；已有前端任务复用不改原排期', async () => {
  const restored = taskFixture({ form: { schedules: { parent: { startDate: '2026-11-02', endDate: '2026-11-06' } } } });
  const jira = taskFixture();
  const frontend = taskFixture(undefined, 'requirement');
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(restored.state.form.schedules.implementation.startDate, '2026-11-03');
    Object.assign(jira.preview, { issue: { key: 'APEX-562', startDate: '2026-11-02', endDate: '2026-11-06' } });
    jira.state.edit('source', 'APEX-562');
    await jira.state.readIssue();
    assert.equal(jira.state.form.schedules.design.startDate, '2026-11-02');
    assert.equal(jira.state.form.schedules.implementation.endDate, '2026-11-06');
    frontend.state.edit('sourceKind', 'frontend');
    frontend.state.editSchedule('implementation', 'startDate', '2026-11-02');
    frontend.state.editSchedule('implementation', 'endDate', '2026-11-13');
    assert.equal(frontend.state.form.schedules.design.startDate, '');
  } finally { restored.close(); jira.close(); frontend.close(); }
});

test('需求项目选择保留各仓库分支，删除主项目后提升新主项目，下一项保留全部基准并清空工作分支', async () => {
  const context = taskFixture({ form: { projectPath: '/fixture/web', baseBranch: 'master', branchName: 'feature/web' } });
  try {
    const { state } = context;
    assert.deepEqual(state.selectedProjects.value.map((item: any) => item.path), ['/fixture/web']);
    state.selectProjects(['/fixture/web', '/fixture/bff']);
    state.editProject('/fixture/bff', 'baseBranch', 'develop');
    state.editProject('/fixture/bff', 'branchName', 'feature/bff');
    state.selectProjects(['/fixture/bff', '/fixture/web']);
    assert.deepEqual(state.selectedProjects.value.map((item: any) => ({ ...item })), [
      { path: '/fixture/bff', baseBranch: 'develop', branchName: 'feature/bff' },
      { path: '/fixture/web', baseBranch: 'master', branchName: 'feature/web' },
    ]);
    state.selectProjects(['/fixture/bff']);
    assert.equal(state.form.projectPath, '/fixture/bff');
    assert.equal(state.form.baseBranch, 'develop');
    state.selectProjects(['/fixture/bff', '/fixture/other']);
    state.editProject('/fixture/other', 'baseBranch', 'release');
    state.editProject('/fixture/other', 'branchName', 'feature/other');
    state.next();
    assert.deepEqual(state.selectedProjects.value.map((item: any) => ({ ...item })), [
      { path: '/fixture/bff', baseBranch: 'develop', branchName: '' },
      { path: '/fixture/other', baseBranch: 'release', branchName: '' },
    ]);
    await nextTick();
    const draft = JSON.parse(context.storage.get('qiyuan:jira-dev:requirement:v1')!);
    assert.equal(draft.form.additionalProjects[0].baseBranch, 'release');
  } finally { context.close(); }
});

test('需求预览校验每个项目，并提交完整项目配置；已确认后项目修改被锁定', async () => {
  const context = taskFixture();
  try {
    const { state } = context;
    state.selectProjects(['/fixture/web', '/fixture/bff']);
    state.editProject('/fixture/web', 'baseBranch', 'master');
    state.editProject('/fixture/web', 'branchName', 'feature/web');
    state.editProject('/fixture/bff', 'branchName', 'feature/bff');
    state.edit('details', '跨项目联动筛选');
    await state.prepare();
    assert.equal(context.requests.length, 0, '第二项目缺少基准时不能发送预览');
    state.editProject('/fixture/bff', 'baseBranch', 'develop');
    await state.prepare();
    assert.equal(context.requests.length, 1);
    assert.equal(context.requests[0].action, 'prepare');
    assert.deepEqual(context.requests[0].body.projects, [
      { path: '/fixture/web', baseBranch: 'master', branchName: 'feature/web' },
      { path: '/fixture/bff', baseBranch: 'develop', branchName: 'feature/bff' },
    ]);
    assert.equal(context.requests[0].body.projectPath, '/fixture/web');
    state.task.value = { ...context.preview, launch: { status: 'started', runId: 'run-1' } };
    state.selectProjects(['/fixture/other']);
    state.editProject('/fixture/bff', 'baseBranch', 'other');
    assert.equal(state.form.projectPath, '/fixture/web');
    assert.equal(state.selectedProjects.value[1].baseBranch, 'develop');
  } finally { context.close(); }
});

test('Jira 修复预览继续使用单项目兼容参数', async () => {
  const context = taskFixture(undefined, 'jira');
  try {
    const { state } = context;
    state.edit('projectPath', '/fixture/web');
    state.edit('baseBranch', 'master');
    state.edit('branchName', 'feature/TEST-123');
    state.edit('source', 'TEST-123');
    state.edit('repairMode', 'direct');
    await state.prepare();
    const prepare = context.requests.filter(item => item.action === 'prepare');
    assert.equal(prepare.length, 1);
    assert.equal('projects' in prepare[0].body, false);
  } finally { context.close(); }
});

test('自动协作不被单模型不可用阻挡，切换回单 Agent 后恢复真实模型选择与校验', async () => {
  const projectCount = ref(1);
  const query = { data: shallowRef([{ provider: 'codex', label: 'Codex', ready: true, accessModes: ['workspace', 'full'], models: [{ id: 'test', label: 'Test' }], defaultModel: 'test' }, { provider: 'claude', label: 'Claude Code', ready: false, message: 'fixture unavailable',
    accessModes: ['workspace', 'full'], models: [{ id: 'fixture-opus', label: 'L_FIXTURE_MODEL' }], defaultModel: 'fixture-opus' }]),
    isPending: shallowRef(false), error: shallowRef(undefined) };
  const saved = { provider: 'claude', model: 'fixture-opus', reasoningEffort: '', accessMode: 'full', collaborationMode: 'manual' };
  let lastSaved = '';
  const teamQuery = { data: shallowRef({ config: { revision: 7, name: '定制团队', members: [{ id: 'ui', name: '页面实现', enabled: true, capability: 'write', binding: { provider: 'codex', model: 'test' } }] } }), error: shallowRef(undefined) };
  const dependencies = { computed, reactive, watch, useAgentModelSelection, useQuery: (options: { queryKey: string[] }) => options.queryKey[0] === 'agent-group-chat' ? teamQuery : query, agentProviderLabels, projectCount,
    agentModelDefaults: shallowRef({ ...codexWorkbenchDefaults, revision: '' }),
    localStorage: { getItem: () => JSON.stringify(saved), setItem: (_key: string, value: string) => { lastSaved = value; } } };
  const scope = effectScope();
  try {
    const state = scope.run(() => new Function(...Object.keys(dependencies), `${scriptCode('../src/features/jira-dev/useJiraDevRuntime.ts')}\nreturn useJiraDevRuntime('requirement', () => projectCount.value);`)(...Object.values(dependencies)));
    assert.equal(state.problem.value, 'fixture unavailable');
    state.automatic.value = true;
    assert.equal(state.selection.collaborationMode, 'group');
    assert.equal(state.problem.value, '');
    assert.match(state.summary.value, /团队群聊.*定制团队.*页面实现/);
    await nextTick();
    assert.equal(JSON.parse(lastSaved).collaborationMode, 'group');
    state.automatic.value = false;
    assert.equal(state.selection.model, 'fixture-opus');
    assert.equal(state.models.value[0].label, 'L_FIXTURE_MODEL');
    assert.equal(state.problem.value, 'fixture unavailable');
    state.automatic.value = true;
    query.data.value = query.data.value.map(item => ({ ...item, accessModes: item.provider === 'claude' ? ['workspace'] : item.accessModes }));
    await nextTick();
    state.selection.accessMode = 'full';
    state.automatic.value = false;
    await nextTick();
    assert.equal(state.selection.accessMode, 'workspace', '切回单 Agent 时不能保留执行器不支持的权限');
    state.automatic.value = true;
    projectCount.value = 2;
    assert.match(state.problem.value, /多项目任务需要完全访问权限/);
    assert.equal(state.selection.accessMode, 'workspace', '多项目校验不能静默升权');
    state.selection.accessMode = 'full';
    assert.equal(state.problem.value, '');
  } finally { scope.stop(); }
});

test('团队已创建但无负责人运行时，按真实 conversationId 打开会话供核对', async () => {
  const context = taskFixture();
  try {
    context.state.task.value = { ...context.preview };
    Object.assign(context.preview, { launch: { status: 'uncertain', runId: '', conversationId: 'team-conversation', teamTaskId: 'team-task', error: '负责人待核对' } });
    await context.state.start({ provider: 'codex', model: '', accessMode: 'full', reasoningEffort: '', collaborationMode: 'automatic' });
    assert.deepEqual(context.opened, ['team-conversation']);
    assert.equal(context.state.task.value.launch.runId, '');
    assert.equal(context.state.launched.value, true);
  } finally { context.close(); }
});

test('群聊已持久化且尚未产生首个运行时也打开关联群聊，不等待或误开普通会话', async () => {
  const context = taskFixture();
  try {
    Object.assign(context.preview, { launch: { status: 'started', groupRoomId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', runId: '' } });
    context.state.task.value = { ...context.preview, launch: undefined,
      preparation: { review: { status: 'ready' }, design: { status: 'ready' } } };
    await context.state.start({ provider: 'codex', model: '', reasoningEffort: '', accessMode: 'full', collaborationMode: 'group', groupConfigRevision: 3 });
    assert.deepEqual(context.opened, ['group:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']);
    assert.equal(context.state.previewOpen.value, false);
  } finally { context.close(); }
});
