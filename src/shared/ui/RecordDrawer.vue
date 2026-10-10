<script setup lang="ts">
import { ref, useId, watch } from 'vue';
import FullRecord from './FullRecord.vue';
defineProps<{ title: string; subtitle?: string; record: unknown }>();
const visible = defineModel<boolean>({ default: false });
const id = useId();
const tab = ref(`${id}-business`);
watch(visible, (open) => { if (open) tab.value = `${id}-business`; });
</script>
<template><el-drawer v-model="visible" :title="title" size="min(920px, 94vw)" class="hub-drawer" destroy-on-close><p v-if="subtitle" class="drawer-subtitle">{{ subtitle }}</p><el-tabs v-model="tab"><el-tab-pane label="业务详情" :name="`${id}-business`"><slot><FullRecord :value="record" /></slot></el-tab-pane><el-tab-pane label="完整原始记录" :name="`${id}-raw`"><FullRecord :value="record" /></el-tab-pane></el-tabs><template #footer><slot name="footer" /><el-button @click="visible = false">关闭</el-button></template></el-drawer></template>
