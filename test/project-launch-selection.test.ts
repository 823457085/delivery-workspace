import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { compile, computed, createSSRApp, effectScope, h, nextTick, reactive, ref, watch } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { QueryClient, useQuery } from '@tanstack/vue-query';
import { projectEnvironments, type LaunchSnapshot, type ProjectCommand, type ProjectEnvironment } from '../shared/project-launch.js';

const source = readFileSync(new URL('../src/features/agent-workbench/AgentProjectLaunch.vue', import.meta.url), 'utf8');
const script = source.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
const tree = ts.createSourceFile('AgentProjectLaunch.ts', script, ts.ScriptTarget.Latest, true);
// 执行真实 SFC 状态、watch 和请求函数；只替换账号无关的查询、存储与通知边界。
const code = ts.transpileModule(tree.statements.filter(statement => !ts.isImportDeclaration(statement))
  .map(statement => statement.getText(tree)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const template = source.slice(source.indexOf('<template>') + '<template>'.length, source.lastIndexOf('</template>'));
const workspaceA = '/fixture/project-a', workspaceB = '/fixture/project-b';
const selectionKey = (workspace: string) => `delivery:launch-selection:${workspace}`;

function project(workspacePath: string): LaunchSnapshot {
  const commands: ProjectCommand[] = [
    { id: 'install', kind: 'install', name: '安装依赖', command: 'pnpm install', fingerprint: 'install-fingerprint' },
    // 特意放在环境命令之前，避免把单测/check 误作启动 test/dev 环境。
    { id: 'unit-test', kind: 'test', environment: 'test', name: '单元测试', command: 'pnpm test', fingerprint: 'unit-test-fingerprint' },
    { id: 'type-check', kind: 'check', environment: 'dev', name: '类型检查', command: 'pnpm check', fingerprint: 'type-check-fingerprint' },
    ...projectEnvironments.flatMap(environment => (['run', 'build'] as const).map(kind => ({
      id: `${kind}:${environment}`, kind, environment, name: `${kind} ${environment}`,
      command: `pnpm ${kind === 'run' ? 'dev' : 'build'}:${environment}`, fingerprint: `${workspacePath}:${kind}:${environment}`,
      ...(kind === 'run' ? { configId: `config:${environment}` } : {}),
    }))),
  ];
  return { workspacePath, revision: 0, packageManager: 'pnpm', scripts: [], commands, executions: [],
    configs: projectEnvironments.map(environment => ({ id: `config:${environment}`, name: environment,
      script: `dev:${environment}`, packageManager: 'pnpm', port: 5173, protocol: 'http' })),
    statuses: projectEnvironments.map(environment => ({ configId: `config:${environment}`, state: 'stopped', message: '未运行' })) };
}

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    await nextTick();
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.ok(check(), '项目状态未按预期更新');
}

async function fixture(options: { saved?: Record<string, string>; cached?: boolean; snapshots?: LaunchSnapshot[] } = {}) {
  const snapshots = new Map((options.snapshots || [project(workspaceA), project(workspaceB)]).map(value => [value.workspacePath, value]));
  const props = reactive({ workspacePaths: [...snapshots.keys()] });
  const storage = new Map(Object.entries(options.saved || {}));
  const requests: { path: string; body: Record<string, unknown> }[] = [], errors: string[] = [];
  const tabs: { closed: boolean; location: { href: string; replace: (address: string) => void }; close: () => void }[] = [];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
  if (options.cached) for (const [path, snapshot] of snapshots) client.setQueryData(['project-launch', path], structuredClone(snapshot));
  const cleanups: (() => void)[] = [];
  const bindings = { computed, nextTick, ref, watch, projectEnvironments,
    defineProps: () => props, useQueryClient: () => client,
    useQuery: (options: Parameters<typeof useQuery>[0]) => useQuery(options, client),
    onMounted: () => {}, onBeforeUnmount: (cleanup: () => void) => cleanups.push(cleanup),
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    window: { open: (url: string) => {
      const tab = { closed: false, opener: {}, document: { title: '', body: { textContent: '' } },
        location: { href: url, replace(address: string) { this.href = address; } }, close() { this.closed = true; } };
      tabs.push(tab);
      return tab;
    } },
    ElMessage: { error: (message: string) => errors.push(message), success() {}, info() {} },
    fetch: async (input: string, init: RequestInit) => {
      const url = new URL(input, 'http://fixture');
      const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (init.method === 'POST') requests.push({ path: url.pathname, body });
      const path = init.method === 'GET' ? url.searchParams.get('path')! : String(body.workspacePath);
      const value = snapshots.get(path);
      assert.ok(value, `未知测试项目 ${path}`);
      return { ok: true, json: async () => structuredClone(value) };
    } };
  const lifetime = effectScope();
  const state = lifetime.run(() => new Function(...Object.keys(bindings), `${code}\nreturn {
    workspace, actionKind, environment, legacySelection, busy, query, snapshot, categories, environmentCommand,
    command, selected, config, status, currentAddress, historyAddress, executions, selectedExecution, runningExecution, runningCount, serviceRunning,
    canExecute, feedback, recordLabel, recordsOpen, executionLabels, execute, stop, cancelExecution,
    completion, duration, time, setLogElement, rememberLogScroll };`)(...Object.values(bindings)))!;
  await until(() => state.snapshot.value?.workspacePath === props.workspacePaths[0]);
  return { state, storage, requests, errors, props, tabs,
    respond(snapshot: LaunchSnapshot) { snapshots.set(snapshot.workspacePath, structuredClone(snapshot)); },
    update(snapshot: LaunchSnapshot) { snapshots.set(snapshot.workspacePath, structuredClone(snapshot)); client.setQueryData(['project-launch', snapshot.workspacePath], structuredClone(snapshot)); },
    async select(kind: 'install' | 'run' | 'build', environment: ProjectEnvironment) {
      state.actionKind.value = kind; state.environment.value = environment; await nextTick();
    },
    async switchWorkspace(path: string) {
      state.workspace.value = path;
      await until(() => state.snapshot.value?.workspacePath === path);
    },
    async render() {
      const app = createSSRApp({ setup: () => ({ ...state, workspacePaths: props.workspacePaths, projectEnvironments }), render: compile(template) });
      for (const name of ['el-select', 'el-option', 'el-popover', 'el-button', 'el-drawer', 'el-empty']) {
        app.component(name, { inheritAttrs: false, setup: (_props, { attrs, slots }) => () => h(name === 'el-button' ? 'button' : 'div', attrs, slots.default?.()) });
      }
      for (const name of ['ExternalLink', 'History', 'Play', 'Square', 'Terminal']) app.component(name, { render: () => h('i') });
      return renderToString(app);
    },
    close() { cleanups.forEach(cleanup => cleanup()); lifetime.stop(); client.clear(); } };
}

test('启动与构建按操作及五种环境选中精确命令，发送真实ID和指纹且不混入单测/check', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.state.categories.map((item: { kind: string }) => item.kind), ['install', 'run', 'build']);
    for (const kind of ['run', 'build'] as const) for (const environment of projectEnvironments) {
      await f.select(kind, environment);
      const command = project(workspaceA).commands.find(item => item.id === `${kind}:${environment}`)!;
      assert.equal(f.state.selected.value, command.id);
      assert.equal(f.state.command.value.command, command.command);
      assert.equal(f.state.canExecute.value, true);
      await f.state.execute();
      assert.deepEqual(f.requests.at(-1), { path: '/api/projects/launch/execute', body: {
        workspacePath: workspaceA, commandId: command.id, fingerprint: command.fingerprint,
      } });
    }
    assert.equal(f.requests.length, 10); assert.deepEqual(f.errors, []);
  } finally { f.close(); }
});

test('安装不依赖环境，缺失启动/构建环境不回退其他命令且不可执行', async () => {
  const snapshot = project(workspaceA);
  snapshot.commands = snapshot.commands.filter(command => command.environment !== 'pre');
  const f = await fixture({ snapshots: [snapshot] });
  try {
    await f.select('install', 'pre');
    assert.equal(f.state.selected.value, 'install'); assert.equal(f.state.canExecute.value, true);
    const installHtml = await f.render();
    assert.doesNotMatch(installHtml, /aria-label="项目环境"/);
    await f.state.execute();
    assert.equal(f.requests[0].body.commandId, 'install');
    for (const kind of ['run', 'build'] as const) {
      await f.select(kind, 'pre');
      assert.equal(f.state.command.value, undefined); assert.equal(f.state.selected.value, '');
      assert.equal(f.state.environmentCommand('pre'), undefined); assert.equal(f.state.canExecute.value, false);
      await f.state.execute();
    }
    assert.equal(f.requests.length, 1);
  } finally { f.close(); }
});

test('旧command/configId选择迁移到操作与环境，异步发现和已有查询缓存都恢复', async t => {
  for (const cached of [false, true]) for (const [legacy, kind, environment] of [
    ['build:i18n-test', 'build', 'i18n-test'], ['config:pre', 'run', 'pre'], ['install', 'install', 'dev'],
  ] as const) await t.test(`${cached ? '缓存' : '异步'} ${legacy}`, async () => {
    const f = await fixture({ saved: { [selectionKey(workspaceA)]: legacy }, cached });
    try {
      assert.equal(f.state.actionKind.value, kind); assert.equal(f.state.environment.value, environment);
      assert.equal(f.state.selected.value, kind === 'install' ? 'install' : `${kind}:${environment}`);
      assert.deepEqual(JSON.parse(f.storage.get(selectionKey(workspaceA))!), { kind, environment });
      assert.equal(f.state.legacySelection.value, '');
    } finally { f.close(); }
  });
});

test('操作与环境按项目保存，切换项目及回到缓存项目均恢复各自选择', async () => {
  const f = await fixture({ saved: {
    [selectionKey(workspaceA)]: JSON.stringify({ kind: 'build', environment: 'prod' }),
    [selectionKey(workspaceB)]: JSON.stringify({ kind: 'run', environment: 'test' }),
  } });
  try {
    assert.equal(f.state.selected.value, 'build:prod');
    await f.select('install', 'i18n-test');
    await f.switchWorkspace(workspaceB);
    assert.equal(f.state.selected.value, 'run:test');
    await f.select('build', 'pre');
    await f.switchWorkspace(workspaceA);
    assert.equal(f.state.selected.value, 'install'); assert.equal(f.state.environment.value, 'i18n-test');
    await f.switchWorkspace(workspaceB);
    assert.equal(f.state.selected.value, 'build:pre');
    assert.deepEqual(JSON.parse(f.storage.get(selectionKey(workspaceA))!), { kind: 'install', environment: 'i18n-test' });
    assert.deepEqual(JSON.parse(f.storage.get(selectionKey(workspaceB))!), { kind: 'build', environment: 'pre' });
    assert.equal(f.requests.length, 0);
  } finally { f.close(); }
});

test('端口conflict仍可提交由后端判断，busy/运行中服务/任意进行中指令阻止重复执行', async () => {
  const f = await fixture();
  try {
    const snapshot = project(workspaceA);
    snapshot.statuses[0] = { configId: 'config:dev', state: 'conflict', message: '端口占用待核对' };
    f.update(snapshot); await nextTick();
    assert.equal(f.state.canExecute.value, true);
    const pending = f.state.execute();
    assert.equal(f.state.canExecute.value, false, '首个请求未回读期间立即阻止连点');
    await Promise.all([pending, f.state.execute()]); assert.equal(f.requests.length, 1);
    f.state.busy.value = 'execute'; assert.equal(f.state.canExecute.value, false);
    await f.state.execute(); f.state.busy.value = '';
    for (const state of ['running', 'starting'] as const) {
      snapshot.statuses[0] = { configId: 'config:dev', state, message: '运行中', managed: true };
      f.update(snapshot); await nextTick();
      assert.equal(f.state.canExecute.value, false); await f.state.execute();
    }
    await f.select('build', 'prod');
    snapshot.executions = [{ id: 'other-execution', commandId: 'install', kind: 'install', name: '安装', command: 'pnpm install',
      state: 'running', message: '执行中', startedAt: new Date().toISOString(), logs: '' }];
    f.update(snapshot); await nextTick();
    assert.equal(f.state.canExecute.value, false); await f.state.execute();
    assert.equal(f.requests.length, 1);
  } finally { f.close(); }
});

test('真实模板对外部复用服务只显示打开，受管理服务才显示停止且都不重复启动', async () => {
  const f = await fixture();
  try {
    const snapshot = project(workspaceA);
    snapshot.statuses[0] = { configId: 'config:dev', state: 'running', message: '复用已有服务', managed: false, url: 'http://localhost:5173' };
    f.update(snapshot); await nextTick();
    const external = await f.render();
    assert.match(external, /aria-label="打开运行页面"/);
    assert.match(external, /href="http:\/\/localhost:5173"/);
    assert.doesNotMatch(external, /aria-label="停止当前环境"|aria-label="执行所选项目指令"/);
    await f.state.execute(); assert.equal(f.requests.length, 0);
    snapshot.statuses[0].managed = true;
    f.update(snapshot); await nextTick();
    assert.match(await f.render(), /aria-label="停止当前环境"/);
    assert.equal(f.state.canExecute.value, false);
  } finally { f.close(); }
});

test('本次启动确认监听后，同一个标签页打开日志中与实际端口一致的 HTTPS 地址，侧栏和记录可点击', async () => {
  const f = await fixture();
  try {
    const next = project(workspaceA);
    const entry = { id: 'current-launch', commandId: 'run:dev', configId: 'config:dev', kind: 'run' as const,
      name: '开发', command: 'pnpm dev:dev --port 5175', startedAt: new Date().toISOString(),
      state: 'running' as const, message: '正在启动', logs: '' };
    next.executions = [entry];
    next.statuses[0] = { configId: 'config:dev', state: 'starting', port: 5175, message: '正在启动', managed: true };
    f.respond(next);
    const start = f.state.execute();
    assert.equal(f.tabs.length, 1, '必须在点击时保留同一浏览器的标签页');
    await start;
    assert.equal(f.tabs[0].location.href, 'about:blank');
    next.executions = [{ ...entry, state: 'succeeded', message: '启动完成，端口 5175 已由本配置进程监听（配置端口 5173 已占用）',
      logs: '15:54:37: ➜ Local: https://localhost:5175/\n➜ Local: http://localhost:5173/\n➜ Local: https://localhost:5175@other.example/\n' }];
    f.update(next); await nextTick();
    assert.equal(f.tabs[0].location.href, 'about:blank', '记录写入后仍要等配置监听回读');
    next.statuses[0] = { ...next.statuses[0], state: 'running', url: 'http://localhost:5175/' };
    f.update(next); await nextTick();
    assert.equal(f.tabs[0].location.href, 'https://localhost:5175/');
    const html = await f.render();
    assert.equal((html.match(/href="https:\/\/localhost:5175\/"/g) || []).length, 2);
    next.statuses[0] = { configId: 'config:dev', state: 'stopped', message: '未运行' };
    f.update(next); await nextTick();
    assert.equal((await f.render()).match(/href="https:\/\/localhost:5175\/"/g)?.length, 1, '历史仍显示该次启动的地址');
    assert.equal(f.tabs.length, 1);
  } finally { f.close(); }
});

test('启动失败关闭占位标签页，构建和被动读取历史不会打开标签页', async () => {
  const f = await fixture();
  try {
    const next = project(workspaceA);
    next.executions = [{ id: 'failed-launch', commandId: 'run:dev', configId: 'config:dev', kind: 'run',
      name: '开发', command: 'pnpm dev', startedAt: new Date().toISOString(), state: 'failed',
      message: '启动失败', logs: 'Local: https://localhost:5175/' }];
    f.respond(next);
    await f.state.execute();
    assert.equal(f.tabs[0].closed, true);
    assert.doesNotMatch(await f.render(), /href="https:\/\/localhost:5175\//);
    await f.select('build', 'dev');
    await f.state.execute();
    assert.equal(f.tabs.length, 1);
  } finally { f.close(); }
});
