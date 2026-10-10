<script setup lang="ts">
defineProps<{ loading: boolean; error: Error | null; hasData: boolean }>();
defineEmits<{ retry: [] }>();
</script>
<template><el-alert v-if="error" class="section-alert" type="error" :title="error.message" :closable="false" show-icon><el-button link @click="$emit('retry')">重新读取</el-button></el-alert><div v-if="loading && !hasData" class="surface loading-panel"><el-skeleton :rows="7" animated /><p>正在读取工作区数据，不会触发执行任务…</p></div><slot v-if="hasData" /></template>
