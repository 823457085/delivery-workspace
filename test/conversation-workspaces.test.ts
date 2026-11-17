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

test('删除仅移除分组：显式及推导会话归入未分组，重载和迟到 seed 不复活',async t=>{
 const f=await fixture(t);
 const project=path.join(f.root,'project');await fs.mkdir(project);await fs.writeFile(path.join(project,'keep.txt'),'keep');
 const seed={action:'seed',workspaces:[{id:`project:${project}`,name:'项目',projectPaths:[project]}]};
 let s=await f.store.update(seed);const target=s.workspaces[0].id;
 s=await f.store.update({action:'save',revision:s.revision,workspace:{name:'另一个工作区',projectPaths:[project]}});
 const other=s.workspaces[1].id;
 for(const [conversationId,workspaceId] of [['explicit',target],['elsewhere',other]])s=await f.store.update({action:'assign',revision:s.revision,conversationId,workspaceId});
 const chats=['explicit','run-derived','legacy','elsewhere'].map(id=>({id,latest:{workspacePath:project,sourceWorkspacePath:project},runs:id==='run-derived'?[{workspaceId:target}]:[]})) as unknown as AgentConversation[];
 const before=structuredClone(chats);
 const oldRevision=s.revision;
 await assert.rejects(f.store.update({action:'remove',revision:s.revision,workspaceId:target,confirmed:false}));
 assert.deepEqual(f.store.read(),s,'未确认不改变任何状态');
 s=await f.store.update({action:'remove',revision:s.revision,workspaceId:target,confirmed:true});
 assert.deepEqual(s.workspaces.map(w=>w.id),[other]);assert.equal(s.assignments.explicit,'');
 const reloaded=await createConversationWorkspaces(f.file);
 assert.deepEqual(reloaded.read(),s);
 assert.deepEqual(await reloaded.update(seed),s,'迟到或旧客户端的 seed 不重建已删除工作区');
 const groups=conversationWorkspaceGroups(s,chats);
 assert.deepEqual(groups[0].conversations.map(c=>c.id),['elsewhere']);
 assert.deepEqual(groups.at(-1)!.conversations.map(c=>c.id),['explicit','run-derived','legacy']);
 assert.deepEqual(chats,before,'会话与执行目录不修改');
 assert.equal(await fs.readFile(path.join(project,'keep.txt'),'utf8'),'keep','不触碰项目文件');
 await assert.rejects(reloaded.update({action:'remove',revision:oldRevision,workspaceId:other,confirmed:true}),/其他页面/);
 await assert.rejects(reloaded.update({action:'remove',revision:s.revision,workspaceId:target,confirmed:true}),/不存在/);
 assert.deepEqual(reloaded.read(),s);
 s=await reloaded.update({action:'assign',revision:s.revision,conversationId:'run-derived',workspaceId:other});
 assert.deepEqual(conversationWorkspaceGroups(s,chats)[0].conversations.map(c=>c.id),['run-derived','elsewhere']);
});

test('删除自定义工作区后历史 run 不回退到项目分组，新工作区可继续使用相同项目',async t=>{
 const f=await fixture(t);
 let s=await f.store.update({action:'save',revision:0,workspace:{name:'业务',projectPaths:['/repo/a']}});
 const id=s.workspaces[0].id;
 s=await f.store.update({action:'remove',revision:s.revision,workspaceId:id,confirmed:true});
 s=await f.store.update({action:'save',revision:s.revision,workspace:{name:'新业务',projectPaths:['/repo/a']}});
 const chat={id:'chat',latest:{workspacePath:'/repo/a'},runs:[{workspaceId:id}]} as unknown as AgentConversation;
 const groups=conversationWorkspaceGroups(s,[chat]);assert.equal(groups.length,2);assert.equal(groups.at(-1)!.conversations[0].id,'chat');
 assert.notEqual(s.workspaces[0].id,id);
});
