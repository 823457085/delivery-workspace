<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { host } from '../../shared/plugin-application-sdk';
import { confirmAction } from '../_shared/confirmation';
const tabs = [{id:'accounts',label:'账号与签到'},{id:'sites',label:'站点'},{id:'plugins',label:'站点适配器'},{id:'runs',label:'执行记录'},{id:'notifications',label:'通知记录'},{id:'backups',label:'备份'},{id:'system',label:'系统设置'}];
const tab=ref('accounts'), rows=ref<any[]>([]), query=ref(''), state=ref(''), busy=ref(false), error=ref(''), endpoint=ref(''), configured=ref(false), selected=ref<string[]>([]), result=ref<any>(), resultDialog=ref<HTMLDialogElement>();
const formDialog=ref<HTMLDialogElement>(), operation=ref(''), title=ref(''), target=ref(''), fields=ref<Field[]>([]), form=ref<Record<string,any>>({}), formError=ref(''), json=ref(''), jsonMode=ref(false), saving=ref(false);
type Field={key:string;label:string;type?:string;options?:string[]};
const filtered=computed(()=>rows.value.filter(row=>(!query.value||JSON.stringify(row).toLowerCase().includes(query.value.toLowerCase()))&&(!state.value||row.login_status===state.value)));
const statuses=computed(()=>[...new Set(rows.value.map(row=>row.login_status).filter(Boolean))]);
const columns=computed(()=>tab.value==='accounts'?['name','username','site_id','login_status','enabled','cron']:tab.value==='sites'?['name','plugin_id','configuration_message']:tab.value==='runs'?['account_id','action','status','message','started_at']:tab.value==='notifications'?['status','message','created_at']:tab.value==='backups'?['file_name','status','message','size']:['id','name','description']);
const labels:Record<string,string>={name:'名称',username:'账号',site_id:'站点',login_status:'登录状态',enabled:'启用',cron:'计划',plugin_id:'适配器',configuration_message:'配置状态',account_id:'账号 ID',action:'操作',status:'状态',message:'结果',started_at:'开始时间',created_at:'时间',file_name:'文件名',size:'大小',description:'说明',id:'ID'};
function display(value:any){return value===undefined?'—':typeof value==='object'?JSON.stringify(value):String(value);}
async function read(operation:string,input:any={}){return host.request('read',{operation,input});}
async function write(op:string,input:any){const p=await host.request('preview',{operation:op,input});if(!await confirmAction(`${p.label}\n服务：${p.endpoint}${p.target?'\n对象：'+p.target:''}\n${op==='accounts.checkin'?'账号：'+input.ids.join('、'):''}`))return {cancelled:true};return {cancelled:false,value:await host.request('execute',{token:p.token})};}
async function load(){busy.value=true;error.value='';selected.value=[];try{const info=await host.request('status');endpoint.value=info.endpoint;configured.value=info.configured;if(!info.configured){rows.value=[];return;}const data=await read(tab.value);rows.value=Array.isArray(data)?data:Array.isArray(data?.plugins)?data.plugins:[data];}catch(e:any){error.value=e.message;}finally{busy.value=false;}}
async function changeTab(id:string){if(busy.value)return;tab.value=id;query.value='';state.value='';rows.value=[];await load();}
function show(value:any){result.value=value;resultDialog.value?.showModal();}
async function detail(op:string,input:any={}){busy.value=true;error.value='';try{show(await read(op,input));}catch(e:any){error.value=e.message;}finally{busy.value=false;}}
async function action(op:string,input:any={}){busy.value=true;error.value='';try{const r=await write(op,input);if(!r.cancelled){await load();show(r.value??{ok:true});}}catch(e:any){error.value=e.message;}finally{busy.value=false;}}
function edit(op:string,label:string,values:any={},defs:Field[]=[],id=''){operation.value=op;title.value=label;target.value=id;form.value={...values};fields.value=defs;jsonMode.value=!defs.length;json.value=JSON.stringify(values,null,2);formError.value='';formDialog.value?.showModal();}
async function submit(){saving.value=true;formError.value='';try{let input=jsonMode.value?JSON.parse(json.value):{...form.value};if(target.value){if(['account.update','account.credentials','account.captcha-submit','site.update'].includes(operation.value)) input={id:target.value,document:input};else input={id:target.value,...input};}const r=await write(operation.value,input);if(!r.cancelled){formDialog.value?.close();form.value={};json.value='';await load();show(r.value??{ok:true});}}catch(e:any){formError.value=e.message;}finally{saving.value=false;}}
function createAccount(){edit('account.create','新增账号',{site_id:'',name:'',username:'',login_mode:'password',password:'',cookies:'',enabled:false,cron:'0 9 * * *',timezone:'Asia/Shanghai',daily:true},[
{key:'site_id',label:'站点 ID'},{key:'name',label:'名称'},{key:'username',label:'账号'},{key:'login_mode',label:'登录方式',options:['password','cookie']},{key:'password',label:'密码',type:'password'},{key:'cookies',label:'Cookie（Cookie 模式）',type:'password'},{key:'enabled',label:'启用定时签到',type:'checkbox'},{key:'cron',label:'Cron 计划'},{key:'timezone',label:'时区'},{key:'daily',label:'每日成功去重',type:'checkbox'}]);}
function editAccount(row:any){edit('account.update','账号计划',{name:row.name,enabled:row.enabled,cron:row.cron,timezone:row.timezone,daily:row.daily},[{key:'name',label:'名称'},{key:'enabled',label:'启用',type:'checkbox'},{key:'cron',label:'Cron'},{key:'timezone',label:'时区'},{key:'daily',label:'每日成功去重',type:'checkbox'}],row.id);}
function credentials(row:any){edit('account.credentials','更新登录凭据',{username:row.username,login_mode:row.login_mode,password:'',cookies:''},[{key:'username',label:'账号'},{key:'login_mode',label:'登录方式',options:['password','cookie']},{key:'password',label:'密码（留空沿用服务端现有密码）',type:'password'},{key:'cookies',label:'Cookie',type:'password'}],row.id);}
async function editSite(row:any){busy.value=true;try{edit('site.update','编辑站点配置',await read('site',{id:row.id}),[],row.id);}catch(e:any){error.value=e.message;}finally{busy.value=false;}}
async function template(row:any){busy.value=true;try{edit('site.create','从适配器模板创建站点',await read('plugin.template',{id:row.id}));}catch(e:any){error.value=e.message;}finally{busy.value=false;}}
async function settings(kind:string){busy.value=true;try{const v=await read(kind);if(kind==='server')edit('server.save','服务监听地址',{host:v.host,port:v.port},[{key:'host',label:'监听地址'},{key:'port',label:'端口',type:'number'}]);else edit('backup.save','WebDAV 备份配置',{url:v.url||'',username:v.username||'',password:'',backup_password:''},[{key:'url',label:'WebDAV 目录 URL'},{key:'username',label:'用户名'},{key:'password',label:'WebDAV 密码（空值保留）',type:'password'},{key:'backup_password',label:'备份加密密码（空值保留）',type:'password'}]);}catch(e:any){error.value=e.message;}finally{busy.value=false;}}
async function browserHelp(){try{await host.copy(endpoint.value);show({message:'服务地址已复制。浏览器助手依赖 Sign Hub 原生浏览器扩展及控制台会话：在独立浏览器打开该地址并完成管理登录，再安装浏览器助手并登录站点。插件支持直接导入 Cookie，浏览器扩展不在插件隔离页面内运行。'});}catch(e:any){error.value=e.message;}}
onMounted(load);
</script>
<template>
 <main class="console">
  <header class="toolbar"><h2>签到工作台</h2><span class="muted">{{endpoint||'尚未配置服务地址'}}</span><button :disabled="busy" @click="load">{{busy?'读取中…':'刷新'}}</button><button :disabled="!configured" @click="browserHelp">浏览器助手</button></header>
  <p v-if="error" role="alert" class="error">{{error}}</p>
  <section v-if="!configured&&!busy" class="card"><h3>配置 Sign Hub</h3><p>在工作台「功能插件 → Sign Hub → 配置」填写服务地址和管理员令牌，再刷新此页。令牌只在插件后端使用。</p></section>
  <template v-if="configured">
   <nav class="tabs" aria-label="Sign Hub 功能"><button v-for="item in tabs" :key="item.id" :disabled="busy" :class="{active:tab===item.id}" @click="changeTab(item.id)">{{item.label}}</button></nav>
   <div class="toolbar"><input v-model="query" aria-label="搜索当前列表" placeholder="搜索当前列表" style="max-width:300px"><select v-if="tab==='accounts'" v-model="state" aria-label="登录状态筛选" style="max-width:200px"><option value="">全部登录状态</option><option v-for="s in statuses" :key="s">{{s}}</option></select>
    <template v-if="tab==='accounts'"><button class="primary" :disabled="busy" @click="createAccount">新增账号</button><button :disabled="busy" @click="edit('accounts.import','批量导入账号',[])">批量导入</button><button :disabled="busy||!selected.length" @click="action('accounts.checkin',{ids:selected})">签到所选 ({{selected.length}})</button></template>
    <button v-if="tab==='sites'" :disabled="busy" @click="edit('site.create','新增站点配置',{id:'',name:'',plugin_id:'generic',base_url:''})">新增站点</button>
    <button v-if="tab==='plugins'" :disabled="busy" @click="action('plugins.reload')">重新加载适配器</button>
    <template v-if="tab==='backups'"><button :disabled="busy" @click="settings('backup.config')">备份配置</button><button :disabled="busy" @click="action('backup.test')">测试 WebDAV</button><button :disabled="busy" @click="action('backup.create')">创建备份</button><button :disabled="busy" @click="detail('backup.remote')">远端备份</button><button :disabled="busy" @click="edit('backup.restore','恢复备份',{file_name:'',password:'',confirm:true})">恢复备份</button></template>
    <button v-if="tab==='system'" :disabled="busy" @click="settings('server')">监听设置</button>
   </div>
   <section class="card scroll">
    <pre v-if="tab==='system'">{{JSON.stringify(rows[0],null,2)}}</pre>
    <table v-else-if="filtered.length"><thead><tr><th v-if="tab==='accounts'">选择</th><th v-for="col in columns" :key="col">{{labels[col]||col}}</th><th>操作</th></tr></thead><tbody><tr v-for="(row,index) in filtered" :key="row.id||index"><td v-if="tab==='accounts'"><input v-model="selected" type="checkbox" :value="row.id" :aria-label="'选择 '+row.name"></td><td v-for="col in columns" :key="col">{{display(row[col])}}</td><td class="actions">
    <template v-if="tab==='accounts'"><button :disabled="busy" @click="action('account.checkin',{id:row.id})">签到</button><button :disabled="busy" @click="action('account.login',{id:row.id})">登录</button><button :disabled="busy" @click="action('account.verify',{id:row.id})">验证</button><button @click="editAccount(row)">计划</button><button @click="credentials(row)">凭据</button><button :disabled="busy" @click="detail('account.captcha',{id:row.id})">验证码</button><button :disabled="busy" @click="action('account.captcha-get',{id:row.id})">获取验证码</button><button @click="edit('account.captcha-submit','提交验证码',{challenge_id:'',code:''},[],row.id)">提交验证码</button><button :disabled="busy" @click="detail('account.cookies',{id:row.id})">查看 Cookie</button><button @click="edit('account.cookies-save','导入 Cookie',{cookies:''},[{key:'cookies',label:'Cookie',type:'password'}],row.id)">导入 Cookie</button><button :disabled="busy" @click="detail('runs',{account_id:row.id})">记录</button><button class="danger" :disabled="busy" @click="action('account.delete',{id:row.id})">删除</button></template>
    <template v-else-if="tab==='sites'"><button :disabled="busy" @click="editSite(row)">编辑</button><button class="danger" :disabled="busy" @click="action('site.delete',{id:row.id})">删除</button></template>
    <template v-else-if="tab==='plugins'"><button :disabled="busy" @click="template(row)">使用模板</button></template>
    <button @click="show(row)">详情</button></td></tr></tbody></table>
    <p v-else class="empty">{{busy?'正在读取…':'暂无记录'}}</p>
   </section>
  </template>
  <dialog ref="formDialog" @cancel="form={};json=''">
   <h2>{{title}}</h2><div class="stack">
    <template v-if="!jsonMode"><label v-for="field in fields" :key="field.key" :class="{'checkbox-field':field.type==='checkbox'}">{{field.label}}
     <select v-if="field.options" v-model="form[field.key]"><option v-for="o in field.options" :key="o">{{o}}</option></select>
     <input v-else-if="field.type==='checkbox'" v-model="form[field.key]" type="checkbox">
     <input v-else-if="field.type==='number'" v-model.number="form[field.key]" type="number">
     <input v-else v-model="form[field.key]" :type="field.type||'text'" autocomplete="off">
    </label></template>
    <label v-else>配置 JSON（按服务端契约填写）<textarea v-model="json" rows="16" spellcheck="false"></textarea></label>
    <p v-if="formError" class="error" role="alert">{{formError}}</p><footer><button type="button" :disabled="saving" @click="formDialog?.close();form={};json=''">取消</button><button type="button" class="primary" :disabled="saving" @click="submit">{{saving?'处理中…':'预览并提交'}}</button></footer>
   </div>
  </dialog>
  <dialog ref="resultDialog"><h2>操作结果</h2><img v-if="result?.challenge?.image?.startsWith('data:image/')" :src="result.challenge.image" alt="验证码"><pre>{{JSON.stringify(result,null,2)}}</pre><footer><button @click="resultDialog?.close();result=undefined">关闭</button></footer></dialog>
 </main>
</template>
