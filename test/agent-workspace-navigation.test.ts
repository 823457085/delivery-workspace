import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyExecutionPaths, registeredWorkspaceSections, workspaceLocation, workspaceSections, workspaceView, workspaceViews } from '../src/pages/agent/workspace-navigation';

test('所有工作入口可以定位且旧链接保留具体任务参数', () => {
  for (const section of workspaceSections) for (const view of section.items) {
    assert.equal(workspaceView(view.id)?.id, view.id);
    assert.equal(workspaceLocation(view.path)?.query.view, view.id);
  }
  assert.deepEqual(workspaceLocation('/delivery/queue', { job: 'job-1', view: 'old' }), { path: '/agent', query: { job: 'job-1', view: 'queue' } });
  assert.deepEqual(workspaceLocation('/deployments', { project: 'project-1' }), { path: '/agent', query: { project: 'project-1', view: 'deployments' } });
  const project = { q: '项目名', workspace: '/code/task', git: '1' };
  assert.deepEqual(workspaceLocation('/projects', project), { path: '/agent', query: { ...project, view: 'projects' } });
  assert.deepEqual(workspaceLocation('/go-studio'), { path: '/agent', query: { view: 'go-studio' } });
  assert.deepEqual(workspaceLocation('/settings', { settingsTab: 'plugins' }), { path: '/agent', query: { view: 'settings', settingsTab: 'plugins' } });
});
test('Jira 接入恢复原菜单和子页，停用时旧链接仍可定位', () => {
  const taskSection = registeredWorkspaceSections(['jira']).find(section => section.id === 'tasks');
  assert.equal(taskSection?.shortLabel, 'Jira');
  assert.deepEqual(taskSection?.items.map(item => item.id), ['tasks', 'calendar', 'stats']);
  assert.ok(!registeredWorkspaceSections([]).some(section => section.id === 'tasks'));
  for (const item of taskSection!.items) {
    assert.deepEqual(workspaceLocation(item.path, { q: 'DEMO-1' }), { path: '/agent', query: { view: item.id, q: 'DEMO-1' } });
    assert.equal(workspaceView(item.id)?.pluginId, 'jira');
  }
});
test('执行中心只有一个导航入口，旧计划与巡检直达链接定位到相应分栏', () => {
  const execution = workspaceSections.find(section => section.id === 'execution')!;
  assert.equal(execution.items.filter(item => item.id === 'queue').length, 1);
  assert.equal(workspaceViews.some(item => ['plan', 'runs'].includes(item.id)), false);
  assert.equal(workspaceView('queue')?.label, '执行中心');
  for (const [path, tab] of Object.entries(legacyExecutionPaths)) {
    assert.equal(workspaceViews.some(item => item.path === path), false);
    assert.strictEqual(workspaceView(tab), workspaceView('queue'));
    assert.deepEqual(workspaceLocation(path, { [tab === 'plan' ? 'plan' : 'run']: 'detail-1', view: 'old', executionTab: 'queue', q: 'APEX' }), {
      path: '/agent', query: { [tab === 'plan' ? 'plan' : 'run']: 'detail-1', view: 'queue', executionTab: tab, q: 'APEX' },
    });
  }
  assert.deepEqual(workspaceLocation('/delivery/queue', { executionTab: 'plan', plan: 'APEX-602' }), {
    path: '/agent', query: { executionTab: 'plan', plan: 'APEX-602', view: 'queue' },
  });
});
test('不接管其他页面或无效的面板值', () => {
  assert.equal(workspaceLocation('/lab'), undefined);
  assert.equal(workspaceLocation('/api/source/scan'), undefined);
  assert.equal(workspaceView(['tasks']), undefined);
  assert.equal(workspaceView('missing'), undefined);
});

test('custom plugin menus use independent identities while preserving existing resource URLs', async () => {
  const { customPluginViews, registeredWorkspaceSections } = await import('../src/pages/agent/workspace-navigation');
  const { inspectCustomPlugin } = await import('../server/plugins/custom-runtime');
  const path = await import('node:path');
  const note = { ...await inspectCustomPlugin(path.resolve('plugins/example-notes')), enabled: true, showInMenu: true, grants: [] };
  const todo = { ...await inspectCustomPlugin(path.resolve('plugins/todos')), enabled: true, showInMenu: true, grants: [] };
  const plugins = [note, todo];
  const menus = registeredWorkspaceSections([], plugins).filter(section => section.id.startsWith('custom:'));
  assert.equal(menus.length, 2);
  for (const menu of menus) {
    const item = menu.items[0], url = new URL(item.path, 'http://localhost');
    assert.equal(workspaceView(url.searchParams.get('view'), plugins, url.searchParams.get('plugin'))?.id, item.id);
    assert.equal(url.searchParams.get('plugin'), item.customPluginId);
  }
  assert.equal(workspaceView('plugins', plugins)?.id, 'plugins');
  assert.equal(workspaceView('plugins', plugins, 'unknown')?.id, 'plugins');
  assert.equal(customPluginViews([{ ...note, showInMenu: false }, { ...todo, enabled: false }]).length, 0);
  assert.equal(customPluginViews([{ ...note, error: '不可用' }]).length, 0);
  assert.equal(workspaceView('plugins', [{ ...note, enabled: false }], note.manifest.id)?.id, 'plugins');
  assert.equal(registeredWorkspaceSections([], plugins).flatMap(section => section.items).filter(item => item.id === 'plugins').length, 1);
});

test('menu preferences order both built-in and plugin menus without losing new or hidden entries', async () => {
  const { applyNavigationPreferences } = await import('../src/pages/agent/workspace-navigation');
  const sections = [{ id: 'today', label: '今日', items: [] }, { id: 'custom:notes', label: '笔记', icon: 'plugins', items: [] }, { id: 'projects', label: '项目', items: [] }];
  const preferences = { order: ['custom:notes', 'unavailable', 'today'], icons: { 'custom:notes': 'notebook' as const } };
  const ordered = applyNavigationPreferences(sections, preferences);
  assert.deepEqual(ordered.map(s => s.id), ['custom:notes', 'today', 'projects']);
  assert.equal(ordered[0].icon, 'notebook');
  assert.equal(sections[1].icon, 'plugins');
  const restored = applyNavigationPreferences([...sections, { id: 'unavailable', label: '恢复', items: [] }], preferences);
  assert.deepEqual(restored.map(s => s.id), ['custom:notes', 'unavailable', 'today', 'projects']);
});

test('hiding a menu keeps the open plugin page identity and resource URL stable', async () => {
  const { inspectCustomPlugin } = await import('../server/plugins/custom-runtime');
  const { registeredWorkspaceSections } = await import('../src/pages/agent/workspace-navigation');
  const path = await import('node:path');
  const plugin = { ...await inspectCustomPlugin(path.resolve('plugins/todos')), enabled: true, showInMenu: true, grants: [] };
  const before = workspaceView('plugins', [plugin], plugin.manifest.id);
  const hidden = { ...plugin, showInMenu: false };
  assert.deepEqual(workspaceView('plugins', [hidden], plugin.manifest.id), before);
  assert.equal(registeredWorkspaceSections([], [hidden]).some(section => section.id === before?.id), false);
});

test('saving default order or only an icon leaves future menus in their default insertion position', async () => {
  const { navigationPreferencesForSave, applyNavigationPreferences } = await import('../src/pages/agent/workspace-navigation');
  const defaults = { order: [], icons: { today: 'star' as const } };
  const saved = navigationPreferencesForSave(defaults, ['today', 'automation'], false);
  assert.deepEqual(saved.order, []);
  const expanded = [{ id: 'today', label: '今日', items: [] }, { id: 'custom:new', label: '新插件', items: [] }, { id: 'automation', label: '设置', items: [] }];
  assert.deepEqual(applyNavigationPreferences(expanded, saved).map(s => s.id), ['today', 'custom:new', 'automation']);
  const previous = { order: ['hidden', 'today', 'automation'], icons: {} };
  assert.deepEqual(navigationPreferencesForSave(previous, ['automation', 'today'], true).order, ['automation', 'today', 'hidden']);
  assert.deepEqual(navigationPreferencesForSave(previous, ['today', 'automation'], false), previous);
});

test('menu editor uses the actual built-in icon registry rather than approximate defaults', async () => {
  const { BookOpen, CircleCheck, Terminal, LayoutGrid } = await import('@lucide/vue');
  const { workspaceMenuIcons, menuIcons } = await import('../src/shared/menu-icons');
  assert.equal(workspaceMenuIcons.tasks, CircleCheck);
  assert.equal(workspaceMenuIcons.execution, Terminal);
  assert.equal(workspaceMenuIcons.learning, BookOpen);
  assert.equal(workspaceMenuIcons.plugins, LayoutGrid);
  for (const [id, component] of Object.entries(menuIcons)) assert.equal(workspaceMenuIcons[id], component);
});
