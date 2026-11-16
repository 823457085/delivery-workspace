import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
// @ts-ignore Public worker module is plain ESM.
import { connectStdioMcp } from '../server/plugins/application-mcp.mjs';
test('stdio initializes, paginates tools, calls once, handles protocol errors and closes process',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'plugin-mcp-')), script=path.join(directory,'fixture.mjs');
 await fs.writeFile(script,`import readline from 'node:readline';let ready=false;
 const io=readline.createInterface({input:process.stdin});io.on('line',line=>{const m=JSON.parse(line);let result;
 if(m.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}}};
 else if(m.method==='notifications/initialized'){ready=true;return;}
 else if(!ready)process.exit(2);
 else if(m.method==='tools/list')result={tools:[{name:m.params.cursor?'second':'first'}],...(!m.params.cursor?{nextCursor:'page2'}:{})};
 else if(m.method==='tools/call'){if(m.params.name==='hang')return;if(m.params.name==='error'){console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32602,message:'SECRET'}}));return;}result={structuredContent:{pid:process.pid,args:m.params.arguments}};}
 console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));});`);
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const client=await connectStdioMcp({command:process.execPath,args:[script]});t.after(()=>client.close());
 assert.deepEqual((await client.listTools()).map((v:any)=>v.name),['first','second']);
 const result=await client.callTool('ok',{id:'one'});assert.equal(result.structuredContent.args.id,'one');
 await assert.rejects(client.callTool('error'),e=>e instanceof Error && !e.message.includes('SECRET'));
 await client.close();assert.throws(()=>process.kill(result.structuredContent.pid,0));await assert.rejects(client.callTool('ok'),/断开/);
 const timeout=await connectStdioMcp({command:process.execPath,args:[script],timeoutMs:200});await assert.rejects(timeout.callTool('hang'),/超时/);await timeout.close();
});
test('startup failure and invalid command reject without disclosing environment',async()=>{
 await assert.rejects(connectStdioMcp({command:'relative'}),/配置/);
 await assert.rejects(connectStdioMcp({command:'/missing/mcp',env:{SECRET:'fake-secret'}}),e=>e instanceof Error && !e.message.includes('fake-secret'));
});

test('host worker owns MCP lifetime and revoking native permission kills its child',async t=>{
 const {createCustomPluginRuntime}=await import('../server/plugins/custom-runtime.js');
 const {createWorkspaceTodos}=await import('../server/workspace-todos.js');
 const {createPluginApplications}=await import('../server/plugins/applications.js');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'mcp-lifecycle-')),pack=path.join(root,'package');await fs.mkdir(pack);
 const fixture=path.join(root,'fixture.mjs');await fs.writeFile(fixture,`import readline from 'node:readline';readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.id)return;console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}}}:{pid:process.pid}}))});`);
 const manifest=JSON.parse(await fs.readFile('plugins/alert-hub/plugin.json','utf8'));manifest.id='mcp-fixture';delete manifest.configuration;
 await fs.writeFile(path.join(pack,'plugin.json'),JSON.stringify(manifest));await fs.writeFile(path.join(pack,'ui.js'),'');await fs.writeFile(path.join(pack,'ui.css'),'');
 await fs.writeFile(path.join(pack,'server.mjs'),`export async function createPlugin(host){const c=await host.mcp.connect({command:${JSON.stringify(process.execPath)},args:[${JSON.stringify(fixture)}]});return {request:()=>c.callTool('pid')}}`);
 const runtime=await createCustomPluginRuntime(path.join(root,'plugins'),await createWorkspaceTodos(path.join(root,'todos'))),apps=createPluginApplications(runtime,async()=>{});
 t.after(async()=>{await apps.close();await runtime.close();await fs.rm(root,{recursive:true,force:true})});
 const inspected=await runtime.inspect(pack);await runtime.install({directory:pack,digest:inspected.digest,grants:manifest.permissions,confirmed:true,trustedLocalCode:true});
 const result:any=await apps.call(manifest.id,{method:'pid'});assert.ok(result.pid>0);
 await runtime.change(manifest.id,{grants:['storage.read']});apps.stop(manifest.id);
 assert.throws(()=>apps.call(manifest.id,{method:'pid'}),/授权/);
 let alive=true;for(let n=0;n<40;n++){try{process.kill(result.pid,0)}catch{alive=false;break}await new Promise(r=>setTimeout(r,100))}assert.equal(alive,false);
});

test('shutdown aborts MCP during initialization even when the child ignores SIGTERM',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'mcp-abort-')),script=path.join(root,'server.mjs'),pidFile=path.join(root,'pid');
 await fs.writeFile(script,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});process.stdin.resume();setInterval(()=>{},1000);`);
 t.after(()=>fs.rm(root,{recursive:true,force:true}));const abort=new AbortController();
 const started=connectStdioMcp({command:process.execPath,args:[script],signal:abort.signal});const rejected=assert.rejects(started,/关闭/);
 let pid=0;for(let n=0;n<40;n++){try{pid=Number(await fs.readFile(pidFile,'utf8'));break}catch{}await new Promise(r=>setTimeout(r,50))}
 assert.ok(pid>0);abort.abort();await rejected;assert.throws(()=>process.kill(pid,0));
});
