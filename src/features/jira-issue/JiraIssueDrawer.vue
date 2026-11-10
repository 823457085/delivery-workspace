<script setup lang="ts">
import {computed,inject,ref,shallowRef,watch,onBeforeUnmount} from 'vue';
import {ElMessage,ElMessageBox} from 'element-plus';
import {ExternalLink,Star,Paperclip,ChevronDown,RefreshCw} from '@lucide/vue';
import type {JiraIssue} from '../../../shared/hub';
import type {JiraIssueDetail,JiraField,JiraPerson,JiraComment} from '../../../shared/jira-issue';
import {safeUrl,dateTime,day} from '../../shared/format';
import StatusPill from '../../shared/ui/StatusPill.vue';
import QueryState from '../../shared/ui/QueryState.vue';
import TaskDelivery from '../workbench/TaskDelivery.vue';
import {agentWorkspaceContext} from '../../shared/agent-workspace-context';
import {jiraQuickPrompt} from '../agent-workbench/agent-quick-actions';
import JiraDescription from './JiraDescription.vue';
import JiraFields from './JiraFields.vue';
import './jira-operation-dialog.css';
const props=defineProps<{issue?:JiraIssue;issueKey?:string}>();
const visible=defineModel<boolean>({required:true});
const emit=defineEmits<{changed:[];inspect:[key:string]}>();
const workspace=inject(agentWorkspaceContext,undefined);
const detail=shallowRef<JiraIssueDetail>(), loading=ref(false),busy=ref(false),error=shallowRef<Error|null>(null),uncertain=ref(false),tab=ref('details');
let controller:AbortController|undefined;
const key=computed(()=>props.issueKey||props.issue?.key||'');
const endpoint=(suffix='')=>`/api/jira/issues/${encodeURIComponent(key.value)}${suffix}`;
async function api<T>(suffix='',body?:unknown):Promise<T> {
 const response=await fetch(endpoint(suffix),{signal:controller?.signal,...(body===undefined?{}:{method:'POST',headers:{'X-Delivery-Confirmed':'yes',...(body instanceof FormData?{}:{'Content-Type':'application/json'})},body:body instanceof FormData?body:JSON.stringify(body)})});
 const result=await response.json();if(!response.ok)throw Object.assign(new Error(result.message||`请求失败 (${response.status})`),{uncertain:!!result.uncertain});return result;
}
async function refresh() {
 if(!key.value)return;const target=key.value;loading.value=true;
 try{const value=await api<JiraIssueDetail>();if(target!==key.value)return;detail.value=value;error.value=null;uncertain.value=false;if(value.warnings.length)ElMessage.warning(value.warnings[0]);}
 catch(cause){if(target===key.value && !(cause instanceof DOMException && cause.name==='AbortError'))error.value=cause as Error;}
 finally{if(target===key.value)loading.value=false;}
}

onBeforeUnmount(()=>controller?.abort());
const right=(permission:string)=>!!detail.value?.permissions[permission];
const disabled=computed(()=>busy.value||loading.value||uncertain.value);
const facts=computed(()=>detail.value?[['类型',detail.value.type],['优先级',detail.value.priority],['负责人',detail.value.assignee||'未指派'],['报告人',detail.value.reporter||'—'],['项目',detail.value.project.name],['修复版本',detail.value.fixVersions.join('、')||'未设置'],['组件',detail.value.components.join('、')||'未设置'],['标签',detail.value.labels.join('、')||'未设置'],['计划开始',day(detail.value.startDate)],['计划结束',day(detail.value.endDate)],['截止日期',day(detail.value.dueDate)],['创建时间',dateTime(detail.value.created)],['更新时间',dateTime(detail.value.updated)]]:[]);
const operation=ref(''),operationTitle:Record<string,string>={edit:'编辑事项',transition:'切换状态',assign:'指派事项',comment:'添加评论',link:'关联事项',subtask:'创建子任务',worklog:'登记工时'};
const descriptionExpanded=ref(false);
const values=ref<Record<string,any>>({}),original=ref<Record<string,any>>({}),meta=shallowRef<JiraField[]>([]),selectedId=ref(''),extra=ref<Record<string,any>>({});
const people=shallowRef<JiraPerson[]>([]),searching=ref(false),options=shallowRef<any[]>([]),preparing=ref(false),upload=ref<HTMLInputElement>();
const supported=(field:JiraField)=>!field.schema?.type||['string','date','number','boolean','user'].includes(field.schema.type)||!!field.allowedValues?.length||field.schema.type==='array'&&field.schema.items==='string';
const blockedForm=computed(()=>meta.value.some(field=>field.required&&!supported(field)));
const incomplete=computed(()=>['edit','transition','subtask'].includes(operation.value)?meta.value.some(field=>field.required&&field.defaultValue==null&&(values.value[field.id]==null||values.value[field.id]===''||Array.isArray(values.value[field.id])&&!values.value[field.id].length)):operation.value==='comment'?!String(extra.value.body||'').trim():operation.value==='link'?!selectedId.value||!String(extra.value.other||'').trim():operation.value==='worklog'?!extra.value.timeSpent||!extra.value.started:false);
function displayFields(fields:JiraField[],raw:Record<string,any>) {
 return Object.fromEntries(fields.map(field=>{const value=raw[field.id]??field.defaultValue;return [field.id,field.allowedValues?.length?field.schema?.type==='array'?(value||[]).map((x:any)=>String(x.id)):value?.id?String(value.id):'':field.schema?.type==='array'?value||[]:field.schema?.type==='user'?value?`${value.accountId?'accountId':'name'}:${value.accountId||value.name}`:'':value??''];}));
}
function payloadFields() {
 return Object.fromEntries(meta.value.map(field=>{let value=values.value[field.id];
  if(field.allowedValues?.length)value=field.schema?.type==='array'?(value||[]).map((id:string)=>({id})):value?{id:value}:null;
  else if(field.schema?.type==='user'){const [kind,...parts]=String(value).split(':');value=value?{[kind]:parts.join(':')}:null;}
  else if(field.schema?.type==='date')value=value||null;
  return [field.id,value];}));
}
let userSearch=0;
async function searchUsers(query:string) {const serial=++userSearch;searching.value=true;try{const list=await api<JiraPerson[]>(`/users?q=${encodeURIComponent(query)}`);if(serial===userSearch){const current=detail.value?.assigneeUser;people.value=current&&!list.some(item=>item.id===current.id)?[current,...list]:list;}}catch(cause){ElMessage.error((cause as Error).message);}finally{if(serial===userSearch)searching.value=false;}}
async function open(action:string,id='') {
 if(disabled.value||!detail.value)return;descriptionExpanded.value=false;operation.value=action;selectedId.value=id;values.value={};extra.value={};meta.value=[];options.value=[];
 if(action==='edit'){meta.value=detail.value.editFields;values.value=displayFields(meta.value,detail.value.fieldValues);original.value=JSON.parse(JSON.stringify(values.value));}
 if(action==='transition'){meta.value=detail.value.transitions.find(item=>item.id===id)?.fields||[];values.value=displayFields(meta.value,{});}
 if(action==='assign'){const user=detail.value.assigneeUser;people.value=user?[user]:[];selectedId.value=user?`${user.kind}:${user.id}`:'';await searchUsers('');}
 if(action==='link'||action==='subtask'){preparing.value=true;try{const list=await api<any[]>(`/options?action=${action}`);if(operation.value!==action)return;options.value=list;if(action==='subtask'&&options.value[0])selectType(options.value[0].id);}catch(cause){ElMessage.error((cause as Error).message);}finally{preparing.value=false;}}
 if(action==='link')extra.value={direction:'outward'};
 if(action==='worklog')extra.value={timeSpent:'',started:new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16),comment:'',adjustEstimate:'leave'};
}
function selectType(id:string){selectedId.value=id;meta.value=options.value.find(item=>item.id===id)?.fields||[];values.value=displayFields(meta.value,{});}
async function run(action:string,data:Record<string,unknown>={},file?:File) {
 if(disabled.value||!detail.value)return;busy.value=true;const target=key.value;
 try {
  const body=file?new FormData():{action,updated:detail.value.updated,values:data};
  if(body instanceof FormData){body.append('file',file!);body.append('updated',detail.value.updated);}
  const result=await api<{createdKey?:string}>('',body);if(target!==key.value)return;
  operation.value='';ElMessage.success(result.createdKey?`已创建 ${result.createdKey}`:'操作已保存');if(action==='comment')tab.value='comments';else if(['edit','subtask','link','attachment'].includes(action))tab.value='details';await refresh();emit('changed');
 }catch(cause){if(target===key.value){uncertain.value=!!(cause as {uncertain?:boolean}).uncertain;ElMessage.error((cause as Error).message);}}
 finally{busy.value=false;}
}
async function submit() {
 if(blockedForm.value){ElMessage.warning('此操作还有当前页面不支持的必填字段，请在 Jira 中完成');return;}
 const action=operation.value;
 if(action==='edit'){const changed=Object.fromEntries(Object.entries(payloadFields()).filter(([id])=>JSON.stringify(values.value[id])!==JSON.stringify(original.value[id])));if(!Object.keys(changed).length){ElMessage.info('没有修改字段');return;}await run(action,changed);}
 else if(action==='transition')await run(action,{id:selectedId.value,fields:payloadFields()});
 else if(action==='assign'){const user=people.value.find(item=>`${item.kind}:${item.id}`===selectedId.value);await run(action,user?{id:user.id,kind:user.kind}:{id:'',kind:'name'});}
 else if(action==='comment')await run(action,{body:extra.value.body||''});
 else if(action==='subtask')await run(action,{typeId:selectedId.value,fields:payloadFields()});
 else if(action==='link')await run(action,{typeId:selectedId.value,other:String(extra.value.other||'').trim().toUpperCase(),direction:extra.value.direction||'outward'});
 else if(action==='worklog'){const started=new Date(extra.value.started);if(!Number.isFinite(started.getTime())){ElMessage.warning('请选择工时开始时间');return;}await run(action,{...extra.value,started:started.toISOString().replace('Z','+0000')});}
}
async function uploadFile(event:Event){const input=event.target as HTMLInputElement,file=input.files?.[0];input.value='';if(!file)return;if(file.size>10*1024*1024){ElMessage.warning('请选择不超过 10 MB 的附件');return;}try{await ElMessageBox.confirm(`上传“${file.name}”到 ${key.value}？`,'确认上传',{confirmButtonText:'上传',cancelButtonText:'取消'});}catch{return;}await run('attachment',{},file);}
const worklogs=shallowRef<{total:number;items:any[]}>();
async function showWorklogs(){tab.value='worklog';try{worklogs.value=await api('/options?action=worklog');}catch(cause){ElMessage.error((cause as Error).message);}}
async function loadComments(){if(!detail.value)return;try{const result=await api<{comments:JiraComment[];total:number;next:number}>(`/comments?start=${detail.value.commentNext}`);detail.value={...detail.value,comments:[...detail.value.comments,...result.comments],commentNext:result.next,commentTotal:result.total};}catch(cause){ElMessage.error((cause as Error).message);}}
function inspect(key:string){emit('inspect',key);}
watch([visible,key],([open])=>{controller?.abort();controller=new AbortController();operation.value='';worklogs.value=undefined;detail.value=undefined;error.value=null;if(open){tab.value='details';void refresh();}},{immediate:true});
</script>
<template>
<el-drawer v-model="visible" class="jira-issue-drawer" size="min(1180px, 100vw)" append-to-body destroy-on-close :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy">
 <template #header="{ titleId }">
  <div :id="titleId" class="issue-heading">
   <a :href="safeUrl(detail?.url || issue?.url)" target="_blank" rel="noopener noreferrer">{{key}} <ExternalLink :size="12"/></a>
   <h2 v-if="detail?.summary || issue?.key === key">{{detail?.summary || issue?.summary}}</h2>
  </div>
 </template>
 <div class="issue-toolbar">
  <el-button :disabled="disabled || !right('EDIT_ISSUES')" :title="right('EDIT_ISSUES')?'':'当前账号没有编辑权限'" @click="open('edit')">编辑</el-button>
  <el-dropdown trigger="click" :disabled="disabled || !right('TRANSITION_ISSUES') || !detail?.transitions.length" @command="(id:string)=>open('transition',id)"><el-button :disabled="disabled || !right('TRANSITION_ISSUES') || !detail?.transitions.length">{{detail?.status || issue?.status || '切换状态'}} <ChevronDown :size="13"/></el-button><template #dropdown><el-dropdown-menu><el-dropdown-item v-for="item in detail?.transitions" :key="item.id" :command="item.id">{{item.name}}</el-dropdown-item></el-dropdown-menu></template></el-dropdown>
  <el-button :disabled="disabled || !right('ASSIGN_ISSUES')" @click="open('assign')">指派</el-button>
  <el-button :disabled="disabled || !right('ADD_COMMENTS')" @click="open('comment')">添加评论</el-button>
  <el-dropdown trigger="click" :disabled="disabled" @command="(action:string)=>action==='attachment'?upload?.click():open(action)"><el-button :disabled="disabled">更多操作 <ChevronDown :size="13"/></el-button><template #dropdown><el-dropdown-menu><el-dropdown-item command="subtask" :disabled="!right('CREATE_ISSUES')">创建子任务</el-dropdown-item><el-dropdown-item command="link" :disabled="!right('LINK_ISSUES')">关联事项</el-dropdown-item><el-dropdown-item command="attachment" :disabled="!right('CREATE_ATTACHMENTS')">上传附件</el-dropdown-item><el-dropdown-item command="worklog" :disabled="!right('WORK_ON_ISSUES')">登记工时</el-dropdown-item></el-dropdown-menu></template></el-dropdown>
  <button v-if="detail?.watching!==null && detail" class="watch-button" :class="{watching:detail.watching}" :disabled="disabled" @click="run('watch',{watching:!detail.watching})"><Star :size="15" :fill="detail.watching?'currentColor':'none'"/>{{detail.watching?'已关注':'关注'}}</button>
  <el-button text :disabled="busy" aria-label="刷新事项" @click="refresh"><RefreshCw :size="15"/></el-button>
  <input ref="upload" type="file" hidden @change="uploadFile">
 </div>
 <QueryState :loading="loading&&!detail" :error="error" :has-data="!!detail" @retry="refresh">
 <div v-if="detail" class="issue-layout">
  <main class="issue-main"><el-tabs v-model="tab">
   <el-tab-pane label="详情" name="details">
    <section class="issue-section"><h3>任务描述</h3><JiraDescription :text="detail.description" :html="detail.descriptionHtml" :base-url="detail.url"/></section>
    <section class="issue-section"><header><h3>附件 <small>{{detail.attachments.length}}</small></h3><el-button link :disabled="disabled || !right('CREATE_ATTACHMENTS')" @click="upload?.click()">上传附件</el-button></header><div v-if="detail.attachments.length" class="attachment-list"><a v-for="file in detail.attachments" :key="file.id" :href="endpoint(`/attachments/${file.id}`)" download><Paperclip :size="15"/><span>{{file.filename}}<small>{{Math.ceil(file.size/1024)}} KB · {{file.author}}</small></span></a></div><p v-else class="empty-line">暂无附件</p></section>
    <section class="issue-section"><header><h3>父子任务</h3><el-button link :disabled="disabled || !right('CREATE_ISSUES')" @click="open('subtask')">创建子任务</el-button></header><button v-if="detail.parent" class="relation-row" @click="inspect(detail.parent.key)"><span>父任务</span><strong>{{detail.parent.key}}</strong><span>{{detail.parent.summary}}</span></button><button v-for="item in detail.subtasks" :key="item.key" class="relation-row" @click="inspect(item.key)"><strong>{{item.key}}</strong><span>{{item.summary}}</span><StatusPill :value="item.status" :label="item.status"/></button><p v-if="!detail.parent&&!detail.subtasks.length" class="empty-line">暂无父子任务</p></section>
    <section class="issue-section"><header><h3>关联事项</h3><el-button link :disabled="disabled || !right('LINK_ISSUES')" @click="open('link')">添加关联</el-button></header><button v-for="item in detail.links" :key="item.id" class="relation-row" @click="inspect(item.key)"><span>{{item.relationship}}</span><strong>{{item.key}}</strong><span>{{item.summary}}</span><StatusPill :value="item.status" :label="item.status"/></button><p v-if="!detail.links.length" class="empty-line">暂无关联事项</p></section>
   </el-tab-pane>
   <el-tab-pane :label="`评论 ${detail.commentTotal}`" name="comments"><header class="section-actions"><h3>评论</h3><el-button :disabled="disabled || !right('ADD_COMMENTS')" @click="open('comment')">添加评论</el-button></header><article v-for="item in detail.comments" :key="item.id" class="comment"><header><strong>{{item.author}}</strong><time>{{dateTime(item.created)}}</time></header><JiraDescription :text="item.body" :html="item.html" :base-url="detail.url"/></article><p v-if="!detail.comments.length" class="empty-line">暂无评论</p><el-button v-if="detail.commentNext<detail.commentTotal" link @click="loadComments">加载更多评论</el-button></el-tab-pane>
   <el-tab-pane label="变更记录" name="history"><p v-if="detail.changes.length<detail.changeTotal" class="empty-line">已载入 {{detail.changes.length}} / {{detail.changeTotal}} 条记录，可在 Jira 查看完整历史。</p><article v-for="item in detail.changes" :key="item.id" class="comment"><header><strong>{{item.author}}</strong><time>{{dateTime(item.created)}}</time></header><p v-for="(change,index) in item.items" :key="index">{{change.field}}：{{change.from || '—'}} → {{change.to || '—'}}</p></article><p v-if="!detail.changes.length" class="empty-line">暂无变更记录</p></el-tab-pane>
   <el-tab-pane label="工时" name="worklog"><header class="section-actions"><el-button link @click="showWorklogs">读取工时记录</el-button><el-button :disabled="disabled || !right('WORK_ON_ISSUES')" @click="open('worklog')">登记工时</el-button></header><template v-if="worklogs"><article v-for="item in worklogs.items" :key="item.id" class="comment"><header><strong>{{item.author}} · {{item.timeSpent}}</strong><time>{{dateTime(item.started)}}</time></header><JiraDescription :text="item.comment"/></article><p v-if="!worklogs.items.length" class="empty-line">暂无工时记录</p><p v-if="worklogs.total>worklogs.items.length" class="empty-line">已载入 {{worklogs.items.length}} / {{worklogs.total}} 条，请在 Jira 查看更多。</p></template></el-tab-pane>
   <el-tab-pane label="关联 AI 交付" name="delivery" lazy><TaskDelivery :issue-key="key"/></el-tab-pane>
  </el-tabs></main>
  <aside class="issue-facts"><StatusPill :value="detail.status" :label="detail.status"/><dl><div v-for="[label,value] in facts" :key="label"><dt>{{label}}</dt><dd>{{value || '—'}}</dd></div></dl><el-button v-if="workspace" link @click="workspace.compose(jiraQuickPrompt({ key }))">带入会话</el-button><a :href="safeUrl(detail.url || issue?.url)" target="_blank" rel="noopener noreferrer">在 Jira 中打开 <ExternalLink :size="12"/></a></aside>
 </div>
 </QueryState>
 <el-dialog :model-value="!!operation" :title="`${operationTitle[operation] || ''} · ${key}`" :width="['edit','subtask'].includes(operation)?'min(920px, 96vw)':'min(640px, 96vw)'" top="6vh" class="jira-operation-dialog" :class="{'is-description-expanded':descriptionExpanded}" append-to-body destroy-on-close :close-on-click-modal="false" :close-on-press-escape="!busy && !descriptionExpanded" :show-close="!busy" @update:model-value="(value:boolean)=>{if(!value)operation=''}">
  <template #header="{titleId,titleClass}">
   <div class="jira-operation-heading"><h2 :id="titleId" :class="titleClass">{{operationTitle[operation] || ''}} <span class="jira-operation-key">{{key}}</span></h2><p v-if="operation!=='edit'">{{detail?.summary}}</p></div>
  </template>
  <el-skeleton v-if="preparing" :rows="3" animated/>
  <el-form v-else class="jira-operation-form" :class="{'is-grid':['edit','transition','subtask','worklog'].includes(operation)}" label-position="top" :disabled="busy" @submit.prevent="submit">
   <template v-if="['edit','transition','subtask'].includes(operation)"><p v-if="operation==='transition'" class="form-context jira-field-wide">{{detail?.status}} → {{detail?.transitions.find(item=>item.id===selectedId)?.to}}</p><el-form-item v-if="operation==='subtask'" class="jira-field-wide" label="事项类型"><el-select v-model="selectedId" popper-class="jira-operation-popper" @change="selectType"><el-option v-for="item in options" :key="item.id" :value="item.id" :label="item.name"/></el-select></el-form-item><JiraFields v-model="values" v-model:description-expanded="descriptionExpanded" :fields="meta" :users="people" :searching="searching" @search-users="searchUsers"/></template>
   <el-form-item v-if="operation==='assign'" label="负责人"><el-select v-model="selectedId" remote filterable clearable :remote-method="searchUsers" :loading="searching" placeholder="搜索可指派人员，留空取消指派" popper-class="jira-operation-popper" style="width:100%"><el-option v-for="user in people" :key="user.id" :value="`${user.kind}:${user.id}`" :label="user.label"/></el-select></el-form-item>
   <el-form-item v-if="operation==='comment'" label="评论内容" required><el-input v-model="extra.body" type="textarea" :rows="8" maxlength="50000"/></el-form-item>
   <template v-if="operation==='link'"><el-form-item label="关联类型" required><el-select v-model="selectedId" popper-class="jira-operation-popper"><el-option v-for="item in options" :key="item.id" :value="item.id" :label="item.name"/></el-select></el-form-item><el-form-item label="方向"><el-radio-group v-model="extra.direction"><el-radio value="outward">{{options.find(item=>item.id===selectedId)?.outward || '向外关联'}}</el-radio><el-radio value="inward">{{options.find(item=>item.id===selectedId)?.inward || '向内关联'}}</el-radio></el-radio-group></el-form-item><el-form-item label="事项编号" required><el-input v-model="extra.other" placeholder="如 OPAY-720"/></el-form-item></template>
   <template v-if="operation==='worklog'"><el-form-item label="耗费时间" required><el-input v-model="extra.timeSpent" placeholder="如 1h 30m"/></el-form-item><el-form-item label="开始时间" required><input v-model="extra.started" type="datetime-local" class="jira-datetime"></el-form-item><el-form-item label="工作说明" class="jira-field-wide"><el-input v-model="extra.comment" type="textarea" :rows="4"/></el-form-item><el-form-item label="剩余估算"><el-select v-model="extra.adjustEstimate" popper-class="jira-operation-popper"><el-option value="leave" label="保持不变"/><el-option value="auto" label="按本次工时自动扣减"/></el-select></el-form-item></template>
  </el-form>
  <template #footer><el-button :disabled="busy" @click="operation=''">取消</el-button><el-button type="primary" :loading="busy" :disabled="disabled || preparing || blockedForm || incomplete || operation==='subtask'&&!selectedId" @click="submit">{{operation==='transition'?'确认切换':operation==='comment'?'发表评论':operation==='subtask'?'创建子任务':'保存'}}</el-button></template>
 </el-dialog>
</el-drawer>
</template>
<style scoped>
:global(.jira-issue-drawer.el-drawer) {
  --el-drawer-padding-primary: clamp(14px, 2vw, 22px);
}
:global(.jira-issue-drawer .el-drawer__header) {
  flex: none;
  align-items: flex-start;
  gap: 12px;
  margin: 0;
  padding: 14px var(--el-drawer-padding-primary);
  border-bottom: 1px solid var(--ui-divider);
}
:global(.jira-issue-drawer .el-drawer__close-btn) {
  display: grid;
  flex: none;
  place-items: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border-radius: 8px;
  color: var(--ui-secondary);
}
:global(.jira-issue-drawer .el-drawer__close-btn:focus-visible) {
  outline: 2px solid var(--ui-accent);
  outline-offset: -2px;
}
:global(.jira-issue-drawer .el-drawer__body) {
  min-height: 0;
  padding-block: 16px;
  overscroll-behavior: contain;
}
.issue-main :deep(.el-empty){padding:12px 0;align-items:flex-start}.issue-main :deep(.el-empty__image){display:none}.issue-main :deep(.el-empty__description){margin:0}
.issue-heading{flex:1;min-width:0}
.issue-heading>a{display:inline-flex;align-items:center;gap:6px;color:var(--ui-accent);font-size:12px}
.issue-heading h2{margin:4px 0 0;font:600 18px/1.45 var(--sans,sans-serif);color:var(--ui-text);overflow-wrap:anywhere}
.issue-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:0 0 18px;border-bottom:1px solid var(--ui-divider)}.issue-toolbar .el-button+.el-button{margin:0}.watch-button{display:flex;align-items:center;gap:6px;margin-left:auto;border:0;border-radius:5px;padding:7px 9px;background:transparent;color:var(--ui-secondary);font-size:12px;cursor:pointer}.watching{color:var(--ui-accent);background:var(--ui-accent-soft)}
.issue-layout{display:grid;grid-template-columns:minmax(0,1fr) 250px;gap:30px}.issue-main{min-width:0}.issue-facts{min-width:0;padding:24px 0 20px 24px;border-left:1px solid var(--ui-divider)}.issue-facts dl{margin:20px 0}.issue-facts dl>div{display:grid;gap:5px;margin-bottom:19px}.issue-facts dt{font-size:12px;color:var(--ui-muted)}.issue-facts dd{margin:0;color:var(--ui-text);font-size:13px;line-height:1.7;overflow-wrap:anywhere}.issue-facts>a{display:flex;align-items:center;gap:5px;margin-top:20px;color:var(--ui-accent);font-size:12px}
.issue-section{padding:16px 0 24px;border-bottom:1px solid var(--ui-divider)}.issue-section h3,.section-actions h3{margin:0 0 15px;font-size:14px;font-weight:600;color:var(--ui-text)}.issue-section>header,.section-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.issue-section>header h3{margin:0}.issue-section h3 small{margin-left:6px;color:var(--ui-muted);font-weight:400}.empty-line{margin:12px 0;color:var(--ui-muted);font-size:12px;line-height:1.8}
.attachment-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:9px}.attachment-list>a{display:flex;gap:9px;align-items:flex-start;padding:12px;border:1px solid var(--ui-border);border-radius:7px;font-size:12px;color:var(--ui-accent)}.attachment-list small{display:block;margin-top:5px;color:var(--ui-muted);font-size:11px}
.relation-row{display:flex;gap:10px;align-items:center;width:100%;padding:12px 0;border:0;border-bottom:1px solid var(--ui-divider);background:transparent;text-align:left;cursor:pointer;font-size:12px;color:var(--ui-secondary)}.relation-row strong{flex:none;color:var(--ui-accent);font-weight:500}.relation-row>span:not(.status-pill){min-width:0;overflow-wrap:anywhere}.relation-row>.status-pill{margin-left:auto}
.comment{padding:18px 0;border-bottom:1px solid var(--ui-divider)}.comment>header{display:flex;gap:14px;align-items:center;margin-bottom:12px;font-size:12px}.comment time{color:var(--ui-muted);font-size:11px}.comment p{font-size:13px;line-height:1.8;color:var(--ui-secondary)}.form-context{font-size:13px;color:var(--ui-secondary)}.jira-datetime{width:100%;padding:8px;border:1px solid var(--ui-border);border-radius:5px;font:inherit;color:var(--ui-text);background:var(--ui-surface)}
@media(max-width:760px){.issue-layout{grid-template-columns:minmax(0,1fr);gap:0}.issue-facts{grid-row:auto;padding:18px 0;border-left:0;border-bottom:1px solid var(--ui-divider)}.issue-facts dl{display:grid;grid-template-columns:1fr 1fr;gap:15px}.issue-facts dl>div{margin:0}.issue-heading h2{font-size:17px}.issue-toolbar{gap:6px}.relation-row{flex-wrap:wrap}.watch-button{margin-left:0}}
</style>
