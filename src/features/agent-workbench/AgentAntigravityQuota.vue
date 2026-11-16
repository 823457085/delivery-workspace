<script setup lang="ts">
import type { AntigravityUsageLimits } from '../../../shared/agent-runtime';
import { antigravityUsageNote, antigravityWindowSummary, quotaPercent, quotaReset } from './usage-quota';

defineProps<{ usage?: AntigravityUsageLimits }>();

</script>

<template>
  <section class="antigravity-quota" aria-label="Antigravity 剩余额度">
    <h3>Antigravity 模型额度</h3>
    <template v-if="usage?.available && usage.groups.length">
      <small v-if="usage.stale" class="quota-unavailable">{{ antigravityUsageNote(usage) }}</small>
      <section v-for="group in usage.groups" :key="group.name" class="quota-group" :aria-label="group.name">
        <h4 :title="group.description">{{ group.name }}</h4>
        <div v-for="bucket in group.buckets" :key="bucket.id" class="quota-window">
          <div class="quota-summary"><span>{{ antigravityWindowSummary(bucket) }}</span><strong :class="{ exhausted: !usage.stale && !bucket.disabled && bucket.remainingPercent <= 0 }">{{ bucket.disabled ? '当前不适用' : `${usage.stale ? '上次剩余' : '剩余'} ${quotaPercent(bucket.remainingPercent)}` }}</strong></div>
          <div v-if="!bucket.disabled" class="quota-track" role="progressbar" :aria-label="`${group.name} · ${bucket.name}`" :aria-valuenow="bucket.remainingPercent" :aria-valuemin="0" :aria-valuemax="100"><i :style="{ width: `${bucket.remainingPercent}%` }"></i></div>
          <small v-if="!bucket.disabled">{{ usage.stale ? '上次记录的重置时间：' : bucket.remainingPercent <= 0 ? '额度已用尽，下次重置：' : '下次重置：' }}{{ quotaReset(bucket.resetsAt) }}</small>
        </div>
      </section>
      <details class="quota-original"><summary>原始额度信息</summary><section v-for="group in usage.groups" :key="group.name"><strong>{{ group.name }}</strong><p v-if="group.description">{{ group.description }}</p><div v-for="bucket in group.buckets" :key="bucket.id"><span>{{ bucket.name }}</span><p v-if="bucket.description">{{ bucket.description }}</p></div></section></details>
    </template>
    <small v-else class="quota-unavailable">{{ usage?.message || '正在读取…' }}</small>
  </section>
</template>

<style scoped>
.antigravity-quota{margin-top:16px;padding-top:16px;border-top:1px solid var(--ui-border);color:var(--ui-secondary)}
h3,h4{margin:0;font-size:12px;font-weight:600;line-height:16px}h3{color:var(--ui-text)}.quota-group{margin-top:12px}.quota-group+.quota-group{margin-top:16px}.quota-window{margin-top:12px}
.quota-summary{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;color:var(--ui-muted);font-size:12px;line-height:16px}.quota-summary strong{flex-shrink:0;color:var(--ui-text);font:500 12px/16px var(--mono);font-variant-numeric:tabular-nums}
.quota-track{height:4px;margin:6px 0;overflow:hidden;border-radius:9999px;background:color-mix(in srgb,var(--ui-border) 82%,transparent)}.quota-track i{display:block;height:100%;border-radius:inherit;background:color-mix(in srgb,var(--ui-accent) 78%,var(--ui-text))}
.quota-summary strong.exhausted{color:var(--ui-danger)}.quota-original{margin-top:12px;color:var(--ui-muted);font-size:12px;line-height:18px;overflow-wrap:anywhere}.quota-original summary{cursor:pointer;color:var(--ui-secondary)}.quota-original section{margin-top:8px}.quota-original p{margin:4px 0 8px;white-space:pre-wrap}.quota-original section>div{margin-top:8px}
.quota-window>small,.quota-unavailable{display:block;color:var(--ui-muted);font-size:12px;line-height:16px;overflow-wrap:anywhere}.quota-unavailable{margin-top:8px;font-size:12px}
</style>
