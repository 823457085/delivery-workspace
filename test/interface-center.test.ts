import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { createInterfaceCenter, createInterfaceCenterRoutes } from '../server/interface-center.js';
import { apiOperationDetail, apiOperations, parseApiDocument } from '../server/interface-center-document.js';

const contract = (title = 'L001 原始标题') => ({ openapi: '3.1.0', info: { title, version: '1.0', description: 'L002 原始说明' },
  paths: { '/items/{id}': { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], get: {
    summary: 'L003', tags: ['订单 / 列表'], parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }],
    responses: { '200': { description: 'L004', content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } } } },
  } } }, components: { schemas: { Item: { type: 'object', properties: { name: { type: 'string', description: 'L005' }, child: { $ref: '#/components/schemas/Item' } } } } } });
const input = (document: unknown) => ({ content: JSON.stringify(document), filename: 'openapi.json' });
const fileSource = (document: unknown) => ({ kind: 'file', ...input(document) });
async function setup(t: { after(fn: () => Promise<void>): void }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'interface-center-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const service = await createInterfaceCenter(path.join(directory, 'state'));
  t.after(() => service.close());
  return { directory, service };
}
async function imported(service: Awaited<ReturnType<typeof createInterfaceCenter>>, name: string, document = contract()) {
  const project = await service.create({ name });
  const preview = service.preview(project.id, input(document));
  return service.import(project.id, { ...input(document), expectedUpdatedAt: preview.expectedUpdatedAt });
}

test('JSON/YAML 导入保留原文，内部引用与递归模型有界展示', () => {
  for (const content of [JSON.stringify(contract()), stringify(contract()), stringify(contract(), { collectionStyle: 'flow' })]) {
    const document = parseApiDocument(content), operations = apiOperations(document);
    assert.equal(operations.length, 1);
    assert.equal(operations[0].summary, 'L003');
    assert.deepEqual(operations[0].tags, ['订单 / 列表']);
    const detail = apiOperationDetail(document, operations[0].key);
    assert.equal((detail.parameters[0] as any).name, 'id');
    assert.equal((detail.responses['200'] as any).description, 'L004');
    const schema = (detail.responses['200'] as any).content['application/json'].schema;
    assert.equal(schema.properties.name.description, 'L005');
    assert.equal(schema.properties.child.$ref, '#/components/schemas/Item');
  }
});

test('项目导入确认只创建一次，追加保留原操作、引用和服务地址，过期目标版本拒绝写入', async t => {
  const { service } = await setup(t);
  const original = { ...contract(), servers: [{ url: 'https://original.example' }] };
  const create = await service.previewProjectImport({ source: fileSource(original) });
  assert.deepEqual(service.snapshot().projects, []);
  assert.equal(create.targetName, original.info.title);
  const [project, repeated] = await Promise.all([
    service.confirmProjectImport({ previewId: create.id, name: '独立项目' }),
    service.confirmProjectImport({ previewId: create.id, name: '独立项目' }),
  ]);
  assert.equal(project.id, repeated.id);
  assert.equal(service.snapshot().projects.length, 1);
  const incoming = { ...contract(), servers: [{ url: 'https://incoming.example' }] };
  const route = incoming.paths['/items/{id}'];
  route.get.summary = '不应覆盖';
  const next = { ...incoming, paths: { '/items/{id}': { ...route, post: { ...route.get, summary: 'L007 新接口' } } } };
  const add = await service.previewProjectImport({ source: fileSource(next), targetId: project.id });
  const stale = await service.previewProjectImport({ source: fileSource(next), targetId: project.id });
  assert.deepEqual([add.added, add.skipped, add.operationCount], [1, 1, 2]);
  assert.equal(service.detail(project.id).operations.length, 1);
  await service.confirmProjectImport({ previewId: add.id });
  await assert.rejects(service.confirmProjectImport({ previewId: stale.id }), /项目已更新/);
  assert.equal(service.operation(project.id, 'GET /items/{id}').summary, 'L003');
  assert.deepEqual(service.operation(project.id, 'GET /items/{id}').servers, original.servers);
  assert.deepEqual(service.operation(project.id, 'POST /items/{id}').servers, incoming.servers);
  const conflict = { ...next, components: { schemas: { Item: { type: 'number' } } },
    paths: { '/another/{id}': next.paths['/items/{id}'] } };
  await assert.rejects(service.previewProjectImport({ source: fileSource(conflict), targetId: project.id }), /契约定义冲突/);
  assert.equal(service.detail(project.id).operations.length, 2);
});

test('路径引用链可列出接口；循环路径引用和外部/缺失引用被拒绝', () => {
  const document: any = contract();
  const original = document.paths['/items/{id}'];
  document.paths = { '/linked': { $ref: '#/components/pathItems/first' } };
  document.components.pathItems = { first: { $ref: '#/components/pathItems/second' }, second: original };
  assert.equal(apiOperations(parseApiDocument(JSON.stringify(document)))[0].path, '/linked');
  document.components.pathItems.second = { $ref: '#/components/pathItems/first' };
  assert.throws(() => parseApiDocument(JSON.stringify(document)), /循环/);
  for (const reference of ['./schemas.json', 'https://example.test/schema', '#/missing']) {
    const invalid: any = contract(); invalid.components.schemas.Item = { $ref: reference };
    assert.throws(() => parseApiDocument(JSON.stringify(invalid)), /\$ref/);
  }
});

test('认证例子不进入目录，但 schema 字段名与文案保持原样', () => {
  const document: any = contract();
  const operation = document.paths['/items/{id}'].get;
  operation.parameters.push({ name: 'Authorization', in: 'header', description: 'LHEADER', example: 'Bearer fixture-header', schema: { type: 'string', default: 'fixture-default' } });
  operation.requestBody = { content: { 'application/json': { schema: { type: 'object', properties: { password: { type: 'string', description: 'LPASS', example: 'fixture-schema' } } }, example: { username: 'fixture-user', password: 'fixture-password', accessToken: 'fixture-token', nested: { 'api-key': 'fixture-api-key' } } } } };
  const parsed = parseApiDocument(JSON.stringify(document));
  const serialized = JSON.stringify(parsed);
  assert.doesNotMatch(serialized, /fixture-header|fixture-default|fixture-schema|fixture-password|fixture-token|fixture-api-key/);
  assert.match(serialized, /fixture-user/);
  assert.match(serialized, /LHEADER|LPASS/);
  assert.equal(parsed.paths['/items/{id}'].get.requestBody.content['application/json'].schema.properties.password.type, 'string');
});

test('Swagger 2 支持参数、Body、响应和环境转换展示', () => {
  const document = parseApiDocument(JSON.stringify({ swagger: '2.0', info: { title: 'Legacy', version: '1' }, host: 'api.example.test', basePath: '/v2', schemes: ['https'],
    paths: { '/items': { post: { parameters: [{ in: 'query', name: 'search', type: 'string' }, { in: 'body', name: 'body', required: true, schema: { $ref: '#/definitions/Item' } }], responses: { '200': { description: 'OK', schema: { $ref: '#/definitions/Item' } } } } } },
    definitions: { Item: { type: 'object', properties: { id: { type: 'integer' } } } } }));
  const detail = apiOperationDetail(document, 'POST /items');
  assert.equal(detail.parameters.length, 1);
  assert.equal((detail.requestBody as any).content['application/json'].schema.properties.id.type, 'integer');
  assert.equal((detail.responses['200'] as any).content['application/json'].schema.type, 'object');
  assert.deepEqual(detail.servers, [{ url: 'https://api.example.test/v2' }]);
});

test('不同项目相同接口不会混淆，重新加载仍保留；并发创建不丢失', async t => {
  const { service, directory } = await setup(t);
  const [a, b] = await Promise.all([imported(service, '项目 A', contract('A')), imported(service, '项目 B', contract('B'))]);
  assert.notEqual(a.id, b.id);
  assert.equal(service.detail(a.id).project.name, '项目 A');
  assert.equal(service.detail(b.id).project.description, 'L002 原始说明');
  const second: any = contract(); second.paths['/items/{id}'].get.summary = 'B 项目专属';
  await service.import(b.id, { ...input(second), expectedUpdatedAt: b.updatedAt });
  assert.equal(service.operation(a.id, 'GET /items/{id}').summary, 'L003');
  const reloaded = await createInterfaceCenter(path.join(directory, 'state'));
  assert.equal(reloaded.snapshot().projects.length, 2);
  assert.equal(reloaded.operation(b.id, 'GET /items/{id}').summary, 'B 项目专属');
});

test('重复导入无重复接口；坏文件/过期预览不覆盖已有内容', async t => {
  const { service } = await setup(t), project = await imported(service, 'A');
  const preview = service.preview(project.id, input(contract()));
  assert.deepEqual([preview.added, preview.updated, preview.removed], [0, 0, 0]);
  const after = await service.import(project.id, { ...input(contract()), expectedUpdatedAt: preview.expectedUpdatedAt });
  assert.equal(after.operationCount, 1);
  await assert.rejects(service.import(project.id, { ...input(contract()), expectedUpdatedAt: preview.expectedUpdatedAt }), /重新预览/);
  const before = service.detail(project.id);
  await assert.rejects(service.import(project.id, { content: 'openapi: [', filename: 'bad.yaml', expectedUpdatedAt: after.updatedAt }), /解析/);
  assert.deepEqual(service.detail(project.id), before);
});

test('预览统计接口增改删，包含共享 schema、继承参数和环境变更', async t => {
  const { service } = await setup(t), project = await imported(service, 'A');
  for (const mutate of [
    (document: any) => { document.components.schemas.Item.properties.name.type = 'integer'; },
    (document: any) => { document.paths['/items/{id}'].parameters[0].description = '新参数'; },
    (document: any) => { document.servers = [{ url: 'https://test.example.test' }]; },
    (document: any) => { document.security = [{ bearer: [] }]; },
  ]) {
    const changed = contract(); mutate(changed);
    const preview = service.preview(project.id, input(changed));
    assert.equal(preview.updated, 1); assert.equal(preview.added, 0); assert.equal(preview.removed, 0);
  }
  const changed: any = contract(); changed.paths = { '/new': { post: { responses: { '201': { description: 'Created' } } } } };
  const preview = service.preview(project.id, input(changed));
  assert.deepEqual([preview.added, preview.updated, preview.removed], [1, 0, 1]);
});

test('损坏的持久化目录报错并保留原文件', async t => {
  const { directory } = await setup(t), file = path.join(directory, 'state', 'catalog.json');
  await fs.writeFile(file, '{broken');
  await assert.rejects(createInterfaceCenter(path.dirname(file)), /原文件已保留/);
  assert.equal(await fs.readFile(file, 'utf8'), '{broken');
});

test('仓库按固定提交读取多个项目，忽略脏工作树、重复格式且幂等导入', async t => {
  const { service, directory } = await setup(t), repository = path.join(directory, 'repository');
  await fs.mkdir(repository);
  const run = promisify(execFile);
  const git = async (...args: string[]) => (await run('git', ['-C', repository, ...args])).stdout.trim();
  await git('init', '-b', 'feature/fixture');
  for (const name of ['alpha', 'beta']) {
    await fs.mkdir(path.join(repository, name));
    await fs.writeFile(path.join(repository, name, 'openapi.yaml'), stringify(contract(name)));
  }
  await fs.writeFile(path.join(repository, 'alpha', 'openapi.json'), JSON.stringify(contract('Generated duplicate')));
  await git('add', '.'); await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', '测试契约');
  const args = { repositoryPath: repository, ref: 'HEAD' };
  const preview = await service.previewRepository(args);
  assert.equal(preview.projects.length, 2);
  assert.deepEqual(preview.projects.map(item => item.name), ['alpha', 'beta']);
  await fs.writeFile(path.join(repository, 'alpha', 'openapi.yaml'), 'broken working tree');
  const result = await service.importRepository({ ...args, commit: preview.commit });
  assert.equal(result.projects.length, 2);
  assert.ok(result.projects.every(item => item.source.commit === preview.commit));
  await service.importRepository({ ...args, commit: preview.commit });
  assert.equal(service.snapshot().projects.length, 2);
  assert.equal(await fs.readFile(path.join(repository, 'alpha', 'openapi.yaml'), 'utf8'), 'broken working tree');
  await git('add', '.'); await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', '移动测试版本');
  await assert.rejects(service.importRepository({ ...args, commit: preview.commit }), /版本已变化/);
  assert.equal(service.snapshot().projects.length, 2);
  const previous = result.projects.find(item => item.source.file === 'alpha/openapi.yaml')!;
  const updated = contract('alpha');
  updated.paths['/items/{id}'].get.summary = 'L_SYNC_FROM_GIT';
  await fs.writeFile(path.join(repository, 'alpha', 'openapi.yaml'), stringify(updated));
  await git('add', '.');
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', '来源接口更新');
  const change = await service.previewProjectImport({
    source: { ...args, kind: 'repository', file: 'alpha/openapi.yaml' }, sync: true, targetId: previous.id,
  });
  assert.deepEqual([change.create, change.added, change.sync?.updated, change.sync?.removed], [false, 0, 1, 0]);
  assert.equal(service.detail(previous.id).operations[0]?.summary, 'L003');
  assert.equal((await service.confirmProjectImport({ previewId: change.id })).id, previous.id);
  assert.equal(service.detail(previous.id).operations[0]?.summary, 'L_SYNC_FROM_GIT');
  assert.equal(service.snapshot().projects.length, 2);
});

test('拉取指定远端契约分支后可预览新提交，工作树、暂存区和其他引用不变', async t => {
  const { service, directory } = await setup(t);
  const remote = path.join(directory, 'remote'), repository = path.join(directory, 'local');
  await fs.mkdir(remote);
  const run = promisify(execFile);
  const git = async (cwd: string, ...args: string[]) => (await run('git', ['-C', cwd, ...args])).stdout.trim();
  const commit = async (title: string) => {
    await fs.writeFile(path.join(remote, 'openapi.json'), JSON.stringify(contract(title)));
    await git(remote, 'add', 'openapi.json');
    await git(remote, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', title);
    return git(remote, 'rev-parse', 'HEAD');
  };
  await git(remote, 'init', '-b', 'main');
  const first = await commit('旧契约');
  await git(remote, 'branch', 'dev');
  await git(directory, 'clone', '--branch', 'main', remote, repository);
  const args = { repositoryPath: repository, ref: 'origin/dev' };
  assert.equal((await service.previewRepository(args)).commit, first);
  await commit('其他分支更新');
  await git(remote, 'switch', 'dev');
  const latest = await commit('新契约');
  const localFile = path.join(repository, 'openapi.json');
  await fs.writeFile(localFile, 'staged change');
  await git(repository, 'add', 'openapi.json');
  await fs.writeFile(localFile, 'unstaged change');
  assert.equal((await service.previewRepository(args)).commit, first);

  const fetched = await service.fetchRepository(args);
  assert.equal(fetched.commit, latest);
  assert.equal(fetched.ref, 'refs/remotes/origin/dev');
  assert.equal(fetched.projects[0].name, '新契约');
  const preview = await service.previewProjectImport({
    source: { kind: 'repository', repositoryPath: fetched.repositoryPath, ref: fetched.ref, commit: fetched.commit, file: 'openapi.json' },
    sync: true,
  });
  assert.equal(preview.title, '新契约');
  assert.deepEqual(service.snapshot().projects, []);
  assert.equal(await git(repository, 'rev-parse', 'HEAD'), first);
  assert.equal(await git(repository, 'rev-parse', 'refs/remotes/origin/main'), first);
  assert.equal(await git(repository, 'show', ':openapi.json'), 'staged change');
  assert.equal(await fs.readFile(localFile, 'utf8'), 'unstaged change');
  await assert.rejects(service.fetchRepository({ ...args, ref: 'HEAD' }), /请指定远端分支/);
  await assert.rejects(service.fetchRepository({ ...args, ref: 'origin/missing' }), /远端没有分支/);
  await git(repository, 'symbolic-ref', 'refs/remotes/origin/alias', 'refs/heads/main');
  await assert.rejects(service.fetchRepository({ ...args, ref: 'origin/alias' }), /指向其他分支/);
});

test('HTTP 目录限制本机同源，写入需要明确 header，读取不会执行外部请求', async t => {
  const { service } = await setup(t);
  const io = { port: 0, json(response: http.ServerResponse, status: number, value: unknown) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); },
    async body(request: http.IncomingMessage, limit = 1000) { let body = ''; for await (const chunk of request) { body += chunk; if (body.length > limit) throw new Error('请求内容过大'); } return JSON.parse(body || '{}'); } };
  const route = createInterfaceCenterRoutes(service, io);
  const server = http.createServer(async (request, response) => { if (!await route(request, response, new URL(request.url || '/', `http://127.0.0.1:${io.port}`))) { response.writeHead(404); response.end(); } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  io.port = (server.address() as { port: number }).port;
  t.after(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }));
  const origin = `http://127.0.0.1:${io.port}`, url = `${origin}/api/interface-center`;
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await fetch(url, { headers: { Origin: 'https://unrelated.example' } })).status, 403);
  const request = { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'HTTP 项目' }) };
  assert.equal((await fetch(`${url}/projects`, request)).status, 403);
  const created = await fetch(`${url}/projects`, { ...request, headers: { ...request.headers, 'X-Delivery-Confirmed': 'yes' } });
  assert.equal(created.status, 201);
  const project = await created.json();
  assert.equal((await fetch(`${url}/projects/${project.id}`)).status, 200);
  assert.equal((await fetch(`${url}/repository/preview`)).status, 404);
});
