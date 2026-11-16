<script setup lang="ts">
/**
 * 设计说明：启动器只收集需求与演示场景，具体 API 和状态刷新由父级 composable 负责。
 * 这让启动表单保持纯输入组件，也避免把演示流程误写成生产交付动作。
 */
import { shallowRef, watch } from 'vue';
import { Play } from '@lucide/vue';
import type { Requirement, Scenario } from '../../../shared/types';

const props = defineProps<{ requirements: Requirement[]; busy: boolean; contextAvailable: boolean }>();
const emit = defineEmits<{ start: [requirementId: string, scenario: Scenario] }>();
const requirementId = shallowRef('');
const scenario = shallowRef<Scenario>('standard');

watch(() => props.requirements, (items) => {
  if (!items.some((item) => item.id === requirementId.value)) requirementId.value = items[0]?.id || '';
}, { immediate: true });
</script>

<template>
  <section class="workflow-launcher" aria-label="启动演示流程">
    <header><span>启动新流程</span><small>本机演示</small></header>
    <select v-model="requirementId" aria-label="选择流程需求">
      <option v-for="item in requirements" :key="item.id" :value="item.id">{{ item.id }} · {{ item.title }}</option>
    </select>
    <div>
      <select v-model="scenario" aria-label="选择演示场景">
        <option value="standard">顺利交付</option>
        <option value="missing-evidence">缺少测试数据</option>
        <option value="merge-conflict">合入冲突</option>
      </select>
      <button type="button" :disabled="busy || !requirementId || !contextAvailable" @click="emit('start', requirementId, scenario)"><Play :size="11" />{{ busy ? '处理中' : '开始' }}</button>
    </div>
    <p v-if="!contextAvailable">请先选择一个 Agent 会话，流程会绑定其工作区与分支。</p>
  </section>
</template>

<style scoped>
.workflow-launcher{margin:0 0 14px;padding:11px 12px;border:1px solid var(--agent-border);border-radius:9px;background:var(--agent-panel-strong)}.workflow-launcher header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;color:var(--agent-secondary);font-size:12.5px;font-weight:600}.workflow-launcher header small{color:var(--agent-muted);font:11px var(--mono)}.workflow-launcher select{min-width:0;width:100%;height:30px;padding:0 8px;border:1px solid var(--agent-border);border-radius:6px;outline:0;background:var(--agent-bg);color:var(--agent-text);font-size:12px}.workflow-launcher>div{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px;margin-top:7px}.workflow-launcher button{display:inline-flex;align-items:center;gap:4px;min-height:30px;padding:0 11px;border:1px solid var(--agent-border);border-radius:6px;background:var(--agent-raised);color:var(--agent-text);font-size:12px;font-weight:500;cursor:pointer;transition:border-color 140ms ease,background-color 140ms ease}.workflow-launcher button:hover:not(:disabled){border-color:color-mix(in srgb,var(--agent-accent) 45%,var(--agent-border));background:var(--agent-panel)}.workflow-launcher button:disabled{opacity:.5;cursor:default}.workflow-launcher p{margin:8px 0 0;color:var(--agent-muted);font-size:11.5px;line-height:1.55}
</style>
