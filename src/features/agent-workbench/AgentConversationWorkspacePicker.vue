<script setup lang="ts">
import { computed, ref, defineAsyncComponent } from 'vue';
import AgentWorkspaceProjectBranch from './AgentWorkspaceProjectBranch.vue';
import { useWorkspacePicker } from '../../shared/useWorkspacePicker';
const WorkspaceBrowserDialog = defineAsyncComponent(() => import('../../shared/ui/WorkspaceBrowserDialog.vue'));
const picker = useWorkspacePicker();
import { Folder, ChevronDown, Plus, Settings2 } from '@lucide/vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { ConversationWorkspace } from '../../../shared/conversation-workspaces';
import type { AgentWorkspaceOption } from './workspace-catalog';
const props=defineProps<{groups:ConversationWorkspace[];projects:AgentWorkspaceOption[];disabled?:boolean;editorOnly?:boolean;saveWorkspace:(workspace:Omit<ConversationWorkspace,'id'>&{id?:string})=>Promise<ConversationWorkspace>}>();
const selected=defineModel<string>({default:''});
const open=ref(false),editing=ref(false),editingId=ref<string>(),name=ref(''),paths=ref<string[]>([]),primary=ref(''),saving=ref(false),query=ref(''),manualPath=ref('');
const projectQuery=ref('');
const projectBranches=ref<Record<string,string[]>>({});
const busy=computed(()=>saving.value);
const availableProjects=computed(()=>{
 const catalog=new Map(props.projects.map(project=>[project.path,project]));
 for(const path of paths.value)if(!catalog.has(path))catalog.set(path,{path,label:path.split('/').filter(Boolean).at(-1)||path,branch:'',source:'custom'});
 return [...catalog.values()].filter(project=>`${project.label} ${project.path} ${project.branch||''} ${(projectBranches.value[project.path]||[]).join(' ')}`.toLowerCase().includes(projectQuery.value.trim().toLowerCase()));
});
function toggleProject(path:string){if(paths.value.includes(path))paths.value=paths.value.filter(item=>item!==path);else if(paths.value.length<10)paths.value=[...paths.value,path];primary.value=paths.value[0]||'';}
const current=computed(()=>props.groups.find(g=>g.id===selected.value));
const filtered=computed(()=>props.groups.filter(g=>`${g.name} ${g.projectPaths.join(' ')}`.toLowerCase().includes(query.value.trim().toLowerCase())));
function edit(group?:ConversationWorkspace){open.value=false;editingId.value=group?.id;name.value=group?.name||'';paths.value=[...(group?.projectPaths||[])];projectBranches.value=structuredClone(group?.projectBranches?JSON.parse(JSON.stringify(group.projectBranches)):{});primary.value=paths.value[0]||'';manualPath.value='';projectQuery.value='';editing.value=true;}
function choose(id:string){selected.value=id;open.value=false;}
function addPath(){const path=manualPath.value.trim();if(!path.startsWith('/')){ElMessage.error('请输入项目的绝对目录');return;}if(!paths.value.includes(path)&&paths.value.length<10)paths.value=[...paths.value,path];primary.value=paths.value[0]||'';manualPath.value='';}
async function chooseFolder(){const selection=await picker.choose(primary.value);if(selection){manualPath.value=selection.workspacePath;addPath();}else if(picker.error.value)ElMessage.error(picker.error.value);}
async function save(){saving.value=true;try{const workspace=await props.saveWorkspace({...(editingId.value?{id:editingId.value}:{}),name:name.value,projectPaths:paths.value,projectBranches:Object.fromEntries(paths.value.filter(path=>projectBranches.value[path]?.length).map(path=>[path,projectBranches.value[path]]))});selected.value=workspace.id;editing.value=false;}catch(e){ElMessage.error(e instanceof Error?e.message:'保存工作区失败');}finally{saving.value=false;}}
function duplicate(group:ConversationWorkspace){
 edit(group); editingId.value=undefined;
 name.value=`${group.name.slice(0,97)} 副本`;
}
async function rename(group:ConversationWorkspace){
 try {
  await ElMessageBox.prompt('修改工作区名称，项目、分支和会话归属保持不变。','重命名工作区',{
   inputValue:group.name, inputPlaceholder:'工作区名称',confirmButtonText:'保存',cancelButtonText:'取消',
   inputValidator:value=>value?.trim()&&value.trim().length<=100 ? true : '请输入 1～100 字的工作区名称',
   beforeClose:async(action,instance,done)=>{
    if(instance.confirmButtonLoading)return;
    if(action!=='confirm'){done();return;}
    instance.confirmButtonLoading=true;
    try{
     const current=props.groups.find(item=>item.id===group.id);
     if(!current)throw new Error('工作区不存在，请刷新后重试');
     await props.saveWorkspace({id:current.id,name:instance.inputValue.trim(),projectPaths:current.projectPaths,projectBranches:current.projectBranches});
     done(); ElMessage.success('工作区已重命名');
    }catch(e){ElMessage.error(e instanceof Error?e.message:'重命名失败');}
    finally{instance.confirmButtonLoading=false;}
   },
  });
 }catch{/* 取消或关闭不保存。 */}
}
defineExpose({create:()=>edit(),edit,duplicate,rename});
</script>
<template>
 <div class="conversation-workspace-picker" :class="{'editor-only':editorOnly}">
  <el-popover v-if="!editorOnly" v-model:visible="open" trigger="click" placement="bottom-start" width="min(440px, calc(100vw - 24px))" :disabled="disabled">
   <template #reference><button class="workspace-trigger" type="button" :disabled="disabled"><Folder :size="14"/><span>{{current?.name||'选择工作区'}}</span><small v-if="current">{{current.projectPaths.length}} 个项目</small><ChevronDown :size="12"/></button></template>
   <div class="workspace-picker-head"><strong>选择工作区</strong><button type="button" @click="edit()"><Plus :size="13"/>新建工作区</button></div>
   <input v-model="query" class="workspace-query" aria-label="搜索工作区" placeholder="搜索工作区或项目目录">
   <div class="workspace-picker-options">
    <button type="button" class="workspace-choice" :class="{active:!selected}" @click="choose('')"><strong>不选择工作区</strong><small>独立会话，可稍后拖入工作区</small></button>
    <div v-for="group in filtered" :key="group.id" class="workspace-picker-row">
     <button type="button" class="workspace-choice" :class="{active:selected===group.id}" @click="choose(group.id)"><strong>{{group.name}}</strong><small>{{group.projectPaths.length}} 个项目 · {{group.projectPaths.map(p=>p.split('/').pop()).join('、')||'未添加项目'}}</small></button>
     <button type="button" class="workspace-edit" :aria-label="`编辑工作区 ${group.name}`" @click="edit(group)"><Settings2 :size="14"/></button>
    </div>
   </div>
  </el-popover>
  <el-dialog v-model="editing" :title="editingId?'编辑工作区':'新建工作区'" width="min(540px, calc(100vw - 24px))" append-to-body :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy">
   <div class="workspace-editor-fields">
    <label>工作区名称<el-input v-model="name" maxlength="100" placeholder="例如：商家业务" :disabled="busy"/></label>
    <label>包含的项目</label>
    <el-input v-model="projectQuery" placeholder="搜索项目名称、目录或分支" aria-label="搜索工作区项目" clearable/>
    <div class="workspace-project-options" role="group" aria-label="选择工作区项目">
     <div v-for="project in availableProjects" :key="project.path" class="workspace-project-option" :class="{selected:paths.includes(project.path)}">
      <label class="workspace-project-identity">
       <input type="checkbox" :checked="paths.includes(project.path)" :disabled="busy||(!paths.includes(project.path)&&paths.length>=10)" @change="toggleProject(project.path)">
       <span><strong>{{project.label}}</strong><small>{{project.path}}</small></span>
      </label>
      <div v-if="paths.includes(project.path)" class="workspace-project-details">
       <div class="workspace-project-primary"><small v-if="paths[0]===project.path">主项目</small><button v-else type="button" :disabled="busy" @click="paths=[project.path,...paths.filter(p=>p!==project.path)];primary=project.path">设为主项目</button></div>
       <AgentWorkspaceProjectBranch v-if="editing" :path="project.path" :model-value="projectBranches[project.path]||[]" :disabled="busy" @update:model-value="projectBranches[project.path]=$event"/>
      </div>
     </div>
     <p v-if="!availableProjects.length">{{projects.length?'没有匹配项目':'暂无已扫描项目，可选择本机目录或手动添加。'}}</p>
    </div>
    <div><el-button size="small" :loading="picker.selecting.value" :disabled="busy||paths.length>=10" @click="chooseFolder">选择其他项目目录…</el-button><small class="workspace-project-count">已选 {{paths.length}} / 10 个项目</small></div>
    <p>点击项目下方“+”添加分支，拖动标签到首位设为默认主分支（*）。新会话使用各分支对应的独立目录；留空则使用项目当前目录。保存配置不会切换原项目分支。</p>
    <div class="workspace-manual"><el-input v-model="manualPath" placeholder="其他项目的绝对目录" aria-label="其他项目目录" :disabled="busy" @keydown.enter.prevent="addPath"/><el-button :disabled="busy||!manualPath.trim()||paths.length>=10" @click="addPath">添加项目</el-button></div>

   </div>
   <template #footer><el-button :disabled="busy" @click="editing=false">取消</el-button><el-button type="primary" :loading="busy" :disabled="busy||!name.trim()" @click="save">保存工作区</el-button></template>
  </el-dialog>
  <WorkspaceBrowserDialog v-if="picker.browserOpen.value" :open="picker.browserOpen.value" :initial-path="picker.browserPath.value" @select="picker.completeBrowser" @cancel="picker.completeBrowser(null)" />
 </div>
</template>
<style scoped>
.editor-only{display:contents}
.workspace-trigger,.workspace-picker-head button,.workspace-edit{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--ui-border);background:var(--ui-surface);color:var(--ui-text);border-radius:6px;padding:6px 10px;cursor:pointer;font:inherit;font-size:12px}.workspace-trigger span{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.workspace-trigger small,.workspace-choice small{color:var(--ui-muted)}.workspace-picker-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}.workspace-query{width:100%;border:1px solid var(--ui-border);border-radius:6px;padding:8px;background:var(--ui-surface);color:var(--ui-text)}.workspace-picker-options{max-height:300px;overflow:auto;margin-top:8px}.workspace-picker-row{display:flex;align-items:center}.workspace-choice{display:grid;gap:4px;width:100%;text-align:left;background:transparent;border:1px solid transparent;border-radius:6px;padding:9px;color:var(--ui-text);cursor:pointer}.workspace-choice small{overflow-wrap:anywhere;font-size:11px}.workspace-choice.active,.workspace-choice:hover{background:var(--ui-accent-soft);border-color:var(--ui-accent)}.workspace-edit{flex:none;padding:6px;border:0}.workspace-editor-fields{display:grid;gap:12px;max-height:58dvh;overflow-y:auto;padding-right:4px}.workspace-editor-fields>label{display:grid;gap:6px}.workspace-editor-fields p{margin:0;color:var(--ui-muted);font-size:12px;line-height:1.6}.workspace-manual{display:flex;gap:8px}.workspace-editor-fields ul{list-style:none;padding:0;margin:0;max-height:120px;overflow:auto;flex-shrink:0}.workspace-editor-fields li{display:flex;align-items:center;gap:8px;padding:6px 0;font-size:12px}.workspace-editor-fields li span{flex:1;overflow-wrap:anywhere}.workspace-editor-fields li button{border:0;background:transparent;color:var(--ui-accent);cursor:pointer;white-space:nowrap}button:disabled{opacity:.5;cursor:not-allowed}
.workspace-project-options{max-height:320px;max-height:min(36dvh,320px);overflow:auto;border:1px solid var(--ui-border);border-radius:8px;padding:4px}.workspace-project-option{padding:8px;border-radius:6px}.workspace-project-option:hover,.workspace-project-option.selected{background:var(--ui-accent-soft)}.workspace-project-identity{display:flex;align-items:center;gap:10px;cursor:pointer}.workspace-project-identity>span{min-width:0;flex:1;display:grid;gap:3px}.workspace-project-option small{font-size:11px;color:var(--ui-muted);overflow-wrap:anywhere}.workspace-project-identity input{accent-color:var(--ui-accent);flex:none}.workspace-project-details{display:grid;gap:6px;margin:6px 0 0 25px;min-width:0}.workspace-project-primary{display:flex;align-items:center;font-size:11px}.workspace-project-primary button{padding:0;border:0;background:transparent;color:var(--ui-accent);font:inherit;cursor:pointer}.workspace-project-count{margin-left:10px;color:var(--ui-muted);font-size:11px}
</style>
