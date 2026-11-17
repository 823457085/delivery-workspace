import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createConversationWorkspaces,createConversationWorkspaceRoutes} from '../server/conversation-workspaces.js';
import {conversationWorkspaceGroups,reorderConversationWorkspaces} from '../src/features/agent-workbench/conversation-workspaces.js';
import type {AgentConversation} from '../src/features/agent-workbench/conversation.js';
async function fixture(t:any){const root=await fs.mkdtemp(path.join(os.tmpdir(),'conversation-workspaces-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const file=path.join(root,'groups.json');return {root,file,store:await createConversationWorkspaces(file)};}
test('工作区多项目、排序和任务归属持久化；移动不修改任务执行目录',async t=>{
 const f=await fixture(t);let s=await f.store.update({action:'save',revision:0,workspace:{name:'业务',projectPaths:['/repo/a','/repo/b','/repo/a']}});
 const a=s.workspaces[0];assert.deepEqual(a.projectPaths,['/repo/a','/repo/b']);
 s=await f.store.update({action:'save',revision:s.revision,workspace:{name:'支持',projectPaths:[]}});const b=s.workspaces[1];
 s=await f.store.update({action:'assign',revision:s.revision,conversationId:'chat',workspaceId:b.id});
 s=await f.store.update({action:'reorder',revision:s.revision,ids:[b.id,a.id]});
 assert.deepEqual((await createConversationWorkspaces(f.file)).read(),s);
 const conversation={id:'chat',latest:{workspacePath:'/runtime/original',sourceWorkspacePath:'/repo/a'},runs:[{workspaceId:a.id}]} as AgentConversation;
 const before=structuredClone(conversation);assert.equal(conversationWorkspaceGroups(s,[conversation])[0].conversations[0].id,'chat');assert.deepEqual(conversation,before);
 s=await f.store.update({action:'assign',revision:s.revision,conversationId:'chat',workspaceId:''});
 assert.equal(conversationWorkspaceGroups(s,[conversation]).at(-1)!.conversations.length,1);
});
test('旧项目默认工作区幂等生成，不覆盖已编辑名称和多项目设置',async t=>{
 const f=await fixture(t);const seed={action:'seed',workspaces:[{id:'project:/repo/a',name:'a',projectPaths:['/repo/a']}]};let s=await f.store.update(seed);
 s=await f.store.update({action:'save',revision:s.revision,workspace:{...s.workspaces[0],name:'新名称',projectPaths:['/repo/a','/repo/b']}});
 assert.deepEqual(await f.store.update(seed),s);
 const c={id:'old',latest:{workspacePath:'/runtime/x',sourceWorkspacePath:'/repo/a'},runs:[]} as unknown as AgentConversation;
 assert.equal(conversationWorkspaceGroups(s,[c])[0].conversations.length,1);
});
test('拒绝过期写入、无效移动和排序；失败不污染状态',async t=>{
 const f=await fixture(t);const s=await f.store.update({action:'save',revision:0,workspace:{name:'a',projectPaths:['/repo/a']}});
 await assert.rejects(f.store.update({action:'save',revision:0,workspace:{name:'b',projectPaths:[]}}),/其他页面/);
 await assert.rejects(f.store.update({action:'assign',revision:s.revision,conversationId:'chat',workspaceId:'missing'}),/不存在/);
 await assert.rejects(f.store.update({action:'reorder',revision:s.revision,ids:[]}),/排序/);
 await assert.rejects(f.store.update({action:'save',revision:s.revision,workspace:{name:'b',projectPaths:['relative']}}));assert.deepEqual(f.store.read(),s);
 assert.deepEqual(reorderConversationWorkspaces(['a','b','c'],'c','a'),['c','a','b']);
 assert.deepEqual(reorderConversationWorkspaces(['a','b','c'],'a','c'),['b','c','a']);
 assert.deepEqual(reorderConversationWorkspaces(['a','b'],'a','a'),['a','b']);
});
test('并发写入仅接受相同版本中的一个，拒绝外源写入',async t=>{
 const f=await fixture(t);const results=await Promise.allSettled([1,2].map(n=>f.store.update({action:'save',revision:0,workspace:{name:String(n),projectPaths:[]}})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 let status=0,readBody=false;const route=createConversationWorkspaceRoutes(f.store,{port:5599,json:(_r,s)=>{status=s;},body:async()=>{readBody=true;return {};}});
 await route({method:'POST',socket:{remoteAddress:'127.0.0.1'},headers:{host:'localhost:5599',origin:'https://untrusted.example','content-type':'application/json','x-delivery-confirmed':'yes'}} as any,{} as any,new URL('http://localhost:5599/api/conversation-workspaces'));
 assert.equal(status,403);assert.equal(readBody,false);
});
