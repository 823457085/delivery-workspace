<script setup lang="ts">
/**
 * 设计说明：访问权限是每轮 Agent 运行的独立边界，该组件只负责显示并选择边界。
 * 具体 CLI 参数由服务端映射；Plan/Ask 固定只读，不允许在此组件中隐式提权。
 */
import { computed } from 'vue';
import { Check, ChevronDown, ShieldAlert, ShieldCheck } from '@lucide/vue';
import type { AgentAccessMode, AgentRunMode } from '../../../shared/agent-runtime';

const props = withDefaults(defineProps<{ mode: AgentRunMode; disabled?: boolean }>(), { disabled: false });
const accessMode = defineModel<AgentAccessMode>({ required: true });
const readonly = computed(() => props.mode !== 'agent');
const label = computed(() => readonly.value ? '只读访问' : accessMode.value === 'full' ? '完全访问' : '工作区访问');

function select(command: unknown) {
  if (props.disabled || readonly.value || !['workspace', 'full'].includes(String(command))) return;
  accessMode.value = command as AgentAccessMode;
}
</script>

<template>
  <el-dropdown trigger="click" :disabled="disabled || readonly" popper-class="agent-access-popper" @command="select">
    <button type="button" class="access-trigger" :class="{ full: !readonly && accessMode === 'full' }" :disabled="disabled" :aria-label="`当前权限：${label}`">
      <ShieldAlert v-if="!readonly && accessMode === 'full'" :size="13" />
      <ShieldCheck v-else :size="13" />
      <span>{{ label }}</span>
      <ChevronDown v-if="!readonly" :size="11" />
    </button>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item command="workspace">
          <div class="access-option"><ShieldCheck :size="15" /><span><strong>工作区访问</strong><small>可修改所选仓库，可访问网络</small></span><Check v-if="accessMode === 'workspace'" :size="14" /></div>
        </el-dropdown-item>
        <el-dropdown-item command="full" divided>
          <div class="access-option danger"><ShieldAlert :size="15" /><span><strong>完全访问</strong><small>可访问网络和电脑上的任何文件</small></span><Check v-if="accessMode === 'full'" :size="14" /></div>
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<style scoped>
.access-trigger{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 9px;border:1px solid var(--agent-border,#343d4e);border-radius:7px;background:var(--agent-panel-strong,#202633);color:var(--agent-secondary,#aab3c3);font-size:10px;white-space:nowrap;cursor:pointer}.access-trigger:hover{border-color:var(--agent-accent,#746bd0);color:var(--agent-text,#fff)}.access-trigger.full{border-color:#c47a2f;background:#3a291b;color:#ffc27b}.access-trigger:disabled{cursor:default;opacity:.7}
.access-option{display:grid;grid-template-columns:18px minmax(0,1fr) 16px;align-items:center;gap:8px;width:260px;padding:3px 1px;color:#d9deea}.access-option>span{display:grid;gap:2px}.access-option strong{font-size:11px}.access-option small{color:#8f99ab;font-size:9px;line-height:1.45}.access-option.danger{color:#ffc27b}
:global(.agent-access-popper.el-popper){--el-bg-color-overlay:#202129;--el-text-color-regular:#c7c7d2;--el-fill-color-light:#302f43;border-color:#414250;background:#202129}:global(.agent-access-popper .el-dropdown-menu__item){padding:7px 10px}:global(.agent-access-popper .el-dropdown-menu__item:not(.is-disabled):focus){background:#302f43}
</style>
