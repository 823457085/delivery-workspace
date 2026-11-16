import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import {createThemeChannel} from '../packages/plugin-sdk/theme.js';

test('browser SDK accepts only parent/current token, honors independent/mode themes and disposes pending listeners',async()=>{
 const source=(await fs.readFile('packages/plugin-sdk/dist/browser.js','utf8')).replace(/^import .*\n/,'').replaceAll('export function','function').replaceAll('export const','const')+'\nglobalThis.sdk=host;';
 for(const mode of ['full','mode','independent']){
  const listeners=new Map<string,Function>(),styles:any={setProperty:(k:string,v:string)=>{styles[k]=v;}},messages:any[]=[];
  const snapshot={id:'one',mode:'light',version:1,instance:'instance',tokens:{background:'#fff',surface:'#fff',text:'#111',muted:'#888',border:'#ccc',accent:'#00f'}};
  const parent={postMessage:(message:any)=>messages.push(message)},window={parent,__deliveryToken:'instance',__deliveryThemeMode:mode,__deliveryTheme:{'--ui-text':'#111'},__deliveryThemeSnapshot:snapshot,addEventListener:(k:string,v:Function)=>listeners.set(k,v),removeEventListener:(k:string)=>listeners.delete(k)};
  const context:any={window,document:{documentElement:{style:styles}},createThemeChannel,crypto:{randomUUID:()=>String(messages.length)},setTimeout:()=>1,clearTimeout:()=>{},Map,Error,Promise,console};vm.runInNewContext(source,context);
  const receive=listeners.get('message')!;
  receive({source:parent,data:{type:'delivery:response',token:'instance',id:messages[0].id,result:snapshot}});await Promise.resolve();
  const seen:number[]=[];context.sdk.theme.subscribe((t:any)=>seen.push(t.version));
  receive({source:{},data:{type:'delivery:theme',token:'instance',theme:{...snapshot,version:9}}});
  receive({source:parent,data:{type:'delivery:theme',token:'wrong',theme:{...snapshot,version:9}}});
  receive({source:parent,data:{type:'delivery:theme',token:'instance',theme:{...snapshot,mode:'dark',version:2},values:{'--ui-text':'#eee'}}});
  assert.deepEqual(seen,[1,2]);
  if(mode==='independent'){assert.equal(styles.colorScheme,undefined);assert.equal(styles['--ui-text'],undefined);}else if(mode==='mode'){assert.equal(styles.colorScheme,'dark');assert.equal(styles['--ui-text'],undefined);}else{assert.equal(styles.colorScheme,'dark');assert.equal(styles['--ui-text'],'#eee');}
  listeners.get('pagehide')!();assert.equal(listeners.has('message'),false);await assert.rejects(context.sdk.request('read'),/关闭/);
 }
});
