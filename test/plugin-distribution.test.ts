import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCustomPluginRuntime, fingerprint } from '../server/plugins/custom-runtime.js';
import { createWorkspaceTodos } from '../server/workspace-todos.js';
import { createPluginApplications } from '../server/plugins/applications.js';
import { createPluginDistribution, unpackRelease } from '../server/plugins/distribution.js';
import { createThemeChannel } from '../packages/plugin-sdk/theme.js';
import { createHash } from 'node:crypto';

async function fixture(t:any, extra:any={}) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'plugin-distribution-'));
 const runtime=await createCustomPluginRuntime(path.join(root,'state'),await createWorkspaceTodos(path.join(root,'todos')));
 const apps=createPluginApplications(runtime,async()=>{});
 const distribution=createPluginDistribution(runtime,path.join(root,'tasks'),[{id:'local',name:'维护目录',location:path.join(root,'catalog.json')},{id:'offline',name:'离线目录',location:path.join(root,'missing.json')}],apps.stop);
 const manifest={apiVersion:1,hostApi:2,id:'test-package',name:'测试',version:'1.0.0',description:'',category:'application',theme:'full',compatibility:{protocol:1,sdk:'2.1.0'},permissions:['storage.read','application.local','conversation.compose'],capabilities:[{id:'storage.read',required:true,purpose:'读取',scope:'自身记录'},{id:'application.local',required:true,purpose:'运行',scope:'当前用户文件网络'},{id:'conversation.compose',required:false,purpose:'草稿',scope:'仅草稿'}],page:{title:'测试',kind:'application'},application:{frontend:'ui.js',styles:'ui.css',backend:'server.mjs'},records:{storage:'private',resourceType:'entry',fields:[{key:'title',label:'标题',type:'text',required:true}]},commands:[],...extra};
 const files={'plugin.json':JSON.stringify(manifest),'ui.js':'window.loaded=true;','ui.css':'body{}','server.mjs':'export function createPlugin(host){return {request(method,input){return {ok:true,method,input};}}}'};
 const envelope=()=>Buffer.from(JSON.stringify({format:'delivery-plugin/1',files:Object.fromEntries(Object.entries(files).map(([n,v])=>[n,Buffer.from(v).toString('base64')]))}));
 const release=path.join(root,'test-package-1.0.0.dwp'); await fs.writeFile(release,envelope());
 const inspect=()=>distribution.preview({localPath:release});
 const confirm=(p:any,changes:any={})=>distribution.confirm({id:p.id,token:p.token,digest:p.digest,permissionsDigest:p.permissionsDigest,grants:['storage.read','application.local'],confirmed:true,trustedLocalCode:true,...changes});
 t.after(async()=>{distribution.close();await apps.close();await runtime.close();await fs.rm(root,{recursive:true,force:true});});
 return {root,runtime,apps,distribution,manifest,files,envelope,release,inspect,confirm};
}
test('cancel or missing required consent has no registration or code execution; optional grant remains absent',async t=>{
 const f=await fixture(t), p=await f.inspect(); await f.distribution.cancel(p.id);
 assert.equal(f.runtime.list().plugins.length,0); await assert.rejects(f.confirm(p));
 const p2=await f.inspect(); await assert.rejects(f.confirm(p2,{trustedLocalCode:false}),/信任/); assert.equal(f.runtime.list().plugins.length,0);
 await assert.rejects(f.confirm(p2,{grants:['application.local']}),/必需/); assert.equal(f.runtime.list().plugins.length,0);
 const p3=await f.inspect();await f.confirm(p3);assert.deepEqual(f.runtime.list().plugins[0].grants,['storage.read','application.local']);
 await assert.rejects(f.apps.compose('test-package',{prompt:'not granted'}),/未获授权/);
 assert.equal((await f.distribution.getTask(p3.id)).status,'installed'); await assert.rejects(f.confirm(p3),/确认无效/);
});
test('changed checked snapshot or confirmation permission digest rejects installation',async t=>{
 const f=await fixture(t), p=await f.inspect();
 await assert.rejects(f.confirm(p,{permissionsDigest:'a'.repeat(64)}),/确认无效/);
 await fs.writeFile(path.join(p.directory,'ui.js'),'tampered');
 await assert.rejects(f.confirm(p),/变化/);assert.equal(f.runtime.list().plugins.length,0);assert.equal((await f.distribution.getTask(p.id)).status,'failed');
});
test('standalone package survives source removal; upgrades preserve preferences/data, failure preserves old version',async t=>{
 const f=await fixture(t), first=await f.inspect();await f.confirm(first,{showInMenu:true});
 await fs.unlink(f.release);assert.equal((await f.apps.call('test-package',{method:'hello'}) as any).ok,true);
 await f.runtime.saveNavigation({order:['tasks','custom:test-package'],icons:{'custom:test-package':'star'},groups:{'custom:test-package':'个人'}});
 await f.runtime.change('test-package',{grants:['storage.read','storage.write','application.local']}).then(()=>assert.fail(),()=>{});
 f.manifest.version='1.0.1';f.files['plugin.json']=JSON.stringify(f.manifest);await fs.writeFile(f.release,f.envelope());
 const p=await f.inspect();await f.confirm(p);
 assert.equal(f.runtime.list().plugins[0].showInMenu,true);assert.equal(f.runtime.list().navigation.icons['custom:test-package'],'star');assert.equal(f.runtime.list().navigation.groups?.['custom:test-package'],'个人');
 f.manifest.version='1.0.2';f.files['plugin.json']=JSON.stringify(f.manifest);await fs.writeFile(f.release,f.envelope());const bad=await f.inspect();await fs.writeFile(path.join(bad.directory,'ui.js'),'changed');await assert.rejects(f.confirm(bad));assert.equal(f.runtime.list().plugins[0].manifest.version,'1.0.1');
});
test('new configuration is pending and disabled; configuration survives reload and remove/reinstall',async t=>{
 const f=await fixture(t,{configuration:{fields:[{key:'secret',label:'密钥',type:'password',required:true}]}}), p=await f.inspect();await f.confirm(p);
 assert.equal(f.runtime.list().plugins[0].enabled,false);await assert.rejects(f.runtime.change('test-package',{enabled:true}),/待配置/);
 const c=await f.runtime.configuration('test-package');await f.runtime.configure('test-package',{revision:c.revision,values:{secret:'fixture-only'}});await f.runtime.change('test-package',{enabled:true});
 await f.runtime.change('test-package',{remove:true});assert.equal(f.runtime.list().plugins.length,0);
 const restored=await f.inspect();await f.confirm(restored);const configured=await f.runtime.configuration('test-package');assert.equal(configured.secrets.secret,true);assert.equal(configured.values.secret,undefined);
});
test('legacy manifest normalization stays digest-compatible and classified only at presentation',async t=>{
 const f=await fixture(t), legacy=JSON.parse(await fs.readFile('plugins/example-notes/plugin.json','utf8'));
 await fs.mkdir(path.join(f.root,'legacy'));await fs.writeFile(path.join(f.root,'legacy/plugin.json'),JSON.stringify(legacy));
 const p=await f.runtime.inspect(path.join(f.root,'legacy'));assert.equal(p.manifest.category,undefined);assert.equal(p.digest,fingerprint(p.manifest));
 await f.runtime.install({directory:p.source,digest:p.digest,grants:p.manifest.permissions,confirmed:true});
 assert.ok(f.runtime.list().plugins.some(p=>p.manifest.id===legacy.id));
});
test('catalog offline does not block local install; fixed metadata and package digests checked',async t=>{
 const f=await fixture(t);const p=await f.inspect();await f.distribution.cancel(p.id);
 const manifest=(await f.runtime.inspect(await (async()=>{const dir=path.join(f.root,'export');await unpackRelease(f.envelope(),dir);return dir;})())).manifest;
 const catalog={protocol:1,releases:[{id:f.manifest.id,version:'1.0.0',manifest,package:path.basename(f.release),sha256:createHash('sha256').update(f.envelope()).digest('hex')}]};await fs.writeFile(path.join(f.root,'catalog.json'),JSON.stringify(catalog));
 const result=await f.distribution.catalogs();assert.equal(result.sources[0].releases.length,1);assert.ok('error' in result.sources[1]);
 const r=catalog.releases[0];await assert.rejects(f.distribution.preview({catalogId:'local',id:r.id,version:r.version,sha256:'a'.repeat(64)}),/变化/);
 await fs.appendFile(f.release,' ');await assert.rejects(f.distribution.preview({catalogId:'local',id:r.id,version:r.version,sha256:r.sha256}),/摘要/);
});
test('malformed envelopes, traversal, symlinks, unsupported versions and oversize files rejected',async t=>{
 const f=await fixture(t);
 for(const files of [{'../escape':'YQ=='},{'plugin.json':Buffer.from(JSON.stringify({...f.manifest,hostApi:99})).toString('base64')},{'plugin.json':'@@@'}])await assert.rejects(unpackRelease(Buffer.from(JSON.stringify({format:'delivery-plugin/1',files})),path.join(f.root,'invalid')));
 await assert.rejects(unpackRelease(Buffer.alloc(41_000_001),path.join(f.root,'oversize')),/上限/);
 await fs.symlink(f.release,path.join(f.root,'link'));await assert.rejects(f.distribution.preview({localPath:path.join(f.root,'link')}),/符号/);
});
test('theme snapshot replay covers get-subscribe race, stale versions and cleanup',async()=>{
 const initial={id:'one',mode:'light' as const,instance:'frame-1',version:1,tokens:{background:'#fff',surface:'#fff',text:'#000',muted:'#888',border:'#ccc',accent:'#00f'}};
 const channel=createThemeChannel(initial);await channel.get();channel.accept({...initial,id:'two',version:2});const seen:number[]=[];const off=channel.subscribe(t=>seen.push(t.version));assert.deepEqual(seen,[2]);
 channel.accept({...initial,version:1});channel.accept({...initial,instance:'old-frame',version:100});channel.accept({...initial,version:3});assert.deepEqual(seen,[2,3]);off();channel.accept({...initial,version:4});assert.deepEqual(seen,[2,3]);channel.close();assert.equal(channel.accept({...initial,version:5}),false);
});
test('new required permission update needs explicit authorization and preserves old grant on refusal',async t=>{
 const f=await fixture(t);await f.confirm(await f.inspect());
 f.manifest.version='1.1.0';f.manifest.capabilities[2].required=true;f.files['plugin.json']=JSON.stringify(f.manifest);await fs.writeFile(f.release,f.envelope());
 await assert.rejects(f.confirm(await f.inspect()),/必需/);assert.equal(f.runtime.list().plugins[0].manifest.version,'1.0.0');
 await f.confirm(await f.inspect(),{grants:f.manifest.permissions});assert.equal(f.runtime.list().plugins[0].manifest.version,'1.1.0');
 await f.runtime.change('test-package',{grants:['storage.read']});f.apps.stop('test-package');assert.equal(f.runtime.list().plugins[0].enabled,false);assert.throws(()=>f.apps.call('test-package',{method:'hello'}),/撤回|停用/);
});
test('public capability calls bind caller scopes, provider version and revoked queue authorization',async t=>{
 const f=await fixture(t,{provides:[{name:'sample.data',version:1,methods:['read']}]}), p=await f.inspect();await f.confirm(p);
 const consumer={...f.manifest,id:'test-consumer',provides:undefined,permissions:[...f.manifest.permissions,'capabilities.call'],capabilities:[...f.manifest.capabilities,{id:'capabilities.call',required:false,purpose:'读取提供者',scope:'sample.data@1 read'}],consumes:[{name:'sample.data',version:1,methods:['read']}]};
 const dir=path.join(f.root,'consumer');await fs.mkdir(dir);
 for(const [name,value] of Object.entries(f.files))await fs.writeFile(path.join(dir,name),name==='plugin.json'?JSON.stringify(consumer):name==='server.mjs'?`export function createPlugin(host){return {request(){return host.capabilities.call('sample.data','read',{test:true});}}}`:value);
 const checked=await f.runtime.inspect(dir);await f.runtime.install({directory:dir,digest:checked.digest,confirmed:true,trustedLocalCode:true,grants:consumer.permissions});
 const value:any=await f.apps.call('test-consumer',{method:'invoke'});assert.equal(value.method,'read');assert.deepEqual(value.input,{test:true});
 await assert.rejects(f.apps.capabilityCall('test-consumer',{name:'sample.data',version:1,method:'execute'}),/未声明/);
 await f.runtime.change('test-consumer',{grants:['storage.read','application.local']});f.apps.stop('test-consumer');await assert.rejects(f.apps.capabilityCall('test-consumer',{name:'sample.data',version:1,method:'read'}),/未获授权/);
});
test('remote directory transport rejects redirects, declared oversize, streaming oversize and malformed metadata',async t=>{
 const f=await fixture(t);const fetcher=globalThis.fetch;
 const remote=createPluginDistribution(f.runtime,path.join(f.root,'remote-tasks'),[{id:'remote',name:'维护者 HTTPS',location:'https://catalog.invalid/catalog.json'}],f.apps.stop);t.after(()=>{globalThis.fetch=fetcher;remote.close();});
 globalThis.fetch=(async(_url:any,options:any)=>{assert.equal(options.redirect,'error');throw new TypeError('redirect rejected');}) as any;
 assert.ok((await remote.catalogs()).sources[0].error);
 globalThis.fetch=(async()=>new Response('{}',{headers:{'Content-Length':'3000000'}})) as any;assert.match((await remote.catalogs()).sources[0].error!,/上限/);
 globalThis.fetch=(async()=>new Response('x'.repeat(2_000_001))) as any;assert.match((await remote.catalogs()).sources[0].error!,/上限/);
 globalThis.fetch=(async()=>new Response('{broken')) as any;assert.ok((await remote.catalogs()).sources[0].error);
});

async function remoteFixture(t:any, f:Awaited<ReturnType<typeof fixture>>) {
  const { createServer } = await import('node:http');
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const dir = path.join(f.root, 'remote-export'); await unpackRelease(f.envelope(), dir);
  const manifest = (await f.runtime.inspect(dir)).manifest;
  const release = {id:manifest.id, version:manifest.version, manifest, package:path.basename(f.release),sha256:createHash('sha256').update(f.envelope()).digest('hex')};
  const state = { offline:false, tamper:false, redirect:false, oversized:false, wrongResource:false, calls:0 };
  const catalog = {protocol:1, releases:[release]};
  const server = createServer(async (req,res) => {
    state.calls++;
    if(state.offline){res.writeHead(503);res.end('offline');return;}
    if(state.redirect){res.writeHead(302,{Location:'http://127.0.0.1:1/'});res.end();return;}
    if(state.oversized){res.writeHead(200,{'Content-Length':'999999999'});res.end();return;}
    if(req.url==='/mcp') {
      if(req.method!=='POST'){res.writeHead(405);res.end();return;}
      const chunks=[];for await(const c of req)chunks.push(c);
      const body=JSON.parse(Buffer.concat(chunks).toString());
      const mcp=new McpServer({name:'fixture-market',version:'1.0.0'});
      mcp.registerResource('catalog','plugin-market://catalog',{},async uri=>({contents:[{uri:state.wrongResource?'plugin-market://wrong':uri.href,text:JSON.stringify(catalog)}]}));
      mcp.registerResource('package',`plugin-market://packages/${release.package}`,{},async uri=>({contents:[{uri:uri.href,blob:(state.tamper?Buffer.from('bad'):f.envelope()).toString('base64')}]}));
      const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
      res.once('close',()=>{void mcp.close();});await mcp.connect(transport);await transport.handleRequest(req,res,body);return;
    }
    res.setHeader('Content-Type','application/json');
    res.end(req.url==='/catalog.json'?JSON.stringify(catalog):state.tamper?'bad':f.envelope());
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${(server.address() as any).port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  return {url,state,release};
}
for (const transport of ['http','mcp'] as const) test(`${transport} market connection: real protocol download, authorization, offline local management and tamper rejection`,async t=>{
  const f=await fixture(t), remote=await remoteFixture(t,f);
  let source={id:'configured',name:'配置的市场',location:remote.url+(transport==='mcp'?'/mcp':''),transport};
  const distribution=createPluginDistribution(f.runtime,path.join(f.root,'remote-tasks'),async()=>[source],f.apps.stop);
  t.after(()=>distribution.close());
  const sources=(await distribution.catalogs()).sources;
  assert.equal(sources[0].releases.length,1, sources[0].error);
  const selection={catalogId:source.id,id:remote.release.id,version:remote.release.version,sha256:remote.release.sha256};
  const preview=await distribution.preview(selection);
  assert.equal(f.runtime.list().plugins.length,0,'preview never installs');
  await distribution.cancel(preview.id);assert.equal(f.runtime.list().plugins.length,0);
  const allowed=await distribution.preview(selection);
  await distribution.confirm({id:allowed.id,token:allowed.token,digest:allowed.digest,permissionsDigest:allowed.permissionsDigest,grants:['storage.read','application.local'],confirmed:true,trustedLocalCode:true});
  assert.equal(f.runtime.list().plugins.length,1);assert.ok(!f.runtime.list().plugins[0].grants.includes('conversation.compose'));
  remote.state.offline=true;
  assert.match((await distribution.catalogs()).sources[0].error!,/503|offline/);
  assert.equal(f.runtime.list().plugins.length,1);await f.runtime.change(remote.release.id,{enabled:false});
  remote.state.offline=false;remote.state.tamper=true;
  await assert.rejects(distribution.preview(selection),/摘要/);
  assert.equal(f.runtime.list().plugins.length,1,'failed update keeps installed data');
  remote.state.tamper=false;remote.state.wrongResource=true;
  if(transport==='mcp')assert.match((await distribution.catalogs()).sources[0].error!,/不匹配/);
  remote.state.wrongResource=false;remote.state.redirect=true;
  assert.ok((await distribution.catalogs()).sources[0].error);remote.state.redirect=false;remote.state.oversized=true;
  assert.match((await distribution.catalogs()).sources[0].error!,/大小上限/);
  source={...source,location:'http://192.168.1.1'};
  assert.match((await distribution.catalogs()).sources[0].error!,/回环/);
});
