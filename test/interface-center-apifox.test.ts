import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApifoxConnection, type ApifoxCredentials } from '../server/interface-center-apifox.js';
import { createInterfaceCenter } from '../server/interface-center.js';
import { apiOperations, parseApiDocument, type ApiDocument } from '../server/interface-center-document.js';
import type { ApiProject } from '../shared/interface-center.js';

const firstToken = 'fixture-first-token', nextToken = 'fixture-next-token';
const target = { teamId: '21', targetProjectId: '31' };
const project: ApiProject = { id: 'local-project', name: '本地接口', description: 'L_PROJECT', version: '1', openapi: '3.1.0',
  operationCount: 2, groups: [], source: { kind: 'manual', label: 'L_SOURCE' }, updatedAt: '2026-11-06T00:00:00.000Z' };
const contract = (entries: Record<string, string>): ApiDocument => parseApiDocument(JSON.stringify({ openapi: '3.1.0',
  info: { title: 'L_TITLE', version: '1' }, paths: Object.fromEntries(Object.entries(entries).map(([url, summary]) => [url,
    { get: { summary, description: 'L_DESCRIPTION', responses: { '200': { description: 'L_RESPONSE' } } } }])) }));
const localDocument = () => contract({ '/shared': 'L_LOCAL', '/local': '本地新增接口' });
type Call = { url: URL; method: string; headers: Headers; body?: any };
function memoryCredentials() {
  let value: string | undefined, deletes = 0;
  const sets: string[] = [];
  const credentials: ApifoxCredentials = { get: async () => value, set: async token => { sets.push(token); value = token; },
    delete: async () => { deletes++; value = undefined; } };
  return { credentials, sets, get value() { return value; }, get deletes() { return deletes; } };
}
function fakeApifox() {
  const calls: Call[] = [];
  const remote = {
    account: { id: 11, username: 'L_ACCOUNT' }, teams: [{ id: 21, name: 'L_TEAM' }],
    projects: [{ id: 31, name: 'L_REMOTE_PROJECT', description: 'L_REMOTE_DESCRIPTION' }],
    document: contract({ '/shared': 'L_REMOTE', '/remote': '远端独有接口' }),
    counters: { endpointCreated: 1, endpointUpdated: 0, endpointFailed: 0 } as Record<string, unknown>,
    identityFailure: '', importFailure: '', failExportAt: 0, exportCount: 0, skipImport: false,
    beforeExport: undefined as ((count: number) => Promise<void> | void) | undefined,
  };
  const respond = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.apifox.com');
    const call: Call = { url, method: init?.method || 'GET', headers: new Headers(init?.headers),
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) };
    calls.push(call);
    if (url.pathname === '/api/v1/current-user') return remote.identityFailure
      ? respond({ success: false, message: remote.identityFailure }, 401) : respond({ success: true, data: remote.account });
    if (url.pathname === '/api/v1/user-teams') return respond({ success: true, data: remote.teams });
    if (/^\/api\/v1\/teams\/\d+\/projects$/.test(url.pathname)) return respond({ success: true, data: url.pathname.includes('/21/') ? remote.projects : [] });
    if (url.pathname === '/v1/projects/31/export-openapi') {
      const count = ++remote.exportCount;
      await remote.beforeExport?.(count);
      if (count === remote.failExportAt) return respond({ success: false, message: '回读失败' }, 503);
      return respond(remote.document);
    }
    if (url.pathname === '/v1/projects/31/import-openapi') {
      if (remote.importFailure) return respond({ success: false, message: remote.importFailure }, 503);
      if (!remote.skipImport) {
        const imported = JSON.parse(call.body.input) as ApiDocument;
        for (const [key, value] of Object.entries(imported.paths)) {
          if (!Object.hasOwn(remote.document.paths, key) || call.body.options.endpointOverwriteBehavior === 'OVERWRITE_EXISTING') {
            remote.document.paths[key] = structuredClone(value);
          }
        }
      }
      return respond({ success: true, data: { counters: remote.counters } });
    }
    throw new Error(`Unexpected fake Apifox endpoint: ${call.method} ${url.pathname}`);
  };
  return { request, calls, remote, imports: () => calls.filter(call => call.url.pathname.endsWith('/import-openapi')) };
}

test('从 Apifox 读取指定团队项目并创建本地目录，预览不创建项目也不写入远端', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'interface-apifox-pull-')), memory = memoryCredentials(), fake = fakeApifox();
  const center = await createInterfaceCenter(directory, { apifox: { credentials: memory.credentials, fetch: fake.request } });
  t.after(async () => { await center.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await center.apifox.connect({ token: firstToken });
  const source = { kind: 'apifox', teamId: '21', projectId: '31' };
  await assert.rejects(center.previewProjectImport({ source: { ...source, teamId: '22' } }), /不属于所选团队/);
  const preview = await center.previewProjectImport({ source });
  assert.equal(preview.added, 2);
  assert.equal(center.snapshot().projects.length, 0);
  const imported = await center.confirmProjectImport({ previewId: preview.id });
  assert.equal(imported.source.kind, 'apifox');
  assert.equal(center.operation(imported.id, 'GET /shared').summary, 'L_REMOTE');
  assert.equal(fake.remote.exportCount, 1);
  assert.equal(fake.imports().length, 0);
});

test('Apifox 来源可再次同步到同一个本地项目，忽略未使用的失效定义并回读来源绑定', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'interface-apifox-source-')), memory = memoryCredentials(), fake = fakeApifox();
  const options = { apifox: { credentials: memory.credentials, fetch: fake.request } };
  const center = await createInterfaceCenter(directory, options);
  t.after(async () => { await center.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await center.apifox.connect({ token: firstToken });
  const input = { source: { kind: 'apifox', teamId: '21', projectId: '31' }, sync: true };
  fake.remote.document.components = { requestBodies: { Invalid: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Missing' } } } } } };
  const first = await center.previewProjectImport(input);
  assert.equal(first.sync?.omittedRequestBodies, 1);
  const project = await center.confirmProjectImport({ previewId: first.id });
  assert.equal(project.source.apifoxProjectId, '31');
  assert.equal(fake.calls.find(call => call.url.pathname.endsWith('/export-openapi'))?.body.options.addFoldersToTags, true);
  assert.equal(Object.hasOwn(center.export(project.id).document.components.requestBodies, 'Invalid'), false);
  const reloaded = await createInterfaceCenter(directory, options);
  t.after(() => reloaded.close());
  assert.equal(reloaded.snapshot().projects[0]?.source.apifoxTeamId, '21');
  fake.remote.document = contract({ '/shared': 'L_UPDATED', '/new': 'L_NEW' });
  const updated = await reloaded.previewProjectImport(input);
  assert.deepEqual([updated.create, updated.added, updated.sync?.updated, updated.sync?.removed], [false, 1, 1, 1]);
  assert.equal(reloaded.operation(project.id, 'GET /remote').summary, '远端独有接口');
  assert.equal((await reloaded.confirmProjectImport({ previewId: updated.id })).id, project.id);
  assert.deepEqual(reloaded.detail(project.id).operations.map(item => item.summary), ['L_UPDATED', 'L_NEW']);
  fake.remote.document.components = { requestBodies: { Invalid: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Missing' } } } } } };
  fake.remote.document.paths['/shared'].get.requestBody = { $ref: '#/components/requestBodies/Invalid' };
  await assert.rejects(reloaded.previewProjectImport(input), /无法解析的内部/);
  assert.equal(reloaded.snapshot().projects.length, 1);
  assert.equal(fake.imports().length, 0);
});
async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'interface-apifox-')), memory = memoryCredentials(), fake = fakeApifox();
  const service = await createApifoxConnection(directory, { credentials: memory.credentials, fetch: fake.request });
  t.after(async () => { await service.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, memory, fake, service, connect: () => service.connect({ token: firstToken }) };
}

test('连接读取本人和团队原文，令牌只写入凭据存储，不进入状态文件或返回值', async t => {
  const f = await fixture(t), connected = await f.connect();
  assert.deepEqual(connected.account, { id: '11', name: 'L_ACCOUNT' });
  assert.deepEqual(connected.teams, [{ id: '21', name: 'L_TEAM' }]);
  assert.equal(connected.configured, true); assert.equal(f.memory.value, firstToken);
  assert.deepEqual(new Set(f.fake.calls.map(call => call.url.pathname)), new Set(['/api/v1/current-user', '/api/v1/user-teams']));
  assert.ok(f.fake.calls.every(call => call.method === 'GET' && call.headers.get('authorization') === `Bearer ${firstToken}`
    && call.headers.get('x-apifox-api-version') === '2026-05-28'));
  const saved = await fs.readFile(path.join(f.directory, 'apifox.json'), 'utf8');
  assert.equal(saved.includes(firstToken), false); assert.equal(JSON.stringify(connected).includes(firstToken), false);
  assert.equal((await fs.stat(path.join(f.directory, 'apifox.json'))).mode & 0o777, 0o600);
  const projects = await f.service.projects('21');
  assert.deepEqual(projects, [{ id: '31', name: 'L_REMOTE_PROJECT', description: 'L_REMOTE_DESCRIPTION', teamId: '21' }]);
  assert.equal(f.service.snapshot().preferredTeamId, '21');
  assert.equal(f.fake.imports().length, 0);
});

test('新令牌验证失败不会覆盖原连接，远端错误中的凭据被隐藏', async t => {
  const f = await fixture(t); await f.connect();
  const before = f.service.snapshot(), saved = await fs.readFile(path.join(f.directory, 'apifox.json'), 'utf8');
  f.fake.remote.identityFailure = `凭据 ${nextToken} 无效 Bearer ${nextToken}`;
  await assert.rejects(f.service.connect({ token: nextToken }), error => {
    assert.ok(error instanceof Error); assert.equal(error.message.includes(nextToken), false);
    assert.match(error.message, /已隐藏凭据/); return true;
  });
  assert.deepEqual(f.service.snapshot(), before); assert.equal(f.memory.value, firstToken);
  assert.deepEqual(f.memory.sets, [firstToken]);
  assert.equal(await fs.readFile(path.join(f.directory, 'apifox.json'), 'utf8'), saved);
});

test('新连接配置持久化失败恢复旧凭据和内存连接', async t => {
  const f = await fixture(t); await f.connect();
  const before = f.service.snapshot(), filename = path.join(f.directory, 'apifox.json');
  await fs.rename(filename, filename + '.original'); await fs.mkdir(filename);
  f.fake.remote.account = { id: 12, username: '另一个账号' };
  await assert.rejects(f.service.connect({ token: nextToken }));
  assert.equal(f.memory.value, firstToken); assert.deepEqual(f.service.snapshot(), before);
  assert.deepEqual(f.memory.sets, [firstToken, nextToken, firstToken]);
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ['apifox.json', 'apifox.json.original']);
});

test('新令牌已写入但凭据回读失败时，恢复原令牌和原连接', async t => {
  const f = await fixture(t); await f.connect();
  const before = f.service.snapshot(), filename = path.join(f.directory, 'apifox.json');
  const saved = await fs.readFile(filename, 'utf8'), set = f.memory.credentials.set;
  f.memory.credentials.set = async token => {
    await set(token);
    if (token === nextToken) throw new Error('模拟保存后回读失败');
  };
  f.fake.remote.account = { id: 12, username: '另一个账号' };
  await assert.rejects(f.service.connect({ token: nextToken }), /模拟保存后回读失败/);
  assert.equal(f.memory.value, firstToken);
  assert.deepEqual(f.service.snapshot(), before);
  assert.equal(await fs.readFile(filename, 'utf8'), saved);
  assert.deepEqual(f.memory.sets, [firstToken, nextToken, firstToken]);
});

test('同步预览核对所选团队和项目，只读取契约并统计新增、匹配、远端独有接口', async t => {
  const f = await fixture(t); await f.connect();
  await assert.rejects(f.service.preview(project, localDocument(), { teamId: '22', targetProjectId: '31' }), /不属于所选团队|无权访问/);
  await assert.rejects(f.service.preview(project, localDocument(), { teamId: '21', targetProjectId: '32' }), /不属于所选团队|无权访问/);
  const calls = f.fake.calls.length;
  await assert.rejects(f.service.preview(project, localDocument(), { teamId: '../21', targetProjectId: '31' }));
  assert.equal(f.fake.calls.length, calls); assert.equal(f.fake.remote.exportCount, 0);
  const preview = await f.service.preview(project, localDocument(), target);
  assert.deepEqual([preview.operationCount, preview.added, preview.matched, preview.remoteOnly], [2, 1, 1, 1]);
  assert.equal(preview.mode, 'keep'); assert.equal(preview.targetProject.teamId, '21');
  assert.equal(f.fake.imports().length, 0);
  const exported = f.fake.calls.find(call => call.url.pathname.endsWith('/export-openapi'))!;
  assert.equal(exported.headers.get('x-project-id'), '31'); assert.equal(exported.headers.get('x-apifox-api-version'), '2024-03-28');
  assert.deepEqual(exported.body.scope, { type: 'ALL' });
});

test('远端未使用的请求体缺失模型时仍可预览，并保留完整远端变化检查', async t => {
  const f = await fixture(t); await f.connect();
  const document = localDocument();
  const body = { content: { 'application/json': { schema: { $ref: '#/components/schemas/IdRequest' } } } };
  f.fake.remote.document.components = { requestBodies: { IdRequest: body } };
  assert.throws(() => parseApiDocument(JSON.stringify(f.fake.remote.document)), /无法解析的内部/);

  const preview = await f.service.preview(project, document, target);
  assert.equal(preview.unusedRequestBodyRefs, 1);
  assert.deepEqual([preview.added, preview.matched, preview.remoteOnly], [1, 1, 1]);
  f.fake.remote.document.components.requestBodies.IdRequest.description = '预览后已修改';
  await assert.rejects(f.service.sync(() => ({ project, document }), { previewId: preview.id }), /契约已变化/);

  f.fake.remote.document.paths['/shared'].get.requestBody = { $ref: '#/components/requestBodies/Id%52equest' };
  await assert.rejects(f.service.preview(project, document, target), /目标项目.*无法解析的内部/);
  assert.equal(f.fake.imports().length, 0);
});

for (const mode of ['keep', 'overwrite'] as const) test(`${mode} 同步沿用导入选项，保留远端独有接口并回读目录`, async t => {
  const f = await fixture(t); await f.connect(); const document = localDocument();
  const preview = await f.service.preview(project, document, { ...target, mode });
  const result = await f.service.sync(() => ({ project, document }), { previewId: preview.id });
  const imported = f.fake.imports(); assert.equal(imported.length, 1);
  const behavior = mode === 'keep' ? 'KEEP_EXISTING' : 'OVERWRITE_EXISTING';
  assert.deepEqual(imported[0].body.options, { endpointOverwriteBehavior: behavior, schemaOverwriteBehavior: behavior,
    deleteUnmatchedResources: false, updateFolderOfChangedEndpoint: false, prependBasePath: false });
  assert.equal(JSON.parse(imported[0].body.input).paths['/shared'].get.summary, 'L_LOCAL');
  assert.equal(f.fake.remote.document.paths['/shared'].get.summary, mode === 'keep' ? 'L_REMOTE' : 'L_LOCAL');
  assert.equal(f.fake.remote.document.paths['/remote'].get.summary, '远端独有接口');
  assert.equal(result.verified, true); assert.equal(result.missing, 0);
  assert.equal(result.projectId, '31'); assert.equal(f.fake.remote.exportCount, 3);
  assert.equal(f.fake.calls.some(call => call.method === 'DELETE'), false);
  assert.equal(JSON.stringify(result).includes(firstToken), false);
});

test('本地契约变化使预览失效，且远端读取期间发生的本地变化也会在写入前拦截', async t => {
  const f = await fixture(t); await f.connect(); let document = localDocument();
  const readSource = () => ({ project, document });
  let preview = await f.service.preview(project, document, target);
  document = contract({ '/shared': '已变更', '/local': '本地新增接口' });
  await assert.rejects(f.service.sync(readSource, { previewId: preview.id }), /本地契约已变化|账号或本地契约已变化/);
  preview = await f.service.preview(project, document, target);
  const nextExport = f.fake.remote.exportCount + 1;
  f.fake.remote.beforeExport = count => { if (count === nextExport) document = contract({ '/changed-during-await': '网络请求期间变化' }); };
  await assert.rejects(f.service.sync(readSource, { previewId: preview.id }), /本地契约已变化/);
  assert.equal(f.fake.imports().length, 0);
});

test('远端契约改动或项目权限变化后拒绝使用旧预览写入', async t => {
  const f = await fixture(t); await f.connect(); const document = localDocument();
  let preview = await f.service.preview(project, document, target);
  f.fake.remote.document.paths['/shared'].get.summary = '远端同时修改';
  await assert.rejects(f.service.sync(() => ({ project, document }), { previewId: preview.id }), /Apifox 契约已变化/);
  preview = await f.service.preview(project, document, target);
  f.fake.remote.projects = [];
  await assert.rejects(f.service.sync(() => ({ project, document }), { previewId: preview.id }), /目标项目已变化或无权访问/);
  assert.equal(f.fake.imports().length, 0);
});

test('同一预览并发或重复提交只导入一次，不能挪给另一个本地项目', async t => {
  const f = await fixture(t); await f.connect(); const document = localDocument(), readSource = () => ({ project, document });
  const preview = await f.service.preview(project, document, target), input = { previewId: preview.id };
  const [first, second] = await Promise.all([f.service.sync(readSource, input), f.service.sync(readSource, input)]);
  assert.deepEqual(second, first); assert.equal(first.verified, true); assert.equal(f.fake.imports().length, 1);
  assert.deepEqual(await f.service.sync(readSource, input), first); assert.equal(f.fake.imports().length, 1);
  await assert.rejects(f.service.sync(() => ({ project: { ...project, id: 'other-project' }, document }), input), /同步项目不匹配/);
});

test('导入 HTTP 失败不返回成功，也不重复使用已经提交过的预览', async t => {
  const f = await fixture(t); await f.connect(); const document = localDocument();
  const preview = await f.service.preview(project, document, target), input = { previewId: preview.id };
  f.fake.remote.importFailure = '导入未完成';
  await assert.rejects(f.service.sync(() => ({ project, document }), input), /导入未完成/);
  await assert.rejects(f.service.sync(() => ({ project, document }), input), /预览已失效/);
  assert.equal(f.fake.imports().length, 1); assert.equal(f.fake.remote.document.paths['/local'], undefined);
});

test('导入后的回读失败返回 verified=false，重试同一预览只返回原结果', async t => {
  const f = await fixture(t); await f.connect(); const document = localDocument();
  const preview = await f.service.preview(project, document, target), input = { previewId: preview.id };
  f.fake.remote.failExportAt = 3;
  const result = await f.service.sync(() => ({ project, document }), input);
  assert.equal(result.verified, false); assert.equal(result.missing, 2); assert.match(result.message, /回读未完成/);
  assert.equal(f.fake.imports().length, 1);
  f.fake.remote.failExportAt = 0;
  assert.deepEqual(await f.service.sync(() => ({ project, document }), input), result);
  assert.equal(f.fake.imports().length, 1); assert.equal(f.fake.remote.exportCount, 3);
});

for (const failure of ['missing-endpoint', 'failed-counter', 'no-counters'] as const) test(`导入返回 200 但 ${failure} 时不会宣称同步已核实`, async t => {
  const f = await fixture(t); await f.connect(); const document = localDocument();
  const preview = await f.service.preview(project, document, target);
  if (failure === 'missing-endpoint') f.fake.remote.skipImport = true;
  if (failure === 'failed-counter') f.fake.remote.counters.endpointFailed = 1;
  if (failure === 'no-counters') f.fake.remote.counters = { notNumeric: '2', negative: -1 };
  const result = await f.service.sync(() => ({ project, document }), { previewId: preview.id });
  assert.equal(result.verified, false); assert.equal(result.missing, failure === 'missing-endpoint' ? 1 : 0);
  if (failure === 'no-counters') assert.deepEqual(result.counters, {});
  assert.equal(f.fake.imports().length, 1);
});

test('断开连接清除凭据和预览，重新连接也不能沿用旧预览', async t => {
  const f = await fixture(t); await f.connect(); const document = localDocument();
  await f.service.projects('21'); const preview = await f.service.preview(project, document, target);
  const disconnected = await f.service.disconnect();
  assert.equal(f.memory.value, undefined); assert.equal(f.memory.deletes, 1);
  assert.equal(disconnected.configured, false); assert.equal(disconnected.account, undefined); assert.deepEqual(disconnected.teams, []);
  const saved = JSON.parse(await fs.readFile(path.join(f.directory, 'apifox.json'), 'utf8'));
  assert.deepEqual(saved, { version: 1, preferredTeamId: '21' });
  await assert.rejects(f.service.projects('21'), /请先连接/);
  await f.connect();
  await assert.rejects(f.service.sync(() => ({ project, document }), { previewId: preview.id }), /预览已失效/);
  assert.equal(f.fake.imports().length, 0);
});

test('账号身份变化后刷新使旧预览失效', async t => {
  const f = await fixture(t); await f.connect(); const document = localDocument();
  const preview = await f.service.preview(project, document, target);
  f.fake.remote.account = { id: 12, username: '另一个账号' };
  assert.equal((await f.service.refresh()).account?.id, '12');
  await assert.rejects(f.service.sync(() => ({ project, document }), { previewId: preview.id }), /预览已失效/);
  assert.equal(f.fake.imports().length, 0);
});

test('接口目录服务在远端核对期间重新导入本地契约时，同步读取最新来源并拒绝旧预览', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'interface-apifox-integration-')), memory = memoryCredentials(), fake = fakeApifox();
  const center = await createInterfaceCenter(directory, { apifox: { credentials: memory.credentials, fetch: fake.request } });
  t.after(async () => { await center.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await center.apifox.connect({ token: firstToken });
  const created = await center.create({ name: '真实目录服务夹具' });
  const initial = { content: JSON.stringify(localDocument()), filename: 'fixture.json' };
  const importPreview = center.preview(created.id, initial);
  await center.import(created.id, { ...initial, expectedUpdatedAt: importPreview.expectedUpdatedAt });
  const preview = await center.previewApifox(created.id, target);
  fake.remote.beforeExport = async count => {
    if (count !== 2) return;
    const changed = { content: JSON.stringify(contract({ '/new-source': '新契约' })), filename: 'changed.json' };
    const pending = center.preview(created.id, changed);
    await center.import(created.id, { ...changed, expectedUpdatedAt: pending.expectedUpdatedAt });
  };
  await assert.rejects(center.syncApifox(created.id, { previewId: preview.id }), /本地契约已变化/);
  assert.deepEqual(center.detail(created.id).operations.map(item => item.key), ['GET /new-source']);
  assert.equal(fake.imports().length, 0); assert.equal(apiOperations(fake.remote.document).length, 2);
});
