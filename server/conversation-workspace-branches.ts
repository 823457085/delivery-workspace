import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {ConversationWorkspace} from '../shared/conversation-workspaces.js';
import {withProjectGitLock} from './project-git.js';
const exec = promisify(execFile);
async function git(directory:string,args:string[]) {
  return (await exec('git',['-c','core.hooksPath=/dev/null','-C',directory,...args],{
    timeout:30_000,maxBuffer:2_000_000,
    env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_'))),GIT_TERMINAL_PROMPT:'0'},
  })).stdout;
}
export type ConversationProjectBinding = {sourcePath:string;workspacePath:string;branch:string};
/** Resolve every selected branch without switching an existing checkout or copying its local files. */
export async function prepareConversationWorkspaceBranches(workspace:ConversationWorkspace,root:string):Promise<ConversationProjectBinding[]> {
  const plan: {sourcePath:string;branch:string;common:string}[]=[];
  // Validate all selections before creating any directories.
  for(const sourcePath of workspace.projectPaths){
    const source=await fs.realpath(sourcePath);
    const branches=workspace.projectBranches?.[sourcePath]||[];
    if(!branches.length){plan.push({sourcePath:source,branch:'',common:''});continue;}
    const common=await fs.realpath((await git(source,['rev-parse','--path-format=absolute','--git-common-dir'])).trim());
    for(const branch of branches){
      try { await git(source,['check-ref-format',`refs/heads/${branch}`]);await git(source,['show-ref','--verify',`refs/heads/${branch}`]); }
      catch { throw new Error(`项目 ${sourcePath} 的分支 ${branch} 不存在，请在工作区中重新选择`); }
      plan.push({sourcePath:source,branch,common});
    }
  }
  const created:{source:string;target:string}[]=[];
  try {
    const bindings:ConversationProjectBinding[]=[];
    for(const item of plan){
      if(!item.branch){bindings.push({sourcePath:item.sourcePath,workspacePath:item.sourcePath,branch:''});continue;}
      const target=await withProjectGitLock(item.sourcePath,async()=>{
        const records=(await git(item.sourcePath,['worktree','list','--porcelain','-z'])).split('\0\0').map(record=>record.split('\0'));
        const matches=records.filter(fields=>fields.includes(`branch refs/heads/${item.branch}`));
        if(matches.length>1)throw new Error(`分支 ${item.branch} 有多个检出目录，请先整理项目工作区`);
        if(matches.length){
          const existing=matches[0].find(field=>field.startsWith('worktree '))?.slice(9);
          if(!existing)throw new Error('无法确认分支目录');
          const canonical=await fs.realpath(existing);
          const common=await fs.realpath((await git(canonical,['rev-parse','--path-format=absolute','--git-common-dir'])).trim());
          if(common!==item.common||(await git(canonical,['symbolic-ref','--quiet','HEAD'])).trim()!==`refs/heads/${item.branch}`)throw new Error('分支目录已变化，请重试');
          return canonical;
        }
        await fs.mkdir(root,{recursive:true,mode:0o700});
        const target=path.join(root,createHash('sha256').update(`${item.common}\0${item.branch}`).digest('hex'));
        try{await fs.lstat(target);throw new Error('分支目标目录已存在但未注册，请先检查目录');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
        await git(item.sourcePath,['worktree','add','--',target,item.branch]);
        created.push({source:item.sourcePath,target});
        return fs.realpath(target);
      });
      if(!bindings.some(binding=>binding.workspacePath===target))bindings.push({sourcePath:item.sourcePath,workspacePath:target,branch:item.branch});
    }
    return bindings;
  } catch(e) {
    const retained:string[]=[];
    for(const item of created.reverse()){
      // Never force removal: a concurrent local edit must survive a preparation failure.
      try{await withProjectGitLock(item.source,()=>git(item.source,['worktree','remove','--',item.target]));}catch{retained.push(item.target);}
    }
    if(retained.length)throw new Error(`${e instanceof Error?e.message:String(e)}；以下目录有变化或被占用，已保留：${retained.join('、')}`);
    throw e;
  }
}
export function conversationWorkspaceContext(bindings:ConversationProjectBinding[]) {
  return bindings.length ? `\n\n[工作区项目与分支]\n${bindings.map((item,index)=>`- ${index===0?'主执行目录':'关联目录'}：${JSON.stringify(item.workspacePath)}${item.branch?`；分支：${JSON.stringify(item.branch)}`:''}`).join('\n')}\n各分支已有独立目录，请在对应目录操作，不要为访问其他分支而切换主目录分支。` : '';
}
