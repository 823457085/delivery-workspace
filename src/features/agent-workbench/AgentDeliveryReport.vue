<script setup lang="ts">
import { computed } from 'vue';
import AgentMarkdownInline from './AgentMarkdownInline.vue';
import { parseMarkdownInline } from './markdown';
import { readableDeliveryReport } from './execution-summary';
const props = defineProps<{ source: string; compact?: boolean }>();
const report = computed(() => readableDeliveryReport(props.source));
</script>

<template>
  <section class="delivery-report" :class="{ 'delivery-report-compact': compact }" aria-label="本轮交付报告">
    <header v-if="!compact"><strong>本轮工作结果</strong><small>由成员汇总，待核对</small></header>
    <template v-if="report">
      <p class="report-headline">{{ report.headline }}</p>
      <p v-if="report.summary" class="report-summary">{{ report.summary }}</p>
      <p v-if="!compact && report.issueKeys.length" class="report-issues">关联 Jira：{{ report.issueKeys.join(' · ') }}</p>
      <dl v-if="report.overview.length" class="report-overview">
        <div v-for="row in report.overview" :key="row.label"><dt>{{ row.label }}</dt><dd>{{ row.text }}</dd></div>
      </dl>
      <p v-if="report.unparsed" class="report-note">部分字段未通过格式校验，请查看原始报告。</p>
      <details v-if="!compact" class="report-details">
        <summary>查看具体原因和检查记录</summary>
        <section v-for="section in report.sections" :key="section.title" class="report-section">
          <h4>{{ section.title }}</h4>
          <details v-for="row in section.rows" :key="row.key" class="report-row" :open="['blocked', 'failed'].includes(row.state)">
            <summary><span>{{ row.title }}</span><strong>{{ row.status }}</strong><small>{{ row.evidence ? '具体说明' : '暂无说明' }}</small></summary>
            <p v-if="row.evidence"><AgentMarkdownInline :nodes="parseMarkdownInline(row.evidence)" /></p>
          </details>
        </section>
        <details class="report-raw"><summary>原始报告 JSON</summary><pre><code>{{ source }}</code></pre></details>
      </details>
    </template>
    <template v-else>
      <p class="report-note">报告内容未解析，请展开查看原文。</p>
      <details class="report-raw"><summary>原始报告 JSON</summary><pre><code>{{ source }}</code></pre></details>
    </template>
  </section>
</template>

<style scoped>
.delivery-report{container-type:inline-size;margin:12px 0;padding:14px 16px;border:1px solid var(--agent-border,var(--ui-border));border-radius:8px;color:inherit;background:var(--agent-panel-strong,var(--ui-surface));font-size:12px;line-height:1.7}
.delivery-report-compact{margin:0 0 10px;padding:0;border:0;border-radius:0;background:transparent}.delivery-report-compact .report-headline{margin-top:0;font-size:12px}.delivery-report-compact .report-summary{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:6;overflow:hidden}
.report-headline{margin:10px 0 6px;font-size:14px;font-weight:600}.report-overview{margin:12px 0}.report-overview>div{display:grid;grid-template-columns:90px minmax(0,1fr);gap:10px;margin:6px 0}.report-overview dt{color:var(--agent-muted,var(--ui-muted))}.report-overview dd{margin:0;overflow-wrap:anywhere}.report-details>summary{cursor:pointer;color:var(--agent-accent,var(--ui-accent))}
.delivery-report>header{display:flex;justify-content:space-between;align-items:center;gap:12px}.delivery-report>header strong{font-size:13px}.delivery-report small,.report-note,.report-issues{color:var(--agent-muted,var(--ui-muted));font-size:11px}.report-summary{white-space:pre-wrap}.report-issues{margin:6px 0 10px;overflow-wrap:anywhere}.report-section h4{margin:12px 0 5px;font-size:12px;color:inherit}.report-row{border-top:1px solid var(--agent-border,var(--ui-border))}.report-row summary{display:grid;grid-template-columns:minmax(95px,1fr) minmax(65px,auto) 65px;align-items:center;gap:10px;padding:7px 0;cursor:pointer;list-style:none}.report-row summary::-webkit-details-marker{display:none}.report-row summary strong{font-weight:500}.report-row summary small{text-align:right}.report-row p{margin:0 0 10px;white-space:pre-wrap;overflow-wrap:anywhere}.report-row[open] summary small{color:var(--agent-accent,var(--ui-accent))}.report-raw{margin-top:12px;color:var(--agent-muted,var(--ui-muted))}.report-raw>summary{cursor:pointer}.report-raw pre{max-height:360px;overflow:auto;padding:10px;background:var(--agent-bg,var(--ui-bg));color:var(--agent-secondary,var(--ui-secondary));font:11px/1.7 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere}
@container(max-width:340px){.delivery-report>header{flex-wrap:wrap;gap:4px}.report-overview>div{grid-template-columns:minmax(0,1fr);gap:0;margin:10px 0}.report-row summary{grid-template-columns:minmax(0,1fr) auto;gap:4px 8px}.report-row summary>*{min-width:0;overflow-wrap:anywhere}.report-row summary small{grid-column:1/-1;text-align:left}}
</style>
