<script setup lang="ts">
/**
 * 设计说明：该组件只展示服务端已归一化的 Codex 额度快照，不自行请求或估算。
 * 边界是连接状态下方的紧凑读数；弹窗和明细页会增加不必要的交互，因此不采用。
 */
import { computed } from 'vue';
import type { AgentUsageLimits, AgentUsageWindow } from '../../../shared/agent-runtime';

const props = defineProps<{ usage?: AgentUsageLimits }>();

const windows = computed(() => [props.usage?.primary, props.usage?.secondary]
  .filter((item): item is AgentUsageWindow => !!item));

function windowLabel(minutes: number | null) {
  if (!minutes) return '当前窗口';
  if (minutes % 1_440 === 0) return `${minutes / 1_440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

function percentLabel(value: number) {
  return `${Math.round(value)}%`;
}

function resetLabel(timestamp: number | null) {
  if (!timestamp) return '';
  const value = new Date(timestamp * 1_000);
  if (Number.isNaN(value.getTime())) return '';
  return `${new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .format(value).replaceAll('/', '-')} 重置`;
}
</script>

<template>
  <section class="usage-quota" aria-label="Codex 剩余额度">
    <div class="usage-heading"><strong>Codex 剩余额度</strong><span v-if="usage?.planType">{{ usage.planType }}</span></div>
    <template v-if="usage?.available && windows.length">
      <div v-for="window in windows" :key="`${window.windowDurationMins}-${window.resetsAt}`" class="usage-window">
        <div class="usage-summary"><span>{{ windowLabel(window.windowDurationMins) }}</span><strong>{{ percentLabel(window.remainingPercent) }}</strong></div>
        <div class="usage-track"><i :style="{ width: `${window.remainingPercent}%` }"></i></div>
        <small v-if="resetLabel(window.resetsAt)">{{ resetLabel(window.resetsAt) }}</small>
      </div>
    </template>
    <small v-else class="usage-unavailable">{{ usage?.message || '正在读取…' }}</small>
  </section>
</template>

<style scoped>
.usage-quota{margin-top:8px;padding-top:9px;border-top:1px solid var(--agent-border)}
.usage-heading,.usage-summary{display:flex;align-items:center;justify-content:space-between;gap:8px}
.usage-heading{margin-bottom:7px;color:var(--agent-secondary)}
.usage-heading strong{font-size:9px;font-weight:600}.usage-heading span{color:var(--agent-muted);font:8px var(--mono);text-transform:uppercase}
.usage-window+.usage-window{margin-top:8px}.usage-summary{color:var(--agent-muted);font-size:8px}.usage-summary strong{color:var(--agent-text);font:9px var(--mono)}
.usage-track{height:3px;margin-top:5px;overflow:hidden;border-radius:3px;background:var(--agent-raised)}.usage-track i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--agent-cyan),var(--agent-accent))}
.usage-window>small,.usage-unavailable{display:block;margin-top:4px;color:var(--agent-muted);font-size:8px}.usage-unavailable{margin:0}
</style>
