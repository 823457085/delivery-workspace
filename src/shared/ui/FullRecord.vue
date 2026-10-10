<script setup lang="ts">
import { computed } from 'vue';
import { safeUrl } from '../format';
defineOptions({ name: 'FullRecord' });
const props = defineProps<{ value: unknown }>();
const entries = computed(() => props.value && typeof props.value === 'object' ? Object.entries(props.value) : []);
</script>
<template><div v-if="value && typeof value === 'object'" class="record-tree"><details v-for="[key, child] in entries" :key="key"><summary><b>{{ key }}</b><span v-if="Array.isArray(child)">{{ child.length }} 项</span><span v-else-if="child && typeof child === 'object'">对象</span><span v-else>{{ String(child ?? '—').slice(0, 95) }}</span></summary><FullRecord :value="child" /></details></div><a v-else-if="typeof value === 'string' && safeUrl(value)" :href="safeUrl(value)" target="_blank" rel="noreferrer">{{ value }}</a><pre v-else class="record-value">{{ value == null ? '—' : String(value) }}</pre></template>
<style scoped>
.record-tree{padding:4px 0}.record-tree details{border-bottom:1px solid var(--ui-border);padding:8px 0}.record-tree summary{cursor:pointer;font-size:12px;line-height:1.7;color:var(--ui-secondary);overflow-wrap:anywhere}.record-tree b{color:var(--ui-text);font-weight:550;margin-right:12px}.record-tree span{color:var(--ui-secondary)}.record-tree .record-tree{padding-left:15px}.record-value{font:12px/1.9 var(--sans);white-space:pre-wrap;overflow-wrap:anywhere;padding:10px;background:var(--ui-accent-soft);border-radius:5px;margin:8px 0}a{display:block;padding:10px;color:var(--ui-accent);overflow-wrap:anywhere;font-size:12px}
</style>
