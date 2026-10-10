<script setup lang="ts">
import { computed, shallowRef } from 'vue';
import { Pause, ArrowRight, RotateCcw, Check, CircleAlert, FileText, ExternalLink, Database, Sparkles } from '@lucide/vue';
import type { Requirement, RunView } from '../../../shared/types';
import { WORKFLOW_STEPS } from '../../../shared/types';
import { formatTime } from './useDelivery';
const props = defineProps<{ requirement: Requirement; run?: RunView; busy: boolean; selectedStep: string }>();
defineEmits<{ resume: [action: 'approve' | 'retest']; rework: [] }>();
const tab = shallowRef<'evidence' | 'analysis' | 'timeline'>('evidence');
const step = computed(() => WORKFLOW_STEPS.find((item) => item.id === props.selectedStep));
const facts = computed(() => props.requirement.evidence);
</script>

<template>
  <div class="inspector">
    <div v-if="run?.gate" class="gate-banner" :class="run.gate.kind">
      <span class="gate-icon"><Pause :size="19" /></span>
      <div class="gate-copy"><strong>{{ run.gate.title }}</strong><p>{{ run.gate.reason }}</p></div>
      <div class="gate-actions">
        <button v-if="run.gate.kind === 'review'" class="btn primary" :disabled="busy" @click="$emit('resume', 'approve')">审核通过，继续演示 <ArrowRight :size="14" /></button>
        <button v-if="run.gate.kind === 'evidence'" class="btn primary" :disabled="busy" @click="$emit('resume', 'retest')">补齐演示数据并重测 <ArrowRight :size="14" /></button>
        <button v-if="run.gate.kind !== 'evidence'" class="text-button" :disabled="busy" @click="$emit('rework')"><RotateCcw :size="13" />{{ run.gate.kind === 'conflict' ? '退回新一轮预演' : '退回补测' }}</button>
      </div>
    </div>
    <div v-else-if="run?.status === 'success'" class="result-banner"><Check :size="20" /><div><strong>演示流程已完成</strong><p>{{ run.result }}</p></div></div>
    <div v-else-if="run?.error" class="error-banner" role="alert"><CircleAlert :size="20" /><span>{{ run.error }}</span><button class="text-button" @click="$emit('rework')">新一轮预演</button></div>
    <div v-else-if="!run" class="start-tip"><Sparkles :size="16" />选择上方演示场景并开始，查看 Mastra 如何执行和等待审核。</div>
    <div class="detail-toolbar"><div class="detail-tabs"><button :class="{ active: tab === 'evidence' }" @click="tab = 'evidence'">证据与结果</button><button :class="{ active: tab === 'analysis' }" @click="tab = 'analysis'">范围分析</button><button :class="{ active: tab === 'timeline' }" @click="tab = 'timeline'">执行记录</button></div><span class="selected-step">{{ step?.title }}</span></div>
    <div v-if="tab === 'evidence'" class="evidence-body">
      <div class="evidence-block">
        <div class="block-title"><Database :size="15" /><strong>原看板事实</strong><span class="mini-label">只读快照</span></div>
        <div class="fact-metrics"><div><b>{{ facts.passed }}</b><span>通过</span></div><div><b>{{ facts.skipped }}</b><span>有理由跳过</span></div><div><b :class="{ amber: facts.failed + facts.missing > 0 }">{{ facts.failed + facts.missing }}</b><span>失败 / 缺失</span></div><div><b>{{ facts.screenshots }}</b><span>功能截图</span></div></div>
        <p v-if="requirement.error" class="source-error"><CircleAlert :size="14" />{{ requirement.error }}</p>
      </div>
      <div class="evidence-block">
        <div class="block-title"><FileText :size="15" /><strong>本轮检查</strong><span class="mini-label demo">演示执行</span></div>
        <div v-if="run?.checks.length" class="checks"><div v-for="check in run.checks" :key="check.name" class="check-row"><Check v-if="check.passed" :size="16" class="green" /><CircleAlert v-else :size="16" class="amber" /><div><strong>{{ check.name }}</strong><p>{{ check.detail }}</p></div><span :class="check.passed ? 'green' : 'amber'">{{ check.passed ? 'PASS' : 'WAIT' }}</span></div></div>
        <p v-else class="empty-checks">{{ run?.status === 'running' ? '正在生成本轮检查结果…' : '开始运行后，检查结果将在这里逐项保留。' }}</p>
      </div>
    </div>
    <div v-else-if="tab === 'analysis'" class="analysis-body"><div class="block-title"><Sparkles :size="15" /><strong>{{ run?.analysisMode === 'llm' ? 'Mastra Agent 分析' : '需求规则分析' }}</strong><span class="mini-label">{{ run?.analysisMode === 'llm' ? '模型生成' : '未调用大模型' }}</span></div><p class="analysis-text">{{ run?.analysis || '运行到“范围分析”后，将基于本次冻结的需求快照整理验收范围与证据缺口。' }}</p></div>
    <div v-else class="timeline-body">
      <p v-if="!run" class="empty-checks">暂无运行记录</p>
      <template v-else><div v-for="item in run.steps" :key="item.id" class="timeline-row"><span class="timeline-dot" :class="item.status"></span><strong>{{ item.title }}</strong><span>{{ item.status === 'success' ? '已完成' : item.status === 'suspended' ? '等待输入' : item.status === 'running' ? '执行中' : '尚未执行' }}</span><time>{{ item.endedAt || item.startedAt ? formatTime(item.endedAt || item.startedAt!) : '—' }}</time></div><a :href="`/api/runs/${run.runId}/snapshot`" target="_blank" class="snapshot-link">查看 Mastra 原始快照 <ExternalLink :size="13" /></a><p v-if="run.parentRunId" class="parent-run mono">上一轮 {{ run.parentRunId }}</p></template>
    </div>
  </div>
</template>

<style scoped>
.inspector{background:var(--ui-surface)}.gate-banner,.result-banner,.error-banner{margin:20px 22px 0;padding:16px;display:flex;gap:12px;align-items:flex-start;border-radius:10px;border:1px solid var(--ui-border);background:var(--ui-warning-bg)}.gate-icon{display:grid;place-items:center;width:32px;height:32px;background:var(--ui-warning-bg);color:var(--ui-warning);border-radius:9px;flex-shrink:0}.gate-copy{min-width:0;flex:1}.gate-copy strong,.result-banner strong{font-size:14px}.gate-copy p,.result-banner p{margin:5px 0 0;font-size:12px;line-height:1.8;color:var(--ui-secondary)}.gate-actions{display:flex;align-items:flex-end;flex-direction:column;gap:8px;flex-shrink:0}.gate-actions .btn{font-size:12px;padding:9px 12px}.gate-actions .text-button{font-size:12px}.result-banner{border-color:var(--ui-border);background:var(--ui-success-bg);color:var(--accent)}.result-banner p{color:var(--ui-secondary)}.error-banner{background:var(--ui-warning-bg);border-color:var(--ui-border);color:var(--ui-warning);font-size:13px}.start-tip{padding:20px 23px 5px;font-size:13px;color:var(--muted);display:flex;align-items:center;gap:8px}.detail-toolbar{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);padding:0 23px;margin-top:12px}.detail-tabs{display:flex;gap:23px}.detail-tabs button{background:none;border:0;padding:17px 0 13px;font-size:13px;color:var(--muted);border-bottom:2px solid transparent;cursor:pointer}.detail-tabs button.active{color:var(--accent);border-color:var(--accent);font-weight:600}.selected-step{font-size:11px;color:var(--ui-muted)}.evidence-body{display:grid;grid-template-columns:1fr 1fr}.evidence-block{padding:19px 22px 22px;min-width:0}.evidence-block+.evidence-block{border-left:1px solid var(--line)}.block-title{display:flex;gap:7px;align-items:center;color:var(--ui-secondary);font-size:13px}.block-title strong{font-weight:550;color:var(--ui-text)}.mini-label{margin-left:auto;font-size:11px;white-space:nowrap;background:var(--ui-accent-soft);color:var(--ui-muted);padding:2px 6px;border-radius:4px}.mini-label.demo{color:var(--ui-secondary);background:var(--ui-warning-bg)}.fact-metrics{display:flex;justify-content:space-between;margin:20px 0 17px}.fact-metrics div{display:flex;flex-direction:column;gap:5px}.fact-metrics b{font-family:var(--mono);font-size:23px;font-weight:500}.fact-metrics span{color:var(--muted);font-size:11px}.source-error{font-size:11px;line-height:1.85;padding:10px 12px;background:var(--ui-accent-soft);border-radius:6px;color:var(--ui-muted);margin:0;max-height:115px;overflow:auto}.source-error svg{display:inline;vertical-align:-2px;margin-right:5px}.checks{margin-top:13px}.check-row{display:flex;gap:7px;align-items:flex-start;padding:9px 0;border-bottom:1px solid var(--ui-border)}.check-row:last-child{border:0}.check-row>svg{margin-top:2px;flex-shrink:0}.check-row div{flex:1}.check-row strong{font-size:12px;font-weight:500}.check-row p{font-size:11px;color:var(--muted);line-height:1.7;margin:4px 0 0}.check-row>span{font:10px var(--mono)}.empty-checks{font-size:13px;line-height:1.8;color:var(--muted);padding:16px 0}.analysis-body,.timeline-body{padding:22px}.analysis-text{white-space:pre-line;font-size:14px;line-height:1.9;color:var(--ui-secondary)}.timeline-row{display:flex;gap:10px;align-items:center;font-size:12px;padding:11px 0;border-bottom:1px solid var(--ui-border)}.timeline-row strong{font-weight:500;min-width:80px}.timeline-row>span:not(.timeline-dot){color:var(--muted)}.timeline-row time{margin-left:auto;color:var(--ui-muted);font:11px var(--mono)}.timeline-dot{width:7px;height:7px;border-radius:50%;background:var(--ui-accent-soft)}.timeline-dot.success{background:var(--ui-success)}.timeline-dot.suspended{background:var(--ui-warning)}.timeline-dot.running{background:var(--ui-accent)}.snapshot-link{display:flex;align-items:center;gap:5px;color:var(--accent);font-size:12px;margin-top:18px;width:fit-content}.parent-run{font-size:11px;color:var(--muted);word-break:break-all}
@media(max-width:1250px){.gate-banner{flex-wrap:wrap}.gate-actions{width:100%;flex-direction:row;justify-content:flex-end}.evidence-body{grid-template-columns:1fr}.evidence-block+.evidence-block{border-left:0;border-top:1px solid var(--line)}}
@media(max-width:650px){.detail-tabs{gap:16px}.gate-banner{margin:14px 12px 0}.gate-actions{flex-wrap:wrap}.selected-step{display:none}}
</style>
