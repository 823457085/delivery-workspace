import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createWorkspaceTodos } from '../server/workspace-todos.js';
import { createWorkspaceTodoRoutes } from '../server/workspace-todo-routes.js';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-workspace-todos-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, service: await createWorkspaceTodos(root), file: path.join(root, 'workspace-todos.json') };
}

test('个人待办新增、编辑、完成和删除可重载，存储权限与调用者隔离', async t => {
  const { root, service, file } = await fixture(t);
  assert.deepEqual(service.list(), []);
  const item = await service.save({ title: '  核对需求  ', details: '检查接口字段', dueDate: '2026-11-05', priority: 'high' });
  assert.equal(item.title, '核对需求'); assert.equal(item.status, 'todo');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const edited = await service.save({ id: item.id, title: '核对需求和验收', details: '按截图逐项确认', dueDate: '2026-11-06', status: 'done', priority: 'normal' });
  assert.equal(edited.id, item.id); assert.equal(edited.createdAt, item.createdAt); assert.equal(edited.status, 'done');
  const reloaded = await createWorkspaceTodos(root); assert.deepEqual(reloaded.list(), [edited]);
  const exposed = reloaded.list(); exposed[0].title = '不能污染存储';
  assert.equal(reloaded.list()[0].title, '核对需求和验收');
  await reloaded.remove({ id: item.id }); assert.deepEqual((await createWorkspaceTodos(root)).list(), []);
});

test('并发新增和编辑串行持久化，不丢待办且不制造重复记录', async t => {
  const { root, service } = await fixture(t);
  const created = await Promise.all(Array.from({ length: 16 }, (_, index) => service.save({ title: `事项${index}` })));
  assert.equal(service.list().length, 16);
  await Promise.all(created.map((item, index) => service.save({ id: item.id, title: `已编辑${index}`, status: 'doing' })));
  const reopened = await createWorkspaceTodos(root);
  assert.equal(reopened.list().length, 16); assert.ok(reopened.list().every(item => item.status === 'doing'));
  await Promise.all(created.slice(0, 8).map(item => service.remove({ id: item.id })));
  assert.equal((await createWorkspaceTodos(root)).list().length, 8);
});

test('拒绝无效日期、长度、状态和未知标识，既有内容不被覆盖', async t => {
  const { service, file } = await fixture(t);
  await service.save({ title: '保留原有待办', dueDate: '2028-02-29' });
  const original = await fs.readFile(file, 'utf8');
  for (const input of [
    { title: '' }, { title: 'a'.repeat(201) }, { title: '事项', details: 'a'.repeat(2001) },
    { title: '事项', dueDate: '2026-02-30' }, { title: '事项', dueDate: '2026-11-4' },
    { title: '事项', dueDate: 'not-a-date' }, { title: '事项', status: 'unknown' }, { title: '事项', priority: 'urgent' },
    { title: '事项', createdAt: '自己传入' }, { title: '事项', id: randomUUID() },
  ]) await assert.rejects(service.save(input));
  await assert.rejects(service.remove({ id: randomUUID() }), /不存在/);
  await assert.rejects(service.remove({ id: '../other' }));
  assert.equal(await fs.readFile(file, 'utf8'), original); assert.equal(service.list().length, 1);
});

test('损坏状态不伪装成空待办，符号链接不被读取或覆盖', async t => {
  const { root, service, file } = await fixture(t);
  const item = await service.save({ title: '不能丢失' });
  const external = path.join(root, 'external.json'); await fs.writeFile(external, '原始内容');
  await fs.rm(file); await fs.symlink(external, file);
  await assert.rejects(createWorkspaceTodos(root), /普通文件/);
  await assert.rejects(service.save({ id: item.id, title: '不应写入' }), /普通文件/);
  assert.equal(service.list()[0].title, '不能丢失'); assert.equal(await fs.readFile(external, 'utf8'), '原始内容');
  await fs.rm(file); await fs.writeFile(file, '{"version":1,"items":[{"title":"损坏记录"}]}');
  await assert.rejects(createWorkspaceTodos(root), /读取失败/);
});

test('待办 HTTP 读写校验 Host、Origin、确认头与 JSON，GET 不执行删除', async t => {
  const { service } = await fixture(t);
  let port = 0;
  const io = {
    get port() { return port; },
    json(response: http.ServerResponse, status: number, value: unknown) {
      response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value));
    },
    async body(request: http.IncomingMessage, limit = 16000) {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > limit) throw new Error('请求过大'); chunks.push(Buffer.from(chunk)); }
      return JSON.parse(Buffer.concat(chunks).toString());
    },
  };
  const route = createWorkspaceTodoRoutes(service, io);
  const server = http.createServer(async (request, response) => {
    if (!await route(request, response, new URL(request.url!, `http://127.0.0.1:${port}`))) io.json(response, 404, {});
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${port}`;
  const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' };
  const post = (body: string, override: Record<string, string> = {}, route = '') => fetch(origin + '/api/workspace-todos' + route,
    { method: 'POST', headers: { ...headers, ...override }, body });
  assert.deepEqual(await (await fetch(origin + '/api/workspace-todos')).json(), { items: [] });
  for (const override of [{ Origin: 'https://example.com' }, { Origin: '' }, { 'X-Delivery-Confirmed': '' }]) {
    assert.equal((await post('{"title":"不应写入"}', override)).status, 403, JSON.stringify(override));
  }
  const hostRejected = await new Promise<number>((resolve, reject) => {
    const req = http.request(origin + '/api/workspace-todos', { method: 'POST', headers: { ...headers, Host: `attacker.test:${port}` } }, response => {
      response.resume(); resolve(response.statusCode!);
    });
    req.on('error', reject); req.end('{"title":"不应写入"}');
  });
  assert.equal(hostRejected, 403);
  assert.equal((await post('{"title":"不应写入"}', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post('not-json')).status, 400);
  assert.deepEqual(service.list(), []);
  const created = await post('{"title":"通过页面新建","dueDate":"2026-11-04"}'); assert.equal(created.status, 200);
  const item = await created.json();
  assert.equal((await fetch(origin + '/api/workspace-todos/delete?id=' + item.id)).status, 405); assert.equal(service.list().length, 1);
  assert.equal((await post(JSON.stringify({ id: item.id }), {}, '/delete')).status, 200); assert.equal(service.list().length, 0);
});
