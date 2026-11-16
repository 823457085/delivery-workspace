<script setup lang="ts">
defineProps<{ title: string; description: string; loading?: boolean; updatedAt?: number }>();
defineEmits<{ refresh: [] }>();
</script>
<template><header class="plugin-toolbar"><slot /><el-button :loading="loading" @click="$emit('refresh')">刷新数据</el-button></header></template>
<style scoped>.plugin-toolbar{display:flex;justify-content:flex-end;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:14px}.plugin-toolbar :deep(.el-button){margin:0}</style>
