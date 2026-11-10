<script setup lang="ts">
import { computed } from 'vue';
import { useJiraDevProject } from './useJiraDevProject';

const props = defineProps<{ selection: { path: string; baseBranch: string; branchName: string }; name?: string; index?: number; disabled: boolean; multiple: boolean }>();
const emit = defineEmits<{ edit: [key: 'baseBranch' | 'branchName', value: string]; remove: [] }>();
const projectName = computed(() => props.name || props.selection.path.split('/').filter(Boolean).at(-1) || props.selection.path);
const project = useJiraDevProject(computed(() => props.selection.path), branch => {
  if (!props.disabled && !props.selection.baseBranch) emit('edit', 'baseBranch', branch);
});
const branchSuggestions = (query: string, callback: (items: { value: string }[]) => void) =>
  callback((project.preferences.value?.branches || []).filter(item => item.toLowerCase().includes(query.toLowerCase())).slice(0, 50).map(value => ({ value })));
</script>

<template>
  <section class="project-fields" :class="{ 'is-multiple': multiple }" :aria-label="`项目分支设置 ${selection.path}`">
    <header v-if="multiple" class="project-head">
      <span v-if="index" class="project-index">{{ index }}</span>
      <strong class="project-name" :title="projectName">{{ projectName }}</strong>
      <span class="project-path" :title="selection.path">{{ selection.path }}</span>
      <el-button v-if="!disabled" link class="project-remove" @click="emit('remove')">移除</el-button>
    </header>
    <div class="project-status">
      <div class="status-copy">
        <p class="status-branch">{{ project.status.error.value?.message || project.statusText.value.branch || (project.status.isFetching.value ? '正在读取项目状态…' : '') }}</p>
        <p v-if="project.statusText.value.changes" class="status-changes">{{ project.statusText.value.changes }}</p>
      </div>
      <el-button link @click="project.status.refetch()">重新读取</el-button>
    </div>
    <div class="two-columns">
      <el-form-item label="基准分支"><el-autocomplete :model-value="selection.baseBranch" :fetch-suggestions="branchSuggestions" maxlength="200" placeholder="已确认的远端基准分支" @update:model-value="emit('edit', 'baseBranch', $event)" /></el-form-item>
      <el-form-item label="工作分支"><el-input :model-value="selection.branchName" maxlength="200" placeholder="请输入工作分支名称" @update:model-value="emit('edit', 'branchName', $event)" /></el-form-item>
    </div>
    <details class="advanced"><summary>项目默认设置</summary><div class="preferences">
      <p class="hint">{{ project.preferenceStatus.value || '保存的默认值用于新任务预览。' }}</p>
      <el-button size="small" @click="project.loadPreferences()">读取候选与默认设置</el-button>
      <el-form-item label="默认基准分支"><el-autocomplete v-model="project.draft.baseBranch" :fetch-suggestions="branchSuggestions" :disabled="!project.preferences.value" /></el-form-item>
      <el-form-item label="技术方案归档"><el-select v-model="project.draft.designMode" :disabled="!project.preferences.value"><el-option value="default" label="团队默认目录" /><el-option value="custom" label="自定义目录" /><el-option value="local" label="仅保存本地" /></el-select></el-form-item>
      <p class="hint">{{ project.destinationSummary.value }}</p>
      <template v-if="project.draft.designMode === 'custom'">
        <el-form-item label="Confluence 站点"><el-input v-model="project.draft.site" maxlength="2000" placeholder="https://confluence.example.com" /></el-form-item>
        <div class="two-columns"><el-form-item label="空间 Key"><el-input v-model="project.draft.spaceKey" maxlength="100" /></el-form-item><el-form-item label="父页面 ID"><el-input v-model="project.draft.parentId" maxlength="32" /></el-form-item></div>
        <el-form-item label="目录名称"><el-input v-model="project.draft.title" maxlength="500" placeholder="技术方案-2027" /></el-form-item>
      </template>
      <el-button size="small" :loading="project.savingPreferences.value" :disabled="!project.preferences.value" @click="project.savePreferences()">保存项目默认设置</el-button>
    </div></details>
  </section>
</template>

<style scoped>
.project-fields{min-width:0}
.project-fields.is-multiple{padding:12px 14px;border:1px solid var(--ui-divider,var(--ui-border));border-radius:var(--ds-radius,10px);background:color-mix(in srgb,var(--ds-canvas,var(--ui-raised)) 38%,var(--ui-surface))}
.project-head{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:3px 8px;margin:0 0 10px;padding-bottom:8px;border-bottom:1px solid var(--ui-divider,var(--ui-border))}
.project-index{display:inline-grid;place-items:center;width:18px;height:18px;flex-shrink:0;border-radius:5px;background:var(--ds-canvas,var(--ui-raised));border:1px solid var(--ui-border);color:var(--ui-secondary);font:600 11px/1 var(--mono)}
.project-name,.project-path{grid-column:2;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.project-name{grid-row:1;font-size:13px;font-weight:600;color:var(--ui-text)}
.project-path{grid-row:2;color:var(--ui-secondary);font:11px/1.4 var(--mono)}
.project-remove{grid-column:3;grid-row:1 / 3;justify-self:end;margin:0;color:var(--ui-secondary)}
.project-remove:hover{color:var(--ui-danger)}
.two-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 12px}.project-fields :deep(.el-select),.project-fields :deep(.el-autocomplete){width:100%}
.project-fields>.two-columns :deep(.el-form-item){margin-bottom:12px}
.project-status{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 12px;padding:8px 12px;border-radius:var(--ds-radius-sm,8px);background:var(--ds-canvas,var(--ui-raised))}
.project-status>.el-button{flex-shrink:0;margin:0}
.project-fields.is-multiple .project-status{background:var(--ui-surface);border:1px solid var(--ui-divider,var(--ui-border))}
.status-copy{min-width:0;display:flex;flex-direction:column;gap:2px}
.status-branch{margin:0;font-size:12px;font-weight:500;line-height:1.5;color:var(--ui-text);overflow-wrap:anywhere}
.status-changes{margin:0;font-size:12px;line-height:1.5;color:var(--ui-secondary);overflow-wrap:anywhere}
.hint{margin:0 0 8px;font-size:12px;line-height:1.7;color:var(--ui-secondary);overflow-wrap:anywhere}
.advanced{margin:0}
.advanced summary{display:flex;align-items:center;gap:8px;width:fit-content;padding:2px 0;list-style:none;cursor:pointer;font-size:13px;color:var(--ui-secondary);transition:color var(--ds-fast,160ms) ease}
.advanced summary::-webkit-details-marker{display:none}
.advanced summary::before{content:'';width:5px;height:5px;margin:0 2px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform var(--ds-fast,160ms) ease}
.advanced[open]>summary::before{transform:rotate(45deg)}.advanced summary:hover{color:var(--ui-text)}
.preferences{display:flex;flex-direction:column;gap:4px;margin-top:10px;padding:12px;border-radius:var(--ds-radius-sm,8px);background:var(--ds-canvas,var(--ui-raised))}.preferences>.el-button{align-self:flex-start}
@container workspace-page (max-width:560px){.two-columns{grid-template-columns:minmax(0,1fr)}}
</style>
