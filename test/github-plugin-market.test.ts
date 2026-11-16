import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createGithubReader } from '../server/plugins/github-catalog.js';
import { githubOptions, githubRepository } from '../server/plugins/github-source.mjs';
import { createPluginStore, readPluginFile } from '../server/plugins/store.mjs';
import { createPluginDistribution } from '../server/plugins/distribution.js';
import { createCustomPluginRuntime } from '../server/plugins/custom-runtime.js';
import { createWorkspaceTodos } from '../server/workspace-todos.js';
import type { CatalogSource } from '../server/plugins/catalog-transport.js';

const digest=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
async function fixture(kind:'market'|'plugin'='market') {
 const seed=JSON.parse(await fs.readFile('plugins/example-notes/plugin.json','utf8'));
 const calls:{url:string;headers:Headers}[]=[];
 const releases=[{id:2,tag_name:'v2.0.0',draft:false,prerelease:false},{id:1,tag_name:'v1.0.0',draft:false,prerelease:false},{id:3,tag_name:'v3.0.0',draft:false,prerelease:true},{id:4,tag_name:'v4.0.0',draft:true,prerelease:false}];
 const files=new Map<number,Buffer>(), manifests=new Map<number,any[]>(), assets=new Map<number,any[]>();
 for(const release of releases){
  const entries=[];const attached=[];
  for(const [index,id] of (kind==='market'?['fixture-notes','fixture-todos']:['fixture-notes']).entries()){
   const manifest={...seed,commands:[],id,version:release.tag_name.slice(1),permissions:['storage.read','storage.write'],capabilities:[{id:'storage.read',required:true,purpose:'读取自身记录',scope:'当前插件'},{id:'storage.write',required:false,purpose:'编辑自身记录',scope:'当前插件'}]};
   const bytes=Buffer.from(JSON.stringify({format:'delivery-plugin/1',files:{'plugin.json':Buffer.from(JSON.stringify(manifest)).toString('base64')}}));
   const name=`${id}-${manifest.version}.dwp`,assetId=release.id*10+index;
   files.set(assetId,bytes);attached.push({id:assetId,name,state:'uploaded',size:bytes.length,digest:`sha256:${digest(bytes)}`});
   entries.push({id,version:manifest.version,manifest,package:name,sha256:digest(bytes)});
  }
  manifests.set(release.id,entries);assets.set(release.id,attached);
 }
 const state={status:200,redirect:'',tamper:false,missing:false,move:false,cdn:false,oversize:false,sidecar:false};
 const mock:typeof fetch=async(input,init)=>{
  const url=new URL(String(input));calls.push({url:url.href,headers:new Headers(init?.headers)});
  if(url.hostname!=='api.github.com'){
   assert.equal(new Headers(init?.headers).has('authorization'),false);assert.equal(new Headers(init?.headers).has('cookie'),false);
   const data=files.get(20)!;return new Response(state.tamper?Buffer.from('changed'):data);
  }
  if(state.status!==200)return new Response('raw secret body must never appear',{status:state.status,headers:state.status===429?{'retry-after':'60'}:{}});
  if(state.move)return new Response(null,{status:301,headers:{location:'https://evil.test'}});
  const p=url.pathname;
  if(p.endsWith('/releases'))return Response.json(releases);
  if(p.includes('/releases/tags/'))return Response.json(releases.find(r=>r.tag_name===decodeURIComponent(p.split('/tags/')[1])));
  const releaseAssets=p.match(/\/releases\/(\d+)\/assets$/);
  if(releaseAssets){
   const list=structuredClone(assets.get(Number(releaseAssets[1]))!);
   if(state.sidecar){for(const a of list)a.digest=null;const a=list[0],data=Buffer.from(`${digest(files.get(a.id)!)}  ${a.name}\n`);files.set(99,data);list.push({id:99,name:a.name+'.sha256',size:data.length,state:'uploaded'});}
   if(state.oversize)list[0].size=41_000_001;
   return Response.json(list);
  }
  if(p.includes('/commits/')){const r=releases.find(r=>r.tag_name===decodeURIComponent(p.split('/commits/')[1]))!;return Response.json({sha:String(r.id).repeat(40)});}
  if(p.includes('/contents/')){
   if(state.missing)return new Response(null,{status:404});
   assert.ok(p.endsWith(kind==='market'?'market/catalog.json':'packages/notes/plugin.json'));
   const entries=manifests.get(Number(url.searchParams.get('ref')![0]))!;
   const raw=kind==='market'?{protocol:1,releases:entries}:entries[0].manifest;
   const bytes=Buffer.from(JSON.stringify(raw));return Response.json({type:'file',encoding:'base64',size:bytes.length,content:bytes.toString('base64')});
  }
  const asset=p.match(/\/releases\/assets\/(\d+)$/);
  if(asset){
   if(state.redirect)return new Response(null,{status:302,headers:{location:state.redirect}});
   if(state.cdn)return new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/download?signature=fixture'}});
   return new Response(state.tamper?Buffer.from('bad'):files.get(Number(asset[1])));
  }
  throw new Error(`unexpected fixture route ${p}`);
 };
 const source:CatalogSource={id:'github',name:'GitHub fixture',transport:'github',location:'https://github.com/maintainer/plugins',githubKind:kind,githubPath:kind==='market'?'market':'packages/notes',githubPolicy:'stable',githubToken:'fixture_private_token'};
 return {source,read:createGithubReader(mock),state,calls,releases,assets,files,manifests};
}

test('GitHub repository, relative directory and version selection validation reject unsafe inputs',()=>{
 assert.equal(githubRepository('https://github.com/Owner/Repo.git/').url,'https://github.com/Owner/Repo');
 for(const url of ['http://github.com/o/r','https://github.com.evil/o/r','https://token@github.com/o/r','https://github.com/o/r/tree/main','https://github.com/o/r?token=x'])assert.throws(()=>githubRepository(url));
 for(const githubPath of ['../secret','/etc','a//b','a/%2e%2e','a\\b'])assert.throws(()=>githubOptions({location:'https://github.com/o/r',githubPath}));
 assert.throws(()=>githubOptions({location:'https://github.com/o/r',githubPolicy:'pinned'}));
});

test('market repository discovers several plugins, pinned commit metadata, versions and pre-release policy',async()=>{
 const f=await fixture();
 let catalog=JSON.parse((await f.read(f.source,2_000_000)).toString());assert.equal(catalog.releases.length,4);
 assert.deepEqual([...new Set(catalog.releases.map((r:any)=>r.id))],['fixture-notes','fixture-todos']);
 catalog=JSON.parse((await f.read({...f.source,githubPolicy:'all'},2_000_000)).toString());assert.equal(catalog.releases.length,6);
 catalog=JSON.parse((await f.read({...f.source,githubPolicy:'pinned',githubRef:'v1.0.0'},2_000_000)).toString());assert.equal(catalog.releases.length,2);assert.equal(catalog.releases[0].version,'1.0.0');
 assert.ok(f.calls.filter(c=>c.url.includes('/contents/')).every(c=>/[?]ref=[123]{40}$/.test(c.url)));
 assert.equal(JSON.stringify(catalog).includes(f.source.githubToken!),false);
});

test('single-plugin repository uses tagged plugin.json and Release digest or SHA256 sidecar',async()=>{
 const f=await fixture('plugin');
 const catalog=JSON.parse((await f.read(f.source,2_000_000)).toString());assert.equal(catalog.releases.length,2);
 const bytes=await f.read(f.source,41_000_000,catalog.releases[0].package);assert.equal(digest(bytes),catalog.releases[0].sha256);
 f.state.sidecar=true;
 assert.equal(JSON.parse((await f.read({...f.source,githubPolicy:'pinned',githubRef:'v2.0.0'},2_000_000)).toString()).releases[0].sha256,digest(f.files.get(20)!));
 f.state.missing=true;await assert.rejects(f.read(f.source,2_000_000),/未发现兼容插件/);
});

test('GitHub asset redirects drop credentials and reject arbitrary hosts, insecure redirects and tampering',async()=>{
 const f=await fixture('plugin');const name='fixture-notes-2.0.0.dwp';
 f.state.cdn=true;await f.read(f.source,41_000_000,name);
 assert.ok(f.calls.some(c=>c.url.startsWith('https://release-assets.githubusercontent.com/')));
 assert.ok(f.calls.filter(c=>c.url.startsWith('https://api.github.com/')).every(c=>c.headers.get('authorization')==='Bearer fixture_private_token'));
 for(const redirect of ['https://evil.test/x','http://release-assets.githubusercontent.com/x','https://api.github.com/secret','https://user:pw@objects.githubusercontent.com/x']){
  f.state.redirect=redirect;await assert.rejects(f.read(f.source,41_000_000,name),/未允许地址/);
 }
 f.state.redirect='';f.state.tamper=true;await assert.rejects(f.read(f.source,41_000_000,name),/大小|摘要/);
 f.state.tamper=false;f.state.oversize=true;await assert.rejects(f.read(f.source,2_000_000),/过大/);
 f.state.oversize=false;f.state.move=true;await assert.rejects(f.read(f.source,2_000_000),/迁移/);
});

test('GitHub errors are actionable and never echo raw authentication responses',async()=>{
 const f=await fixture();
 for(const status of [401,403,404,429]){f.state.status=status;await assert.rejects(f.read(f.source,2_000_000),e=>e instanceof Error&&!/raw secret|fixture_private_token/.test(e.message)&&/GitHub/.test(e.message));}
});

test('GitHub credentials persist privately, clear explicitly and never cross repositories or protocols',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'github-config-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const file=path.join(root,'plugins.json'),store=await createPluginStore({file,env:{}});
 const input={enabled:true,transport:'github',baseUrl:'https://github.com/Owner/Repo',githubKind:'plugin',githubPolicy:'pinned',githubRef:'v1.0.0',githubToken:'private_fixture'};
 await store.save('plugin-market',input);
 assert.equal((await store.list()).find(p=>p.id==='plugin-market')!.githubTokenConfigured,true);
 assert.ok(!JSON.stringify(await store.list()).includes('private_fixture'));
 assert.equal((await store.catalogSources())[0].githubToken,'private_fixture');
 await store.save('plugin-market',{...input,baseUrl:'https://github.com/owner/repo.git',githubToken:''});assert.equal((await store.catalogSources())[0].githubToken,'private_fixture');
 await store.save('plugin-market',{...input,githubToken:'',clearGithubToken:true});assert.ok(!(await store.catalogSources())[0].githubToken);
 await store.save('plugin-market',input);await store.save('plugin-market',{...input,baseUrl:'https://github.com/Other/Repo',githubToken:''});assert.ok(!(await store.catalogSources())[0].githubToken);
 await store.save('plugin-market',input);await store.save('plugin-market',{enabled:true,transport:'http',baseUrl:'http://127.0.0.1:5499'});assert.equal((await readPluginFile(file)).plugins['plugin-market'].githubToken,undefined);
 assert.equal((await fs.stat(file)).mode&0o777,0o600);
});

for(const kind of ['market','plugin'] as const)test(`${kind} GitHub discovery feeds host verification, cancellation, actual grants and safe upgrades`,async t=>{
 const f=await fixture(kind),root=await fs.mkdtemp(path.join(os.tmpdir(),'github-install-'));
 const runtime=await createCustomPluginRuntime(path.join(root,'plugins'),await createWorkspaceTodos(path.join(root,'todos')));
 const d=createPluginDistribution(runtime,path.join(root,'tasks'),[f.source],()=>{},(s,l,p)=>f.read(s,l,p));
 t.after(async()=>{d.close();await runtime.close();await fs.rm(root,{recursive:true,force:true});});
 const catalog=await d.catalogs();assert.ok(!JSON.stringify(catalog).includes(f.source.githubToken!));
 const versions=catalog.sources[0].releases.filter(r=>r.id==='fixture-notes');assert.equal(versions.length,2);
 const select=(r:any)=>d.preview({catalogId:f.source.id,id:r.id,version:r.version,sha256:r.sha256});
 const confirm=(p:any)=>d.confirm({id:p.id,token:p.token,digest:p.digest,permissionsDigest:p.permissionsDigest,confirmed:true,grants:['storage.read']});
 const old=versions.find(r=>r.version==='1.0.0')!,latest=versions.find(r=>r.version==='2.0.0')!;
 const denied=await select(old);await d.cancel(denied.id);assert.equal(runtime.list().plugins.length,0);
 const installed=await select(old);await confirm(installed);assert.deepEqual(runtime.list().plugins[0].grants,['storage.read']);
 await runtime.saveNavigation({order:['custom:fixture-notes'],icons:{'custom:fixture-notes':'star'},groups:{'custom:fixture-notes':'个人'}});
 const updated=await select(latest);assert.equal(runtime.list().plugins[0].manifest.version,'1.0.0');
 const changed=JSON.parse(await fs.readFile(path.join(updated.directory,'plugin.json'),'utf8'));changed.description='tampered';await fs.writeFile(path.join(updated.directory,'plugin.json'),JSON.stringify(changed));await assert.rejects(confirm(updated),/变化/);assert.equal(runtime.list().plugins[0].manifest.version,'1.0.0');
 await confirm(await select(latest));assert.equal(runtime.list().plugins[0].manifest.version,'2.0.0');assert.equal(runtime.list().navigation.icons['custom:fixture-notes'],'star');
 f.state.tamper=true;await assert.rejects(select(latest),/大小|摘要/);assert.equal(runtime.list().plugins.length,1);
 f.state.status=429;assert.ok((await d.catalogs()).sources[0].error);assert.equal(runtime.list().plugins.length,1);
});


test('GitHub metadata drift, missing checksums and incompatible repositories fail before preview',async()=>{
 const f=await fixture('plugin');
 const original=f.assets.get(2)![0].digest;
 f.assets.get(2)![0].digest=null;
 await assert.rejects(f.read(f.source,2_000_000),/缺少 SHA256/);
 f.assets.get(2)![0].digest=original;
 f.manifests.get(2)![0].manifest.version='9.0.0';
 await assert.rejects(f.read(f.source,2_000_000),/标签必须/);
 const market=await fixture();market.manifests.get(2)![0].sha256='a'.repeat(64);
 await assert.rejects(market.read(market.source,2_000_000),/摘要不符/);
 const publicSource=await fixture();await publicSource.read({...publicSource.source,githubToken:undefined},2_000_000);
 assert.ok(publicSource.calls.every(c=>!c.headers.has('authorization')));
});
