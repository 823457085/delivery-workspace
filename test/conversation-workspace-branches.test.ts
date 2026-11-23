import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {prepareConversationWorkspaceBranches,conversationWorkspaceContext} from '../server/conversation-workspace-branches.js';
import {createConversationWorkspaces} from '../server/conversation-workspaces.js';
const exec=promisify(execFile);
const git=async(directory:string,...args:string[])=>(await exec('git',['-C',directory,...args])).stdout.trim();
async function fixture(t:any){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'multi-branch-workspace-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const source=path.join(root,'project');await fs.mkdir(source);
 await git(source,'init','-b','main');await git(source,'-c','user.name=Test','-c','user.email=test@example.test','commit','--allow-empty','-m','init');
 for(const branch of ['feature/a','feature/b'])await git(source,'branch',branch);
 return {root,source,managed:path.join(root,'managed'),workspace:{id:'group',name:'test',projectPaths:[source],projectBranches:{[source]:['feature/a','feature/b']}}};
}
test('多分支各自拥有可用目录，主分支顺序生效，原目录和本地文件不变且重试复用',async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.source,'private-local.txt'),'keep');
 const bindings=await prepareConversationWorkspaceBranches(f.workspace,f.managed);
 assert.equal(bindings.length,2);assert.notEqual(bindings[0].workspacePath,bindings[1].workspacePath);
 assert.deepEqual(await Promise.all(bindings.map(b=>git(b.workspacePath,'branch','--show-current'))),['feature/a','feature/b']);
 assert.equal(await git(f.source,'branch','--show-current'),'main');
 assert.equal(await fs.readFile(path.join(f.source,'private-local.txt'),'utf8'),'keep');
 for(const binding of bindings)await assert.rejects(fs.stat(path.join(binding.workspacePath,'private-local.txt')),{code:'ENOENT'});
 assert.deepEqual(await prepareConversationWorkspaceBranches(f.workspace,f.managed),bindings);
 const reversed=await prepareConversationWorkspaceBranches({...f.workspace,projectBranches:{[f.source]:['feature/b','feature/a']}},f.managed);
 assert.equal(reversed[0].workspacePath,bindings[1].workspacePath);
 const context=conversationWorkspaceContext(bindings);assert.ok(context.includes(bindings[0].workspacePath));assert.ok(context.includes(bindings[1].workspacePath));assert.match(context,/feature\/a/);
});
test('删除的分支在准备前拒绝，后续创建失败回收本次新目录，不删除已有目录',async t=>{
 const f=await fixture(t);
 await assert.rejects(prepareConversationWorkspaceBranches({...f.workspace,projectBranches:{[f.source]:['feature/a','missing']}},f.managed),/不存在/);
 await assert.rejects(fs.stat(f.managed),{code:'ENOENT'});
 const common=await fs.realpath(await git(f.source,'rev-parse','--path-format=absolute','--git-common-dir'));
 const collision=path.join(f.managed,createHash('sha256').update(`${common}\0feature/b`).digest('hex'));
 await fs.mkdir(collision,{recursive:true});await fs.writeFile(path.join(collision,'keep'),'keep');
 await assert.rejects(prepareConversationWorkspaceBranches(f.workspace,f.managed),/未注册/);
 assert.deepEqual(await fs.readdir(f.managed),[path.basename(collision)]);
 assert.equal(await fs.readFile(path.join(collision,'keep'),'utf8'),'keep');
 assert.doesNotMatch(await git(f.source,'worktree','list','--porcelain'),/refs\/heads\/feature\/a/);
});
test('未选分支沿用原目录，已检出分支复用真实目录',async t=>{
 const f=await fixture(t);
 const bindings=await prepareConversationWorkspaceBranches({...f.workspace,projectBranches:{[f.source]:['main','feature/a']}},f.managed);
 assert.equal(bindings[0].workspacePath,await fs.realpath(f.source));
 const plain=await prepareConversationWorkspaceBranches({...f.workspace,projectBranches:{}},f.managed);
 assert.equal(plain.length,1);assert.equal(plain[0].workspacePath,await fs.realpath(f.source));
});
test('分支多选及顺序保存重载，旧数据兼容，拒绝其他项目的分支配置',async t=>{
 const f=await fixture(t),file=path.join(f.root,'groups.json');
 const store=await createConversationWorkspaces(file);
 let state=await store.update({action:'save',revision:0,workspace:{name:'old',projectPaths:[f.source]}});
 assert.equal((await createConversationWorkspaces(file)).read().workspaces[0].projectBranches,undefined);
 const withTrailingSeparator = f.source + path.sep;
 state=await store.update({action:'save',revision:state.revision,workspace:{...state.workspaces[0],projectPaths:[withTrailingSeparator],projectBranches:{[withTrailingSeparator]:['feature/b','feature/a','feature/b']}}});
 assert.deepEqual((await createConversationWorkspaces(file)).read().workspaces[0].projectBranches?.[f.source],['feature/b','feature/a']);
 await assert.rejects(store.update({action:'save',revision:state.revision,workspace:{...state.workspaces[0],projectBranches:{'/other':['main']}}}),/属于/);
 assert.deepEqual(store.read(),state);
});
