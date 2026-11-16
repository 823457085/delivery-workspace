<script setup lang="ts">
/** 设计说明：只为支持 Fast 的 Codex 模型显示输入区开关；具体选择由父组件保存，执行器覆盖由服务端负责，不修改全局配置。 */
import { computed } from 'vue';
import { Zap } from '@lucide/vue';
import type { AgentRuntimeHealth, AgentServiceTier } from '../../../shared/agent-runtime';
import { modelSpeed } from './model-speed';

const props = defineProps<{ runtime?: AgentRuntimeHealth; model: string; serviceTier?: AgentServiceTier }>();
const emit = defineEmits<{ 'update:serviceTier': [value: AgentServiceTier] }>();
const fast = computed(() => modelSpeed(props.runtime, props.model, 'priority'));
const enabled = computed(() => props.serviceTier === 'priority'
  || (props.serviceTier === undefined && ['fast', 'priority'].includes(props.runtime?.configuredServiceTier || '')));
</script>

<template>
  <el-tooltip v-if="fast" :content="enabled ? fast.description : 'Fast 已关闭'" placement="top">
    <button type="button" class="agent-model-speed" :class="{ enabled }" :aria-pressed="enabled"
      :aria-label="enabled ? '关闭 Fast 模式（下轮生效）' : '开启 Fast 模式（下轮生效）'"
      @click="emit('update:serviceTier', enabled ? 'default' : 'priority')">
      <Zap :size="14" fill="currentColor" aria-hidden="true" />
    </button>
  </el-tooltip>
</template>

<style scoped>
.agent-model-speed{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;flex-shrink:0;border:1px solid var(--ui-border);border-radius:8px;background:var(--ui-raised);color:var(--ui-muted);cursor:pointer;transition:background 300ms cubic-bezier(0.22,1,0.36,1),border-color 300ms cubic-bezier(0.22,1,0.36,1),color 300ms cubic-bezier(0.22,1,0.36,1)}.agent-model-speed:hover{border-color:var(--ui-accent);color:var(--ui-text)}.agent-model-speed.enabled{border-color:color-mix(in srgb,var(--ui-accent) 42%,var(--ui-border));background:var(--ui-accent-soft);color:var(--ui-accent)}.agent-model-speed:focus-visible{outline:2px solid var(--ui-accent);outline-offset:2px}
</style>
