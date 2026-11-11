import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createPluginStore, readPluginFile, applyPluginEnvironment } from '../server/plugins/store.mjs';
import { assertIntegrationRequest, assertIntegrationCapability } from '../server/plugins/definitions.mjs';
import { integrationAvailable, integrationCatalog } from '../shared/integration-plugins.js';
import { registeredWorkspaceSections, workspaceView, workspaceLocation, workspaceSections } from '../src/pages/agent/workspace-navigation.js';
import { createIntegrationRuntime } from '../server/plugins/integration-runtime.js';
import { createWecomIntegration } from '../server/wecom-integration.js';
import { integrationCatalogFixture } from './fixtures/integration-catalog.js';

test('legacy credentials survive immediate disable, remove, restart and restore without re-entry or copying secrets', async t => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-state-')); t.after(() => fs.rm(root, {recursive: true, force: true}));
 const file = path.join(root, 'plugins.json'), env: NodeJS.ProcessEnv = {JIRA_BASE_URL: 'https://jira.test', JIRA_COOKIE: 'original-private-cookie'};
 const store = await createPluginStore({file, env});
 assert.equal(integrationAvailable((await store.list())[0]), true);
 await store.save('jira', {enabled:true, baseUrl:'https://jira.test',username:'',token:''});
 assert.equal((await readPluginFile(file)).plugins.jira.baseUrl, undefined);
 assert.equal((await store.list())[0].restartRequired, false);
 await store.state('jira', {enabled: false});
 assert.equal(integrationAvailable((await store.list())[0]), false);
 assert.equal((await store.list())[0].restartRequired, false);
 assert.throws(() => assertIntegrationCapability('issues.read', env), /停用/);
 assert.throws(() => assertIntegrationRequest('/api/source/scan', env, 'POST'), /停用/);
 assert.throws(() => assertIntegrationRequest('/api/automation/dispatch', env, 'POST'), /停用/);
 assert.doesNotThrow(() => assertIntegrationRequest('/api/agent-runtimes/jira-fix', env, 'GET'));
 assert.throws(() => assertIntegrationRequest('/api/agent-runtimes/jira-fix', env, 'POST'), /停用/);
 await store.state('jira', {installed: false});
 assert.equal(env.JIRA_COOKIE, 'original-private-cookie');
 assert.doesNotMatch(await fs.readFile(file, 'utf8'), /original-private-cookie|JIRA_COOKIE/);
 const reloadedEnv = {...env}; applyPluginEnvironment(await readPluginFile(file), reloadedEnv);
 const reloaded = await createPluginStore({file, env: reloadedEnv});
 await reloaded.state('jira', {installed: true, enabled: true});
 assert.equal(integrationAvailable((await reloaded.list())[0]), true);
 assert.equal(reloadedEnv.JIRA_COOKIE, 'original-private-cookie');
 assert.equal(integrationAvailable((await reloaded.list())[1]), false, 'unconfigured provider has no active contributions');
 await reloaded.save('jira', {enabled: true, baseUrl: 'https://other.test', token: 'replacement'});
 assert.equal(reloadedEnv.JIRA_BASE_URL, 'https://jira.test', 'connection changes remain pending restart');
 assert.equal((await reloaded.list())[0].restartRequired, true);
 assert.doesNotMatch(JSON.stringify(await reloaded.list()), /original-private-cookie|replacement/);
});

test('core navigation has no vendor pages; registration restores every legacy view exactly once', () => {
 assert.equal(workspaceSections.flatMap(section => section.items).some(view => ['tasks','calendar','stats','jira-fix'].includes(view.id)), false);
 const disabled = registeredWorkspaceSections([]).flatMap(section => section.items);
 for (const manifest of integrationCatalog) for (const view of manifest.views) {
  assert.equal(disabled.some(item => item.id === view.id), false);
  assert.equal(workspaceView(view.id)?.pluginId, manifest.id);
  assert.equal(workspaceLocation(view.path, {task: 'DEMO-1'})?.query.task, 'DEMO-1');
 }
 for (let i = 0; i < 3; i++) {
  const active = registeredWorkspaceSections(['jira','confluence']).flatMap(section => section.items);
  for (const view of integrationCatalog[0].views) assert.equal(active.filter(item => item.id === view.id).length, 1);
  assert.equal(registeredWorkspaceSections([]).some(section => section.id === 'tasks'), false);
 }
 assert.equal(workspaceView('calendar')?.mode, 'calendar');
 assert.equal(workspaceView('stats')?.mode, 'stats');
});

test('registered Confluence routes retain scope, search, preview and fresh snapshots; disable blocks before remote calls', async t => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-route-')); t.after(() => fs.rm(root,{recursive:true,force:true}));
 const original = {...process.env};
 t.after(() => {for (const key of ['CONFLUENCE_BASE_URL','DELIVERY_PLUGIN_CONFLUENCE_ENABLED','DELIVERY_PLUGIN_CONFLUENCE_INSTALLED']) {if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];}});
 process.env.CONFLUENCE_BASE_URL = 'https://wiki.test/wiki'; process.env.DELIVERY_PLUGIN_CONFLUENCE_ENABLED = 'true'; delete process.env.DELIVERY_PLUGIN_CONFLUENCE_INSTALLED;
 let version = 1, calls = 0;
 const page = () => ({id:'42',type:'page',title:'原有技术方案',space:{key:'TEAM'},version:{number:version},body:{storage:{value:`<p>方案版本 ${version}</p>`}}});
 const source = {jiraIssueRequest: async () => {throw new Error('unexpected Jira');}, confluenceReadRequest: async (resource: string) => {calls++; return Response.json(resource.startsWith('content/search?') ? {results:[page()],_links:{}} : page());}};
 let runtime: ReturnType<typeof createIntegrationRuntime>;
 const server = http.createServer(async (req,res) => {if (!await runtime.route(req,res,new URL(req.url!, 'http://localhost'))) {res.writeHead(404);res.end();}});
 await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve)); const port = (server.address() as any).port;
 t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
 const host = {directory: root, source, port, json: (res: http.ServerResponse,status: number,value: unknown) => {res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));}, body: async (req: http.IncomingMessage) => {let text='';for await (const chunk of req) text+=chunk;return JSON.parse(text);}};
 runtime = createIntegrationRuntime(host); t.after(() => runtime.close());
 const base = `http://127.0.0.1:${port}`, endpoint = base+'/api/agent-runtimes/confluence/';
 const headers = {Origin:base, 'Content-Type':'application/json','X-Delivery-Confirmed':'yes'};
 assert.equal((await fetch(endpoint+'config',{method:'POST',headers:{...headers,Origin:'https://other.test'},body:'{}'})).status,403);
 const scope = {spaceKey:'TEAM',requirementParentId:'',designParentId:''};
 assert.equal((await fetch(endpoint+'config',{method:'POST',headers,body:JSON.stringify({workspacePath:root,scope})})).status,200);
 assert.deepEqual((await (await fetch(endpoint+'config?workspacePath='+encodeURIComponent(root))).json()).scope,scope);
 const search = await (await fetch(endpoint+'search?q=方案&workspacePath='+encodeURIComponent(root))).json();
 assert.equal(search.pages[0].title,'原有技术方案'); const reference = search.pages[0].reference;
 const preview = await (await fetch(endpoint+'page?reference='+encodeURIComponent(reference))).json(); assert.equal(preview.version,1);
 version = 2; const snapshot = await runtime.resolveKnowledge('@'+reference); assert.match(snapshot,/方案版本 2/);
 const before = calls; process.env.DELIVERY_PLUGIN_CONFLUENCE_ENABLED = 'false';
 assert.equal((await fetch(endpoint+'search')).status,400);
 await assert.rejects(runtime.resolveKnowledge('@'+reference),/停用/); assert.equal(calls,before);
 process.env.DELIVERY_PLUGIN_CONFLUENCE_ENABLED = 'true';
 assert.equal((await fetch(endpoint+'search')).status,200); assert.match(snapshot,/方案版本 2/);
 await runtime.close(); runtime = createIntegrationRuntime(host);
 assert.deepEqual((await (await fetch(endpoint+'config?workspacePath='+encodeURIComponent(root))).json()).scope,scope);
});

test('integration gateway preserves multipart upload protocol and confirmation guards', async () => {
 let calls = 0, code = 0;
 const host = {directory: '/unused', port: 5199, source: {jiraIssueRequest: async () => Response.json({}), confluenceReadRequest: async () => Response.json({})}, json: (_res: any,status: number) => {code=status;}, body: async () => ({})};
 const runtime = createIntegrationRuntime(host, [() => ({id:'jira',contentTypes:['application/json','multipart/form-data'],matches: () => true,route: async () => {calls++;return true;},close: async () => {}})]);
 const request = {method:'POST',socket:{remoteAddress:'127.0.0.1'},headers:{host:'127.0.0.1:5199',origin:'http://127.0.0.1:5199','x-delivery-confirmed':'yes','content-type':'multipart/form-data; boundary=fixture'}} as unknown as http.IncomingMessage;
 await runtime.route(request, {} as http.ServerResponse, new URL('http://localhost/api/jira/issues/DEMO-1'));
 assert.equal(calls,1,'multipart must reach original Jira upload handler');
 request.headers['x-delivery-confirmed'] = '';
 await runtime.route(request, {} as http.ServerResponse, new URL('http://localhost/api/jira/issues/DEMO-1'));
 assert.equal(code,403); assert.equal(calls,1);
});

test('WeCom plugin status gates sending from the configured integration catalog', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wecom-plugin-catalog-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { DELIVERY_PLUGIN_WECOM_ENABLED: enabled, DELIVERY_PLUGIN_WECOM_INSTALLED: installed } = process.env;
  t.after(() => {
    if (enabled === undefined) delete process.env.DELIVERY_PLUGIN_WECOM_ENABLED;
    else process.env.DELIVERY_PLUGIN_WECOM_ENABLED = enabled;
    if (installed === undefined) delete process.env.DELIVERY_PLUGIN_WECOM_INSTALLED;
    else process.env.DELIVERY_PLUGIN_WECOM_INSTALLED = installed;
  });
  process.env.DELIVERY_PLUGIN_WECOM_INSTALLED = 'true';
  process.env.DELIVERY_PLUGIN_WECOM_ENABLED = 'true';
  let sends = 0;
  const service = await createWecomIntegration(directory, {
    configFile: path.join(directory, 'credentials', 'wecom.json'),
    catalog: integrationCatalogFixture,
    fetch: async () => { sends++; return Response.json({ errcode: 0 }); },
  });
  await service.configure({ groupName: '测试群', webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture-only' });
  const input = {
    interfaceId: 'fixture-merchant', summary: '接口反馈', environment: 'fixture',
    parameters: '{}', actual: '缺少字段', expected: '返回字段', contractReference: '测试契约', traceId: '',
  };
  const preview = service.preview(input);
  assert.equal(preview.canSend, true);
  process.env.DELIVERY_PLUGIN_WECOM_ENABLED = 'false';
  assert.equal(service.preview(input).canSend, false);
  await assert.rejects(service.send({ input: preview.input, hash: preview.hash }), /停用/);
  assert.equal(sends, 0);
  process.env.DELIVERY_PLUGIN_WECOM_ENABLED = 'true';
  assert.equal((await service.send({ input: preview.input, hash: preview.hash })).record.status, 'sent');
  assert.equal(sends, 1);
});
