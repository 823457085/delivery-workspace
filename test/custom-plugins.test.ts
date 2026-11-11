import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createWorkspaceTodos } from '../server/workspace-todos.js';
import { createCustomPluginRuntime, fingerprint, inspectCustomPlugin, privateJson } from '../server/plugins/custom-runtime.js';
import { createPluginJira } from '../server/plugins/host-jira.js';
import { createCustomPluginRoutes } from '../server/plugins/custom-routes.js';
import { pluginReferences, pluginReference } from '../shared/custom-plugins.js';
const todoPackage = path.resolve('plugins/todos'), notePackage = path.resolve('plugins/example-notes');
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'custom-plugin-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const todos = await createWorkspaceTodos(path.join(root, 'todos'));
  const runtime = await createCustomPluginRuntime(path.join(root, 'plugins'), todos);
  async function install(directory: string, grants?: string[]) { const preview = await runtime.inspect(directory); await runtime.install({ directory, digest: preview.digest, grants: grants || preview.manifest.permissions, confirmed: true }); }
  return { root, todos, runtime, install };
}
test('independent packages install without core registration; existing todos reused, private data isolated and persistent', async t => {
  const f = await fixture(t), existing = await f.todos.save({ title: '已有待办', details: '原有数据' });
  await f.install(todoPackage); await f.install(notePackage);
  assert.equal((await f.runtime.records('personal-todos'))[0].id, existing.id);
  const note = await f.runtime.saveRecord('example-notes', { values: { title: '备忘', details: '独立数据' } });
  assert.equal(f.todos.list().length, 1);
  const current = (await f.runtime.records('personal-todos'))[0];
  await f.runtime.saveRecord('personal-todos', { id: current.id, expectedVersion: fingerprint(current), values: { ...current.values, status: 'done' } });
  assert.equal(f.todos.list()[0].status, 'done');
  await assert.rejects(f.runtime.saveRecord('personal-todos', { id: current.id, expectedVersion: fingerprint(current), values: current.values }), /更新/);
  const reloaded = await createCustomPluginRuntime(path.join(f.root, 'plugins'), f.todos);
  assert.equal(reloaded.list().plugins.length, 2); assert.equal((await reloaded.records('example-notes'))[0].id, note.id);
  assert.equal((await fs.stat(path.join(f.root, 'plugins/data/example-notes/records.json'))).mode & 0o777, 0o600);
  await reloaded.change('example-notes', { remove: true }); await assert.rejects(reloaded.records('example-notes'), /移除/);
  const inspection = await reloaded.inspect(notePackage); await reloaded.install({ directory: notePackage, digest: inspection.digest, grants: inspection.manifest.permissions, confirmed: true });
  assert.equal((await reloaded.records('example-notes'))[0].id, note.id);
});
test('inspection validates data only, rejects executable entry, incompatible version, duplicate IDs and changed packages', async t => {
  const f = await fixture(t); await f.install(notePackage);
  await assert.rejects(f.install(notePackage), /已存在/);
  const dir = path.join(f.root, 'candidate'); await fs.mkdir(dir);
  const base = JSON.parse(await fs.readFile(path.join(notePackage, 'plugin.json'), 'utf8'));
  for (const change of [{ entry: '../../evil.mjs' }, { id: '../escape' }, { hostApi: 2 }, { apiVersion: 2 }, { permissions: ['all'] }]) {
    await fs.writeFile(path.join(dir, 'plugin.json'), JSON.stringify({ ...base, ...change }));
    await assert.rejects(inspectCustomPlugin(dir), /声明无效/);
  }
  await fs.writeFile(path.join(dir, 'plugin.json'), JSON.stringify({ ...base, id: 'new-notes' }));
  const inspected = await f.runtime.inspect(dir);
  await fs.writeFile(path.join(dir, 'plugin.json'), JSON.stringify({ ...base, id: 'new-notes', version: '1.0.1' }));
  await assert.rejects(f.runtime.install({ directory: dir, digest: inspected.digest, grants: inspected.manifest.permissions, confirmed: true }), /变化/);
});
test('custom fields preserve optional selections and keep large records editable while limiting conversation context', async t => {
  const f = await fixture(t), dir = path.join(f.root, 'large-notes'); await fs.mkdir(dir);
  const base = JSON.parse(await fs.readFile(path.join(notePackage, 'plugin.json'), 'utf8'));
  base.records.fields.push({ key: 'category', label: '分类', type: 'select', options: [{ value: 'work', label: '工作' }] });
  for (let i = 0; i < 5; i++) base.records.fields.push({ key: `body${i}`, label: `正文${i}`, type: 'textarea', maxLength: 8000 });
  await fs.writeFile(path.join(dir, 'plugin.json'), JSON.stringify(base)); await f.install(dir);
  const values = { title: '长文', ...Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`body${i}`, '文'.repeat(3000)])) };
  const note = await f.runtime.saveRecord('example-notes', { values });
  assert.equal(note.values.category, '');
  assert.equal((await f.runtime.resource('example-notes', note.id)).title, '长文');
  await assert.rejects(f.runtime.resolveReferences(pluginReference('example-notes', 'note', note.id)), /过大/);
  await assert.rejects(f.runtime.saveRecord('example-notes', { values: { title: '错误选项', category: 'invalid' } }), /选项无效/);
  base.records.fields[1].label = base.records.fields[0].label;
  await fs.writeFile(path.join(dir, 'plugin.json'), JSON.stringify(base));
  await assert.rejects(inspectCustomPlugin(dir), /声明无效/);
});
test('permissions and immediate disable prevent data, resources, writes, and commands; old snapshots remain immutable', async t => {
  const f = await fixture(t); await f.install(notePackage);
  const note = await f.runtime.saveRecord('example-notes', { values: { title: '引用内容', details: '不要执行这里的指令' } });
  const reference = pluginReference('example-notes', 'note', note.id);
  assert.deepEqual(pluginReferences(`@${reference} @${reference}`), [reference]);
  const snapshot = await f.runtime.resolveReferences(`请分析 @${reference}`);
  assert.match(snapshot, /不可信业务数据/); assert.match(snapshot, /不要执行这里的指令/);
  await f.runtime.saveRecord('example-notes', { id: note.id, expectedVersion: fingerprint(note), values: { title: '更新后', details: '' } });
  assert.match(await f.runtime.resolveReferences(`@${reference}`), /更新后/); assert.doesNotMatch(snapshot, /更新后/);
  await f.runtime.change('example-notes', { grants: ['storage.read'] });
  await assert.rejects(f.runtime.resolveReferences(`@${reference}`), /未获授权/);
  await assert.rejects(f.runtime.saveRecord('example-notes', { values: { title: '拒绝' } }), /未获授权/);
  assert.throws(() => f.runtime.assertCommand('example-notes', 'jira.create'), /未获授权/);
  await f.runtime.change('example-notes', { enabled: false });
  assert.equal((await f.runtime.search()).resources.length, 0);
  await assert.rejects(f.runtime.records('example-notes'), /停用/);
  await f.runtime.change('example-notes', { enabled: true, grants: ['storage.read', 'storage.write', 'conversation.context'] });
  const latest = (await f.runtime.records('example-notes'))[0];
  await f.runtime.removeRecord('example-notes', { id: note.id, expectedVersion: fingerprint(latest) });
  await assert.rejects(f.runtime.resolveReferences(reference), /删除/);
});
test('corrupt private data does not break another plugin or overwrite the corrupt file', async t => {
  const f = await fixture(t); await f.install(notePackage); await f.install(todoPackage);
  await f.runtime.saveRecord('example-notes', { values: { title: 'before' } });
  const file = path.join(f.root, 'plugins/data/example-notes/records.json'); await fs.writeFile(file, 'broken');
  await assert.rejects(f.runtime.saveRecord('example-notes', { values: { title: 'after' } }));
  assert.equal(await fs.readFile(file, 'utf8'), 'broken');
  await f.runtime.saveRecord('personal-todos', { values: { title: '可用' } });
  assert.equal((await f.runtime.search()).resources.length, 1);
});
test('private data beyond the read limit is rejected before replacing readable records', async t => {
  const f = await fixture(t); await f.install(notePackage);
  const note = await f.runtime.saveRecord('example-notes', { values: { title: '仍可读取' } });
  const file = path.join(f.root, 'plugins/data/example-notes/records.json');
  await assert.rejects(privateJson(file, { text: '文'.repeat(3_400_000) }), /大小上限/);
  assert.deepEqual(await f.runtime.records('example-notes'), [note]);
});
async function jiraFixture(t: TestContext, mode: 'ok' | 'timeout' | 'reject' | 'readback' = 'ok',
  options: Parameters<typeof createPluginJira>[3] = { site: () => 'https://jira.example.test/context', identity: () => 'test-identity' }) {
  const f = await fixture(t); await f.install(todoPackage);
  const record = await f.runtime.saveRecord('personal-todos', { values: { title: '待办转 Jira', details: '说明' } });
  let posts = 0; let fields: any;
  const request = async (resource: string, method = 'GET', body?: any) => {
    if (resource === 'project') return Response.json([{ key: 'DEMO', name: '示例项目' }]);
    if (resource.startsWith('issue/createmeta/DEMO/issuetypes/10?')) return Response.json({ isLast: true, fields: [
      { fieldId: 'summary', name: '标题', required: true, schema: { type: 'string' } },
      { fieldId: 'description', name: '描述', required: false, schema: { type: 'string' } },
      { fieldId: 'labels', name: '标签', required: false, schema: { type: 'array', items: 'string' } },
      { fieldId: 'customfield_123', name: '交付范围', required: true, schema: { type: 'string' } },
    ] });
    if (resource.startsWith('issue/createmeta/DEMO/issuetypes?')) return Response.json({ isLast: true, issueTypes: [{ id: '10', name: 'Task', subtask: false }] });
    if (resource === 'issue' && method === 'POST') { posts++; fields = body.fields; if (mode === 'timeout') throw new Error('timeout'); if (mode === 'reject') throw Object.assign(new Error('forbidden'), { definite: true }); return Response.json({ key: 'DEMO-1' }); }
    if (resource.startsWith('issue/DEMO-1?')) { if (mode === 'readback') throw new Error('readback timeout'); return Response.json({ key: 'DEMO-1', fields: fields || { summary: '已有任务', project: { key: 'DEMO' }, issuetype: { id: '10' } } }); }
    throw new Error(`unexpected resource: ${resource}`);
  };
  const jira = await createPluginJira(path.join(f.root, 'plugins'), f.runtime, request, options);
  const input = { recordId: record.id, version: fingerprint(record), project: 'DEMO', type: '10', fields: { summary: record.values.title, description: record.values.details, customfield_123: '范围' } };
  return { ...f, record, jira, input, posts: () => posts, reopen: () => createPluginJira(path.join(f.root, 'plugins'), f.runtime, request, options) };
}
test('Jira create requires real required metadata, preview and confirmation; duplicate and restart do not repost', async t => {
  const f = await jiraFixture(t);
  await assert.rejects(f.jira.prepare('personal-todos', { ...f.input, fields: { summary: '缺少必填' } }), /交付范围/);
  const preview = await f.jira.prepare('personal-todos', f.input);
  await assert.rejects(f.jira.commit('personal-todos', { ticketId: preview.ticketId, confirmed: false }));
  const results = await Promise.all([1,2].map(() => f.jira.commit('personal-todos', { ticketId: preview.ticketId, confirmed: true })));
  assert.ok(results.every(item => item.status === 'done')); assert.equal(f.posts(), 1);
  assert.equal((await f.jira.status('personal-todos', f.record.id)).links[0].url, 'https://jira.example.test/context/browse/DEMO-1');
  await (await f.reopen()).commit('personal-todos', { ticketId: preview.ticketId, confirmed: true }); assert.equal(f.posts(), 1);
  await assert.rejects(f.jira.prepare('personal-todos', f.input), /已创建/);
});
for (const mode of ['timeout', 'readback'] as const) test(`Jira ${mode} stays uncertain across restart without resending`, async t => {
  const f = await jiraFixture(t, mode), preview = await f.jira.prepare('personal-todos', f.input);
  assert.equal((await f.jira.commit('personal-todos', { ticketId: preview.ticketId, confirmed: true })).status, 'unknown');
  const reopened = await f.reopen(); await assert.rejects(reopened.prepare('personal-todos', f.input), /禁止重复/);
  await assert.rejects(reopened.commit('personal-todos', { ticketId: preview.ticketId, confirmed: true }), /不能重发/); assert.equal(f.posts(), 1);
});
test('Jira linking is local only and stop/changed source invalidate prepared writes', async t => {
  const f = await jiraFixture(t), preview = await f.jira.prepare('personal-todos', f.input);
  await f.jira.link('personal-todos', { recordId: f.record.id, version: fingerprint(f.record), key: 'DEMO-1', confirmed: true }); assert.equal(f.posts(), 0);
  await f.runtime.change('personal-todos', { enabled: false });
  await assert.rejects(f.jira.commit('personal-todos', { ticketId: preview.ticketId, confirmed: true }), /停用/);
  await f.runtime.change('personal-todos', { enabled: true });
  await f.runtime.saveRecord('personal-todos', { id: f.record.id, expectedVersion: fingerprint(f.record), values: { ...f.record.values, title: '已经修改' } });
  await assert.rejects(f.jira.commit('personal-todos', { ticketId: preview.ticketId, confirmed: true }), /变化/); assert.equal(f.posts(), 0);
});
test('Jira preview and links use the active provider site, and an account change invalidates the preview', async t => {
  const environment = {
    JIRA_BASE_URL: 'https://jira.example.test/context/',
    JIRA_KEYCHAIN_SERVICE: 'test-jira-keychain',
    JIRA_KEYCHAIN_ACCOUNT: 'first-account',
  };
  for (const [key, value] of Object.entries(environment)) {
    const previous = process.env[key];
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    process.env[key] = value;
  }
  const f = await jiraFixture(t, 'ok', {});
  assert.equal((await f.jira.find('personal-todos', 'DEMO-1')).url, 'https://jira.example.test/context/browse/DEMO-1');
  const preview = await f.jira.prepare('personal-todos', f.input);
  assert.equal(preview.site, 'https://jira.example.test/context');
  process.env.JIRA_KEYCHAIN_ACCOUNT = 'another-account';
  await assert.rejects(f.jira.commit('personal-todos', { ticketId: preview.ticketId, confirmed: true }), /连接已变化/);
  assert.equal(f.posts(), 0);
});
test('custom plugin routes reject cross-origin mutations, require explicit confirmation and do not expose credentials', async t => {
  const f = await fixture(t);
  const jira = await createPluginJira(path.join(f.root, 'plugins'), f.runtime, async () => { throw new Error('unexpected network'); });
  let port = 0, routes: ReturnType<typeof createCustomPluginRoutes>;
  const server = http.createServer(async (req, res) => { if (!await routes(req, res, new URL(req.url!, `http://127.0.0.1:${port}`))) res.end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); port = (server.address() as any).port;
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  routes = createCustomPluginRoutes(f.runtime, jira, { port, examples: [], citations: () => [], json: (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); }, body: async req => { let data = ''; for await (const chunk of req) data += chunk; return JSON.parse(data); } });
  const base = `http://127.0.0.1:${port}/api/custom-plugins`, headers = { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes', Origin: `http://127.0.0.1:${port}` };
  assert.equal((await fetch(base + '/inspect', { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.test' }, body: JSON.stringify({ directory: notePackage }) })).status, 403);
  assert.equal((await fetch(base + '/inspect', { method: 'POST', headers: { ...headers, 'X-Delivery-Confirmed': '' }, body: '{}' })).status, 403);
  const inspection = await (await fetch(base + '/inspect', { method: 'POST', headers, body: JSON.stringify({ directory: notePackage }) })).json();
  const installed = await fetch(base + '/install', { method: 'POST', headers, body: JSON.stringify({ directory: notePackage, digest: inspection.digest, grants: inspection.manifest.permissions, confirmed: true }) });
  assert.equal(installed.status, 200); assert.equal((await installed.json()).plugins.length, 1);
  const saved = await (await fetch(base + '/example-notes/save', { method: 'POST', headers, body: JSON.stringify({ values: { title: '接口验证' } }) })).json();
  const navigation = { order: ['custom:example-notes', 'today'], icons: { 'custom:example-notes': 'notebook' } };
  assert.equal((await fetch(base + '/navigation/settings', { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.test' }, body: JSON.stringify(navigation) })).status, 403);
  const menuSaved = await fetch(base + '/navigation/settings', { method: 'POST', headers, body: JSON.stringify(navigation) });
  assert.equal(menuSaved.status, 200);
  assert.deepEqual((await menuSaved.json()).navigation, navigation);
  assert.ok(saved.id); assert.doesNotMatch(await (await fetch(base)).text(), /AUTH_HEADER|API_TOKEN|Cookie/);
});

test('menu preference persists without changing grants or records and supports legacy installations', async t => {
  const f = await fixture(t); await f.install(notePackage);
  const note = await f.runtime.saveRecord('example-notes', { values: { title: '菜单切换保留数据' } });
  const before = f.runtime.list().plugins[0];
  assert.equal(before.showInMenu, false);
  await f.runtime.change('example-notes', { showInMenu: true });
  const restarted = await createCustomPluginRuntime(path.join(f.root, 'plugins'), f.todos);
  assert.equal(restarted.list().plugins[0].showInMenu, true);
  assert.deepEqual(restarted.list().plugins[0].grants, before.grants);
  await restarted.change('example-notes', { enabled: false });
  assert.equal(restarted.list().plugins[0].showInMenu, true);
  await restarted.change('example-notes', { enabled: true, showInMenu: false });
  assert.equal((await restarted.records('example-notes'))[0].id, note.id);
  await assert.rejects(restarted.change('example-notes', { showInMenu: 'yes' }));
  await restarted.change('example-notes', { showInMenu: true, remove: true });
  assert.equal(restarted.list().plugins.length, 0);
  const preview = await restarted.inspect(notePackage);
  await restarted.install({ directory: notePackage, digest: preview.digest, grants: preview.manifest.permissions, confirmed: true });
  assert.equal(restarted.list().plugins[0].showInMenu, true);
  const file = path.join(f.root, 'plugins', 'installed.json');
  const legacy = JSON.parse(await fs.readFile(file, 'utf8'));
  delete legacy.plugins[0].showInMenu;
  await fs.writeFile(file, JSON.stringify(legacy));
  const migrated = await createCustomPluginRuntime(path.join(f.root, 'plugins'), f.todos);
  assert.equal(migrated.list().plugins[0].showInMenu, false);
  assert.equal((await migrated.records('example-notes'))[0].id, note.id);
  const todo = await migrated.inspect(todoPackage);
  await migrated.install({ directory: todoPackage, digest: todo.digest, grants: todo.manifest.permissions, confirmed: true, showInMenu: true });
  assert.equal(migrated.list().plugins.find(p => p.manifest.id === 'personal-todos')?.showInMenu, true);
});

test('menu order and built-in icons persist atomically without changing plugin data or permissions', async t => {
  const f = await fixture(t); await f.install(notePackage);
  const before = f.runtime.list().plugins;
  assert.deepEqual(f.runtime.list().navigation, { order: [], icons: {} });
  const navigation = { order: ['custom:example-notes', 'today', 'automation'], icons: { 'custom:example-notes': 'notebook', today: 'star' } };
  await f.runtime.saveNavigation(navigation);
  await f.runtime.change('example-notes', { showInMenu: true });
  const restarted = await createCustomPluginRuntime(path.join(f.root, 'plugins'), f.todos);
  assert.deepEqual(restarted.list().navigation, navigation);
  assert.deepEqual(restarted.list().plugins[0].grants, before[0].grants);
  for (const invalid of [{ order: ['today', 'today'], icons: {} }, { order: [], icons: { today: 'https://example.com/icon.svg' } }, { order: ['../escape'], icons: {} }]) {
    await assert.rejects(restarted.saveNavigation(invalid));
    assert.deepEqual(restarted.list().navigation, navigation);
  }
  const snapshot = restarted.list(); snapshot.navigation.order.reverse();
  assert.deepEqual(restarted.list().navigation, navigation);
  await restarted.saveNavigation({ order: [], icons: {} });
  assert.deepEqual(restarted.list().navigation, { order: [], icons: {} });
});
