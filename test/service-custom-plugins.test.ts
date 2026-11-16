import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPlugin as signHub, operations as signOperations } from '../plugins/sign-hub/application.js';
import { createPlugin as shanlian, operations as shanOperations } from '../plugins/shanlian/application.js';
import { serviceEndpoint } from '../plugins/_shared/service-client.js';
import { createCustomPluginRuntime } from '../server/plugins/custom-runtime.js';
import { createWorkspaceTodos } from '../server/workspace-todos.js';
import { createPluginApplications } from '../server/plugins/applications.js';
import { integrationCatalog } from '../shared/integration-plugins.js';
import { registeredWorkspaceSections } from '../src/pages/agent/workspace-navigation.js';

async function fixture(t:any, kind:'sign'|'shan') {
 const calls:any[]=[]; let unauthorized=false; let redirect=false;
 const server=http.createServer(async(req,res)=>{
  let text='';for await(const c of req)text+=c;const body=text?JSON.parse(text):undefined;
  calls.push({method:req.method,url:req.url,headers:req.headers,body});
  res.setHeader('Content-Type','application/json');
  if(redirect){res.writeHead(302,{Location:'/untrusted'});res.end('{}');return;}
  if(kind==='shan'&&req.url==='/api/session/login'){
   if(body.password!=='fixture-password'){res.writeHead(401);res.end(JSON.stringify({error:'管理账号或密码不正确。'}));return;}
   res.setHeader('Set-Cookie','shanlian_session=abcdef; HttpOnly; Path=/');res.end(JSON.stringify({authenticated:true,csrf:'fixture-csrf'}));return;
  }
  if(unauthorized){res.writeHead(401);res.end(JSON.stringify({error:'原始服务提示'}));return;}
  if(kind==='sign') assert.equal(req.headers.authorization,'Bearer fixture-token');
  if(kind==='shan'){assert.equal(req.headers.cookie,'shanlian_session=abcdef');if(req.method!=='GET')assert.equal(req.headers['x-csrf-token'],'fixture-csrf');}
  if(req.method==='DELETE'){res.writeHead(204);res.end();return;}
  res.end(JSON.stringify(req.url==='/api/accounts'?[{id:'account-1',name:'测试账号'}]:req.url==='/api/nodes'?{nodes:[{id:'node-1',name:'测试节点'}],selected:'node-1'}:{ok:true}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
 const endpoint=`http://127.0.0.1:${(server.address() as any).port}`;
 const configuration=kind==='sign'?{endpoint,token:'fixture-token'}:{endpoint,username:'admin',password:'fixture-password'};
 const host:any={configuration,dataDirectory:'',workspaceDirectory:'',mcp:{}};
 const plugin=kind==='sign'?signHub(host):shanlian(host);t.after(()=>plugin.close());
 return {plugin,calls,configuration,endpoint,setUnauthorized:(v:boolean)=>unauthorized=v,setRedirect:()=>redirect=true};
}
test('Sign Hub 使用真实 API 契约，写入确认不可重放、不接受任意路径',async t=>{
 const f=await fixture(t,'sign');
 assert.deepEqual(await f.plugin.request('read',{operation:'accounts'}),[{id:'account-1',name:'测试账号'}]);
 await assert.rejects(f.plugin.request('read',{operation:'account.checkin',input:{id:'account-1'}}),/确认/);
 await assert.rejects(f.plugin.request('read',{operation:'toString'}),/不支持/);
 await assert.rejects(f.plugin.request('read',{operation:'account',input:{id:'../settings'}}));
 const value:any=await f.plugin.request('preview',{operation:'account.checkin',input:{id:'account-1'}});
 assert.equal(f.calls.length,1,'预览不调用业务服务');
 assert.equal(JSON.stringify(value).includes('fixture-token'),false);
 await f.plugin.request('execute',{token:value.token});
 assert.equal(f.calls[1].url,'/api/accounts/account-1/checkin');
 await assert.rejects(f.plugin.request('execute',{token:value.token}),/失效/);
 const p:any=await f.plugin.request('preview',{operation:'account.delete',input:{id:'account-1'}});
 assert.equal(await f.plugin.request('execute',{token:p.token}),null,'204 正常完成');
 f.setUnauthorized(true);await assert.rejects(f.plugin.request('read',{operation:'accounts'}),/原始服务提示/);
 assert.equal(f.calls.length,4,'失败不会重放');
});
test('Shanlian 管理登录 Cookie/CSRF 留在后端，修改节点及代理须先确认',async t=>{
 const f=await fixture(t,'shan');
 const session=await f.plugin.request('session',{});assert.deepEqual(session,{authenticated:true,endpoint:f.endpoint});
 assert.equal(JSON.stringify(session).includes('csrf'),false);
 await f.plugin.request('read',{operation:'nodes'});
 await assert.rejects(f.plugin.request('read',{operation:'nodes.select',input:{id:'node-1'}}),/确认/);
 const p:any=await f.plugin.request('preview',{operation:'nodes.select',input:{id:'node-1'}});
 await f.plugin.request('execute',{token:p.token});
 assert.deepEqual(f.calls.at(-1).body,{id:'node-1'});
 assert.equal(f.calls.at(-1).headers.origin,f.endpoint);
 assert.equal(f.calls.filter(c=>c.url==='/api/session/login').length,1);
 f.setUnauthorized(true);
 const second:any=await f.plugin.request('preview',{operation:'connection',input:{action:'connect'}});
 await assert.rejects(f.plugin.request('execute',{token:second.token}),/原始服务提示/);
 assert.equal(f.calls.filter(c=>c.url==='/api/connection').length,1,'401 不重放写请求');
});
test('无配置、错误地址、跳转及已关闭调用被拒绝',async t=>{
 for(const create of [signHub,shanlian]){
  const p=create({configuration:{}} as any);assert.equal((await p.request('status',{}) as any).configured,false);
  await assert.rejects(p.request('read',{operation:create===signHub?'accounts':'nodes'}),/配置/);p.close();
 }
 for(const address of ['file:///etc/passwd','http://secret@localhost','https://example.test/path','https://example.test/?token=x'])assert.throws(()=>serviceEndpoint(address));
 const f=await fixture(t,'sign');f.setRedirect();await assert.rejects(f.plugin.request('read',{operation:'accounts'}),/无法连接/);assert.equal(f.calls.length,1);
 f.plugin.close();await assert.rejects(f.plugin.request('read',{operation:'accounts'}),/停止/);
});
test('两个可分发包独立安装、菜单、配置持久化、撤权及移除后停止访问',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'service-plugins-'));
 const todos=await createWorkspaceTodos(path.join(root,'todos'));
 const runtime=await createCustomPluginRuntime(path.join(root,'plugins'),todos),apps=createPluginApplications(runtime,async()=>{});
 t.after(async()=>{await apps.close();await runtime.close();await fs.rm(root,{recursive:true,force:true});});
 for(const [id,kind] of [['sign-hub','sign'],['shanlian','shan']] as const){
  const f=await fixture(t,kind),directory=path.resolve('plugins',id,'package'),p=await runtime.inspect(directory);
  assert.equal(integrationCatalog.some(item=>item.id===id),false);
  const input={directory,digest:p.digest,grants:p.manifest.permissions,confirmed:true,trustedLocalCode:true,showInMenu:true};
  await runtime.install(input);
  assert.equal(registeredWorkspaceSections([],runtime.list().plugins).some(menu=>menu.id===`custom:${id}`),true);
  const saved=await runtime.configure(id,{revision:(await runtime.configuration(id)).revision,values:f.configuration});
  assert.equal(JSON.stringify(saved).includes(kind==='sign'?'fixture-token':'fixture-password'),false);
  assert.ok((await apps.page(id)).javascript.length>0);
  await apps.call(id,{method:'read',input:{operation:kind==='sign'?'accounts':'nodes'}});
  await runtime.change(id,{enabled:false});apps.stop(id);assert.throws(()=>apps.call(id,{method:'status'}),/停用/);
  assert.equal(registeredWorkspaceSections([],runtime.list().plugins).some(menu=>menu.id===`custom:${id}`),false);
  await runtime.change(id,{enabled:true});assert.equal((await apps.call(id,{method:'status'}) as any).configured,true);
  await runtime.change(id,{grants:['storage.read']});apps.stop(id);await assert.rejects(apps.page(id),/授权/);
  await runtime.change(id,{remove:true});apps.stop(id);await assert.rejects(apps.page(id),/移除/);
  await runtime.install(input);assert.deepEqual(await runtime.applicationConfiguration(id),f.configuration);
 }
 const reloaded=await createCustomPluginRuntime(path.join(root,'plugins'),todos);t.after(()=>reloaded.close());
 assert.equal((await reloaded.configuration('sign-hub')).secrets.token,true);
 assert.equal((await reloaded.configuration('shanlian')).secrets.password,true);
});
test('后端覆盖两个服务的业务路由，旧固定页面和读取宿主令牌实现已移除',async()=>{
 assert.ok(Object.keys(signOperations).length>=30);assert.ok(Object.keys(shanOperations).length>=14);
 for(const file of ['server/sign-hub-session.ts','plugins/sign-hub/integration.json','plugins/shanlian/integration.json','src/features/sign-hub/SignHubPanel.vue','src/features/shanlian/ShanlianPanel.vue'])await assert.rejects(fs.access(file));
 const source=await fs.readFile('plugins/shanlian/ui.js','utf8');assert.equal(source.includes('fetch('),false);assert.equal(source.includes('history.replaceState'),false);
 for(const id of ['sign-hub','shanlian'])assert.equal((await fs.readFile(`plugins/${id}/package/ui.js`,'utf8')).includes('<iframe'),false);
});

test('确认保存参数快照，后续修改原对象不会改变待执行请求',async t=>{
 const f=await fixture(t,'sign');
 const input={id:'site-1',document:{name:'已预览名称',nested:{value:'before'}}};
 const preview:any=await f.plugin.request('preview',{operation:'site.update',input});
 input.document.nested.value='after';input.document.name='后续变更';
 await f.plugin.request('execute',{token:preview.token});
 assert.deepEqual(f.calls[0].body,{name:'已预览名称',nested:{value:'before'}});
 await assert.rejects(f.plugin.request('execute',{token:preview.token,document:{name:'替换'}}));
});
