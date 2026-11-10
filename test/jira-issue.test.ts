import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import type http from 'node:http';
import {createJiraIssueService,createJiraIssueRoute} from '../server/jira-issue';
import {jiraWikiMarkdown} from '../src/features/jira-issue/jira-description';
function fixture() {
 const calls:{path:string;method:string;body:any}[]=[],key='OPAY-720';let revision=0,deny='',uncertain=false;
 const f:any={summary:'L1001 原始标题',description:'h2. 目标\n原始描述',updated:'2026-11-02T08:00:00.000Z',created:'2026-10-01T08:00:00.000Z',status:{id:'1',name:'测试中',statusCategory:{key:'indeterminate'}},project:{id:'100',key:'OPAY',name:'支付平台'},issuetype:{id:'3',name:'子任务'},priority:{id:'2',name:'L2001'},assignee:{name:'lzr',displayName:'示例用户'},reporter:{name:'r',displayName:'报告人'},fixVersions:[],components:[],labels:[],attachment:[],subtasks:[],issuelinks:[]};
 const discussion:any[]=[],logs:any[]=[],watchers={isWatching:false};
 const metadata:any={summary:{name:'标题',required:true,schema:{type:'string'}},description:{name:'描述',schema:{type:'string'}},priority:{name:'优先级',schema:{type:'priority'},allowedValues:[{id:'2',name:'L2001'},{id:'3',name:'低'}]},labels:{name:'标签',schema:{type:'array',items:'string'}}};
 const workflow=[{id:'31',name:'完成测试',to:{id:'2',name:'已完成'},fields:{customfield_10110:{name:'结束日期',required:true,schema:{type:'date'}}}}];
 const raw=()=>({key,self:`https://jira.example.test/rest/api/2/issue/${key}`,fields:f,renderedFields:{description:'<h2>目标</h2><p>原始描述</p><script>window.pwned=true</script><a href="javascript:alert(1)">坏链接</a>'},changelog:{histories:[],total:0}});
 const response=(value:unknown,status=200)=>new Response(status===204?null:JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
 async function request(path:string,method='GET',body?:any):Promise<Response>{calls.push({path,method,body});const url=new URL(path,'https://fixture/');
  if(method==='GET'){
   if(path.startsWith('mypermissions?'))return response({permissions:Object.fromEntries(['EDIT_ISSUES','TRANSITION_ISSUES','ASSIGN_ISSUES','ADD_COMMENTS','CREATE_ATTACHMENTS','WORK_ON_ISSUES','LINK_ISSUES','CREATE_ISSUES'].map(id=>[id,{havePermission:id!==deny}]))});
   if(url.pathname==='/'+'issue/'+key)return response(raw());
   if(url.pathname.endsWith('/editmeta'))return response({fields:metadata});
   if(url.pathname.endsWith('/transitions'))return response({transitions:workflow});
   if(url.pathname.endsWith('/comment'))return response({comments:discussion,total:discussion.length});
   if(/\/comment\/\d+$/.test(url.pathname))return response(discussion.find(x=>x.id===path.split('/').at(-1)));
   if(url.pathname.endsWith('/watchers'))return response(watchers);
   if(path==='myself')return response({name:'lzr'});
   if(path.startsWith('user/assignable/search?'))return response([{name:'lzr',displayName:'示例用户',active:true},{name:'next',displayName:'下一位',active:true}]);
   if(path==='issueLinkType')return response({issueLinkTypes:[{id:'100',name:'阻塞',inward:'被阻塞',outward:'阻塞'}]});
   if(url.pathname==='/issue/createmeta/OPAY/issuetypes')return response({issueTypes:[{id:'3',name:'子任务',subtask:true}],isLast:true});
   if(url.pathname==='/issue/createmeta/OPAY/issuetypes/3')return response({fields:Object.entries(metadata).map(([fieldId,field])=>({fieldId,...field as object})),isLast:true});
   if(path.startsWith('issue/createmeta?'))return response({projects:[{key:'OPAY',issuetypes:[{id:'3',name:'子任务',subtask:true,fields:metadata}]}]});
   if(url.pathname.endsWith('/worklog'))return response({worklogs:logs,total:logs.length});
   if(/\/worklog\/\d+$/.test(url.pathname))return response(logs.find(x=>x.id===path.split('/').at(-1)));
   if(path.startsWith('issue/OPAY-721?'))return response({key:'OPAY-721',fields:{parent:{key},summary:'child'}});
   if(path==='attachment/content/11')return new Response('fixture download');
   throw Error('Unexpected GET '+path);
  }
  if(uncertain)throw Error('Network disconnected');
  revision++;f.updated=new Date(Date.parse('2026-11-02T08:00:00Z')+revision*1000).toISOString();
  if(method==='PUT'&&url.pathname==='/issue/'+key){Object.assign(f,body.fields);return response(null,204);}
  if(path.endsWith('/transitions')){assert.equal(body.transition.id,'31');Object.assign(f,body.fields);f.status={id:'2',name:'已完成'};return response(null,204);}
  if(path.endsWith('/assignee')){f.assignee=body.name?{name:body.name}:null;return response(null,204);}
  if(path.endsWith('/comment')){const item={id:String(discussion.length+1),body:body.body,author:{displayName:'示例用户'}};discussion.push(item);return response(item);}
  if(url.pathname.endsWith('/watchers')){watchers.isWatching=method==='POST';return response(null,204);}
  if(path==='issueLink'){f.issuelinks.push({id:'7',type:{id:body.type.id,outward:'阻塞'},outwardIssue:{key:body.outwardIssue.key,fields:{summary:'related'}}});return response(null,204);}
  if(path==='issue'){f.subtasks.push({key:'OPAY-721',fields:{summary:body.fields.summary}});return response({key:'OPAY-721'});}
  if(url.pathname.endsWith('/worklog')){const item={id:'9',...body};logs.push(item);return response(item);}
  if(path.endsWith('/attachments')){assert.ok(body instanceof FormData);const file=body.get('file') as File;f.attachment.push({id:'11',filename:file.name,mimeType:file.type,size:file.size});return response([{id:'11'}]);}
  throw Error('Unexpected mutation '+method+' '+path);
 }
 const service=createJiraIssueService(request);
 const mutate=(action:string,values:any={},file?:File)=>service.mutate(key,{action,values,updated:f.updated},file);
 return {service,request,calls,f,mutate,setDeny:(value:string)=>deny=value,setUncertain:()=>uncertain=true};
}

test('详情保留原文、权限、元数据，读取不触发写入',async()=>{
 const t=fixture(),d=await t.service.detail('OPAY-720');assert.equal(d.summary,'L1001 原始标题');assert.equal(d.priority,'L2001');assert.equal(d.description,'h2. 目标\n原始描述');assert.equal(d.permissions.EDIT_ISSUES,true);assert.equal(d.transitions[0].fields[0].required,true);assert.ok(t.calls.every(x=>x.method==='GET'));
});
test('编辑、指派、评论、状态、关注、关联、子任务、工时、附件均经实际回读',async()=>{
 const t=fixture();await t.mutate('edit',{summary:'保留接口文案',priority:{id:'3'},labels:['标签']});assert.equal(t.f.summary,'保留接口文案');
 await t.mutate('assign',{id:'next',kind:'name'});assert.equal(t.f.assignee.name,'next');
 await t.mutate('comment',{body:'  原始评论 L1001\n'});assert.equal((await t.service.comments('OPAY-720')).comments[0].body,'  原始评论 L1001\n');
 await assert.rejects(t.mutate('transition',{id:'31',fields:{}}),/结束日期/);
 await t.mutate('transition',{id:'31',fields:{customfield_10110:'2026-11-02'}});assert.equal(t.f.status.id,'2');
 await t.mutate('watch',{watching:true});assert.equal((await t.service.detail('OPAY-720')).watching,true);
 await t.mutate('watch',{watching:false});assert.equal((await t.service.detail('OPAY-720')).watching,false);
 await t.mutate('link',{typeId:'100',other:'OPAY-722',direction:'outward'});assert.equal(t.f.issuelinks[0].outwardIssue.key,'OPAY-722');
 assert.equal((await t.mutate('subtask',{typeId:'3',fields:{summary:'创建子任务'}})).createdKey,'OPAY-721');
 await t.mutate('worklog',{timeSpent:'1h 30m',started:'2026-11-02T08:00:00.000+0000',comment:'验证工时',adjustEstimate:'leave'});
 await t.mutate('attachment',{},new File(['test'],'proof.txt',{type:'text/plain'}));assert.equal(t.f.attachment[0].filename,'proof.txt');
 const file=await t.service.attachment('OPAY-720','11');assert.equal(await file.response.text(),'fixture download');await assert.rejects(t.service.attachment('OPAY-720','12'),/不属于/);
});
test('拒绝过期更新、无权限、越界字段/选项/人员和不确定请求重放',async()=>{
 const t=fixture();await assert.rejects(t.service.mutate('OPAY-720',{action:'edit',updated:'stale',values:{summary:'x'}}),/发生变化/);
 t.setDeny('EDIT_ISSUES');await assert.rejects(t.mutate('edit',{summary:'x'}),/权限/);t.setDeny('');
 await assert.rejects(t.mutate('edit',{password:'no'}),/可编辑范围/);await assert.rejects(t.mutate('edit',{priority:{id:'999'}}),/已变化/);
 await assert.rejects(t.mutate('assign',{id:'unassignable',kind:'name'}),/可指派/);
 await assert.rejects(t.mutate('link',{typeId:'100',other:'OPAY-720',direction:'outward'}),/自身/);
 assert.equal(t.calls.filter(x=>x.method!=='GET').length,0);
 t.setUncertain();await assert.rejects(t.mutate('comment',{body:'only once'}),(e:any)=>e.uncertain===true);assert.equal(t.calls.filter(x=>x.method==='POST').length,1);
});
test('HTTP 路由拒绝跨源、非确认写入和非法事项路径',async()=>{
 const t=fixture(),route=createJiraIssueRoute(t.service);
 async function req(options:{method?:string;origin?:string;confirmed?:string;path?:string;body?:string}={}){
  const request=Object.assign(Readable.from([options.body||'{}']),{url:options.path||'/api/jira/issues/OPAY-720',method:options.method||'POST',headers:{host:'127.0.0.1:5296',origin:options.origin||'http://127.0.0.1:5296','x-delivery-confirmed':options.confirmed||'no','content-type':'application/json'},socket:{remoteAddress:'127.0.0.1'}}) as unknown as http.IncomingMessage;
  let status=0,data='';const response={writeHead:(code:number)=>{status=code;},end:(value:string)=>{data=value;}} as unknown as http.ServerResponse;await route(request,response,5296);return{status,data};
 }
 assert.equal((await req()).status,403);assert.equal((await req({origin:'https://evil.test',confirmed:'yes'})).status,403);assert.equal((await req({path:'/api/jira/issues/../../config',method:'GET'})).status,404);assert.equal(t.calls.length,0);assert.equal((await req({method:'GET'})).status,200);
});
test('Jira Wiki 降级展示只转换结构，不改写标题及链接文案',()=>{
 assert.equal(jiraWikiMarkdown('h2. 来源\n* 目标\n[需求|https://jira.example.test/browse/OPAY-720]'),'## 来源\n- 目标\n[需求](https://jira.example.test/browse/OPAY-720)');assert.equal(jiraWikiMarkdown('h1. 标题'),'# 标题');
});
export {fixture};
test('子任务元数据兼容新版分页和旧版接口',async()=>{
 const t=fixture();let legacy=0;
 const service=createJiraIssueService(async(path,method,body)=>{
  if(path.startsWith('issue/createmeta/'))throw Object.assign(new Error('older server'),{statusCode:404});
  if(path.startsWith('issue/createmeta?'))legacy++;
  return t.request(path,method,body);
 });
 const types=await service.options('OPAY-720','subtask') as any[];
 assert.equal(types[0].name,'子任务');assert.equal(legacy,1);assert.ok(types[0].fields.some((x:any)=>x.id==='summary'&&x.required));
 const modern=await t.service.options('OPAY-720','subtask') as any[];assert.equal(modern[0].id,'3');
 assert.ok(t.calls.some(x=>x.path.includes('issuetypes/3?startAt=0')));
});
