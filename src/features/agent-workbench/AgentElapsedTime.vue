<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue';
import { formatElapsedTime, type GroupElapsedTiming } from './group-elapsed';

const props = defineProps<{ timing?: GroupElapsedTiming }>();
const now = shallowRef(Date.now());
watch(() => [props.timing?.running, props.timing?.startedAt] as const, ([running], _, onCleanup) => {
  now.value = Date.now();
  if (!running) return;
  const timer = setInterval(() => { now.value = Date.now(); }, 1000);
  onCleanup(() => clearInterval(timer));
}, { immediate: true });
const elapsed = computed(() => props.timing
  ? formatElapsedTime((props.timing.running ? now.value : props.timing.endedAt ?? props.timing.startedAt) - props.timing.startedAt)
  : '');
</script>

<template>
  <span v-if="timing" class="agent-elapsed-time" role="timer" aria-live="off" :data-running="timing.running"
    title="本轮开始到当前或结束的总用时（含等待时间）">用时 {{ elapsed }}</span>
</template>

<style scoped>
.agent-elapsed-time{display:inline-block;flex-shrink:0;color:var(--agent-muted);font-size:11px;font-weight:400;font-variant-numeric:tabular-nums;white-space:nowrap}
</style>
