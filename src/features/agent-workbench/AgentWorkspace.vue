<script setup lang="ts">
/**
 * 设计说明：通过插槽由路由页面编排业务面板，会话控制面不复制其他业务域的数据。
 */
import AgentRuntimePanel from './AgentRuntimePanel.vue';
import { ref } from 'vue';
defineProps<{ workbenchOpen?: boolean }>();
const emit = defineEmits<{ chat: []; ready: [hasSession: boolean] }>();
const runtime = ref<InstanceType<typeof AgentRuntimePanel>>();
defineExpose({ openSession: (id: string) => runtime.value?.openSession(id) || false,
  openRun: (id: string) => runtime.value?.openRun(id), compose: (prompt: string) => runtime.value?.compose(prompt) });
</script>

<template>
  <AgentRuntimePanel ref="runtime" :workbench-open="workbenchOpen" @chat="emit('chat')" @ready="emit('ready', $event)">
    <template #navigation><slot name="navigation" /></template>
    <template #workbench="context"><slot name="workbench" v-bind="context" /></template>
  </AgentRuntimePanel>
</template>
