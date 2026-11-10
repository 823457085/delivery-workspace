import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createSystemCatalog, createSystemCatalogRoutes, parseProjectSystems, parseSystemAccounts } from '../server/system-catalog.js';
import { repositoryKey, systemWebUrl } from '../shared/system-catalog.js';

const site = 'https://wiki.example.test';
const config = { projectsPage: '101', accountsPage: '102', repository: 'https://gitlab.example.test/demo/multilingual-management' };
const source = { id: '101', title: '项目资料', url: 'https://wiki.example.test/pages/101', version: 3 };
const markdown = (branch = 'develop') => `<ac:structured-macro ac:name="markdown"><ac:plain-text-body><![CDATA[
## 原始系统名称 L0001
| 环境 | 分支 | 项目地址 | 流水线 | 备注 |
| --- | --- | --- | --- | --- |
| 开发 | ${branch} | <https://dev.example.test/> | 原始流水线 | node20 |
| 多语言测试 | i8n-test | https://i18n.example.test/ | 测试自行部署 | - |
**代码仓库**: https://git.example.test/org/repo.git
]]></ac:plain-text-body></ac:structured-macro>`;
const domestic = `<h1>国内系统</h1><table><tr><th>环境</th><th>分支</th><th>项目地址</th><th>流水线</th><th>备注</th></tr>
<tr><td>生产</td><td>prod</td><td><a href="https://test.example.test/">https://prod.example.test/</a></td><td>原始发布文案</td><td>需要配置 host</td></tr></table>
<p><strong>代码仓库</strong>: <a href="https://git.example.test/other/repo">https://git.example.test/other/repo</a></p>
<h1>品牌小程序</h1><table><tr><th>分支</th><th>对应商家</th><th>备注</th></tr><tr><td>master-brand</td><td>原始商家名称</td><td></td></tr></table>`;
const credentials = `<p>开发测试 <a href="https://dev.example.test/screen">https://dev.example.test/screen</a><br/>account@example.test sample-password<br/>partial@example.test</p>
<p>其他平台 <a href="https://tools.example.test/">https://tools.example.test/</a><br/>账号：tool-user<br/>密码：tool-password</p>`;

test('保留 Markdown/HTML 的原始字段、分支、链接差异及无网址的小程序', () => {
  const systems = parseProjectSystems(markdown(), source, '海外');
  assert.equal(systems[0].name, '原始系统名称 L0001');
  assert.equal(systems[0].repository, 'https://git.example.test/org/repo.git');
  assert.equal(systems[0].environments[0].url, 'https://dev.example.test/');
  assert.equal(systems[0].environments[1].branch, 'i8n-test');
  assert.equal(systems[0].environments[0].id, parseProjectSystems(markdown('feature/new'), source, '海外')[0].environments[0].id);
  const html = parseProjectSystems(domestic, { ...source, id: '103' }, '国内');
  assert.equal(html.length, 2);
  assert.equal(html[0].environments[0].url, 'https://prod.example.test/');
  assert.equal(html[0].environments[0].sourceHref, 'https://test.example.test/');
  assert.equal(html[0].environments[0].pipeline, '原始发布文案');
  assert.equal(html[1].environments[0].name, '原始商家名称');
  assert.equal(html[1].environments[0].url, '');
});

test('账号按文档段落读取，支持多个账号、缺少密码和明确字段', () => {
  const groups = parseSystemAccounts(credentials, source.url);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].accounts.map(account => [account.username, account.password]), [['account@example.test', 'sample-password'], ['partial@example.test', '']]);
  assert.equal(groups[1].accounts[0].password, 'tool-password');
  assert.equal(groups[1].accounts[0].sourceUrl, source.url);
});

test('仓库只按完整主机及组织匹配，入口拒绝脚本和内嵌凭据', () => {
  assert.equal(repositoryKey('git@git.example.test:org/repo.git'), repositoryKey('https://git.example.test/org/repo'));
  assert.equal(repositoryKey('ssh://git@git.example.test/org/repo.git'), repositoryKey('https://git.example.test/org/repo.git'));
  assert.notEqual(repositoryKey('https://git.example.test/org/repo'), repositoryKey('https://git.example.test/other/repo'));
  assert.equal(systemWebUrl('javascript:alert(1)'), '');
  assert.equal(systemWebUrl('https://user:password@example.test/'), '');
  assert.equal(repositoryKey('/local/path/repo.git'), '');
});

test('本机项目按环境追加，重试去重，冲突整批拒绝，Confluence 同步保留项目与账号', async t => {
  const { directory, service, request, readProjects } = await setup(t);
  await service.sync();
  const development = { name: '本机录入', region: '国内', environment: '开发', branch: 'develop', url: 'https://local.example.test/',
    repository: 'https://git.example.test/team/local', notes: '' } as const;
  const testing = { ...development, environment: '测试', branch: 'test', url: 'https://local-test.example.test/', repository: '' };
  const rows = [development, testing];
  assert.equal(service.previewProjects(rows).added, 2);
  assert.equal((await service.list()).localSystems, undefined);
  const added = await service.saveProjects({ rows });
  const project = added.catalog.localSystems![0];
  assert.equal(added.systemId, project.id);
  assert.equal(project.environments.length, 2);
  const env = project.environments[0];
  await service.save({ environmentId: env.id, accounts: [{ username: 'fixture', password: 'local-secret' }] });
  const duplicate = await service.saveProjects({ rows });
  assert.equal(duplicate.added, 0);
  assert.equal(duplicate.skipped, 2);
  await assert.rejects(service.saveProjects({ rows: [{ ...development, name: '整批不落盘' }, { ...testing, branch: 'conflict' }] }), /内容不同/);
  await assert.rejects(service.saveProjects({ rows: [{ ...testing, environment: '预发布', url: 'https://name:password@example.test/' }] }), /不含账号密码/);
  const synced = await service.sync();
  assert.equal(synced.systems.some(item => item.id === project.id), false);
  assert.equal(synced.localSystems?.length, 1);
  assert.equal(synced.localSystems?.[0].environments[0].accounts[0].hasPassword, true);
  assert.doesNotMatch(JSON.stringify(synced), /local-secret/);
  await service.close();
  const reloaded = await createSystemCatalog(directory, request, site, readProjects, config);
  assert.equal((await reloaded.list()).localSystems?.[0].id, project.id);
  assert.equal(reloaded.reveal(env.id).accounts[0].password, 'local-secret');
});

test('删除导航项目后同步和重启不恢复，重新录入本机项目不带回旧账号', async t => {
  const { directory, service, request, readProjects } = await setup(t);
  const initial = await service.list();
  const synced = initial.systems.find(system => system.name === '多语言管理平台')!;
  const survivor = initial.systems.find(system => system.id !== synced.id)!;
  const rows = [{ name: '本机测试项目', region: '其他', environment: '测试', branch: 'test', url: '',
    repository: '', notes: '' }];
  const added = await service.saveProjects({ rows });
  const localEnv = added.catalog.localSystems![0].environments[0];
  await service.save({ environmentId: localEnv.id, accounts: [{ username: 'fixture', password: 'removed-secret' }] });

  const afterLocal = await service.removeProject({ systemId: added.systemId });
  assert.equal(afterLocal.localSystems, undefined);
  assert.throws(() => service.reveal(localEnv.id), /环境不存在/);
  const afterSynced = await service.removeProject({ systemId: synced.id });
  assert.deepEqual(afterSynced.systems.map(system => system.id), [survivor.id]);
  assert(!afterSynced.sources.some(source => source.id === synced.source.id));
  assert.throws(() => service.reveal(synced.environments[0].id), /环境不存在/);
  await assert.rejects(service.removeProject({ systemId: 'unknown' }), /项目不存在/);
  await service.close();

  const reloaded = await createSystemCatalog(directory, request, site, readProjects, config);
  assert.deepEqual((await reloaded.list()).systems.map(system => system.id), [survivor.id]);
  assert.deepEqual((await reloaded.sync()).systems.map(system => system.id), [survivor.id]);
  assert.deepEqual(reloaded.reveal(survivor.environments[0].id).accounts.length, 2);
  assert.doesNotMatch(await fs.readFile(path.join(directory, 'catalog.json'), 'utf8'), /removed-secret/);
  await reloaded.saveProjects({ rows });
  assert.deepEqual(reloaded.reveal(localEnv.id).accounts, []);
});

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'system-catalog-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, 'workspace');
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'README.md'), '# multilingual-management\n\n## 环境信息\n\n| 环境 | 访问地址 | 分支名 |\n| --- | --- | --- |\n| 测试环境 | https://language-test.example.test/ | `test` |\n| 预发环境 | https://language-pre.example.test/ | `pre` |\n| 生产环境 | https://language.example.test/ | `prod` |\n\n## Getting started\n');
  const readProjects = async () => ({ projects: [{ path: workspace,
    remoteUrl: 'git@gitlab.example.test:demo/multilingual-management.git',
    webUrl: 'https://gitlab.example.test/demo/multilingual-management' }] });
  let fail = false, branch = 'develop';
  const request = async (resource: string) => {
    const id = resource.match(/content\/(\d+)/)?.[1];
    if (fail) return new Response('', { status: 503 });
    return Response.json({ id, title: id === '102' ? '账号来源' : '项目来源', version: { number: 3 },
      body: { storage: { value: id === '101' ? markdown(branch) : id === '103' ? domestic : credentials } } });
  };
  const service = await createSystemCatalog(directory, request, site, readProjects, config);
  return { directory, service, request, readProjects, fail: () => { fail = true; }, branch: () => { branch = 'feature/new'; } };
}

test('真实服务数据流仅把账号摘要给列表，按域名精确关联且私有文件权限正确', async t => {
  const { service, directory } = await setup(t);
  const catalog = await service.list();
  assert.equal(catalog.systems.length, 2);
  assert(catalog.systems.every(system => system.region === '海外'));
  assert(!catalog.sources.some(source => source.id === '103'));
  const multilingual = catalog.systems.find(system => system.name === '多语言管理平台')!;
  assert.deepEqual(multilingual.environments.map(env => [env.branch, env.url]), [
    ['test', 'https://language-test.example.test/'], ['pre', 'https://language-pre.example.test/'], ['prod', 'https://language.example.test/'],
  ]);
  const system = catalog.systems.find(system => system.region === '海外')!;
  assert.equal(system.environments[0].accounts.length, 2);
  assert.equal(system.environments[1].accounts.length, 0);
  assert.doesNotMatch(JSON.stringify(catalog), /account@example|sample-password|tool-password|"username"|"password"/);
  assert.equal(service.reveal(system.environments[0].id).accounts[0].password, 'sample-password');
  assert.equal((await fs.stat(path.join(directory, 'catalog.json'))).mode & 0o777, 0o600);
  await assert.rejects(service.save({ environmentId: system.environments[0].id, accounts: [{ username: 'x', password: 'x', extra: true }] }));
});

test('本机账号在重新同步、分支更新和重新加载后保留，清空不会被文档重新填回', async t => {
  const { service, directory, request, readProjects, branch } = await setup(t);
  const env = (await service.list()).systems[0].environments[0];
  const saved = await service.save({ environmentId: env.id, accounts: [{ username: 'local-user', password: 'local-secret' }] });
  assert.doesNotMatch(JSON.stringify(saved), /local-user|local-secret/);
  branch(); await service.sync();
  assert.equal(service.reveal(env.id).accounts[0].username, 'local-user');
  const reloaded = await createSystemCatalog(directory, request, site, readProjects, config);
  assert.equal(reloaded.reveal(env.id).accounts[0].password, 'local-secret');
  await reloaded.save({ environmentId: env.id, accounts: [] });
  await reloaded.sync();
  assert.equal(reloaded.reveal(env.id).accounts.length, 0);
});

test('旧缓存自动收敛为海外系统并补齐多语言平台，已有本机账号保留', async t => {
  const { service, directory, request, readProjects } = await setup(t);
  const env = (await service.list()).systems[0].environments[0];
  await service.save({ environmentId: env.id, accounts: [{ username: 'preserved-user', password: 'preserved-secret' }] });
  const file = path.join(directory, 'catalog.json');
  const legacy = JSON.parse(await fs.readFile(file, 'utf8'));
  delete legacy.scope;
  legacy.catalog.systems = legacy.catalog.systems.filter((system: { name: string }) => system.name !== '多语言管理平台');
  legacy.catalog.systems.push(...parseProjectSystems(domestic, { ...source, id: '103' }, '国内'));
  await fs.writeFile(file, JSON.stringify(legacy));
  const reloaded = await createSystemCatalog(directory, request, site, readProjects, config);
  const catalog = await reloaded.list();
  assert.deepEqual(catalog.systems.map(system => system.name), ['原始系统名称 L0001', '多语言管理平台']);
  assert.equal(reloaded.reveal(env.id).accounts[0].password, 'preserved-secret');
});

test('同步失败保留已有目录和账号，不返回远端响应中的敏感正文', async t => {
  const { service, fail } = await setup(t);
  const before = await service.list();
  fail(); await assert.rejects(service.sync(), /HTTP 503/);
  assert.deepEqual(await service.list(), before);
});

test('账号接口限制本机、Host、Origin、显式标记和 HTTP 方法，响应禁止缓存', async t => {
  const { service } = await setup(t);
  const env = (await service.list()).systems[0].environments[0];
  const io = {
    port: 0,
    json(response: http.ServerResponse, status: number, value: unknown) { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); },
    async body(request: http.IncomingMessage) { let value = ''; for await (const chunk of request) value += chunk; return JSON.parse(value || '{}'); },
  };
  const route = createSystemCatalogRoutes(service, io);
  const server = http.createServer((request, response) => { void route(request, response, new URL(request.url!, 'http://localhost')).then(handled => { if (!handled) response.end(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  io.port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${io.port}`, url = base + '/api/systems/accounts/read';
  assert.equal((await fetch(url)).status, 405);
  const foreignHost = await new Promise<number | undefined>((resolve, reject) => {
    http.get(base + '/api/systems', { headers: { Host: `attacker.test:${io.port}` } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(foreignHost, 403);
  assert.equal((await fetch(base + '/api/systems', { headers: { Origin: 'https://attacker.test' } })).status, 403);
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 403);
  const response = await fetch(url, { method: 'POST', headers: { Origin: base, 'X-Delivery-Confirmed': 'yes', 'Content-Type': 'application/json' }, body: JSON.stringify({ environmentId: env.id }) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal((await response.json()).accounts[0].password, 'sample-password');
});

test('账号读回版本随真实记录变化，串行写锁内拒绝并发旧版本并保留已保存记录', async t => {
  const { service, directory, request, readProjects } = await setup(t);
  const catalog = await service.list(), environments = catalog.systems[0].environments;
  const first = service.reveal(environments[0].id) as ReturnType<typeof service.reveal> & { revision?: string };
  const other = service.reveal(environments[1].id) as typeof first;
  assert.match(first.revision || '', /^[a-f0-9]{64}$/);
  assert.notEqual(first.revision, other.revision, '版本绑定环境，不借用另一个空环境的版本');
  assert.notEqual(other.revision, service.reveal(catalog.systems[1].environments[0].id).revision, '两个空环境也有各自版本');
  assert.equal(first.revision, (service.reveal(environments[0].id) as typeof first).revision);
  const filename = path.join(directory, 'catalog.json');
  const outcomes = await Promise.allSettled([
    service.save({ environmentId: environments[0].id, expectedRevision: first.revision,
      accounts: [{ username: 'newer-fixture', password: 'kept-fixture' }] }),
    service.save({ environmentId: environments[0].id, expectedRevision: first.revision,
      accounts: [{ username: 'stale-fixture', password: 'must-not-overwrite-fixture' }] }),
  ]);
  assert.equal(outcomes[0].status, 'fulfilled');
  assert.equal(outcomes[1].status, 'rejected');
  if (outcomes[1].status === 'rejected') assert.equal(outcomes[1].reason.message, '账号已更新，请重新读取后再保存');
  const current = service.reveal(environments[0].id) as typeof first;
  assert.deepEqual(current.accounts.map(account => account.username), ['newer-fixture']);
  assert.notEqual(current.revision, first.revision);
  const persisted = await fs.readFile(filename, 'utf8');
  await assert.rejects(service.save({ environmentId: environments[0].id, expectedRevision: first.revision, accounts: [] }), /账号已更新/);
  assert.equal(await fs.readFile(filename, 'utf8'), persisted, '冲突不触碰持久记录');
  const reloaded = await createSystemCatalog(directory, request, site, readProjects, config);
  assert.equal((reloaded.reveal(environments[0].id) as typeof first).revision, current.revision);
  await reloaded.save({ environmentId: environments[0].id, accounts: [] });
  assert.equal(reloaded.reveal(environments[0].id).accounts.length, 0, '旧客户端不传版本仍兼容');
});

test('账号保存路由接受合法中文和最大JSON转义字段，版本冲突409且其他路由保留原字节上限', async t => {
  const { service } = await setup(t);
  const env = (await service.list()).systems[0].environments[0];
  const limits: { route: string; limit: number | undefined }[] = [];
  const io = {
    port: 0,
    json(response: http.ServerResponse, status: number, value: unknown) { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); },
    async body(request: http.IncomingMessage, limit?: number) {
      limits.push({ route: request.url || '', limit });
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const value = Buffer.concat(chunks);
      if (limit !== undefined && value.byteLength > limit) throw new Error('请求体超过限制');
      return JSON.parse(value.toString('utf8') || '{}');
    },
  };
  const route = createSystemCatalogRoutes(service, io);
  const server = http.createServer((request, response) => { void route(request, response, new URL(request.url!, 'http://localhost')); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  io.port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${io.port}`;
  const post = (action: string, value: unknown) => fetch(base + '/api/systems' + action, { method: 'POST',
    headers: { Origin: base, 'X-Delivery-Confirmed': 'yes', 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const read = await post('/accounts/read', { environmentId: env.id });
  const original = await read.json();
  assert.equal(read.status, 200);
  for (const characters of ['示', '\u0001']) {
    const input = { environmentId: env.id, expectedRevision: (service.reveal(env.id) as typeof original).revision,
      accounts: Array.from({ length: 20 }, (_, index) => ({ id: `fixture-${index}`, username: characters.repeat(500), password: characters.repeat(2000) })) };
    assert.ok(Buffer.byteLength(JSON.stringify(input)) > 60_000);
    const response = await post('/accounts/save', input);
    assert.equal(response.status, 200);
    assert.equal(service.reveal(env.id).accounts.length, 20);
    assert.equal(service.reveal(env.id).accounts[0].password.length, 2000);
    await response.body?.cancel();
  }
  assert.match(original.revision || '', /^[a-f0-9]{64}$/);
  const conflict = await post('/accounts/save', { environmentId: env.id, expectedRevision: original.revision, accounts: [] });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { message: '账号已更新，请重新读取后再保存' });
  assert.equal(service.reveal(env.id).accounts.length, 20);
  const synced = await post('/sync', {}); assert.equal(synced.status, 200); await synced.body?.cancel();
  assert.ok(limits.filter(item => item.route.endsWith('/save')).every(item => item.limit === 384 * 1024));
  assert.ok(limits.filter(item => !item.route.endsWith('/save')).every(item => item.limit === 60_000));
});
