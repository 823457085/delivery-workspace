<script setup lang="ts">
// 操作栏自行管理对齐与留白，兼容独立页面和 Agent 内嵌面板，不依赖旧 Hub 外层样式。
defineProps<{ title: string; description: string; loading?: boolean; updatedAt?: number }>();
defineEmits<{ refresh: [] }>();
</script>
<template>
  <header class="page-heading" :aria-label="title">
    <div class="heading-actions"><slot /><el-button :loading="loading" @click="$emit('refresh')">刷新数据</el-button></div>
  </header>
</template>

<style scoped>
.page-heading{display:flex;align-items:center;justify-content:flex-end;min-height:46px;margin-bottom:16px}
.heading-actions{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:12px;min-width:0;max-width:100%;flex-shrink:1}
.heading-actions :deep(.el-button){min-height:36px;margin-left:0}
@media(max-width:550px){.page-heading{min-height:40px;margin-bottom:12px}.heading-actions{justify-content:flex-start}}
</style>
