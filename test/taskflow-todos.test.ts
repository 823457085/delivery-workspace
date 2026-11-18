import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWorkspaceTodos } from '../server/workspace-todos.js';
import { createTaskflowTodos, readTaskflowSession, type TaskflowRequest, type TaskflowSession } from '../server/taskflow-todos.js';

type Remote = { id: string; title: string; details: string; dueDate: string; priority: string; status: string; version: number; projectId: string | null; createdAt: string; updatedAt: string; sourceId?: string };

function fakeTaskflow() {
  const todos = new Map<string, Remote>(), calls: string[] = [];
  let offline = false, expired = false;
  const stamp = () => new Date().toISOString();
  const request: TaskflowRequest = async (session, method, pathname, body: any) => {
    calls.push(`${method} ${pathname}`);
    if (offline) throw new Error('ECONNREFUSED');
    if (expired || session.token !== 'device-token') return { status: 401, body: { error: { message: 'expired' } } };
    const [route, query] = pathname.split('?'), version = Number(new URLSearchParams(query).get('expectedVersion'));
    if (method === 'GET' && route === '/api/todos') return { status: 200, body: { todos: [...todos.values()].map(({ sourceId, ...todo }) => todo) } };
    if (method === 'POST' && route === '/api/todos') {
      const todo = { id: randomUUID(), details: '', dueDate: '', priority: 'normal', status: 'todo', ...body, version: 1, projectId: null, createdAt: stamp(), updatedAt: stamp() };
      todos.set(todo.id, todo); return { status: 201, body: { todo } };
    }
    if (method === 'POST' && route === '/api/todos/import') {
      let imported = 0;
      for (const item of body.items) if (![...todos.values()].some(todo => todo.sourceId === item.id)) {
        const id = randomUUID(); todos.set(id, { ...item, id, sourceId: item.id, version: 1, projectId: null }); imported++;
      }
      return { status: 200, body: { imported, skipped: body.items.length - imported } };
    }
    const todo = todos.get(route.split('/').pop()!);
    if (!todo) return { status: 404, body: { error: { message: '待办不存在' } } };
    if (todo.projectId && method === 'DELETE') return { status: 403, body: { error: { message: '本机工作台不能删除项目待办，请在任务中心操作' } } };
    const expected = method === 'PATCH' ? body.expectedVersion : version;
    if (expected !== todo.version) return { status: 409, body: { error: { message: '待办已被他人修改，请刷新后重试' } } };
    if (method === 'DELETE') { todos.delete(todo.id); return { status: 204, body: undefined }; }
    const { expectedVersion, ...fields } = body;
    Object.assign(todo, fields, { version: todo.version + 1, updatedAt: stamp() });
    return { status: 200, body: { todo } };
  };
  return { todos, calls, request, setOffline: (value: boolean) => { offline = value; }, expire: () => { expired = true; } };
}

async function fixture(t: TestContext, session: TaskflowSession | undefined = { url: 'https://hub.example', token: 'device-token' }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-taskflow-todos-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const local = await createWorkspaceTodos(root), remote = fakeTaskflow();
  const state = { session };
  const markerFile = path.join(root, 'taskflow-imported.json');
  const service = createTaskflowTodos(local, { markerFile, request: remote.request, session: async () => state.session });
  return { root, local, remote, state, markerFile, service };
}

test('配对后待办读写任务中心，本机旧待办只导入一次并保留原文件', async t => {
  const { local, remote, markerFile, service, root } = await fixture(t);
  await local.save({ title: '本机旧待办', priority: 'high', dueDate: '2026-11-20' });
  await service.refresh();
  assert.deepEqual(service.source(), { mode: 'taskflow', url: 'https://hub.example', ready: true });
  assert.deepEqual(service.list().map(item => [item.title, item.priority, item.dueDate]), [['本机旧待办', 'high', '2026-11-20']]);
  assert.equal(JSON.parse(await fs.readFile(markerFile, 'utf8')).imported, 1);
  assert.equal(local.list().length, 1);

  const created = await service.save({ title: '  新建到服务器  ', details: '备注' });
  assert.equal(created.title, '新建到服务器'); assert.ok(remote.todos.has(created.id));
  const done = await service.save({ id: created.id, title: created.title, details: created.details, status: 'done' });
  assert.equal(done.status, 'done'); assert.equal(remote.todos.get(created.id)!.version, 2);
  await service.remove({ id: created.id });
  assert.equal(remote.todos.has(created.id), false); assert.equal(service.list().length, 1);
  assert.equal(local.list().length, 1);

  const again = createTaskflowTodos(await createWorkspaceTodos(root), { markerFile, request: remote.request, session: async () => ({ url: 'https://hub.example', token: 'device-token' }) });
  await again.refresh();
  assert.equal(remote.calls.filter(call => call.includes('/import')).length, 1);
  assert.equal(again.list().length, 1);
});

test('他人在任务中心改过的待办按版本冲突拒绝覆盖，刷新后可继续编辑', async t => {
  const { remote, service } = await fixture(t);
  await service.refresh();
  const item = await service.save({ title: '共享事项' });
  remote.todos.get(item.id)!.version = 5; remote.todos.get(item.id)!.title = '他人修改';
  await assert.rejects(service.save({ id: item.id, title: '我的修改' }), /他人修改/);
  await assert.rejects(service.save({ id: item.id, title: '我的修改' }, item), /他人修改/);
  await service.refresh();
  assert.equal(service.list()[0].title, '他人修改');
  await assert.rejects(service.save({ id: item.id, title: '我的修改' }, item), /已更新/);
  assert.equal((await service.save({ id: item.id, title: '我的修改' })).title, '我的修改');
  remote.todos.get(item.id)!.projectId = 'default';
  await assert.rejects(service.remove({ id: item.id }), /不能删除项目待办/);
});

test('断网或登录失效时报错不改本机文件，未配对时继续使用本机待办', async t => {
  const { local, remote, service, state } = await fixture(t);
  await service.refresh();
  const kept = await service.save({ title: '已同步' });
  remote.setOffline(true);
  await assert.rejects(service.refresh(), /连不上任务中心/);
  assert.deepEqual(service.list().map(item => item.id), [kept.id]);
  await assert.rejects(service.save({ title: '断网新建' }), /连不上任务中心/);
  remote.setOffline(false); remote.expire();
  await assert.rejects(service.save({ title: '失效新建' }), /重新连接本机 Bridge/);
  assert.deepEqual(local.list(), []);

  state.session = undefined;
  await service.refresh();
  assert.deepEqual(service.source(), { mode: 'local' });
  const offline = await service.save({ title: '未配对写本机' });
  assert.deepEqual(local.list().map(item => item.id), [offline.id]);
  assert.deepEqual(service.list().map(item => item.id), [offline.id]);
});

test('Bridge 会话文件缺失、过期或格式错误时不启用任务中心', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-taskflow-home-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  assert.equal(await readTaskflowSession(home), undefined);
  await fs.mkdir(path.join(home, 'state'));
  const write = (value: unknown) => fs.writeFile(path.join(home, 'state', 'session.json'), JSON.stringify(value));
  await write({ url: 'https://hub.example/path', token: 'device-token', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  await fs.writeFile(path.join(home, 'taskflow-ca.pem'), 'PEM');
  assert.deepEqual(await readTaskflowSession(home), { url: 'https://hub.example', token: 'device-token', ca: 'PEM' });
  await write({ url: 'https://hub.example', token: 'device-token', expiresAt: new Date(Date.now() - 1).toISOString() });
  assert.equal(await readTaskflowSession(home), undefined);
  await write({ url: 'file:///etc/passwd', token: 'device-token' });
  assert.equal(await readTaskflowSession(home), undefined);
  await write({ url: 'https://hub.example' });
  assert.equal(await readTaskflowSession(home), undefined);
});
