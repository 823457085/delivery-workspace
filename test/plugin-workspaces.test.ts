import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCustomPluginRuntime } from '../server/plugins/custom-runtime.js';
import { createWorkspaceTodos } from '../server/workspace-todos.js';
import { createPluginApplications } from '../server/plugins/applications.js';
import { applicationManifest } from './plugin-application-fixture.js';

async function fixture(t:any) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'plugin-workspaces-'));
 const runtime=await createCustomPluginRuntime(path.join(root,'data'),await createWorkspaceTodos(path.join(root,'todos')));
 const source=path.join(root,'package');await fs.mkdir(source);
 const manifest={...applicationManifest(),compatibility:{protocol:1,sdk:'2.2.0'},background:{method:'tick',intervalSeconds:60},permissions:['storage.read','application.local','workspaces.read','workspaces.cleanup','background.run']};
 await fs.writeFile(path.join(source,'plugin.json'),JSON.stringify(manifest));await fs.writeFile(path.join(source,'ui.js'),'');await fs.writeFile(path.join(source,'ui.css'),'');
 await fs.writeFile(path.join(source,'server.mjs'),`export function createPlugin(host){let ticks=0;return {request(method,input){if(method==='tick'){ticks++;return host.workspaces.list();}if(method==='ticks')return ticks;return host.workspaces[method](input);}}}`);
 let reads=0,deletes=0;let beforeRemove=async()=>{};
 const apps=createPluginApplications(runtime,async()=>{},()=>({
  pluginInventory:async()=>{reads++;return [{path:'/fixture',sessions:[],eligible:true,managed:true,lastUsedAt:new Date().toISOString()}] as any;},
  preview:async(path:string)=>({path,revision:'revision',eligible:true,canSchedule:false}),
  removeSessionWorkspace:async(input:any,guard:()=>void)=>{await beforeRemove();guard();deletes++;return {path:input.path,deleted:true};}
 }));
 t.after(async()=>{await apps.close();await runtime.close();await fs.rm(root,{recursive:true,force:true});});
 const preview=await runtime.inspect(source);
 await runtime.install({directory:source,digest:preview.digest,grants:manifest.permissions,confirmed:true,trustedLocalCode:true});
 return {runtime,apps,id:manifest.id,permissions:manifest.permissions,reads:()=>reads,deletes:()=>deletes,beforeRemove:(action:()=>Promise<void>)=>{beforeRemove=action;}};
}

test('公开工作区 IPC 按插件权限与当前实例校验；执行前撤权不产生删除',async t=>{
 const f=await fixture(t);
 assert.equal((await f.apps.call(f.id,{method:'list'}) as any[])[0].path,'/fixture');
 await f.runtime.change(f.id,{grants:['storage.read','application.local','workspaces.read']});
 await assert.rejects(f.apps.call(f.id,{method:'remove',input:{path:'/fixture'}}),/未获授权/);assert.equal(f.deletes(),0);
 await f.runtime.change(f.id,{grants:f.permissions});
 f.beforeRemove(async()=>{await f.runtime.change(f.id,{grants:['storage.read','application.local','workspaces.read']});});
 await assert.rejects(f.apps.call(f.id,{method:'remove',input:{path:'/fixture'}}),/未获授权/);assert.equal(f.deletes(),0);
 await f.runtime.change(f.id,{enabled:false});f.apps.stop(f.id);
 assert.throws(()=>f.apps.call(f.id,{method:'list'}),/停用/);
});
test('后台调用遵循间隔、启停与授权；隐藏菜单不停止后台任务',async t=>{
 const f=await fixture(t);await f.apps.runBackground(100000);assert.equal(f.reads(),1);
 await f.apps.runBackground(100001);assert.equal(f.reads(),1);
 await f.runtime.change(f.id,{showInMenu:false});await f.apps.runBackground(160001);assert.equal(f.reads(),2);
 await f.runtime.change(f.id,{grants:f.permissions.filter(p=>p!=='background.run')});await f.apps.runBackground(220002);assert.equal(f.reads(),2);
 await f.runtime.change(f.id,{grants:f.permissions,enabled:false});f.apps.stop(f.id);await f.apps.runBackground(280003);assert.equal(f.reads(),2);
 await f.runtime.change(f.id,{enabled:true});await f.apps.runBackground(340004);assert.equal(f.reads(),3);
 await f.apps.close();await f.apps.runBackground(400005);assert.equal(f.reads(),3);
});
test('排队后台调用在撤权后不执行',async t=>{
 const f=await fixture(t);
 let release!:()=>void, entered!:()=>void;
 const holding=new Promise<void>(resolve=>{release=resolve;});
 const reached=new Promise<void>(resolve=>{entered=resolve;});
 f.beforeRemove(async()=>{entered();await holding;});
 const pending=f.apps.call(f.id,{method:'remove',input:{path:'/fixture'}});
 await reached;
 const background=f.apps.runBackground();
 await f.runtime.change(f.id,{grants:f.permissions.filter(p=>p!=='background.run')});
 release();await pending;await background;
 assert.equal(f.reads(),0);assert.equal(f.deletes(),1);
 const read=await f.apps.call(f.id,{method:'access'}) as any;assert.equal(read.background,false);assert.equal(read.cleanup,true);
});
