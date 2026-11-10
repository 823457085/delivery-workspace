<script setup lang="ts">
import { computed, shallowRef } from 'vue';
import { FileText, Play } from '@lucide/vue';
import type { AgentRun } from '../../../shared/agent-runtime';
import StatusPill from '../../shared/ui/StatusPill.vue';
import AgentReportPreview from './AgentReportPreview.vue';
import { agentRunStatus } from './conversation';
import { agentReplyText } from './execution-summary';
import { dailyReportDate, isDailyReportDate } from './daily-report';

const props = defineProps<{ available: boolean; pending: boolean; reportForDate: (date: string) => AgentRun | undefined }>();
const emit = defineEmits<{ generate: [date: string] }>();
const date = shallowRef(dailyReportDate());
const valid = computed(() => isDailyReportDate(date.value));
const report = computed(() => valid.value ? props.reportForDate(date.value) : undefined);
const status = computed(() => report.value && agentRunStatus(report.value));
const generating = computed(() => status.value?.value === 'queued' || status.value?.value === 'running');
const content = computed(() => report.value?.status === 'completed' && report.value.resultReady !== false
  ? agentReplyText(report.value.result) : '');

function generate() {
  if (props.available && !props.pending && !generating.value && valid.value) emit('generate', date.value);
}
</script>

<template>
  <form class="daily-report" aria-label="日报生成" @submit.prevent="generate">
    <header class="daily-heading"><FileText :size="14" /><strong>日报生成</strong><span>Computer History</span></header>
    <p class="daily-description">按所选日期生成草稿，可在此查看，不自动发布。</p>
    <input v-model="date" class="daily-date" type="date" aria-label="日报日期" :max="dailyReportDate()" required :disabled="pending" />
    <small v-if="report?.error" class="daily-hint">{{ report.error }}</small>
    <small v-else-if="status?.value === 'completed' && !content" class="daily-hint">本轮没有保存草稿。</small>
    <small v-if="!available" class="daily-hint">请先连接支持只读问答的 Codex。</small>
    <footer class="daily-actions automation-card-footer">
      <button type="submit" :disabled="!available || pending || generating || !valid"><Play :size="12" />{{ pending ? '正在启动…' : generating ? '生成中…' : '生成日报' }}</button>
      <div v-if="status" class="daily-result">
        <StatusPill v-bind="status" :label="content ? '草稿已就绪' : status.label" />
        <AgentReportPreview v-if="content" :title="`日报草稿 · ${date}`" :content="content" />
      </div>
    </footer>
  </form>
</template>

<style scoped>
.daily-report{margin-bottom:16px;padding:12px;border:1px solid var(--agent-border);border-radius:10px;background:var(--agent-panel-strong)}
.daily-heading{display:flex;align-items:center;gap:6px;color:var(--agent-text);font-size:13px;flex-wrap:wrap}
.daily-heading span{margin-left:auto;color:var(--agent-muted);font-size:12px}
.daily-description,.daily-hint{color:var(--agent-muted);font-size:12px;line-height:1.6}
.daily-description{margin:8px 0 12px}.daily-hint{display:block;margin-top:8px}
.daily-result{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-left:auto}
.daily-actions{display:flex;flex-wrap:wrap;gap:8px}
.daily-date{width:min(100%,240px);min-width:0;padding:6px 8px;border:1px solid var(--agent-border);border-radius:6px;background:var(--agent-bg);color:var(--agent-text);font:12px var(--mono);color-scheme:dark}
.daily-actions button{display:flex;align-items:center;justify-content:center;gap:5px;padding:6px 9px;border:1px solid var(--agent-border);border-radius:6px;background:var(--agent-raised);color:var(--agent-text);font-size:12px;cursor:pointer}
.daily-actions button:disabled{opacity:.45;cursor:default}
</style>
