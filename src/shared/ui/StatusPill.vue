<script setup lang="ts">
import { statusLabels, statusTone } from '../format';
defineProps<{ value?: string; label?: string }>();
</script>
<template><span class="status-pill" :class="statusTone(value)"><i></i>{{ label || statusLabels[value || ''] || value || '未记录' }}</span></template>
<style scoped>
.status-pill{display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border-radius:5px;background:var(--ui-accent-soft);color:var(--ui-secondary);font-size:12px;line-height:1.4;white-space:nowrap}.status-pill i{width:5px;height:5px;background:currentColor;border-radius:50%}.success{background:var(--ui-success-bg);color:var(--ui-success)}.warning{background:var(--ui-warning-bg);color:var(--ui-warning)}.danger{background:var(--ui-danger-bg);color:var(--ui-danger)}.primary{background:var(--ui-accent-soft);color:var(--ui-accent)}
</style>
