import type http from 'node:http';
import { z } from 'zod';
import type { JiraField, JiraIssueDetail, JiraPerson } from '../shared/jira-issue.js';

export type JiraIssueRequest = (resource: string, method?: string, body?: unknown) => Promise<Response>;
// Jira JSON is validated at the operation boundary; raw metadata stays on the server.
type Raw = Record<string, any>;
const keySchema = z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/);
const permissions = ['EDIT_ISSUES','TRANSITION_ISSUES','ASSIGN_ISSUES','ADD_COMMENTS','CREATE_ATTACHMENTS','WORK_ON_ISSUES','LINK_ISSUES','CREATE_ISSUES'];
const issuePath = (key: string) => `issue/${keySchema.parse(key)}`;
const failure = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const name = (value: Raw | null | undefined) => value?.displayName || value?.name || value?.value || '';
const person = (value: Raw): JiraPerson => ({ id: value.accountId || value.name, kind: value.accountId ? 'accountId' : 'name', label: name(value) });
const fields = (raw: Raw = {}): JiraField[] => Object.entries(raw).map(([id, field]) => ({ id, name: field.name || id, required: !!field.required, schema: field.schema, allowedValues: field.allowedValues, defaultValue: field.defaultValue }));
const editable = (field: JiraField) => ['summary','description','priority','fixVersions','components','labels','duedate','customfield_10109','customfield_10110'].includes(field.id);
const comment = (item: Raw) => ({ id: String(item.id), author: name(item.author), body: typeof item.body === 'string' ? item.body : '', html: item.renderedBody || '', created: item.created || '' });

export function createJiraIssueService(request: JiraIssueRequest) {
  const locks = new Set<string>();
  const json = async (resource: string, method = 'GET', body?: unknown): Promise<Raw> => {
    const response = await request(resource, method, body);
    if (response.status === 204) return {};
    return response.json();
  };
  const read = (key: string) => json(`${issuePath(key)}?fields=*all&expand=renderedFields,changelog`);
  async function capabilities(key: string) {
    const result = await json(`mypermissions?${new URLSearchParams({ issueKey: key, permissions: permissions.join(',') })}`);
    return Object.fromEntries(permissions.map(id => [id, result.permissions?.[id]?.havePermission === true]));
  }
  async function comments(key: string, start = 0) {
    const data = await json(`${issuePath(key)}/comment?${new URLSearchParams({ startAt: String(start), maxResults: '50', expand: 'renderedBody', orderBy:'-created' })}`);
    return { comments: (data.comments || []).map(comment), total: data.total || 0, next: start + (data.comments || []).length };
  }
  async function detail(key: string): Promise<JiraIssueDetail> {
    const raw = await read(key), f = raw.fields || {};
    if (raw.key !== key || !f.summary) throw failure('Jira 事项返回不完整');
    const warnings: string[] = [];
    const optional = async <T>(work: Promise<T>, fallback: T) => work.catch(error => { warnings.push(error.message); return fallback; });
    const [rights, edit, workflow, discussion, watching] = await Promise.all([
      optional(capabilities(key), {}), optional(json(`${issuePath(key)}/editmeta`), { fields: {} }),
      optional(json(`${issuePath(key)}/transitions?expand=transitions.fields`), { transitions: [] }),
      optional(comments(key), { comments: [], total: 0, next: 0 }), optional(json(`${issuePath(key)}/watchers`), {}),
    ]);
    const editFields = fields(edit.fields).filter(editable);
    return {
      key, url: raw.self ? new URL(`/browse/${key}`,raw.self).href : `/browse/${key}`, summary: f.summary, description: typeof f.description === 'string' ? f.description : '', descriptionHtml: raw.renderedFields?.description || '',
      updated: f.updated || '', created: f.created || '', status: name(f.status), statusCategory: f.status?.statusCategory?.key || '', type: name(f.issuetype), priority: name(f.priority),
      project: { id: String(f.project?.id || ''), key: f.project?.key || '', name: name(f.project) }, assignee: name(f.assignee), assigneeUser: f.assignee ? person(f.assignee) : null, reporter: name(f.reporter),
      fixVersions: (f.fixVersions || []).map(name), components: (f.components || []).map(name), labels: f.labels || [],
      startDate: f.customfield_10109 || '', endDate: f.customfield_10110 || '', dueDate: f.duedate || '',
      parent: f.parent ? { key: f.parent.key, summary: f.parent.fields?.summary || '' } : null,
      subtasks: (f.subtasks || []).map((item: Raw) => ({ key: item.key, summary: item.fields?.summary || '', status: name(item.fields?.status) })),
      links: (f.issuelinks || []).map((link: Raw) => { const target = link.outwardIssue || link.inwardIssue; return { id: link.id, key: target?.key, summary: target?.fields?.summary || '', status: name(target?.fields?.status), relationship: link.outwardIssue ? link.type?.outward : link.type?.inward }; }).filter((item: Raw) => item.key),
      attachments: (f.attachment || []).map((item: Raw) => ({ id: String(item.id), filename: item.filename, size: item.size, mimeType: item.mimeType, created: item.created, author: name(item.author) })),
      comments: discussion.comments, commentTotal: discussion.total, commentNext: discussion.next,
      changes: (raw.changelog?.histories || []).map((item: Raw) => ({ id: item.id, author: name(item.author), created: item.created, items: (item.items || []).map((change: Raw) => ({ field: change.field, from: change.fromString ?? change.from ?? '', to: change.toString ?? change.to ?? '' })) })), changeTotal: raw.changelog?.total || 0,
      permissions: rights, warnings, watching: typeof watching.isWatching === 'boolean' ? watching.isWatching : null,
      editFields, fieldValues: Object.fromEntries(editFields.map(field => [field.id, f[field.id] ?? null])),
      transitions: (workflow.transitions || []).map((item: Raw) => ({ id: item.id, name: item.name, to: name(item.to), fields: fields(item.fields) })),
    };
  }
  async function users(key: string, query: string) {
    const data = await json(`user/assignable/search?${new URLSearchParams({ issueKey: keySchema.parse(key), username: query.slice(0,100), maxResults:'30' })}`);
    if (!Array.isArray(data)) throw failure('Jira 未返回可指派人员');
    return data.filter((item: Raw) => item.active !== false && (item.accountId || item.name)).map(person);
  }
  async function options(key: string, action: string) {
    if (action === 'link') return (await json('issueLinkType')).issueLinkTypes || [];
    if (action === 'subtask') {
      const raw = await read(key), project = raw.fields?.project;
      const prefix=`issue/createmeta/${encodeURIComponent(project?.key || '')}/issuetypes`;
      const pages=async(path:string,property:string):Promise<Raw[]>=>{
        const result:Raw[]=[];
        for(let start=0,count=0;count<50;count++){
          const page=await json(`${path}?${new URLSearchParams({startAt:String(start),maxResults:'100'})}`);
          const items=page[property] || page.values;if(!Array.isArray(items))throw failure('Jira 创建元数据返回不完整');
          result.push(...items);start+=items.length;
          if(page.isLast===true || Number.isInteger(page.total)&&start>=page.total || !items.length || page.total===undefined&&items.length<(page.maxResults||100))return result;
        }
        throw failure('创建元数据超过读取上限，请在 Jira 核对');
      };
      try {
        const types=(await pages(prefix,'issueTypes')).filter(item=>item.subtask===true);
        return await Promise.all(types.map(async item=>({id:String(item.id),name:item.name,fields:fields(Object.fromEntries((await pages(`${prefix}/${encodeURIComponent(item.id)}`,'fields')).map(field=>[field.fieldId||field.key||field.id,field]))).filter(field=>!['project','issuetype','parent'].includes(field.id))})));
      }catch(cause){
        if(![404,405].includes((cause as {statusCode?:number}).statusCode||0))throw cause;
        const legacy=await json(`issue/createmeta?${new URLSearchParams({projectKeys:project?.key||'',expand:'projects.issuetypes.fields'})}`);
        return (legacy.projects?.find((item:Raw)=>item.key===project.key)?.issuetypes||[]).filter((item:Raw)=>item.subtask).map((item:Raw)=>({id:String(item.id),name:item.name,fields:fields(item.fields).filter(field=>!['project','issuetype','parent'].includes(field.id))}));
      }
    }
    if (action === 'worklog') {
      const data = await json(`${issuePath(key)}/worklog?maxResults=100`);
      return { total: data.total, items: (data.worklogs || []).map((item: Raw) => ({ id: item.id, author: name(item.author), started: item.started, timeSpent: item.timeSpent, comment: item.comment })) };
    }
    throw failure('不支持的事项操作');
  }
  function validateFields(values: Raw, metadata: JiraField[], required = false) {
    const allowed = new Map(metadata.map(field => [field.id, field]));
    for (const [id, value] of Object.entries(values)) {
      const field = allowed.get(id); if (!field) throw failure('字段不在当前 Jira 可编辑范围内');
      if (field.schema?.type === 'array') { if (!Array.isArray(value)) throw failure(`${field.name}必须为数组`); }
      else if (field.allowedValues?.length && value !== null) { if (!value || typeof value !== 'object' || typeof value.id !== 'string') throw failure(`${field.name}选项格式不正确`); }
      else if(field.schema?.type==='user' && value!==null) {if(!value || typeof value!=='object' || !['name','accountId'].some(kind=>typeof value[kind]==='string'&&value[kind].length<=200))throw failure(`${field.name}人员格式不正确`);}
      else if(field.schema?.type==='number' && value!==null){if(typeof value!=='number'||!Number.isFinite(value))throw failure(`${field.name}必须为数值`);}
      else if(field.schema?.type==='boolean'){if(typeof value!=='boolean')throw failure(`${field.name}必须为布尔值`);}
      else if (value !== null && typeof value !== 'string') throw failure(`${field.name}格式不正确`);
      if(field.schema?.type==='array' && field.schema.items==='string' && value.some((item:unknown)=>typeof item!=='string'))throw failure(`${field.name}格式不正确`);
      if (field.allowedValues?.length) {
        const ids = new Set(field.allowedValues.map(item => String(item.id)));
        for (const item of Array.isArray(value) ? value : value === null ? [] : [value]) if (!item || !ids.has(String(item.id))) throw failure(`${field.name}选项已变化，请刷新`);
      }
    }
    if (required) for (const field of metadata) if (field.required && field.defaultValue == null && (values[field.id] == null || values[field.id] === '' || Array.isArray(values[field.id]) && !values[field.id].length)) throw failure(`请填写${field.name}`);
  }
  async function mutate(key: string, input: unknown, file?: File) {
    keySchema.parse(key);
    const command = z.object({ action: z.enum(['edit','transition','assign','comment','watch','link','subtask','worklog','attachment']), updated: z.string(), values: z.record(z.string(), z.unknown()).default({}) }).strict().parse(input);
    if (locks.has(key)) throw failure('此事项有操作正在执行，请稍后核对', 409);
    locks.add(key);
    try {
      const current = await read(key), rights = await capabilities(key), v: Raw = command.values;
      const permission: Record<string,string> = { edit:'EDIT_ISSUES',transition:'TRANSITION_ISSUES',assign:'ASSIGN_ISSUES',comment:'ADD_COMMENTS',attachment:'CREATE_ATTACHMENTS',worklog:'WORK_ON_ISSUES',link:'LINK_ISSUES',subtask:'CREATE_ISSUES' };
      if (permission[command.action] && !rights[permission[command.action]]) throw failure('当前账号没有此 Jira 操作权限',403);
      if (current.fields?.updated !== command.updated) throw failure('事项已发生变化，请刷新后再操作',409);
      let wrote = false;
      const write = async (path: string, method: string, body?: unknown) => {
        try { const result = await json(path, method, body); wrote = true; return result; }
        catch (error) { if (!(error as { definite?: boolean }).definite) throw Object.assign(failure('Jira 操作结果待核对，请刷新并检查现有记录，不要重复提交',409),{uncertain:true}); throw error; }
      };
      let result: Raw = {}; let targetStatus = '';
      if (command.action === 'edit') {
        const meta = fields((await json(`${issuePath(key)}/editmeta`)).fields).filter(editable);
        validateFields(v,meta); if (!Object.keys(v).length) throw failure('没有要保存的字段');
        await write(issuePath(key),'PUT',{fields:v});
      } else if (command.action === 'transition') {
        const { id, fields: values } = z.object({id:z.string().min(1),fields:z.record(z.string(),z.unknown()).default({})}).strict().parse(v);
        const list = (await json(`${issuePath(key)}/transitions?expand=transitions.fields`)).transitions || [];
        const target = list.find((item: Raw) => item.id === id); if (!target) throw failure('工作流已变化，请刷新');
        targetStatus = String(target.to.id); validateFields(values,fields(target.fields),true); await write(`${issuePath(key)}/transitions`,'POST',{transition:{id},fields:values});
      } else if (command.action === 'assign') {
        const user = z.object({ id:z.string().max(200),kind:z.enum(['name','accountId']) }).strict().parse(v);
        if (user.id && !(await users(key,user.id)).some(item => item.id===user.id && item.kind===user.kind)) throw failure('该人员不在当前事项的可指派范围');
        await write(`${issuePath(key)}/assignee`,'PUT',{[user.kind]: user.id || null});
      } else if (command.action === 'comment') {
        const { body } = z.object({body:z.string().min(1).max(50000).refine(value=>value.trim().length>0)}).strict().parse(v);
        result = await write(`${issuePath(key)}/comment`,'POST',{body});
      } else if (command.action === 'watch') {
        const { watching } = z.object({watching:z.boolean()}).strict().parse(v);
        const myself = await json('myself');if(!(myself.name||myself.accountId))throw failure('Jira 未返回当前账号标识');
        await write(`${issuePath(key)}/watchers${watching?'':`?${new URLSearchParams({username:myself.name || myself.accountId})}`}`,watching?'POST':'DELETE',watching?(myself.name || myself.accountId):undefined);
      } else if (command.action === 'link') {
        const { typeId, other, direction } = z.object({typeId:z.string(),other:keySchema,direction:z.enum(['outward','inward'])}).strict().parse(v);
        if (other===key) throw failure('不能关联事项自身');
        const type = ((await json('issueLinkType')).issueLinkTypes || []).find((item: Raw)=>item.id===typeId); if (!type) throw failure('关联类型已变化');
        await write('issueLink','POST',{type:{id:typeId},inwardIssue:{key:direction==='outward'?key:other},outwardIssue:{key:direction==='outward'?other:key}});
      } else if (command.action === 'subtask') {
        const { typeId, fields: values } = z.object({typeId:z.string(),fields:z.record(z.string(),z.unknown())}).strict().parse(v);
        const types = await options(key,'subtask') as Raw[], type=types.find(item=>item.id===typeId); if (!type) throw failure('没有可用的子任务类型');
        validateFields(values,type.fields,true);
        result = await write('issue','POST',{fields:{...values,project:{id:current.fields.project.id},issuetype:{id:typeId},parent:{key}}});
      } else if (command.action === 'worklog') {
        const {timeSpent,started,comment:body,adjustEstimate} = z.object({timeSpent:z.string().regex(/^(?:\d+[wdhm]\s*)+$/).refine(value=>/[1-9]/.test(value)),started:z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d{4}$/),comment:z.string().max(50000).default(''),adjustEstimate:z.enum(['leave','auto'])}).strict().parse(v);
        result = await write(`${issuePath(key)}/worklog?adjustEstimate=${adjustEstimate}`,'POST',{timeSpent,started,comment:body});
      } else {
        if (!file || !file.size || file.size > 10*1024*1024) throw failure('请选择不超过 10 MB 的附件');
        const form=new FormData();form.append('file',file,file.name); result=await write(`${issuePath(key)}/attachments`,'POST',form);
      }
      if (wrote) {
        try {
          const saved = await read(key);
          if (command.action==='edit') for(const [id,value] of Object.entries(v)) {
            const normalize=(x:any):any=>x==null||x===''?null:Array.isArray(x)?x.map(normalize).sort():x&&typeof x==='object'?String(x.id ?? x.value):x??null;
            if(JSON.stringify(normalize(saved.fields[id]))!==JSON.stringify(normalize(value)))throw new Error();
          }
          const returned:Raw = result as Raw;
          if(command.action==='transition' && String(saved.fields.status?.id)!==targetStatus)throw new Error();
          if(command.action==='assign' && (saved.fields.assignee?.[v.kind] || '')!==v.id)throw new Error();
          if(command.action==='link' && !(saved.fields.issuelinks || []).some((link:Raw)=>String(link.type?.id)===v.typeId && (link.outwardIssue || link.inwardIssue)?.key===v.other))throw new Error();
          if(command.action==='worklog') {if(!result.id || !(await json(`${issuePath(key)}/worklog/${result.id}`)).id)throw new Error();}
          if(command.action==='attachment') {if(!Array.isArray(result) || !result.length || !result.every((file:Raw)=>(saved.fields.attachment || []).some((item:Raw)=>String(item.id)===String(file.id))))throw new Error();}
          if(command.action==='comment') { const savedComment=await json(`${issuePath(key)}/comment/${returned.id}`);if(savedComment.body!==v.body)throw new Error(); }
          if(command.action==='watch') {const state=await json(`${issuePath(key)}/watchers`);if(state.isWatching!==v.watching)throw new Error();}
          if(command.action==='subtask') {if(!keySchema.safeParse(returned.key).success||(await read(returned.key)).fields?.parent?.key!==key)throw new Error();}
          return {ok:true,createdKey:returned.key,verified:true};
        } catch { throw Object.assign(failure('Jira 已接收操作，但回读未能核对，请检查现有记录后再继续',409),{uncertain:true}); }
      }
      return {ok:true};
    } finally { locks.delete(key); }
  }
  async function attachment(key: string, id: string) {
    const raw=await read(key), item=(raw.fields?.attachment || []).find((file:Raw)=>String(file.id)===id);
    if(!item)throw failure('附件不属于此事项',404);
    return {response:await request(`attachment/content/${id}`),filename:item.filename,mimeType:item.mimeType};
  }
  return {detail,comments,users,options,mutate,attachment};
}

export function createJiraIssueRoute(service: ReturnType<typeof createJiraIssueService>) {
  return async (request: http.IncomingMessage, response: http.ServerResponse, port: number) => {
    const send=(status:number,value:unknown)=>{response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});response.end(JSON.stringify(value));};
    try {
      const origin=`http://${request.headers.host}`;
      if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress||'')||![`localhost:${port}`,`127.0.0.1:${port}`].includes(request.headers.host||'')||request.headers.origin&&request.headers.origin!==origin) {send(403,{message:'仅接受当前本机工作台请求'});return;}
      const url=new URL(request.url||'/',origin),match=url.pathname.match(/^\/api\/jira\/issues\/([A-Z][A-Z0-9_]*-\d+)(?:\/(users|options|comments|attachments\/\d+))?$/);
      if(!match){send(404,{message:'事项接口不存在'});return;}const key=match[1],suffix=match[2]||'';
      if(request.method==='GET') {
        if(suffix.startsWith('attachments/')) {
          const file=await service.attachment(key,suffix.split('/')[1]);
          const reader=file.response.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
          if(!reader)throw failure('附件内容为空');
          while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>20*1024*1024){await reader.cancel();throw failure('附件超过本地预览限制');}chunks.push(part.value);}
          const buffer=Buffer.concat(chunks);
          response.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});response.end(buffer);return;
        }
        const start=Number(url.searchParams.get('start')||'0');if(!Number.isSafeInteger(start)||start<0)throw failure('分页位置不正确');
        const value=suffix==='users'?await service.users(key,url.searchParams.get('q')||''):suffix==='options'?await service.options(key,url.searchParams.get('action')||''):suffix==='comments'?await service.comments(key,start):await service.detail(key);
        send(200,value);return;
      }
      if(request.method!=='POST'||suffix){send(405,{message:'请求方法不支持'});return;}
      if(request.headers.origin!==origin||request.headers['x-delivery-confirmed']!=='yes'){send(403,{message:'请在当前工作台确认此操作'});return;}
      const limit=11*1024*1024, chunks:Buffer[]=[];let size=0;
      for await(const chunk of request){size+=Buffer.byteLength(chunk);if(size>limit){send(413,{message:'请求内容过大'});return;}chunks.push(Buffer.from(chunk));}
      const body=Buffer.concat(chunks),contentType=request.headers['content-type']||'';
      if(contentType.startsWith('multipart/form-data;')) {
        const form=await new Request(origin,{method:'POST',headers:{'Content-Type':contentType},body}).formData();
        const file=form.get('file');if(!file||typeof file==='string')throw failure('请选择附件');
        send(200,await service.mutate(key,{action:'attachment',updated:form.get('updated'),values:{}},file));return;
      }
      if(contentType.split(';')[0]!=='application/json'){send(415,{message:'请发送 JSON 或附件'});return;}
      if(body.length>200000){send(413,{message:'请求内容过大'});return;}
      send(200,await service.mutate(key,JSON.parse(body.toString()||'{}')));
    } catch(error) {
      const cause=error as Error & {statusCode?:number;uncertain?:boolean};
      send(cause.statusCode||400,{message:error instanceof z.ZodError || error instanceof SyntaxError?'输入格式不正确':cause.message,uncertain:!!cause.uncertain});
    }
  };
}
