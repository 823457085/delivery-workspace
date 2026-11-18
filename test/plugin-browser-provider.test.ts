import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCustomPluginRuntime } from '../server/plugins/custom-runtime.js';
import { createWorkspaceTodos } from '../server/workspace-todos.js';
import { createPluginApplications } from '../server/plugins/applications.js';
import { applicationManifest } from './plugin-application-fixture.js';

async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-provider-'));
  const runtime = await createCustomPluginRuntime(path.join(root, 'data'), await createWorkspaceTodos(path.join(root, 'todos')));
  const apps = createPluginApplications(runtime, async () => {});
  t.after(async () => { await apps.close(); await runtime.close(); await fs.rm(root, {recursive: true, force: true}); });
  async function install(id = 'test-browser', endpoint = 'ws://127.0.0.1:43897/secret-ticket', grant = true) {
    const directory = path.join(root, id); await fs.mkdir(directory);
    const manifest = {...applicationManifest(), id, compatibility: {protocol: 1, sdk: '2.2.1'},
      permissions: ['storage.read', 'application.local', 'browser.provide'],
      provides: [{name: 'browser.connection', version: 1, methods: ['browser/session']}]};
    await fs.writeFile(path.join(directory, 'plugin.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(directory, 'ui.js'), ''); await fs.writeFile(path.join(directory, 'ui.css'), '');
    await fs.writeFile(path.join(directory, 'server.mjs'), `export function createPlugin(){return {async request(method,input,context){
      if(method==='context')return context;
      if(method==='wait'){await new Promise(r=>setTimeout(r,200));return true;}
      if(method==='browser/session'){if(context?.source!=='host')throw Error('host only');return {verified:true,endpoint:${JSON.stringify(endpoint)}};}
    }}}`);
    const preview = await runtime.inspect(directory);
    await runtime.install({directory, digest: preview.digest, grants: manifest.permissions.filter(p => grant || p !== 'browser.provide'), confirmed: true, trustedLocalCode: true});
    return id;
  }
  return {root, runtime, apps, install};
}

test('提供者按公开声明与当前授权选择；无插件与可选权限拒绝可降级', async t => {
  const f = await fixture(t);
  assert.equal(await f.apps.browserSession(), undefined);
  const id = await f.install('independent-browser', undefined, false);
  assert.deepEqual(await f.apps.call(id, {method: 'context'}), {source: 'page'});
  assert.equal(await f.apps.browserSession(), undefined);
  await f.runtime.change(id, {grants: ['storage.read','application.local','browser.provide']});
  assert.equal(await f.apps.browserSession(), 'ws://127.0.0.1:43897/secret-ticket');
  await f.runtime.change(id, {showInMenu: false});
  assert.ok(await f.apps.browserSession(), '隐藏菜单不停止连接');
  await f.install('another-browser');
  await assert.rejects(f.apps.browserSession(), /多个/);
  await f.runtime.change(id, {enabled: false}); f.apps.stop(id);
  assert.ok(await f.apps.browserSession());
  await f.runtime.change('another-browser', {enabled: false}); f.apps.stop('another-browser');
  assert.equal(await f.apps.browserSession(), undefined);
});

test('页面与其他插件不可伪造宿主上下文取得通道', async t => {
  const f = await fixture(t), id = await f.install();
  assert.throws(() => f.apps.call(id, {method:'browser/session', context:{source:'host'}}));
  await assert.rejects(f.apps.call(id, {method:'browser/session', input:{source:'host'}}), /host only/);
  const caller = 'test-caller', directory = path.join(f.root, caller); await fs.mkdir(directory);
  await fs.writeFile(path.join(directory,'plugin.json'), JSON.stringify({...applicationManifest(), id:caller,
    permissions:['storage.read','application.local','capabilities.call'], consumes:[{name:'browser.connection',version:1,methods:['browser/session']}]}));
  await fs.writeFile(path.join(directory,'ui.js'),'');await fs.writeFile(path.join(directory,'ui.css'),'');
  await fs.writeFile(path.join(directory,'server.mjs'),'export function createPlugin(){return {request(){return true}}}');
  const preview=await f.runtime.inspect(directory);
  await f.runtime.install({directory,digest:preview.digest,grants:['storage.read','application.local','capabilities.call'],confirmed:true,trustedLocalCode:true});
  await assert.rejects(f.apps.capabilityCall(caller,{name:'browser.connection',version:1,method:'browser/session',input:{source:'host'}}),/host only/);
});

test('拒绝非本机能力地址；队列中撤权不执行通道请求', async t => {
  const f = await fixture(t);
  const id = await f.install('remote-browser', 'ws://example.com:9222/secret');
  await assert.rejects(f.apps.browserSession(), /本机连接地址无效/);
  const waiting = f.apps.call(id, {method:'wait'});
  const pending = f.apps.browserSession();
  const rejected = assert.rejects(pending, /未获授权|状态已变化/);
  await f.runtime.change(id, {grants:['storage.read','application.local']});
  await waiting; await rejected;
  assert.equal(await f.apps.browserSession(), undefined);
});

test('停用会使正在执行的提供者请求失效，不能复活旧实例', async t => {
  const f = await fixture(t), id = await f.install();
  await f.apps.call(id,{method:'context'});
  const waiting = f.apps.call(id,{method:'wait'}), pending = f.apps.browserSession();
  const checked = [assert.rejects(waiting, /停止|状态已变化|停用/), assert.rejects(pending, /停止|状态已变化|停用/)];
  await f.runtime.change(id,{enabled:false}); f.apps.stop(id);
  await Promise.all(checked);
  assert.equal(await f.apps.browserSession(),undefined);
});

test('AI 轮次使用声明提供者的配置，端点仅写入私有配置且不进入回复', async t => {
  const {createCodexAdapter}=await import('../server/agent-runtime.js');
  const f=await fixture(t);await f.install();
  const previous=process.env.DELIVERY_AGENT_BROWSER_BIN;process.env.DELIVERY_AGENT_BROWSER_BIN=process.execPath;
  t.after(()=>{if(previous===undefined)delete process.env.DELIVERY_AGENT_BROWSER_BIN;else process.env.DELIVERY_AGENT_BROWSER_BIN=previous;});
  const peer=path.join(f.root,'mock-codex.mjs');
  await fs.writeFile(peer,`#!/usr/bin/env node
import {createInterface} from 'node:readline';
let config;const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const {id,method,params}=JSON.parse(line);
 if(method==='initialize')send({id,result:{}});
 if(method==='thread/start'){config=params.config;send({id,result:{thread:{id:'browser-provider-test'}}});}
 if(method==='turn/start'){
  send({id,result:{turn:{id:'turn-provider-test'}}});
  send({method:'item/completed',params:{threadId:'browser-provider-test',turnId:'turn-provider-test',item:{type:'agentMessage',text:JSON.stringify(config)}}});
  send({method:'turn/completed',params:{threadId:'browser-provider-test',turn:{id:'turn-provider-test',status:'completed'}}});
 }
});`,{mode:0o700});
  const adapter=createCodexAdapter(peer,f.root,()=>f.apps.browserSession());
  const events:string[]=[];
  const result=await adapter.execute({run:{id:'browser-provider-test',provider:'codex',mode:'ask',accessMode:'workspace',model:'',reasoningEffort:'',objective:'mock browser integration',workspacePath:f.root,branch:'',headSha:'',status:'running',sessionId:'',pid:null,result:'',error:'',events:[],createdAt:'',updatedAt:''},imagePaths:[],fileAttachments:[],signal:new AbortController().signal,onPid(){},onSession(){},onEvent(_type,message){events.push(message);}});
  const server=JSON.parse(result)['mcp_servers.delivery_browser'];assert.ok(server);
  const config=JSON.parse(await fs.readFile(server.env.AGENT_BROWSER_CONFIG,'utf8'));
  assert.equal(config.cdp,'ws://127.0.0.1:43897/secret-ticket');assert.equal(config.pinTab,true);assert.equal(config.profile,undefined);
  assert.equal(result.includes('secret-ticket'),false);assert.equal(events.some(e=>e.includes('secret-ticket')),false);
  assert.ok(events.some(e=>e.includes('已配置任务浏览器通道')));
  await fs.rm(server.env.AGENT_BROWSER_SOCKET_DIR,{recursive:true,force:true});
});
