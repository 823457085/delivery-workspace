<script setup lang="ts">
/**
 * 设计说明：访问权限是每轮 Agent 运行的独立边界，该组件只负责显示并选择边界。
 * 具体 CLI 参数由服务端映射；Plan/Ask 固定只读，不允许在此组件中隐式提权。
 */
import { computed, watch } from 'vue';
import { Check, ChevronDown, ShieldAlert, ShieldCheck } from '@lucide/vue';
import type { AgentAccessMode, AgentProvider, AgentRunMode } from '../../../shared/agent-runtime';

const props = withDefaults(defineProps<{ mode: AgentRunMode; provider?: AgentProvider; disabled?: boolean; accessModes?: AgentAccessMode[]; allowModeChange?: boolean; modes?: AgentRunMode[] }>(), {
  disabled: false, accessModes: () => ['workspace', 'full'], allowModeChange: false, modes: () => [],
});
const accessMode = defineModel<AgentAccessMode>({ required: true });
const emit = defineEmits<{ modeChange: [mode: AgentRunMode]; selectionChange: [] }>();
const readonly = computed(() => props.mode !== 'agent');
const canChangeMode = computed(() => props.allowModeChange && !!props.modes?.includes('agent'));
const readonlyMode = computed<AgentRunMode | undefined>(() => props.mode !== 'agent' && props.modes?.includes(props.mode)
  ? props.mode : props.modes?.includes('ask') ? 'ask' : props.modes?.includes('plan') ? 'plan' : undefined);
const label = computed(() => readonly.value ? '只读访问' : accessMode.value === 'full' ? '完全访问' : '工作区访问');
watch([readonly, () => props.accessModes, accessMode], () => {
  if (readonly.value || !props.accessModes.includes(accessMode.value)) accessMode.value = 'workspace';
}, { immediate: true });

function select(command: unknown) {
  if (props.disabled) return;
  if (command === 'readonly') {
    if (!props.allowModeChange || !readonlyMode.value) return;
    emit('modeChange', readonlyMode.value);
    accessMode.value = 'workspace';
    emit('selectionChange');
    return;
  }
  if (!props.accessModes.includes(command as AgentAccessMode) || (readonly.value && !canChangeMode.value)) return;
  if (readonly.value) emit('modeChange', 'agent');
  accessMode.value = command as AgentAccessMode;
  emit('selectionChange');
}
</script>

<template>
  <el-dropdown trigger="click" :disabled="disabled || (readonly && !canChangeMode)" popper-class="agent-access-popper" @command="select">
    <button type="button" class="access-trigger" :class="{ full: !readonly && accessMode === 'full' }" :disabled="disabled" :aria-label="`当前权限：${label}`">
      <ShieldAlert v-if="!readonly && accessMode === 'full'" :size="13" />
      <ShieldCheck v-else :size="13" />
      <span>{{ label }}</span>
      <ChevronDown v-if="!readonly || canChangeMode" :size="11" />
    </button>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item v-if="allowModeChange && readonlyMode" command="readonly">
          <div class="access-option"><ShieldCheck :size="15" /><span><strong>只读访问</strong><small>只读分析，不修改工作区或外部系统</small></span><Check v-if="readonly" :size="14" /></div>
        </el-dropdown-item>
        <el-dropdown-item command="workspace" :disabled="!accessModes.includes('workspace')">
          <div class="access-option"><ShieldCheck :size="15" /><span><strong>工作区访问</strong><small>{{ provider === 'grok' || provider === 'deepseek' ? '可使用专用文件工具修改工作区；命令只读，无网络和子进程' : provider === 'kiro' ? '仅可读取和修改所选工作区文件，不执行命令' : provider === 'antigravity' ? '可修改所选工作区并在沙箱内运行命令；网络和工作区外访问受限' : '可修改所选仓库，可访问网络' }}</small></span><Check v-if="!readonly && accessMode === 'workspace'" :size="14" /></div>
        </el-dropdown-item>
        <el-dropdown-item command="full" divided :disabled="!accessModes.includes('full')">
          <div class="access-option danger"><ShieldAlert :size="15" /><span><strong>完全访问</strong><small>可访问网络和电脑上的任何文件</small></span><Check v-if="accessMode === 'full'" :size="14" /></div>
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<style scoped>
.access-trigger{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 10px;border:1px solid var(--ui-border);border-radius:8px;background:var(--ui-raised);color:var(--ui-secondary);font:500 12px/16px var(--sans);white-space:nowrap;cursor:pointer;transition:background 300ms cubic-bezier(0.22,1,0.36,1),border-color 300ms cubic-bezier(0.22,1,0.36,1),color 300ms cubic-bezier(0.22,1,0.36,1)}.access-trigger:hover{border-color:var(--ui-accent);background:var(--ui-hover);color:var(--ui-text)}.access-trigger.full{border-color:color-mix(in srgb,var(--ui-warning) 44%,var(--ui-border));background:var(--ui-warning-bg);color:var(--ui-warning)}.access-trigger:disabled{cursor:default;opacity:.7}
.access-option{display:grid;grid-template-columns:18px minmax(0,1fr) 16px;align-items:center;gap:8px;width:272px;padding:4px 2px;color:var(--ui-text)}.access-option>span{display:grid;gap:2px}.access-option strong{font:600 12px/16px var(--sans)}.access-option small{color:var(--ui-muted);font:400 12px/16px var(--sans);white-space:normal}.access-option.danger{color:var(--ui-warning)}
:global(.agent-access-popper.el-popper){--el-bg-color-overlay:var(--ui-surface);--el-text-color-regular:var(--ui-text);--el-fill-color-light:var(--ui-raised);border-color:var(--ui-border);border-radius:12px;background:var(--ui-surface);box-shadow:var(--ui-shadow)}:global(.agent-access-popper .el-dropdown-menu__item){padding:8px 10px;border-radius:8px}:global(.agent-access-popper .el-dropdown-menu__item:not(.is-disabled):focus){background:var(--ui-raised);color:var(--ui-text)}
</style>
