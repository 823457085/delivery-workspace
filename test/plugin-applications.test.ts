import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCustomPluginRuntime } from '../server/plugins/custom-runtime.js';
import { createWorkspaceTodos } from '../server/workspace-todos.js';
import { createPluginApplications } from '../server/plugins/applications.js';
import { registeredWorkspaceSections } from '../src/pages/agent/workspace-navigation.js';
import { integrationCatalog } from '../shared/integration-plugins.js';
import { createCustomPluginRoutes } from '../server/plugins/custom-routes.js';

async function fixture(t: any) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-app-')));
  const todos = await createWorkspaceTodos(path.join(root, 'todos'));
  const runtime = await createCustomPluginRuntime(path.join(root, 'plugins'), todos);
  const opened: string[] = [];
  const apps = createPluginApplications(runtime, async (app, directory) => { opened.push(`${app}:${directory}`); });
  t.after(async () => { await apps.close(); await runtime.close(); await fs.rm(root, { force: true, recursive: true }); });
  async function install(directory: string) {
    const preview = await runtime.inspect(directory);
    await runtime.install({ directory, digest: preview.digest, grants: preview.manifest.permissions, confirmed: true, trustedLocalCode: true, showInMenu: true });
    return preview;
  }
  return { root, runtime, apps, install, opened, todos };
}

test('application package uses generic installation, explicit native trust, pinned assets and isolated host capabilities', async t => {
  const f = await fixture(t), source = path.join(f.root, 'package');
  await fs.mkdir(source);
  const manifest = JSON.parse(await fs.readFile('plugins/go-learning/plugin.json', 'utf8'));
  manifest.id = 'another-application'; manifest.name = '独立示例';
  await fs.writeFile(path.join(source, 'plugin.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(source, 'ui.js'), 'window.sample=true;');
  await fs.writeFile(path.join(source, 'ui.css'), 'body{color:blue}');
  await fs.writeFile(path.join(source, 'server.mjs'), `export function createPlugin(host) {return {request: async (method) => {if(method === 'wait') await new Promise(r=>setTimeout(r,30000)); return { ...host, secret:process.env.JIRA_AUTH_HEADER, result:'original' };}}}`);
  const preview = await f.runtime.inspect(source);
  const input = {directory:source,digest:preview.digest,grants:manifest.permissions,confirmed:true};
  await assert.rejects(f.runtime.install(input), /明确确认/);
  await fs.appendFile(path.join(source, 'ui.js'), '\n// changed');
  await assert.rejects(f.runtime.install({...input,trustedLocalCode:true}), /内容已变化/);
  await f.install(source);
  await fs.writeFile(path.join(source, 'server.mjs'), `throw new Error('source must not be executed')`);
  const old = process.env.JIRA_AUTH_HEADER; process.env.JIRA_AUTH_HEADER = 'not-for-plugin';
  try {
    const result: any = await f.apps.call(manifest.id, {method:'read'});
    assert.equal(result.result,'original'); assert.equal(result.secret,undefined);
    assert.ok(result.workspaceDirectory.startsWith(path.join(f.root,'plugins','data',manifest.id)));
    await f.apps.open(manifest.id,{app:'terminal',workspacePath:result.workspaceDirectory});
    assert.equal(f.opened.length,1);
    await assert.rejects(f.apps.open(manifest.id,{app:'terminal',workspacePath:f.root}), /只能使用/);
    const draft = await f.apps.compose(manifest.id,{prompt:'只填入草稿',workspacePath:result.workspaceDirectory});
    assert.equal(draft.prompt,'只填入草稿');
    await f.runtime.change(manifest.id,{grants:['storage.read','application.local']});
    await assert.rejects(f.apps.compose(manifest.id,{prompt:'no'}), /未获授权/);
    const pending = f.apps.call(manifest.id,{method:'wait'});
    const rejection = assert.rejects(pending,/已停止|状态已变化|停用/);
    await f.runtime.change(manifest.id,{enabled:false}); f.apps.stop(manifest.id); await rejection;
    assert.throws(()=>f.apps.call(manifest.id,{method:'read'}), /停用/);
    await f.runtime.change(manifest.id,{enabled:true});
    assert.equal((await f.apps.call(manifest.id,{method:'read'}) as any).result,'original');
    const entry=f.runtime.applicationEntry(manifest.id);
    await fs.writeFile(path.join(entry.packageDirectory,'ui.js'),'tampered');
    await assert.rejects(f.apps.page(manifest.id), /损坏/);
  } finally { if(old===undefined)delete process.env.JIRA_AUTH_HEADER;else process.env.JIRA_AUTH_HEADER=old; }
});

test('Go package is absent from integrations; install, real Go run, saved progress and remove/restore use the custom host only', async t => {
  const f = await fixture(t), source=path.resolve('plugins/go-learning/package');
  assert.equal(integrationCatalog.some(p=>p.id==='go-learning'),false);
  const preview=await f.install(source);
  assert.equal(registeredWorkspaceSections([],f.runtime.list().plugins).some(p=>p.id==='custom:go-learning'),true);
  const overview:any=await f.apps.call('go-learning',{method:'overview'});
  assert.equal(overview.days.length,7);
  assert.ok(overview.sandboxPath.startsWith(path.join(f.root,'plugins','data','go-learning')));
  const run:any=await f.apps.call('go-learning',{method:'sandbox/run',input:{action:'run'}});
  if(overview.environment.installed) { assert.equal(run.result.exitCode,0); assert.match(run.result.stdout,/TaskMgr|任务/); }
  else assert.equal(run.result.exitCode,-1);
  await f.apps.call('go-learning',{method:'progress',input:{note:{day:1,content:'custom plugin note'}}});
  const saved:any=await f.apps.call('go-learning',{method:'overview'});
  assert.equal(saved.progress.notes['1'],'custom plugin note');
  if (overview.environment.installed && process.platform !== 'win32') {
    await f.apps.call('go-learning',{method:'sandbox/save-file',input:{filePath:'main.go',content:'package main\nimport ("os"; "strconv"; "time")\nfunc main(){os.WriteFile("process.pid",[]byte(strconv.Itoa(os.Getpid())),0600);time.Sleep(30*time.Second)}'}});
    const running = f.apps.call('go-learning',{method:'sandbox/run',input:{action:'run'}});
    const stopped = assert.rejects(running,/已停止/);
    let pid = 0;
    for(let n=0;n<150;n++) {try {pid=Number(await fs.readFile(path.join(overview.sandboxPath,'process.pid'),'utf8'));break;}catch{} await new Promise(r=>setTimeout(r,100));}
    assert.ok(pid>0,'Go child should have started');
    await f.runtime.change('go-learning',{enabled:false});f.apps.stop('go-learning');await stopped;
    let alive=true;
    for(let n=0;n<40;n++) {try {process.kill(pid,0);}catch{alive=false;break;}await new Promise(r=>setTimeout(r,100));}
    assert.equal(alive,false,'Stopping the plugin must also stop its detached Go process');
    await f.runtime.change('go-learning',{enabled:true});
  }
  await f.runtime.change('go-learning',{remove:true}); f.apps.stop('go-learning');
  await assert.rejects(f.apps.page('go-learning'),/移除/);
  await f.runtime.install({directory:source,digest:preview.digest,grants:preview.manifest.permissions,confirmed:true,trustedLocalCode:true});
  assert.equal((await f.apps.call('go-learning',{method:'overview'}) as any).progress.notes['1'],'custom plugin note');
});

test('application routes retain same-origin, confirmation and post-body capability checks', async t=>{
  const f=await fixture(t);await f.install(path.resolve('plugins/go-learning/package'));
  let status=0,value:any;let afterBody=async()=>{};
  const route=createCustomPluginRoutes(f.runtime,{} as any,{port:5317,applications:f.apps,examples:[],citations:()=>[],json(_r,s,v){status=s;value=v},async body(){await afterBody();return {method:'overview'}}});
  const req:any={method:'POST',socket:{remoteAddress:'127.0.0.1'},headers:{host:'localhost:5317',origin:'http://localhost:5317','content-type':'application/json','x-delivery-confirmed':'yes'}};
  const url=new URL('http://localhost:5317/api/custom-plugins/go-learning/application-call');
  await route({...req,headers:{...req.headers,origin:'https://evil.test'}},{} as any,url);assert.equal(status,403);
  await route({...req,headers:{...req.headers,'content-type':'text/plain'}},{} as any,url);assert.equal(status,415);
  afterBody=async()=>{await f.runtime.change('go-learning',{enabled:false})};
  await route(req,{} as any,url);assert.equal(status,400);assert.match(value.message,/停用/);
});
