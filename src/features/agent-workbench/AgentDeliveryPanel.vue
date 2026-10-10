<script setup lang="ts">
/**
 * 设计说明：交付结果栏只回读当前会话明确关联的执行、追平和合入记录。
 * 全部记录与审核操作进入宽面板，避免把全局记录堆进侧栏；原有确认和权限边界不变。
 */
import { computed } from 'vue';
import { CheckCircle2, ExternalLink, GitMerge, PackageCheck } from '@lucide/vue';
import type { AgentBusinessContext } from './agent-business-context';
import { catchupQuickPrompt, deliveryJobQuickPrompt, mergeQuickPrompt } from './agent-quick-actions';

const props = defineProps<{ context: AgentBusinessContext; loading: boolean }>();
const emit = defineEmits<{ compose: [prompt: string] }>();
const currentCount = computed(() => props.context.jobs.length + props.context.catchup.length + props.context.merges.length);
const visibleJobs = computed(() => byUpdated(props.context.jobs, item => item.updatedAt));
const visibleCatchup = computed(() => byUpdated(props.context.catchup, item => item.session.updatedAt || item.execution.updatedAt));
const visibleMerges = computed(() => byUpdated(props.context.merges, item => item.pipeline.updatedAt));
const hasResults = computed(() => !!(visibleJobs.value.length || visibleCatchup.value.length || visibleMerges.value.length));

function byUpdated<T>(items: T[], getUpdatedAt: (item: T) => string) {
  return [...items].sort((first, second) => Date.parse(getUpdatedAt(second)) - Date.parse(getUpdatedAt(first)));
}
</script>

<template>
  <section class="delivery-panel" aria-label="Agent 交付结果">
    <header class="delivery-toolbar">
      <strong>当前会话交付 · {{ currentCount }}</strong>
    </header>
    <el-skeleton v-if="loading && !hasResults" :rows="5" animated />
    <template v-else-if="hasResults">
      <section v-if="visibleJobs.length" class="delivery-section">
        <h3>自动执行 <span>{{ visibleJobs.length }}</span></h3>
      <article v-for="job in visibleJobs" :key="job.id" class="delivery-card">
        <header><span><PackageCheck :size="13" /> 执行记录</span><b>{{ job.status }}</b></header>
        <strong>{{ job.issueKey ? `${job.issueKey} · ` : '' }}{{ job.title }}</strong>
        <p v-if="job.result">{{ job.result }}</p><p v-else-if="job.error" class="error-text">{{ job.error }}</p>
        <small>{{ job.branch || '未识别分支' }} · 尝试 {{ job.attempts }} 次</small>
        <nav><button type="button" @click="emit('compose', deliveryJobQuickPrompt(job))">带入会话</button><a v-if="job.mrUrl" :href="job.mrUrl" target="_blank" rel="noreferrer">MR <ExternalLink :size="11" /></a><router-link :to="{ path: '/delivery/runs', query: { job: job.id } }">查看运行</router-link></nav>
      </article>
      </section>
      <section v-if="visibleCatchup.length" class="delivery-section">
        <h3>需求追平 <span>{{ visibleCatchup.length }}</span></h3>
      <article v-for="item in visibleCatchup" :key="item.id" class="delivery-card">
        <header><span><CheckCircle2 :size="13" /> 追平记录</span><b>{{ item.execution.status || item.deliveryStatus }}</b></header>
        <strong>{{ item.id }} · {{ item.title }}</strong>
        <p>{{ item.session.result || item.session.error || item.nextAction }}</p>
        <small>{{ item.session.branch || '未识别分支' }}</small>
        <nav><button type="button" @click="emit('compose', catchupQuickPrompt(item))">继续检查</button><router-link :to="{ path: '/catchup/execution', query: { requirement: item.id } }">查看执行</router-link></nav>
      </article>
      </section>
      <section v-if="visibleMerges.length" class="delivery-section">
        <h3>分支合入 <span>{{ visibleMerges.length }}</span></h3>
      <article v-for="item in visibleMerges" :key="item.requirementId" class="delivery-card">
        <header><span><GitMerge :size="13" /> 合入记录</span><b>{{ item.merged ? '已合入' : item.status }}</b></header>
        <strong>{{ item.requirementId }} · {{ item.title }}</strong>
        <p>{{ item.pipeline.result || item.pipeline.error || item.decisionNote }}</p>
        <small>{{ item.sourceBranch }} · 证据 {{ item.reviewGate.screenshotCount }} 张</small>
        <nav><button type="button" @click="emit('compose', mergeQuickPrompt(item))">审核合入</button><a v-if="item.mrUrl" :href="item.mrUrl" target="_blank" rel="noreferrer">MR <ExternalLink :size="11" /></a><router-link :to="{ path: '/catchup/merge', query: { requirement: item.requirementId } }">查看合入</router-link></nav>
      </article>
      </section>
    </template>
    <div v-else class="delivery-empty"><PackageCheck :size="28" /><strong>当前会话暂无关联交付</strong></div>
  </section>
</template>

<style scoped>
.delivery-panel{height:100%;min-height:0;padding:0 12px 12px;overflow-y:auto;background:var(--agent-panel)}.delivery-toolbar{position:sticky;z-index:2;top:0;padding:12px 0 10px;background:var(--agent-panel)}.delivery-section>h3{display:flex;align-items:center;gap:5px;margin:8px 2px;color:var(--agent-secondary);font-size:13px}.delivery-section>h3 span{color:var(--agent-muted);font:12px var(--mono)}.delivery-card{margin-bottom:10px;padding:13px;border:1px solid var(--agent-border);border-radius:11px;background:color-mix(in srgb,var(--agent-panel-strong) 82%,transparent)}.delivery-card header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:9px}.delivery-card header span{display:flex;align-items:center;gap:5px;color:var(--agent-muted);font-size:13px}.delivery-card header b{padding:2px 6px;border-radius:6px;background:color-mix(in srgb,var(--agent-accent) 14%,var(--agent-raised));color:color-mix(in srgb,var(--agent-accent) 48%,#fff);font-size:12px}.delivery-card>strong{display:block;color:var(--agent-text);font-size:14px;line-height:1.5}.delivery-card>p{display:-webkit-box;margin:8px 0;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:4;color:var(--agent-secondary);font-size:13px;line-height:1.6}.delivery-card>.error-text{color:#ff9aac}.delivery-card>small{display:block;overflow:hidden;color:var(--agent-muted);font:12px var(--mono);text-overflow:ellipsis;white-space:nowrap}.delivery-card nav{display:flex;gap:12px;margin-top:10px}.delivery-card nav a{display:inline-flex;align-items:center;gap:3px;color:color-mix(in srgb,var(--agent-accent) 55%,#fff);font-size:13px;text-decoration:none}.delivery-card nav a:hover{color:#fff}.delivery-empty{display:grid;place-items:center;align-content:center;height:calc(100% - 58px);padding:24px;color:var(--agent-muted);text-align:center}.delivery-empty strong{margin-top:12px;color:var(--agent-secondary);font-size:14px}.delivery-panel:deep(.el-skeleton__item){background:var(--agent-panel-strong)}
.delivery-card nav button{display:inline-flex;align-items:center;gap:3px;padding:0;border:0;background:transparent;color:color-mix(in srgb,var(--agent-accent) 55%,#fff);font-size:13px;cursor:pointer}.delivery-card nav button:hover{color:#fff}
.delivery-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px}
</style>
