<script setup lang="ts">
/** 日期卡片只发出生成请求；执行与会话切换由父容器负责，避免在侧栏复制运行状态。 */
import { computed, shallowRef } from 'vue';
import { FileText, Play } from '@lucide/vue';
import { dailyReportDate, isDailyReportDate } from './daily-report';

const props = defineProps<{ available: boolean; pending: boolean }>();
const emit = defineEmits<{ generate: [date: string] }>();
const date = shallowRef(dailyReportDate());
const valid = computed(() => isDailyReportDate(date.value));

function generate() {
  if (props.available && !props.pending && isDailyReportDate(date.value)) emit('generate', date.value);
}
</script>

<template>
  <section class="daily-report" aria-label="日报生成">
    <header class="daily-heading"><FileText :size="14" /><strong>日报生成</strong><span>Computer History</span></header>
    <p class="daily-description">按当天工作记录生成草稿，在独立只读会话中查看、复制或导出，不自动发布。</p>
    <form class="daily-actions" @submit.prevent="generate">
      <input v-model="date" type="date" aria-label="日报日期" :max="dailyReportDate()" required :disabled="pending" />
      <button type="submit" :disabled="!available || pending || !valid"><Play :size="12" />{{ pending ? '正在创建…' : '生成日报' }}</button>
    </form>
    <small v-if="!available" class="daily-hint">请先选择项目，并连接支持只读问答的 Codex。</small>
  </section>
</template>

<style scoped>
.daily-report{margin-bottom:16px;padding:12px;border:1px solid var(--agent-border);border-radius:10px;background:var(--agent-panel-strong)}
.daily-heading{display:flex;align-items:center;gap:6px;color:var(--agent-text);font-size:13px;flex-wrap:wrap}
.daily-heading span{margin-left:auto;color:var(--agent-muted);font-size:12px}
.daily-description,.daily-hint{color:var(--agent-muted);font-size:12px;line-height:1.6}
.daily-description{margin:8px 0 12px}.daily-hint{display:block;margin-top:8px}
.daily-actions{display:flex;flex-wrap:wrap;gap:8px}
.daily-actions input{flex:1;min-width:130px;max-width:100%;padding:6px 8px;border:1px solid var(--agent-border);border-radius:6px;background:var(--agent-bg);color:var(--agent-text);font:12px var(--mono);color-scheme:dark}
.daily-actions button{display:flex;align-items:center;justify-content:center;gap:5px;padding:6px 9px;border:1px solid var(--agent-border);border-radius:6px;background:var(--agent-raised);color:var(--agent-text);font-size:12px;cursor:pointer}
.daily-actions button:disabled{opacity:.45;cursor:default}
</style>
