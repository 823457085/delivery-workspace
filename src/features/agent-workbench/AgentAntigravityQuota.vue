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
.antigravity-quota{margin-top:16px;padding-top:14px;border-top:1px solid var(--agent-border);color:var(--agent-secondary)}
h3,h4{margin:0;font-size:12px;font-weight:600;line-height:1.6}h3{color:var(--agent-text)}.quota-group{margin-top:12px}.quota-group+.quota-group{margin-top:18px}.quota-window{margin-top:10px}
.quota-summary{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;color:var(--agent-muted);font-size:12px;line-height:1.6}.quota-summary strong{flex-shrink:0;color:var(--agent-text);font:12px/1.6 var(--mono)}
.quota-track{height:4px;margin:7px 0;overflow:hidden;border-radius:3px;background:var(--agent-raised)}.quota-track i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--agent-cyan),var(--agent-accent))}
.quota-summary strong.exhausted{color:var(--ui-danger)}.quota-original{margin-top:14px;color:var(--agent-muted);font-size:11px;line-height:1.7;overflow-wrap:anywhere}.quota-original summary{cursor:pointer;color:var(--agent-secondary)}.quota-original section{margin-top:10px}.quota-original p{margin:3px 0 8px;white-space:pre-wrap}.quota-original section>div{margin-top:7px}
.quota-window>small,.quota-unavailable{display:block;color:var(--agent-muted);font-size:11px;line-height:1.6;overflow-wrap:anywhere}.quota-unavailable{margin-top:7px;font-size:12px}
</style>
