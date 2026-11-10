<script setup lang="ts">
defineProps<{ items: { label: string; value?: string | number | null; note?: string; tone?: string }[] }>();
</script>
<template>
  <section class="hub-metrics" aria-label="页面指标" :style="{ gridTemplateColumns: `repeat(${items.length}, minmax(0,1fr))` }">
    <article v-for="item in items" :key="item.label" class="metric-card" :class="{ 'is-zero': item.value === 0 || item.value === '0' }">
      <span>{{ item.label }}</span><strong :class="item.tone">{{ item.value ?? '—' }}</strong><small>{{ item.note }}</small>
    </article>
  </section>
</template>
