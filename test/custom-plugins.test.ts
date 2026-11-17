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
import { pluginReferences, pluginReference, parsePluginRecordProposal } from '../shared/custom-plugins.js';
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
  for (const invalid of [{ order: ['today', 'today'], icons: {} }, { order: [], icons: { today: 'javascript:alert(1)' } }, { order: ['../escape'], icons: {} }]) {
    await assert.rejects(restarted.saveNavigation(invalid));
    assert.deepEqual(restarted.list().navigation, navigation);
  }
  const snapshot = restarted.list(); snapshot.navigation.order.reverse();
  assert.deepEqual(restarted.list().navigation, navigation);
  await restarted.saveNavigation({ order: [], icons: {} });
  assert.deepEqual(restarted.list().navigation, { order: [], icons: {} });
});

test('rich field types (number, url, checkbox, tags) validate strictly and normalize cleanly', async t => {
  const f = await fixture(t), dir = path.join(f.root, 'rich-ledger'); await fs.mkdir(dir);
  const manifest = {
    apiVersion: 1, hostApi: 1, id: 'rich-ledger', name: '富字段台账', version: '1.0.0', description: '验证多类型字段',
    permissions: ['storage.read', 'storage.write', 'conversation.context'],
    page: { title: '富字段台账', kind: 'records' },
    records: {
      storage: 'private', resourceType: 'item',
      fields: [
        { key: 'title', label: '标题', type: 'text', required: true },
        { key: 'estimate', label: '工时', type: 'number', default: '1.5' },
        { key: 'link', label: '链接', type: 'url' },
        { key: 'verified', label: '已核验', type: 'checkbox', default: 'false' },
        { key: 'tags', label: '标签', type: 'tags' },
      ],
    },
    commands: [{ id: 'cite', label: '引用', action: 'conversation.context' }],
  };
  await fs.writeFile(path.join(dir, 'plugin.json'), JSON.stringify(manifest));
  await f.install(dir);

  const saved = await f.runtime.saveRecord('rich-ledger', {
    values: {
      title: '支持富字段',
      estimate: 3.25,
      link: 'https://example.com/docs/spec',
      verified: true,
      tags: ['后端', '性能，后端', 'SSE'],
    },
  });
  assert.equal(saved.values.estimate, '3.25');
  assert.equal(saved.values.verified, 'true');
  assert.equal(saved.values.tags, '后端, 性能, SSE');

  const res = await f.runtime.resource('rich-ledger', saved.id, true);
  assert.equal(JSON.parse(res.content!).已核验, '是');

  const snapshot = await f.runtime.resolveReferences(`请检查 @${res.reference}`);
  const marker = '<!-- delivery-plugin-context:v1 -->\n';
  const markerIdx = snapshot.lastIndexOf(marker);
  assert.ok(markerIdx > 0);
  assert.match(snapshot.slice(0, markerIdx), /plugin-record/);
  assert.equal(JSON.parse(snapshot.slice(markerIdx + marker.length))[0].id, saved.id);

  await assert.rejects(f.runtime.saveRecord('rich-ledger', { values: { title: '坏数字', estimate: '12abc' } }), /数字无效/);
  await assert.rejects(f.runtime.saveRecord('rich-ledger', { values: { title: '坏协议', link: 'javascript:alert(1)' } }), /链接无效/);
  await assert.rejects(f.runtime.saveRecord('rich-ledger', { values: { title: '含凭据链接', link: 'https://user:pass@example.com' } }), /链接无效/);
  await assert.rejects(f.runtime.saveRecord('rich-ledger', { values: { title: '坏布尔', verified: 'maybe' } }), /布尔值无效/);
});

test('in-place upgrade migrates compatible records, blocks incompatible schema changes, and guards removed field data', async t => {
  const f = await fixture(t), dir = path.join(f.root, 'upgradable-notes'); await fs.mkdir(dir);
  const v1 = JSON.parse(await fs.readFile(path.join(notePackage, 'plugin.json'), 'utf8'));
  await fs.writeFile(path.join(dir, 'plugin.json'), JSON.stringify(v1));
  await f.install(dir);
  const created = await f.runtime.saveRecord('example-notes', { values: { title: '历史事项', details: '重要复盘内容' } });

  const v2Incompatible = {
    ...v1,
    version: '1.1.0',
    records: {
      ...v1.records,
      fields: [
        ...v1.records.fields,
        { key: 'mandatoryLink', label: '必填链接', type: 'url', required: true },
      ],
    },
  };
  await fs.writeFile(path.join(dir, 'plugin.json'), JSON.stringify(v2Incompatible));
  const badPreview = await f.runtime.inspectUpgrade('example-notes', dir);
  assert.equal(badPreview.compatible, false);
  assert.equal(badPreview.incompatibleRecords.length, 1);
  await assert.rejects(f.runtime.upgrade({
    id: 'example-notes', directory: dir, digest: badPreview.digest, grants: badPreview.manifest.permissions, confirmed: true,
  }), /不兼容/);

  const v2CompatibleDrop = {
    ...v1,
    version: '1.2.0',
    records: {
      ...v1.records,
      fields: [
        { key: 'title', label: '标题', type: 'text', required: true, maxLength: 200 },
        { key: 'tags', label: '分类标签', type: 'tags', default: 'legacy, migrated' },
        { key: 'reviewed', label: '已复核', type: 'checkbox', default: 'false' },
      ],
    },
  };
  await fs.writeFile(path.join(dir, 'plugin.json'), JSON.stringify(v2CompatibleDrop));
  const dropPreview = await f.runtime.inspectUpgrade('example-notes', dir);
  assert.equal(dropPreview.compatible, true);
  assert.equal(dropPreview.affectedRemovedFieldCount, 1);
  assert.equal(dropPreview.removedFields[0].key, 'details');
  await assert.rejects(f.runtime.upgrade({
    id: 'example-notes', directory: dir, digest: dropPreview.digest, grants: dropPreview.manifest.permissions, confirmed: true,
  }), /清理移除字段/);

  await f.runtime.upgrade({
    id: 'example-notes', directory: dir, digest: dropPreview.digest, grants: dropPreview.manifest.permissions, confirmed: true, dropRemovedFields: true,
  });
  const migrated = (await f.runtime.records('example-notes'))[0];
  assert.equal(migrated.id, created.id);
  assert.equal(migrated.createdAt, created.createdAt);
  assert.equal(migrated.values.tags, 'legacy, migrated');
  assert.equal(migrated.values.reviewed, 'false');
  assert.equal('details' in migrated.values, false);

  await f.runtime.change('example-notes', { remove: true });
  assert.equal(f.runtime.list().removedPlugins.length, 1);
  const v3Restore = { ...v2CompatibleDrop, version: '1.3.0' };
  await fs.writeFile(path.join(dir, 'plugin.json'), JSON.stringify(v3Restore));
  const restorePreview = await f.runtime.inspectUpgrade('example-notes', dir);
  assert.equal(restorePreview.wasRemoved, true);
  await f.runtime.upgrade({
    id: 'example-notes', directory: dir, digest: restorePreview.digest, grants: restorePreview.manifest.permissions, confirmed: true,
  });
  assert.equal(f.runtime.list().plugins[0].manifest.version, '1.3.0');
  assert.equal((await f.runtime.records('example-notes'))[0].id, created.id);
});

test('parsePluginRecordProposal safely normalizes Agent JSON proposals and strips dangerous keys', () => {
  const proposal = parsePluginRecordProposal(JSON.stringify({
    pluginId: 'bug-retrospective',
    values: {
      title: 'SSE 重连竞态修复',
      regressionAdded: true,
      estimate: 2,
      tags: ['sse', 'race'],
      __proto__: 'ignored',
      constructor: 'ignored',
    },
  }));
  assert.ok(proposal);
  assert.equal(proposal.pluginId, 'bug-retrospective');
  assert.equal(proposal.values.title, 'SSE 重连竞态修复');
  assert.equal(proposal.values.regressionAdded, 'true');
  assert.equal(proposal.values.estimate, '2');
  assert.equal(proposal.values.tags, 'sse, race');
  assert.equal(Object.hasOwn(proposal.values, 'constructor'), false);
  assert.equal(parsePluginRecordProposal('not-json'), null);
  assert.equal(parsePluginRecordProposal('[]'), null);
});

test('Jira unknown ticket reconciles by marker search, verified issue link, or explicit not_created unlock without resending', async t => {
  const f = await fixture(t); await f.install(todoPackage);
  const record = await f.runtime.saveRecord('personal-todos', { values: { title: '待办核对解锁', details: '说明' } });
  let posts = 0, searchMatches: any[] = [];
  const request = async (resource: string, method = 'GET') => {
    if (resource.startsWith('issue/createmeta/DEMO/issuetypes/10?')) return Response.json({ isLast: true, fields: [
      { fieldId: 'summary', name: '标题', required: true, schema: { type: 'string' } },
      { fieldId: 'labels', name: '标签', required: false, schema: { type: 'array', items: 'string' } },
    ] });
    if (resource.startsWith('issue/createmeta/DEMO/issuetypes?')) return Response.json({ isLast: true, issueTypes: [{ id: '10', name: 'Task', subtask: false }] });
    if (resource === 'issue' && method === 'POST') { posts++; throw new Error('network timeout'); }
    if (resource.startsWith('search?')) return Response.json({ issues: searchMatches });
    if (resource.startsWith('issue/DEMO-99?')) return Response.json({ key: 'DEMO-99', fields: { summary: '人工找回任务', project: { key: 'DEMO' }, issuetype: { id: '10' } } });
    if (resource.startsWith('issue/OTHER-1?')) return Response.json({ key: 'OTHER-1', fields: { summary: '跨项目误关联', project: { key: 'OTHER' }, issuetype: { id: '10' } } });
    throw new Error(`unexpected resource: ${resource}`);
  };
  const jira = await createPluginJira(path.join(f.root, 'plugins'), f.runtime, request, {
    site: () => 'https://jira.example.test',
    identity: () => 'test-identity',
  });
  const baseInput = { recordId: record.id, version: fingerprint(record), project: 'DEMO', type: '10', fields: { summary: record.values.title } };
  const preview = await jira.prepare('personal-todos', baseInput);
  const committed = await jira.commit('personal-todos', { ticketId: preview.ticketId, confirmed: true });
  assert.equal(committed.status, 'unknown');
  assert.equal(posts, 1);

  // 未检索到标记时仍保持 unknown，绝不假定远端未创建或自动重发
  const emptyAuto = await jira.reconcile('personal-todos', { ticketId: preview.ticketId, outcome: 'auto', confirmed: true });
  assert.equal(emptyAuto.status, 'unknown');
  await assert.rejects(jira.prepare('personal-todos', baseInput), /禁止重复/);

  // 确认远端未创建后解锁，允许重新 prepare，且不自动发写请求
  const unlocked = await jira.reconcile('personal-todos', { ticketId: preview.ticketId, outcome: 'not_created', confirmed: true });
  assert.equal(unlocked.status, 'failed');
  assert.equal(posts, 1);

  const preview2 = await jira.prepare('personal-todos', baseInput);
  await jira.commit('personal-todos', { ticketId: preview2.ticketId, confirmed: true });
  assert.equal(posts, 2);

  // 拒绝跨项目错误编号，支持按标记自动找回并保存关联
  await assert.rejects(jira.reconcile('personal-todos', { ticketId: preview2.ticketId, outcome: 'linked', issueKey: 'OTHER-1', confirmed: true }), /不一致/);
  searchMatches = [{ key: 'DEMO-88', fields: { summary: record.values.title, project: { key: 'DEMO' }, issuetype: { id: '10' } } }];
  const autoLinked = await jira.reconcile('personal-todos', { ticketId: preview2.ticketId, outcome: 'auto', confirmed: true });
  assert.equal(autoLinked.status, 'done');
  assert.equal(autoLinked.result?.key, 'DEMO-88');
  assert.equal((await jira.status('personal-todos', record.id)).links[0].key, 'DEMO-88');
  assert.equal(posts, 2);
});

test('新增内置图标和外链图标保存重载后保留，不改变菜单顺序与分组', async t => {
  const f = await fixture(t);
  const navigation = { order: ['today', 'projects'], icons: { today: 'https://example.com/logo.svg?v=2', projects: 'database' }, groups: { today: '个人' } };
  await f.runtime.saveNavigation(navigation);
  const restarted = await createCustomPluginRuntime(path.join(f.root, 'plugins'), f.todos);
  assert.deepEqual(restarted.list().navigation, navigation);
  await assert.rejects(restarted.saveNavigation({ ...navigation, icons: { today: 'file:///tmp/private.svg' } }));
  assert.deepEqual(restarted.list().navigation, navigation);
});
