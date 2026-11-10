<script setup lang="ts">
/** 详情抽屉只承载各业务提供的内容，不自动追加内部字段快照。 */
defineProps<{ title: string; subtitle?: string; record: unknown }>();
const visible = defineModel<boolean>({ default: false });
</script>
<template><el-drawer v-model="visible" :title="title" size="min(920px, 94vw)" class="hub-drawer" destroy-on-close><p v-if="subtitle" class="drawer-subtitle">{{ subtitle }}</p><slot /><template #footer><slot name="footer" /><el-button @click="visible = false">关闭</el-button></template></el-drawer></template>
