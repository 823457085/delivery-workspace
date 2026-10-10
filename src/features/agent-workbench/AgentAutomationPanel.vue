<script setup lang="ts">
/**
 * 设计说明：自动化面板复用 Jira 自动交付的唯一服务端状态，只提供状态回读、会话引用和已有确认动作。
 * 策略编辑仍留在设置页，避免在 Agent 侧栏形成第二份配置源。
 */
import { computed, shallowRef } from 'vue';
import { CalendarClock, Play, RefreshCw, Settings2, Zap } from '@lucide/vue';
import type { AutomationData, Job } from '../../../shared/hub';
import { automationSubtaskKeys, isAutomationSubtaskJob } from '../../../shared/automation-policy.mjs';
import { dateTime } from '../../shared/format';
import StatusPill from '../../shared/ui/StatusPill.vue';
import { useSource, useSourceActions } from '../../shared/api';
import { deliveryJobQuickPrompt } from './agent-quick-actions';
import AgentWeeklyReportCard from './AgentWeeklyReportCard.vue';
import AgentDailyReportCard from './AgentDailyReportCard.vue';

const props = defineProps<{ conversationId?: string; scopedJobs: Job[]; dailyReportAvailable: boolean; dailyReportPending: boolean }>();
const emit = defineEmits<{ compose: [prompt: string]; generateDailyReport: [date: string] }>();
const query = useSource<AutomationData>('automation');
const actions = useSourceActions();
const filter = shallowRef<'all' | 'running' | 'blocked'>('all');
const scope = shallowRef<'conversation' | 'all'>('conversation');
const allActiveJobs = computed(() => {
  const subtaskKeys = automationSubtaskKeys(query.data.value?.plan);
  return (query.data.value?.jobs || []).filter((job) =>
    ['waiting', 'pending', 'dispatching', 'dispatched', 'running', 'blocked'].includes(job.status)
    && !isAutomationSubtaskJob(job, subtaskKeys));
});
const scopedJobIds = computed(() => new Set(props.scopedJobs.map((job) => job.id)));
const scopedActiveJobs = computed(() => allActiveJobs.value.filter((job) => scopedJobIds.value.has(job.id)));
const activeJobs = computed(() => scope.value === 'conversation' && props.conversationId
  ? scopedActiveJobs.value : allActiveJobs.value);
const runningCount = computed(() => activeJobs.value.filter((job) => ['dispatching', 'dispatched', 'running'].includes(job.status)).length);
const blockedCount = computed(() => activeJobs.value.filter((job) => job.status === 'blocked').length);
const visibleJobs = computed(() => activeJobs.value.filter((job) => filter.value === 'all'
  || filter.value === 'running' && ['dispatching', 'dispatched', 'running'].includes(job.status)
  || filter.value === 'blocked' && job.status === 'blocked').slice(0, 12));
const jiraMaintenanceEnabled = computed(() => Boolean(query.data.value?.settings.enabled && query.data.value.settings.autoTransitionJira));

function runScan() {
  void actions.execute('scan', {}, '确认立即巡检', '巡检会按已保存的自动交付设置读取 Jira 和本地项目，并可能创建 Codex 任务、推进 Jira 或创建合并请求。');
}

function generateWeeklyReport() {
  void actions.execute('weekly-report', {}, '确认生成周报', '将读取当前用户的 Jira 任务与本地 Agent 运行记录，生成本地周报草稿；不会发布到 Jira 或 Confluence。');
}
</script>

<template>
  <section class="automation-panel" aria-label="Agent 自动化">
    <AgentDailyReportCard :available="dailyReportAvailable" :pending="dailyReportPending" @generate="emit('generateDailyReport', $event)" />
    <header v-if="query.data.value" class="automation-summary">
      <div><span><Zap :size="13" /> Jira 自动维护</span><strong>{{ jiraMaintenanceEnabled ? '策略已启用' : '策略已暂停' }}</strong></div>
      <StatusPill :value="jiraMaintenanceEnabled ? 'active' : 'paused'" :label="jiraMaintenanceEnabled ? '运行中' : '已暂停'" />
    </header>
    <el-skeleton v-if="query.isPending.value" :rows="7" animated />
    <div v-else-if="query.error.value" class="automation-empty">{{ query.error.value.message }}</div>
    <template v-else-if="query.data.value">
      <dl class="automation-facts">
        <div><dt><CalendarClock :size="12" /> 下次巡检</dt><dd>{{ dateTime(query.data.value.nextRun) }}</dd></div>
        <div><dt>维护计划</dt><dd>工作日 {{ query.data.value.settings.dailyTimes.join('、') }}</dd></div>
        <div><dt>执行中</dt><dd>{{ runningCount }} 个任务</dd></div>
        <div><dt>自动动作</dt><dd>{{ query.data.value.settings.autoCreateCodex ? 'Codex' : '不派发' }} · {{ query.data.value.settings.autoTransitionJira ? 'Jira' : '不改状态' }} · {{ query.data.value.settings.autoCreateMergeRequest ? 'MR' : '不建 MR' }}</dd></div>
      </dl>
      <div class="automation-actions">
        <button type="button" :disabled="actions.pending.value || query.data.value.running" @click="runScan"><Play :size="12" />{{ query.data.value.running ? '巡检中' : '立即巡检' }}</button>
        <button type="button" :disabled="query.isFetching.value" @click="query.refetch()"><RefreshCw :size="12" />刷新</button>
        <router-link to="/settings"><Settings2 :size="12" />策略设置</router-link>
      </div>
      <AgentWeeklyReportCard :report="query.data.value.weeklyReport" :pending="actions.pending.value" @generate="generateWeeklyReport" />
      <div class="automation-heading"><span>待处理任务</span><small>{{ activeJobs.length }} 条</small></div>
      <nav v-if="conversationId" class="automation-scopes" aria-label="自动化任务范围">
        <button type="button" :class="{ active: scope === 'conversation' }" @click="scope = 'conversation'">当前会话 {{ scopedActiveJobs.length }}</button>
        <button type="button" :class="{ active: scope === 'all' }" @click="scope = 'all'">全部 {{ allActiveJobs.length }}</button>
      </nav>
      <nav class="automation-filters" aria-label="自动化任务筛选">
        <button type="button" :class="{ active: filter === 'all' }" @click="filter = 'all'">全部 {{ activeJobs.length }}</button>
        <button type="button" :class="{ active: filter === 'running' }" @click="filter = 'running'">执行中 {{ runningCount }}</button>
        <button type="button" :class="{ active: filter === 'blocked' }" @click="filter = 'blocked'">阻塞 {{ blockedCount }}</button>
      </nav>
      <article v-for="job in visibleJobs" :key="job.id" class="automation-job">
        <header><span>{{ job.issueKey || job.id }}</span><StatusPill :value="job.status" /></header>
        <strong>{{ job.title }}</strong>
        <small>{{ job.branch || '未识别分支' }} · 尝试 {{ job.attempts }} 次</small>
        <footer><button type="button" @click="emit('compose', deliveryJobQuickPrompt(job))">带入会话</button><router-link :to="{ path: '/delivery/runs', query: { job: job.id } }">查看运行</router-link></footer>
      </article>
      <div v-if="!visibleJobs.length" class="automation-empty">当前筛选下没有自动化任务。</div>
    </template>
  </section>
</template>

<style scoped>
.automation-panel{height:100%;min-height:0;padding:16px;overflow-y:auto;background:var(--agent-panel)}.automation-summary{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px;border:1px solid var(--agent-border);border-radius:10px;background:color-mix(in srgb,var(--agent-accent) 9%,var(--agent-panel-strong))}.automation-summary span{display:flex;align-items:center;gap:5px;color:var(--agent-muted);font-size:12px}.automation-summary strong{display:block;margin-top:6px;color:var(--agent-text);font-size:14px}.automation-facts{display:grid;gap:7px;margin:12px 0}.automation-facts div{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:0 2px}.automation-facts dt,.automation-facts dd{margin:0;font-size:12px;line-height:1.5}.automation-facts dt{display:flex;align-items:center;gap:4px;color:var(--agent-muted)}.automation-facts dd{max-width:65%;color:var(--agent-secondary);text-align:right}.automation-actions{display:flex;align-items:center;gap:10px;padding:10px 0 13px;border-bottom:1px solid var(--agent-border)}.automation-actions button,.automation-actions a{display:flex;align-items:center;gap:4px;padding:0;border:0;background:transparent;color:color-mix(in srgb,var(--agent-accent) 55%,#fff);font-size:12px;text-decoration:none;cursor:pointer}.automation-actions button:disabled{opacity:.45;cursor:default}.automation-heading{display:flex;align-items:center;justify-content:space-between;padding:12px 2px 7px;color:var(--agent-secondary);font-size:13px}.automation-heading small{color:var(--agent-muted);font:12px var(--mono)}.automation-scopes,.automation-filters{display:flex;gap:5px;margin-bottom:8px}.automation-scopes button,.automation-filters button{padding:4px 7px;border:1px solid var(--agent-border);border-radius:6px;background:var(--agent-bg);color:var(--agent-muted);font-size:12px;cursor:pointer}.automation-scopes button.active,.automation-filters button.active{border-color:color-mix(in srgb,var(--agent-accent) 42%,var(--agent-border));background:color-mix(in srgb,var(--agent-accent) 12%,var(--agent-panel-strong));color:color-mix(in srgb,var(--agent-accent) 50%,#fff)}.automation-job{margin-bottom:7px;padding:10px;border:1px solid var(--agent-border);border-radius:9px;background:color-mix(in srgb,var(--agent-panel-strong) 82%,transparent)}.automation-job header,.automation-job footer{display:flex;align-items:center;justify-content:space-between;gap:8px}.automation-job header>span{color:var(--agent-muted);font:12px var(--mono)}.automation-job>strong,.automation-job>small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.automation-job>strong{margin-top:7px;color:var(--agent-text);font-size:13px}.automation-job>small{margin:5px 0 9px;color:var(--agent-muted);font-size:12px}.automation-job footer{justify-content:flex-start;gap:12px}.automation-job footer button,.automation-job footer a{padding:0;border:0;background:transparent;color:color-mix(in srgb,var(--agent-accent) 55%,#fff);font-size:12px;text-decoration:none;cursor:pointer}.automation-empty{padding:24px;color:var(--agent-muted);font-size:12px;line-height:1.6;text-align:center}.automation-panel:deep(.el-skeleton__item){background:var(--agent-panel-strong)}.automation-panel:deep(.status-pill){padding:2px 6px;font-size:12px}
.automation-actions,.automation-scopes,.automation-filters,.automation-job footer{flex-wrap:wrap}.automation-job>strong,.automation-job>small{white-space:normal;overflow-wrap:anywhere;line-height:1.6}
</style>
