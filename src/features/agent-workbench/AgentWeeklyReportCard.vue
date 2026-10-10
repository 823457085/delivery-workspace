<script setup lang="ts">
/**
 * 设计说明：周报卡片只呈现服务端真实调度与生成结果，并通过事件请求手动生成。
 * 它不维护第二份定时配置，也不承担 Jira、Confluence 等外部发布职责。
 */
import { computed } from 'vue';
import { CalendarClock, FileText, Play } from '@lucide/vue';
import type { WeeklyReportData } from '../../../shared/hub';
import { dateTime } from '../../shared/format';
import StatusPill from '../../shared/ui/StatusPill.vue';

const props = defineProps<{ report: WeeklyReportData; pending: boolean }>();
const emit = defineEmits<{ generate: [] }>();
const weekdayLabels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const schedule = computed(() => `每${weekdayLabels[props.report.settings.weekday] || '周五'} ${props.report.settings.time}`);
const status = computed(() => props.report.running ? 'running' : props.report.settings.enabled ? 'active' : 'paused');
const statusLabel = computed(() => props.report.running ? '生成中' : props.report.settings.enabled ? '已启用' : '已暂停');
</script>

<template>
  <article class="weekly-card">
    <header class="weekly-header">
      <div><span><FileText :size="13" /> 周报定时</span><strong>{{ schedule }}</strong></div>
      <StatusPill :value="status" :label="statusLabel" />
    </header>
    <dl class="weekly-facts">
      <div><dt><CalendarClock :size="12" /> 下次生成</dt><dd>{{ dateTime(report.nextRun) }}</dd></div>
      <div><dt>生成方式</dt><dd>本地草稿 · 不自动发布</dd></div>
      <div><dt>最近结果</dt><dd>{{ report.lastRun ? report.lastRun.status === 'completed' ? '生成成功' : '生成失败' : '尚未生成' }}</dd></div>
    </dl>
    <button class="weekly-action" type="button" :disabled="pending || report.running" @click="emit('generate')">
      <Play :size="12" />{{ report.running ? '生成中' : '立即生成' }}
    </button>
    <details v-if="report.lastRun" class="weekly-result">
      <summary>最近周报 · {{ dateTime(report.lastRun.generatedAt) }}</summary>
      <p v-if="report.lastRun.status === 'failed'">{{ report.lastRun.error || '生成失败' }}</p>
      <pre v-else>{{ report.lastRun.content }}</pre>
    </details>
    <p v-else class="weekly-empty">尚未生成，服务端将在下次计划时间自动生成。</p>
  </article>
</template>

<style scoped>
.weekly-card{margin-top:10px;padding:12px;border:1px solid var(--agent-border);border-radius:10px;background:color-mix(in srgb,var(--agent-accent) 6%,var(--agent-panel-strong))}.weekly-header{display:flex;align-items:center;justify-content:space-between;gap:10px}.weekly-header span{display:flex;align-items:center;gap:5px;color:var(--agent-muted);font-size:8px}.weekly-header strong{display:block;margin-top:6px;color:var(--agent-text);font-size:11px}.weekly-facts{display:grid;gap:7px;margin:12px 0}.weekly-facts div{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.weekly-facts dt,.weekly-facts dd{margin:0;font-size:8px;line-height:1.5}.weekly-facts dt{display:flex;align-items:center;gap:4px;color:var(--agent-muted)}.weekly-facts dd{max-width:65%;color:var(--agent-secondary);text-align:right}.weekly-action{display:flex;align-items:center;gap:4px;padding:0;border:0;background:transparent;color:color-mix(in srgb,var(--agent-accent) 55%,#fff);font-size:8px;cursor:pointer}.weekly-action:disabled{opacity:.45;cursor:default}.weekly-result{margin-top:10px;border-top:1px solid var(--agent-border);color:var(--agent-muted);font-size:8px}.weekly-result summary{padding-top:10px;cursor:pointer}.weekly-result p{color:var(--agent-danger,#f87171);line-height:1.6}.weekly-result pre{max-height:260px;margin:8px 0 0;padding:9px;overflow:auto;border-radius:7px;background:var(--agent-bg);color:var(--agent-secondary);font:7px/1.65 var(--mono);white-space:pre-wrap;word-break:break-word}.weekly-empty{margin:10px 0 0;padding-top:10px;border-top:1px solid var(--agent-border);color:var(--agent-muted);font-size:7px;line-height:1.5}.weekly-card:deep(.status-pill){padding:2px 6px;font-size:7px}
</style>
