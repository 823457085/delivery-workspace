<script setup lang="ts">
/**
 * 设计说明：该组件只展示服务端已归一化的当前执行器额度快照（Codex / Cursor / Claude Code），不自行请求或估算。
 * 由页头的连接与额度面板承载，保留真实窗口、剩余比例和重置时间。
 */
import { computed } from 'vue';
import type { AgentUsageLimits, AgentUsageWindow } from '../../../shared/agent-runtime';
import { agentQuotaState } from '../../../shared/agent-usage';
import { quotaCreditsLabel, quotaLabel, quotaPercent, quotaReset, quotaUsageNote, quotaWindow } from './usage-quota';

const props = defineProps<{ usage?: AgentUsageLimits; label: string }>();

const windows = computed(() => [props.usage?.primary, props.usage?.secondary]
  .filter((item): item is AgentUsageWindow => !!item && Number.isFinite(item.remainingPercent)));
const state = computed(() => agentQuotaState(props.usage));
const creditsLabel = computed(() => quotaCreditsLabel(props.usage));
</script>

<template>
  <section class="usage-quota" :class="state.state" :aria-label="`${label} 剩余额度`">
    <div class="usage-heading"><strong>{{ label }} 剩余额度</strong><span v-if="usage?.planType">{{ usage.planType }}</span></div>
    <p class="usage-status">{{ quotaLabel(usage) }}</p>
    <small v-if="usage?.sourceLabel" class="usage-source">{{ usage.sourceLabel }}</small>
    <template v-if="usage?.available && (windows.length || creditsLabel)">
      <div v-for="(window, index) in windows" :key="index" class="usage-window">
        <div class="usage-summary"><span>{{ quotaWindow(window.windowDurationMins) }}</span><strong>{{ usage?.stale ? '上次剩余' : '剩余' }} {{ quotaPercent(window.remainingPercent) }}</strong></div>
        <div class="usage-track"><i :style="{ width: `${window.remainingPercent}%` }"></i></div>
        <small>{{ usage?.stale ? '上次记录的重置时间' : '重置时间' }}：{{ quotaReset(window.resetsAt) }}</small>
      </div>
      <div v-if="creditsLabel" class="usage-window usage-credits">
        <div class="usage-summary"><span>{{ usage?.stale ? '上次额度' : state.usingCredits ? '用量来源：额度' : '可用额度' }}</span><strong>{{ creditsLabel }}</strong></div>
      </div>
      <small v-if="usage?.stale" class="usage-unavailable">{{ quotaUsageNote(usage) }}</small>
    </template>
    <small v-else class="usage-unavailable">{{ usage?.message || '服务未提供可读取的额度；未知不代表已用尽' }}</small>
  </section>
</template>

<style scoped>
.usage-quota{margin-top:8px;padding-top:8px;border-top:1px solid var(--ui-border)}
.usage-heading,.usage-summary{display:flex;align-items:center;justify-content:space-between;gap:8px}
.usage-heading{margin-bottom:8px;color:var(--ui-secondary)}
.usage-heading strong{font-size:14px;line-height:20px;font-weight:600}.usage-heading span{color:var(--ui-muted);font:500 12px/16px var(--mono);text-transform:uppercase}
.usage-window+.usage-window{margin-top:8px}.usage-summary{color:var(--ui-muted);font-size:12px;line-height:16px}.usage-summary strong{color:var(--ui-text);font:500 12px/16px var(--mono);font-variant-numeric:tabular-nums}
.usage-track{height:4px;margin-top:6px;overflow:hidden;border-radius:9999px;background:color-mix(in srgb,var(--ui-border) 82%,transparent)}.usage-track i{display:block;height:100%;border-radius:inherit;background:color-mix(in srgb,var(--ui-text) 78%,var(--ui-secondary))}
.low .usage-track i{background:var(--ui-warning)}
.usage-window>small,.usage-unavailable{display:block;margin-top:4px;color:var(--ui-muted);font-size:11.5px;line-height:16px}.usage-unavailable{margin:0}
.usage-source{display:block;margin-bottom:6px;color:var(--ui-muted);font-size:11.5px;line-height:16px;overflow-wrap:anywhere}
.usage-status{margin:4px 0 8px;font:600 15px/22px var(--sans);color:var(--ui-text);font-variant-numeric:tabular-nums}.exhausted .usage-status{color:var(--ui-danger)}.exhausted .usage-track i{background:var(--ui-danger)}.unknown .usage-status{font-size:13px;line-height:19px;color:var(--ui-secondary)}
</style>
