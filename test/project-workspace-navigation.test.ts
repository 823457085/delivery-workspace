/** 执行项目页真实定位函数和 watcher；不访问 Git、不打开本机应用。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { effectScope, nextTick, reactive, shallowRef, watch, type ShallowRef } from 'vue';
import type { LocalProject } from '../shared/hub.js';

const project = (path: string, projectId = 'same-repository') => ({ path, projectId } as LocalProject);
function fixture(workspace: string, projects: LocalProject[] | undefined, git?: string) {
  const source = readFileSync(new URL('../src/features/project-inventory/ProjectInventory.vue', import.meta.url), 'utf8')
    .match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
  const tree = ts.createSourceFile('ProjectInventory.ts', source, ts.ScriptTarget.Latest, true);
  const names = ['selectedProjectId', 'gitProject', 'gitDrawer', 'workspacePaths', 'activeWorkspacePath',
    'locatedWorkspace', 'refreshedWorkspace', 'missingWorkspace'];
  const functions = ['selectActiveWorkspace', 'openGitManager', 'locateRequestedWorkspace'];
  const pieces = tree.statements.flatMap(statement => {
    if (ts.isVariableStatement(statement)) return [...statement.declarationList.declarations]
      .filter(item => names.includes(item.name.getText(tree)))
      .map(item => `${statement.declarationList.flags & ts.NodeFlags.Let ? 'let' : 'const'} ${item.getText(tree)};`);
    if (ts.isFunctionDeclaration(statement) && functions.includes(statement.name?.text || '')) return [statement.getText(tree)];
    if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
      && statement.expression.expression.getText(tree) === 'watch'
      && statement.expression.arguments[1]?.getText(tree) === 'locateRequestedWorkspace') return [statement.getText(tree)];
    return [];
  });
  assert.equal(pieces.length, names.length + functions.length + 1, '必须执行真实定位状态、函数和 watcher');
  const code = ts.transpileModule(pieces.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const route = reactive<{ query: { workspace?: string; git?: string } }>({ query: { workspace, git } });
  const data = shallowRef(projects ? { projects } : undefined), isFetching = shallowRef(false);
  const search = shallowRef('旧筛选'), root = shallowRef('旧扫描目录'), status = shallowRef('dirty');
  const warnings: string[] = [], refreshes: (() => void)[] = [];
  const query = { refetch: () => {
    isFetching.value = true;
    return new Promise<void>(resolve => refreshes.push(resolve));
  } };
  const dependencies = { route, data, isFetching, search, root, status, query, shallowRef, watch,
    ElMessage: { warning: (message: string) => warnings.push(message) } };
  const scope = effectScope();
  const state = scope.run(() => new Function(...Object.keys(dependencies), `${code}\nreturn { selectedProjectId, activeWorkspacePath, gitProject, gitDrawer, workspacePaths, selectActiveWorkspace, locateRequestedWorkspace };`)(...Object.values(dependencies))) as {
    selectedProjectId: ShallowRef<string>; activeWorkspacePath: ShallowRef<string>;
    gitProject: ShallowRef<LocalProject | undefined>; gitDrawer: ShallowRef<boolean>; workspacePaths: Map<string, string>;
    selectActiveWorkspace: (item: LocalProject) => void; locateRequestedWorkspace: () => void;
  };
  return { ...state, route, data, isFetching, search, root, status, warnings, refreshes,
    finishRefresh: async (projects: LocalProject[]) => {
      data.value = { projects }; isFetching.value = false; refreshes.forEach(resolve => resolve()); await nextTick();
    },
    close: () => { scope.stop(); refreshes.forEach(resolve => resolve()); } };
}

test('完整任务路径精确定位，不选源仓库或相同前缀的兄弟目录', () => {
  const base = project('/code/merchant-front'), sibling = project('/code/merchant-front-tasks/vms-748-copy');
  const target = project('/code/merchant-front-tasks/vms-748');
  const f = fixture(target.path, [base, sibling, target], '1');
  try {
    assert.equal(f.gitProject.value, target);
    assert.equal(f.activeWorkspacePath.value, target.path);
    assert.equal(f.selectedProjectId.value, target.projectId);
    assert.equal(f.gitDrawer.value, true);
    assert.equal(f.search.value, target.path);
    assert.equal(f.root.value, 'all'); assert.equal(f.status.value, 'all');
    assert.equal(f.workspacePaths.get(target.projectId), target.path);
    assert.equal(f.refreshes.length, 0);
  } finally { f.close(); }
});

test('初始数据未到时等待，读取完成后才定位目标', async () => {
  const target = project('/code/task');
  const f = fixture(target.path, undefined, '1');
  try {
    assert.equal(f.gitDrawer.value, false);
    assert.equal(f.refreshes.length, 0);
    f.data.value = { projects: [target] };
    await nextTick();
    assert.equal(f.gitProject.value, target);
    assert.equal(f.gitDrawer.value, true);
  } finally { f.close(); }
});

test('目标尚未进入列表时只刷新一次，出现后定位该目标', async () => {
  const base = project('/code/source'), target = project('/code/task');
  const f = fixture(target.path, [base], '1');
  try {
    assert.equal(f.refreshes.length, 1);
    assert.equal(f.gitDrawer.value, false);
    assert.equal(f.gitProject.value, undefined);
    assert.deepEqual(f.warnings, []);
    await f.finishRefresh([base, target]);
    assert.equal(f.gitProject.value, target);
    assert.equal(f.gitDrawer.value, true);
    assert.equal(f.refreshes.length, 1);
    assert.deepEqual(f.warnings, []);
  } finally { f.close(); }
});

test('目标刷新后仍缺失时不误选其他工作区，不重复刷新或重复提示', async () => {
  const base = project('/code/task-source');
  const f = fixture('/code/task', [base], '1');
  try {
    await f.finishRefresh([base]);
    assert.equal(f.gitProject.value, undefined);
    assert.equal(f.gitDrawer.value, false);
    assert.equal(f.activeWorkspacePath.value, '');
    assert.deepEqual(f.warnings, ['项目列表中未找到工作区：/code/task']);
    for (let index = 0; index < 3; index++) { f.data.value = { projects: [{ ...base }] }; await nextTick(); }
    assert.equal(f.refreshes.length, 1);
    assert.equal(f.warnings.length, 1);
  } finally { f.close(); }
});

test('同路径轮询不重新打开抽屉，也不抢走用户手动选择', async () => {
  const target = project('/code/task'), manual = project('/code/task-other');
  const f = fixture(target.path, [target, manual], '1');
  try {
    f.gitDrawer.value = false;
    f.selectActiveWorkspace(manual);
    f.search.value = '用户新筛选';
    f.data.value = { projects: [{ ...target }, { ...manual }] };
    await nextTick();
    assert.equal(f.gitDrawer.value, false);
    assert.equal(f.activeWorkspacePath.value, manual.path);
    assert.equal(f.search.value, '用户新筛选');
    assert.equal(f.refreshes.length, 0);
  } finally { f.close(); }
});

test('切换有效目标定位新目录，清空参数后再次请求同路径可重新打开', async () => {
  const first = project('/code/first', 'first-project'), next = project('/code/next', 'next-project');
  const f = fixture(first.path, [first, next], '1');
  try {
    f.route.query = { workspace: next.path, git: '1' };
    await nextTick();
    assert.equal(f.gitProject.value, next);
    assert.equal(f.selectedProjectId.value, next.projectId);
    f.route.query = {};
    await nextTick();
    f.gitDrawer.value = false;
    f.route.query = { workspace: next.path, git: '1' };
    await nextTick();
    assert.equal(f.gitProject.value, next);
    assert.equal(f.gitDrawer.value, true);
  } finally { f.close(); }
});

test('没有 git=1 参数时只定位，不打开 Git 抽屉', () => {
  const target = project('/code/task');
  const f = fixture(target.path, [target]);
  try {
    assert.equal(f.activeWorkspacePath.value, target.path);
    assert.equal(f.selectedProjectId.value, target.projectId);
    assert.equal(f.gitProject.value, undefined);
    assert.equal(f.gitDrawer.value, false);
  } finally { f.close(); }
});

test('已打开抽屉后改成缺失的新目标，不将旧工作区展示为新目标', async () => {
  const first = project('/code/first');
  const f = fixture(first.path, [first], '1');
  try {
    f.route.query = { workspace: '/code/missing', git: '1' };
    await nextTick();
    await f.finishRefresh([first]);
    assert.equal(f.gitDrawer.value, false);
    assert.equal(f.warnings.length, 1);
  } finally { f.close(); }
});
