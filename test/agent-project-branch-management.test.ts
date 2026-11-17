import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createAgentRuntimeService, type AgentRuntimeAdapter} from '../server/agent-runtime.js';
const exec=promisify(execFile);
async function fixture(t:any,hold=false){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'project-branch-management-'));
 const repo=path.join(root,'repo');await fs.mkdir(repo);
 await exec('git',['init','-b','main',repo]);
 await exec('git',['-C',repo,'-c','user.name=Test','-c','user.email=test@example.test','commit','--allow-empty','-m','init']);
 await exec('git',['-C',repo,'branch','feature/second']);
 const adapter:AgentRuntimeAdapter={id:'codex',health:async()=>({provider:'codex',label:'test',binary:'test',version:'test',authenticated:true,ready:true,message:'ready',modes:['agent'],models:[{id:'',label:'默认'}],defaultModel:'',writable:true,checkedAt:new Date().toISOString()}),execute:async ctx=>{
  if(hold)await new Promise<void>((_,reject)=>ctx.signal.addEventListener('abort',()=>reject(new Error('stopped')),{once:true}));
  return 'done';
 }};
 const service=await createAgentRuntimeService(path.join(root,'data'),{adapters:[adapter]});
 t.after(async()=>{await service.close();await fs.rm(root,{recursive:true,force:true});});
 return {repo,service,branch:async()=>(await exec('git',['-C',repo,'branch','--show-current'])).stdout.trim()};
}
test('项目分支切换立即生效，重新读取及无分支参数的新会话使用当前分支',async t=>{
 const {repo,service,branch}=await fixture(t);
 const result=await service.switchProjectBranch(repo,'feature/second','main');assert.equal(result.current,'feature/second');assert.equal(await branch(),'feature/second');
 assert.equal((await service.workspaceBranches(repo)).current,'feature/second');
 const run=await service.start({provider:'codex',mode:'agent',model:'',objective:'test',workspacePath:repo,isolateWorkspace:false});
 assert.equal(run.branch,'feature/second');
 for(let i=0;i<100&&!run.resultReady;i++)await new Promise(r=>setTimeout(r,10));
});
test('拒绝过时分支、无效分支与脏工作区，不丢失文件',async t=>{
 const {repo,service,branch}=await fixture(t);
 await assert.rejects(service.switchProjectBranch(repo,'feature/second','stale'),/已变化/);
 await assert.rejects(service.switchProjectBranch(repo,'missing','main'),/本地分支/);
 await fs.writeFile(path.join(repo,'unsaved.txt'),'keep');
 await assert.rejects(service.switchProjectBranch(repo,'feature/second','main'),/未提交改动/);
 assert.equal(await branch(),'main');assert.equal(await fs.readFile(path.join(repo,'unsaved.txt'),'utf8'),'keep');
});
test('运行中或排队的项目禁止切换分支',async t=>{
 const {repo,service,branch}=await fixture(t,true);
 await service.start({provider:'codex',mode:'agent',model:'',objective:'hold',workspacePath:repo,isolateWorkspace:false});
 await assert.rejects(service.switchProjectBranch(repo,'feature/second','main'),/运行或排队/);
 assert.equal(await branch(),'main');
});
