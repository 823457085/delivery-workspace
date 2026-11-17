import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { ConversationWorkspaceState } from '../shared/conversation-workspaces.js';
const id = z.string().min(1).max(5000).refine(v => !['__proto__', 'constructor', 'prototype'].includes(v));
const projectPath = z.string().min(1).max(4000).refine(v => path.isAbsolute(v) && !/[\x00-\x1f\x7f]/.test(v), '项目必须是绝对目录');
const branches = z.record(projectPath, z.array(z.string().min(1).max(300).refine(value=>!/[\x00-\x1f\x7f]/.test(value))).max(8).transform(values=>[...new Set(values)]));
const workspace = z.object({ id, name: z.string().trim().min(1).max(100), projectBranches: branches.optional(), projectPaths: z.array(projectPath).max(10).transform(v => [...new Set(v.map(p => path.resolve(p)))]) }).strict();
const stateSchema = z.object({ revision: z.number().int().nonnegative(), workspaces: z.array(workspace).max(1000), assignments: z.record(id, z.string().max(5000)), deletedWorkspaceIds: z.array(id).optional() }).strict();
const revision = z.number().int().nonnegative();
const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('seed'), workspaces: z.array(workspace).max(1000) }).strict(),
  z.object({ action: z.literal('save'), revision, workspace: workspace.omit({id:true}).extend({id:id.optional()}) }).strict(),
  z.object({ action: z.literal('remove'), revision, workspaceId: id, confirmed: z.literal(true) }).strict(),
  z.object({ action: z.literal('reorder'), revision, ids: z.array(id).max(1000) }).strict(),
  z.object({ action: z.literal('assign'), revision, conversationId: id, workspaceId: z.string().max(5000) }).strict(),
]);
export async function createConversationWorkspaces(file: string) {
  let state: ConversationWorkspaceState = { revision:0,workspaces:[],assignments:{} };
  try { state = stateSchema.parse(JSON.parse(await fs.readFile(file,'utf8'))); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('工作区分组数据无法读取，请检查本机文件'); }
  let queue = Promise.resolve();
  const read = () => structuredClone(state);
  async function update(raw: unknown) {
    const input = actionSchema.parse(raw);
    const task = queue.then(async () => {
      if ('revision' in input && input.revision !== state.revision) throw new Error('工作区已在其他页面更新，请刷新后重试');
      const next = read();
      if (input.action === 'save' && Object.keys(input.workspace.projectBranches || {}).some(key=>!input.workspace.projectPaths.includes(key))) throw new Error('分支配置必须属于工作区中的项目');
      if (input.action === 'seed') {
        for (const item of input.workspaces) {
          if (item.id !== `project:${item.projectPaths[0]}` || item.projectPaths.length !== 1) throw new Error('默认工作区标识无效');
          if (next.deletedWorkspaceIds?.includes(item.id)) continue;
          if (!next.workspaces.some(w => w.id === item.id)) next.workspaces.push(item);
        }
        if (next.workspaces.length === state.workspaces.length) return read();
      } else if (input.action === 'save') {
        const item = { ...input.workspace, id: input.workspace.id || randomUUID() };
        const index = next.workspaces.findIndex(w => w.id === item.id);
        if (input.workspace.id && index < 0) throw new Error('工作区不存在');
        if (index < 0) next.workspaces.push(item); else next.workspaces[index] = item;
      } else if (input.action === 'remove') {
        if (!next.workspaces.some(w => w.id === input.workspaceId)) throw new Error('工作区不存在，请刷新后重试');
        next.workspaces = next.workspaces.filter(w => w.id !== input.workspaceId);
        // Keep a tombstone for historical run/project-derived membership and late seed requests.
        next.deletedWorkspaceIds = [...new Set([...(next.deletedWorkspaceIds || []), input.workspaceId])];
        for (const [conversationId, workspaceId] of Object.entries(next.assignments)) {
          if (workspaceId === input.workspaceId) next.assignments[conversationId] = '';
        }
      } else if (input.action === 'reorder') {
        if (input.ids.length !== next.workspaces.length || new Set(input.ids).size !== input.ids.length
          || input.ids.some(id => !next.workspaces.some(w => w.id === id))) throw new Error('工作区排序已变化，请刷新后重试');
        next.workspaces = input.ids.map(id => next.workspaces.find(w => w.id === id)!);
      } else {
        if (input.workspaceId && !next.workspaces.some(w => w.id === input.workspaceId)) throw new Error('目标工作区不存在');
        Object.defineProperty(next.assignments,input.conversationId,{value:input.workspaceId,enumerable:true,writable:true,configurable:true});
      }
      next.revision++;
      stateSchema.parse(next);
      await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
      const temporary = `${file}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temporary,JSON.stringify(next,null,2)+'\n',{mode:0o600,flag:'wx'}); await fs.rename(temporary,file); }
      finally { await fs.rm(temporary,{force:true}); }
      state = next; return read();
    });
    queue = task.then(()=>{},()=>{}); return task;
  }
  return { read, update, get(id: string) { const item=state.workspaces.find(w=>w.id===id); if(!item) throw new Error('工作区不存在，请重新选择'); return structuredClone(item); } };
}
export function createConversationWorkspaceRoutes(store: Awaited<ReturnType<typeof createConversationWorkspaces>>, options: {
  port:number; json(response:ServerResponse,status:number,value:unknown):void; body(request:IncomingMessage,limit?:number):Promise<unknown>;
}) {
  return async (request:IncomingMessage,response:ServerResponse,url:URL) => {
    if(url.pathname!=='/api/conversation-workspaces')return false;
    const local=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress||'');
    const hosts=[`localhost:${options.port}`,`127.0.0.1:${options.port}`];
    if(!local||!hosts.includes(request.headers.host||'')){options.json(response,403,{message:'仅接受本机工作台请求'});return true;}
    if(request.method==='GET'){options.json(response,200,store.read());return true;}
    if(request.method!=='POST'){options.json(response,405,{message:'请求方法不支持'});return true;}
    if(!hosts.map(h=>`http://${h}`).includes(request.headers.origin||'')||request.headers['x-delivery-confirmed']!=='yes'
      ||request.headers['content-type']?.split(';')[0]!=='application/json'){options.json(response,403,{message:'请在工作台确认工作区变更'});return true;}
    try { options.json(response,200,await store.update(await options.body(request,2_000_000))); }
    catch(e){options.json(response,400,{message:e instanceof Error?e.message:'工作区保存失败'});}
    return true;
  };
}
