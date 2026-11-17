import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export function applicationManifest() {
  return {apiVersion:1,hostApi:2,id:'sample-application',name:'独立应用夹具',version:'1.0.0',description:'宿主协议测试',
    permissions:['storage.read','application.local','conversation.compose','workspace.open'],
    page:{title:'应用夹具',kind:'application'},application:{frontend:'ui.js',styles:'ui.css',backend:'server.mjs'},
    records:{storage:'private',resourceType:'note',fields:[{key:'title',label:'标题',type:'text',required:true}]},commands:[]};
}
export async function applicationFixture(t:any) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'host-application-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.writeFile(path.join(root,'plugin.json'),JSON.stringify(applicationManifest()));
  await fs.writeFile(path.join(root,'ui.js'),'');await fs.writeFile(path.join(root,'ui.css'),'');
  await fs.writeFile(path.join(root,'server.mjs'),`import fs from 'node:fs/promises';import path from 'node:path';import {spawn} from 'node:child_process';
export function createPlugin(host){let child;const file=path.join(host.dataDirectory,'note.json');return {
request:async(method,input)=>{if(method==='write'){await fs.writeFile(file,JSON.stringify(input));return input;}
if(method==='child'){child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});return {pid:child.pid};}
return {note:await fs.readFile(file,'utf8').then(JSON.parse).catch(()=>null),workspace:host.workspaceDirectory};},
close:()=>{child?.kill('SIGTERM');}};}`);
  return root;
}
