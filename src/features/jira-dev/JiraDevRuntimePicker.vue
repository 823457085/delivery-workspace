<script setup lang="ts">
/** 选择本次任务使用的 CLI、模型、推理强度和访问权限；仅影响新启动的会话。 */
import type { useJiraDevRuntime } from './useJiraDevRuntime';
import { jiraDevEffortLabels } from './useJiraDevRuntime';
import AgentCollaborationMode from '../agent-workbench/AgentCollaborationMode.vue';
defineProps<{ runtime: ReturnType<typeof useJiraDevRuntime>; disabled?: boolean }>();
</script>

<template>
  <div class="runtime-picker" role="group" aria-label="执行器与模型">
    <span class="runtime-label">执行</span>
    <AgentCollaborationMode v-model="runtime.automatic.value" :disabled="disabled" automatic-label="团队群聊" />
    <span v-if="runtime.automatic.value" class="team-summary">{{ runtime.team.value?.name || '正在读取团队' }} · {{ runtime.teamMembers.value.map(member => member.name).join('、') }} <a href="/agent?group=1">设置团队</a></span>
    <template v-if="!runtime.automatic.value">
    <el-select :model-value="runtime.selection.provider" class="runtime-provider" aria-label="CLI" :disabled="disabled" :loading="runtime.loading.value" @change="runtime.choose">
      <el-option v-for="item in runtime.runtimes.value" :key="item.provider" :value="item.provider" :label="item.label" :disabled="!item.ready">
        <span>{{ item.label }}</span><small v-if="!item.ready" class="runtime-unready">不可用</small>
      </el-option>
    </el-select>
    <el-select :model-value="runtime.modelPicker.model.value" class="runtime-model" filterable aria-label="模型" :disabled="disabled || !runtime.models.value.length" :empty-values="[null, undefined]" @change="runtime.chooseModel">
      <el-option v-for="item in runtime.models.value" :key="item.id || 'default'" :value="item.id" :label="item.label || item.id || 'CLI 默认模型'" />
    </el-select>
    <el-select v-if="runtime.efforts.value.length" v-model="runtime.modelPicker.effort.value" class="runtime-effort" aria-label="推理强度" :disabled="disabled" :empty-values="[null, undefined]">
      <el-option v-if="runtime.modelPicker.allowDefaultEffort.value" value="" label="模型默认" />
      <el-option v-for="effort in runtime.efforts.value" :key="effort" :value="effort" :label="`推理 ${jiraDevEffortLabels[effort]}`" />
    </el-select>
    </template>
    <el-select v-model="runtime.selection.accessMode" class="runtime-access" aria-label="访问权限" :disabled="disabled">
      <el-option v-for="mode in runtime.accessModes.value" :key="mode" :value="mode" :label="mode === 'full' ? '完全访问' : '仅工作区'" />
    </el-select>
    <small v-if="runtime.problem.value" class="runtime-problem" role="status">{{ runtime.problem.value }}</small>
  </div>
</template>

<style scoped>
.runtime-picker{display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-width:0}.runtime-label{font-size:12px;color:var(--ui-secondary)}
.runtime-provider{width:128px}.runtime-model{width:190px}.runtime-effort{width:112px}.runtime-access{width:112px}
.team-summary{font-size:12px;color:var(--ui-secondary);overflow-wrap:anywhere}.team-summary a{color:var(--ui-accent);margin-left:8px}
.runtime-unready{margin-left:8px;color:var(--ui-muted)}.runtime-problem{flex-basis:100%;color:var(--ui-warning);font-size:12px}
@container workspace-page (max-width:560px){
  .runtime-picker{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));width:100%}
  .runtime-label{display:none}
  .runtime-picker>.collaboration-mode,.runtime-problem{grid-column:1/-1;width:100%}
  .runtime-provider,.runtime-model,.runtime-effort,.runtime-access{width:100%;min-width:0}
}
</style>
