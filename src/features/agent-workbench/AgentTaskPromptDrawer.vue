<script setup lang="ts">
import { computed } from 'vue';

const prompt = defineModel<string>();
const open = computed({ get: () => !!prompt.value, set: value => { if (!value) prompt.value = undefined; } });
</script>

<template>
  <el-drawer v-model="open" title="完整提示词" size="min(760px, 94vw)" class="hub-drawer" append-to-body destroy-on-close>
    <pre class="task-prompt">{{ prompt }}</pre>
    <template #footer><el-button @click="open = false">关闭</el-button></template>
  </el-drawer>
</template>

<style scoped>
.task-prompt { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 1.8; color: var(--el-text-color-primary); }
</style>
