<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ChevronDown, Folder, GitBranch, Settings2 } from '@lucide/vue';
import type { ConversationWorkspace } from '../../../shared/conversation-workspaces';
const props=defineProps<{workspace:ConversationWorkspace;disabled?:boolean}>();
const emit=defineEmits<{manage:[id:string]}>();
const open=ref(false);
const projects=computed(()=>props.workspace.projectPaths.map((path,index)=>({
 path,name:path.replaceAll('\\','/').split('/').filter(Boolean).at(-1)||path,
 primary:index===0,branches:[...new Set(props.workspace.projectBranches?.[path]||[])],
})));
const branchCount=computed(()=>projects.value.reduce((count,project)=>count+project.branches.length,0));
watch(()=>props.workspace.id,()=>{open.value=false;});
function manage(){open.value=false;emit('manage',props.workspace.id);}
</script>
<template>
 <el-popover v-model:visible="open" trigger="click" placement="bottom-start" width="min(440px, calc(100vw - 24px))">
  <template #reference>
   <button type="button" class="workspace-summary" :aria-label="`查看工作区 ${workspace.name} 的项目与分支`" :aria-expanded="open" :title="workspace.name">
    <Folder :size="13"/><strong>{{workspace.name}}</strong><span>{{projects.length}} 个项目 · {{branchCount ? `${branchCount} 个分支` : '当前目录'}}</span><ChevronDown :size="12"/>
   </button>
  </template>
  <div class="workspace-details">
   <div class="workspace-details-heading"><strong>{{workspace.name}}</strong><span>工作区配置</span></div>
   <div class="workspace-project-list">
    <section v-for="project in projects" :key="project.path" class="workspace-project-detail">
     <div class="workspace-project-title"><Folder :size="13"/><strong>{{project.name}}</strong><small v-if="project.primary">主项目</small></div>
     <div class="workspace-project-path">{{project.path}}</div>
     <div class="workspace-project-branches">
      <span v-for="(branch,index) in project.branches" :key="branch" class="workspace-branch-tag" :class="{primary:index===0}" :title="`${branch}${index===0?' · 默认主分支':''}`"><GitBranch :size="11"/><b v-if="index===0" aria-label="默认主分支">*</b><span>{{branch}}</span></span>
      <small v-if="!project.branches.length">使用项目当前目录，未指定分支</small>
     </div>
    </section>
    <p v-if="!projects.length">此工作区暂未添加项目。</p>
   </div>
   <div class="workspace-details-footer"><small>* 为项目默认主分支；配置调整用于新会话。</small><button type="button" :disabled="disabled" @click="manage"><Settings2 :size="13"/>管理项目与分支</button></div>
  </div>
 </el-popover>
</template>
<style scoped>
.workspace-summary{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:min(420px,100%);height:24px;flex:0 0 auto;padding:0 8px;border:1px solid var(--ui-border);border-radius:var(--ds-radius-xs,6px);background:var(--ui-raised);color:var(--ui-muted);font:500 11px/1.4 var(--sans);cursor:pointer}.workspace-summary>svg{flex:none}.workspace-summary strong{min-width:0;max-width:150px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--ui-text);font-weight:500}.workspace-summary>span{white-space:nowrap;flex:none}.workspace-summary:hover,.workspace-summary[aria-expanded=true]{color:var(--ui-accent);border-color:var(--ui-accent);background:var(--ui-accent-soft)}.workspace-summary:focus-visible{outline:2px solid var(--ui-accent);outline-offset:2px}.workspace-details{color:var(--ui-text);font-size:12px}.workspace-details-heading{display:flex;align-items:center;gap:12px;padding-bottom:10px;border-bottom:1px solid var(--ui-border)}.workspace-details-heading strong{min-width:0;flex:1;overflow-wrap:anywhere}.workspace-details-heading>span{font-size:11px;color:var(--ui-muted);white-space:nowrap}.workspace-project-list{max-height:min(50dvh,360px);overflow:auto}.workspace-project-detail{padding:12px 0;border-bottom:1px solid var(--ui-border)}.workspace-project-title{display:flex;align-items:center;gap:6px}.workspace-project-title strong{min-width:0;overflow-wrap:anywhere}.workspace-project-title svg{flex:none;color:var(--ui-muted)}.workspace-project-title small{margin-left:auto;white-space:nowrap;color:var(--ui-accent);font-size:11px}.workspace-project-path{margin:5px 0 8px;color:var(--ui-muted);font-size:11px;line-height:1.5;overflow-wrap:anywhere}.workspace-project-branches{display:flex;flex-wrap:wrap;gap:6px}.workspace-branch-tag{display:inline-flex;align-items:center;gap:4px;max-width:100%;padding:3px 6px;border-radius:5px;border:1px solid var(--ui-border);background:var(--ui-raised);font-size:11px}.workspace-branch-tag span{overflow-wrap:anywhere;min-width:0}.workspace-branch-tag svg,.workspace-branch-tag b{flex:none}.workspace-branch-tag.primary{background:var(--ui-accent-soft);color:var(--ui-accent);border-color:color-mix(in srgb,var(--ui-accent) 30%,var(--ui-border))}.workspace-project-branches>small,.workspace-details-footer>small{font-size:11px;color:var(--ui-muted)}.workspace-details-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;padding-top:10px}.workspace-details-footer button{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--ui-border);border-radius:5px;background:var(--ui-surface);color:var(--ui-text);padding:5px 8px;font:inherit;cursor:pointer}.workspace-details-footer button:disabled{opacity:.5;cursor:not-allowed}
</style>
