<script setup lang="ts">
import { useIntegrationPlugins } from '../../plugins/runtime';
const integrations = useIntegrationPlugins();
/** 统一工作台复用同一读模型；嵌入 Agent 时由顶部导航提供入口，独立页面保留快捷入口。 */
import { computed, inject, onBeforeUnmount, onMounted, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { CalendarDays, Terminal, FileCheck2, ArrowUpRight, Bot, Search, RefreshCw, Activity, CircleAlert, ClipboardCheck, Sun, ChevronRight, MessageSquare, Plug, GitBranch } from '@lucide/vue';
import { agentWorkspaceContext } from '../../shared/agent-workspace-context';
import { useWorkspacePanelState } from '../../shared/useWorkspacePanelState';
import { dateTime, day, safeUrl } from '../../shared/format';
import PageHeading from '../../shared/ui/PageHeading.vue';
import StatusPill from '../../shared/ui/StatusPill.vue';
import DeliveryRecords from './DeliveryRecords.vue';
import PersonalTodos from './PersonalTodos.vue';
import TeamPendingTasks from './TeamPendingTasks.vue';
import { useWorkbench } from './useWorkbench';
import { deliveryAcceptanceLabels } from '../../../shared/delivery-acceptance';
import { agentRunPath, agentStatusLabel, deliveryRecordCount, deliveryRecordState, deliveryStatusLabel, forIssue, issueKey, localDay, plannedToday, threadUrl, type DeliveryRecord, type DeliveryRecordFilter, type DeliveryRecordState } from './domain';
import { buildAgentConversations } from '../agent-workbench/conversation';
import { agentTaskBoardColumn } from '../agent-workbench/agent-task-graph';

const PAGE_SIZE = 15;
type RecordTab = DeliveryRecordState | 'all';
const route = useRoute(), router = useRouter();
const workspace = inject(agentWorkspaceContext, undefined);
const { records, errors, loading, fetching, incomplete, refresh, runtime, issues, automation } = useWorkbench({ applyDismissals: true });
const { search, filter, page } = useWorkspacePanelState('today', () => ({ search: '', filter: 'all' as RecordTab, page: 1 }));
const focusedRecord = shallowRef<DeliveryRecord>();
const selectedKey = computed(() => typeof route.query.issue === 'string' ? issueKey(route.query.issue) : '');
const selectedIssue = computed(() => issues.data.value?.issues.find(issue => issue.key === selectedKey.value));
const jiraUrl = computed(() => safeUrl(selectedIssue.value?.url || (selectedKey.value && issues.data.value?.baseUrl ? `${issues.data.value.baseUrl.replace(/\/$/, '')}/browse/${selectedKey.value}` : '')));
const selectedRecords = computed(() => selectedKey.value ? forIssue(records.value, selectedKey.value) : focusedRecord.value ? records.value.filter(record => record.id === focusedRecord.value?.id) : []);
const drawer = computed({ get: () => !!selectedKey.value || !!focusedRecord.value, set: (open: boolean) => { if (!open) { focusedRecord.value = undefined; const { issue: _, ...query } = route.query; void router.replace({ query }); } } });
const title = computed(() => selectedIssue.value?.summary || selectedRecords.value[0]?.title || selectedKey.value);
const now = computed(() => new Date(issues.dataUpdatedAt.value || Date.now()));
const today = computed(() => localDay(now.value));
const monthDay = computed(() => `${now.value.getMonth() + 1}月${now.value.getDate()}日`);
const weekday = computed(() => new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(now.value));
// 刻度尺：现在时刻每分钟刷新；范围默认 08:00–20:00，现在或活动超出时自动扩展。
const clock = shallowRef(new Date());
let clockTimer: ReturnType<typeof setInterval> | undefined;
onMounted(() => { clockTimer = setInterval(() => { clock.value = new Date(); }, 60_000); });
onBeforeUnmount(() => clearInterval(clockTimer));
const minutesOf = (date: Date) => date.getHours() * 60 + date.getMinutes();
const rulerEvents = computed(() => records.value
  .map(record => ({ record, date: new Date(record.updatedAt) }))
  .filter(item => !Number.isNaN(item.date.getTime()) && localDay(item.date) === localDay(clock.value))
  .slice(0, 80));
const syncTimes = computed(() => (automation.data.value?.settings.dailyTimes || []).filter(time => /^\d{1,2}:\d{2}$/.test(time)));
const rulerRange = computed(() => {
  const points = [minutesOf(clock.value), ...rulerEvents.value.map(item => minutesOf(item.date)), ...syncTimes.value.map(time => Number(time.split(':')[0]) * 60 + Number(time.split(':')[1]))];
  const start = Math.min(8 * 60, Math.floor(Math.min(...points) / 60) * 60);
  const end = Math.max(20 * 60, Math.ceil((Math.max(...points) + 1) / 60) * 60);
  return { start, end, hours: Array.from({ length: (end - start) / 60 + 1 }, (_, index) => start / 60 + index) };
});
const rulerAt = (minutes: number) => `${((minutes - rulerRange.value.start) / (rulerRange.value.end - rulerRange.value.start)) * 100}%`;
const timeOf = (date: Date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
const greeting = computed(() => { const hour = new Date().getHours(); return hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好'; });
const issuesLive = computed(() => !!issues.data.value && !issues.error.value && issues.data.value.source !== 'mock');
const todayIssues = computed(() => (issues.data.value?.issues || []).filter(issue => plannedToday(issue, today.value)));
const jiraSyncStatus = computed(() => {
  const data = automation.data.value;
  if (!data) return undefined;
  return {
    schedule: data.settings.dailyTimes.join('、'),
    lastRunAt: data.lastRun?.completedAt ? dateTime(data.lastRun.completedAt) : '尚未执行',
    nextRunAt: data.nextRun ? dateTime(data.nextRun) : '未排期',
    updatedCount: data.lastRun?.transitionUpdatedCount || 0,
    blockedCount: data.lastRun?.transitionBlockedCount || 0,
  };
});
const count = (filter: DeliveryRecordFilter) => deliveryRecordCount(records.value, filter,
  { incomplete: incomplete.value, runtimeKnown: !!runtime.data.value && !runtime.error.value });
// 指标卡同时是筛选入口，点击后直接定位到对应记录，避免看到数字后再去找标签。
const metrics = computed(() => [
  { id: 'today' as const, label: '今日计划', value: issuesLive.value ? todayIssues.value.length : undefined, note: 'Jira 计划日期覆盖今天', icon: Sun, tone: 'primary' },
  { id: 'running' as const, label: 'Agent 执行中', value: count('running'), note: '已关联本机运行', icon: Activity, tone: 'primary' },
  { id: 'review' as const, label: '等待审核', value: count('review'), note: '需要人工确认', icon: ClipboardCheck, tone: 'warning' },
  { id: 'blocked' as const, label: '阻塞 / 失败', value: count('blocked'), note: '需要排查处理', icon: CircleAlert, tone: 'danger' },
]);
const summary = computed(() => {
  const parts = [
    count('running') ? `${count('running')} 个任务正在执行` : '',
    count('review') ? `${count('review')} 项等待审核` : '',
    count('blocked') ? `${count('blocked')} 项阻塞或失败需要处理` : '',
  ].filter(Boolean);
  return parts.length ? parts.join('，') + '。' : incomplete.value ? '部分来源尚未就绪，数据可能不完整。' : '暂无需要处理的交付记录。';
});
const tabDefinitions: { id: RecordTab; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'pending', label: '待处理' },
  { id: 'running', label: '执行中' },
  { id: 'review', label: '待审核' },
  { id: 'blocked', label: '阻塞 / 失败' },
  { id: 'history', label: '历史记录' },
  { id: 'unknown', label: '待核实' },
];
const recordTab = (value: unknown) => tabDefinitions.find(tab => tab.id === (value === 'actionable' ? 'all' : value === 'results' ? 'history' : value))?.id;
filter.value = recordTab(filter.value) || 'all';
watch(() => route.query.filter, value => {
  const explicit = recordTab(value);
  if (explicit) filter.value = explicit;
}, { immediate: true });
const searched = computed(() => {
  const term = search.value.trim().toLowerCase();
  return records.value.filter(record => !term || [record.title, record.source, ...record.issueKeys, ...(record.jiraStatuses || []).map(issue => issue.status), record.project, record.workspacePath, record.branch, record.threadId, record.runId].join(' ').toLowerCase().includes(term));
});
const tabRecords = (tab: RecordTab) => searched.value.filter(record => tab === 'all' || deliveryRecordState(record) === tab);
const tabs = computed(() => tabDefinitions.map(tab => ({ ...tab,
  count: incomplete.value ? '—' : tabRecords(tab.id).length,
})));
const filtered = computed(() => tabRecords(filter.value));
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / PAGE_SIZE)));
const visible = computed(() => filtered.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE));
watch([search, filter], () => { page.value = 1; });
watch(filter, value => { if (workspace) void router.replace({ query: { ...route.query, filter: value } }); });
watch(() => filtered.value.length, () => { page.value = Math.min(page.value, pageCount.value); });
function pickMetric(id: 'today' | 'running' | 'review' | 'blocked') {
  if (id === 'today') { document.getElementById('workbench-today')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); return; }
  filter.value = id;
  document.getElementById('workbench-records')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function inspect(record: DeliveryRecord) { if (record.issueKeys[0]) openIssue(record.issueKeys[0]); else focusedRecord.value = record; }
function openIssue(key: string) { focusedRecord.value = undefined; void router.replace({ query: { ...route.query, issue: key } }); }

/** 当前状态优先取本机 Agent 快照；没有关联运行时才回落到来源记录的历史状态，并在文案上区分。 */
function primaryStatus(record: DeliveryRecord) {
  if (record.agentStatus) return { value: record.agentStatus === 'completed' ? 'ended' : record.agentStatus, label: agentStatusLabel(record.agentStatus), live: true };
  return { value: record.sourceKind === 'agent' && record.status === 'completed' ? 'ended' : record.status, label: deliveryStatusLabel(record), live: false };
}
function tone(record: DeliveryRecord) {
  const value = (record.currentStatus || record.agentStatus || record.status || '').toLowerCase();
  if (/blocked|fail|error/.test(value)) return 'danger';
  if (/review/.test(value)) return 'warning';
  if (/running|queued|progress|active|dispatch/.test(value)) return 'primary';
  if (/completed|ended|done|success/.test(value)) return 'success';
  return 'idle';
}
function acceptanceLabel(record: DeliveryRecord) {
  return record.acceptanceKnown === false ? '验收未就绪' : deliveryAcceptanceLabels[record.acceptanceStatus || 'pending'];
}
function acceptanceTone(record: DeliveryRecord) {
  return record.acceptanceStatus === 'accepted' ? 'success' : record.acceptanceStatus === 'rejected' ? 'danger' : record.acceptanceStatus === 'stale' ? 'warning' : 'idle';
}
function folder(path = '') { return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''; }
function relative(value?: string) {
  const time = Date.parse(value || '');
  if (!time) return '—';
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} 小时前`;
  if (minutes < 60 * 24 * 7) return `${Math.round(minutes / 1440)} 天前`;
  return dateTime(value);
}
const shortcuts = computed(() => [
  { path: '/agent', title: 'Agent 工作台', detail: '会话与执行过程', icon: Bot },
  { path: '/projects', title: '本地项目与 Git', detail: '目录扫描、代码与分支管理', icon: GitBranch },
  { path: '/design', title: '需求开发', detail: '需求、方案与功能开发', icon: FileCheck2 },
  { path: '/delivery/queue', title: '交付队列', detail: '自动巡检与执行记录', icon: Terminal },
  ...integrations.active.value.flatMap(plugin => plugin.views.map(view => ({path: view.path, title: view.label, detail: plugin.name, icon: Plug}))),
]);
const agentBoardDefinitions = [
  { id: 'queued', label: '待处理', tone: 'warning' },
  { id: 'running', label: '执行中', tone: 'primary' },
  { id: 'review', label: '待复核', tone: 'review' },
  { id: 'completed', label: '已完成', tone: 'success' },
  { id: 'blocked', label: '阻塞', tone: 'danger' },
] as const;
const agentBoardColumns = computed(() => {
  const latest = buildAgentConversations(runtime.data.value?.runs || [])
    .map(conversation => conversation.latest)
    .filter(run => !!run.task || ['queued', 'running'].includes(run.status));
  return agentBoardDefinitions.map(column => ({
    ...column,
    runs: latest.filter(run => agentTaskBoardColumn(run.status, run.task?.role || 'main') === column.id).slice(0, 8),
  }));
});
const agentBoardVisible = computed(() => !!runtime.data.value && !runtime.error.value && agentBoardColumns.value.some(column => column.runs.length));
const agentAcceptanceByRunId = computed(() => new Map(records.value
  .filter(record => record.sourceKind === 'agent' && !!record.runId)
  .map(record => [record.runId!, record])));
function agentRoleLabel(run: { task?: { role: string } }) {
  return run.task?.role === 'reviewer' ? '复核 Agent' : run.task?.role === 'worker' ? '执行 Agent' : '主 Agent';
}
function agentGateLabel(run: { id: string; status: string; resultReady?: boolean; result?: string; error?: string; recovery?: { state: string } }) {
  if (run.recovery?.state === 'active') return '原进程仍在，待核对';
  if (run.recovery?.state === 'needs-review') return '恢复待确认';
  if (run.recovery?.state === 'pending') return '恢复待核对';
  const acceptance = agentAcceptanceByRunId.value.get(run.id);
  if (acceptance?.acceptanceKnown === false) return '验收来源未就绪';
  if (acceptance?.acceptanceStatus === 'accepted') return '人工验收通过';
  if (acceptance?.acceptanceStatus === 'rejected') return '人工验收未通过';
  if (acceptance?.acceptanceStatus === 'stale') return '需重新验收';
  if (run.status === 'completed' && run.resultReady) return '等待人工验收';
  if (run.status === 'completed') return '结果已完成，待落盘核对';
  if (['failed', 'interrupted', 'cancelled'].includes(run.status)) return '执行未通过';
  return run.result ? '结果已回传' : '执行中';
}
</script>
<template>
  <div class="wb" :class="{ embedded: workspace }">
    <PageHeading title="我的工作台" description="统一查看今日任务、原会话、执行结果和交付证据。" :loading="fetching || issues.isFetching.value" @refresh="refresh"><RouterLink v-if="!workspace" to="/agent"><el-button type="primary">打开 Agent 工作台 <ArrowUpRight :size="14" /></el-button></RouterLink></PageHeading>

    <div class="wb-masthead">
      <header class="wb-hero">
        <div class="wb-hero-title">
          <h1>{{ monthDay }}</h1>
          <p class="wb-eyebrow">{{ weekday }} · {{ greeting }}</p>
        </div>
        <p class="wb-summary">{{ summary }}</p>
      </header>

      <section class="wb-ruler" :aria-label="`今日交付刻度：${rulerEvents.length} 次交付活动，现在 ${timeOf(clock)}`">
        <div class="wb-ruler-track">
          <span v-for="hour in rulerRange.hours" :key="hour" class="wb-tick" :class="{ major: hour % 2 === 0 }" :style="{ left: rulerAt(hour * 60) }"><small>{{ String(hour).padStart(2, '0') }}</small></span>
          <span v-for="time in syncTimes" :key="time" class="wb-sync-mark" :style="{ left: rulerAt(Number(time.split(':')[0]) * 60 + Number(time.split(':')[1])) }" :title="`Jira 自动同步 ${time}`"></span>
          <button v-for="item in rulerEvents" :key="item.record.id" type="button" class="wb-event" :class="tone(item.record)" :style="{ left: rulerAt(minutesOf(item.date)) }" :title="`${timeOf(item.date)} · ${item.record.title || item.record.issueKeys[0] || '交付记录'}`" @click="inspect(item.record)"></button>
          <span class="wb-now" :style="{ left: rulerAt(minutesOf(clock)) }"><b>现在 {{ timeOf(clock) }}</b></span>
        </div>
        <p class="wb-ruler-legend"><span><i class="dot"></i>今日交付活动 {{ rulerEvents.length }} 次</span><span v-if="syncTimes.length"><i class="diamond"></i>Jira 自动同步 {{ syncTimes.join('、') }}</span><span><i class="line"></i>当前时刻</span></p>
      </section>
    </div>

    <el-alert v-for="error in errors" :key="error" :title="error" type="error" :closable="false" class="wb-alert" />
    <el-alert
      v-if="issues.error.value"
      :title="issues.error.value.message.includes('未配置鉴权') ? 'Jira 尚未配置连接凭据，可在「交付与连接设置」中填入 Jira 地址与 Token 后同步任务' : `Jira 任务：${issues.error.value.message}`"
      :type="issues.error.value.message.includes('未配置鉴权') ? 'info' : 'error'"
      :closable="false"
      class="wb-alert"
    />
    <el-alert v-if="issues.data.value?.source === 'mock'" title="当前任务来源为模拟数据，不是实时 Jira 排期" type="warning" :closable="false" class="wb-alert" />

    <section class="wb-metrics" aria-label="工作台指标">
      <button v-for="item in metrics" :key="item.id" type="button" class="wb-metric" :class="[item.value ? item.tone : 'zero', { active: item.id === filter }]" @click="pickMetric(item.id)">
        <span class="wb-metric-icon"><component :is="item.icon" :size="17" /></span>
        <span class="wb-metric-text"><span>{{ item.label }}</span><small>{{ item.note }}</small></span>
        <strong>{{ item.value ?? '—' }}</strong>
      </button>
    </section>

    <div class="wb-grid">
      <div class="wb-main">
        <section id="workbench-records" class="wb-card wb-records">
          <div class="wb-card-head">
            <div><h2>任务、会话与交付结果</h2><p>按当前状态分类，保留每轮执行历史{{ incomplete ? ' · 部分来源尚未就绪' : '' }}</p></div>
            <el-input v-model="search" placeholder="搜索任务、Jira、项目、分支或会话" clearable aria-label="搜索交付记录" class="wb-search"><template #prefix><Search :size="14" /></template></el-input>
          </div>
          <div class="wb-tabs" role="tablist" aria-label="交付记录筛选">
            <button v-for="tab in tabs" :key="tab.id" type="button" role="tab" :aria-selected="filter === tab.id" :class="{ active: filter === tab.id }" @click="filter = tab.id">{{ tab.label }}<span>{{ tab.count }}</span></button>
          </div>

          <div v-loading="loading && !records.length" class="wb-list">
            <article v-for="row in visible" :key="row.id" class="wb-row" :class="tone(row)">
              <button type="button" class="wb-row-main" :title="`查看详情：${row.title || row.issueKeys[0] || '交付记录'}`" @click="inspect(row)">
                <span class="wb-row-title">{{ row.title || row.issueKeys[0] || '交付记录' }}</span>
                <span class="wb-row-meta">
                  <span class="wb-tag">{{ row.source }}</span>
                  <template v-if="row.jiraStatuses?.length"><span v-for="issue in row.jiraStatuses" :key="issue.key" class="wb-key">{{ issue.key }} · {{ issue.status }}</span></template>
                  <span v-else-if="row.issueKeys.length" class="wb-key">{{ row.issueKeys.join(' · ') }}</span>
                  <span v-else class="wb-dim">未关联 Jira</span>
                  <span v-if="row.project || row.workspacePath" class="wb-dim wb-path" :title="[row.project, row.workspacePath].filter(Boolean).join('\n')">{{ folder(row.project || row.workspacePath) }}</span>
                  <span v-if="row.branch" class="wb-branch" :title="row.branch"><GitBranch :size="11" /><span>{{ row.branch }}</span></span>
                </span>
              </button>
              <div class="wb-row-status">
                <StatusPill :value="primaryStatus(row).value" :label="primaryStatus(row).label" />
                <span class="wb-hint">{{ primaryStatus(row).live ? 'Agent 当前' : row.agentStateKnown === false ? 'Agent 未就绪 · 历史' : '历史记录' }}</span>
              </div>
              <div class="wb-row-accept"><span class="wb-badge" :class="acceptanceTone(row)">{{ acceptanceLabel(row) }}</span></div>
              <time class="wb-row-time" :datetime="row.updatedAt" :title="dateTime(row.updatedAt)">{{ relative(row.updatedAt) }}</time>
              <div class="wb-row-actions">
                <RouterLink v-if="row.runId" :to="agentRunPath(row.runId)" class="wb-icon-btn" title="打开 Agent 会话" aria-label="打开 Agent 会话"><MessageSquare :size="15" /></RouterLink>
                <a v-else-if="threadUrl(row.threadId)" :href="threadUrl(row.threadId)" class="wb-icon-btn" title="打开原会话" aria-label="打开原会话"><ArrowUpRight :size="15" /></a>
                <span v-else class="wb-icon-btn disabled" :title="row.clientThreadId ? '会话创建中' : '未关联会话'"><MessageSquare :size="15" /></span>
                <button type="button" class="wb-icon-btn" title="详情与验收" aria-label="详情与验收" @click="inspect(row)"><ChevronRight :size="16" /></button>
              </div>
            </article>
            <el-empty v-if="!visible.length && !(loading && !records.length)" :description="errors.length ? '来源读取失败或没有匹配记录' : search ? '没有匹配的交付记录，试试其他关键词' : '当前筛选下暂时没有记录'" :image-size="40">
              <div v-if="records.length && (filter !== 'all' || search)" class="wb-empty-actions">
                <button v-if="search" type="button" class="wb-empty-btn" @click="search = ''">清空搜索</button>
                <button v-if="filter !== 'all'" type="button" class="wb-empty-btn primary" @click="filter = 'all'">查看全部记录 ({{ searched.length }})</button>
              </div>
            </el-empty>
          </div>
          <div class="wb-foot">
            <span>{{ incomplete ? '已读取 ' : '共 ' }}{{ filtered.length }} 条{{ pageCount > 1 ? ` · 第 ${page}/${pageCount} 页` : '' }}</span>
            <el-pagination v-if="pageCount > 1" v-model:current-page="page" :total="filtered.length" :page-size="PAGE_SIZE" layout="prev, pager, next" small />
          </div>
        </section>

        <section v-if="agentBoardVisible" class="wb-card wb-agent-board" aria-label="Agent 协作任务总览">
          <div class="wb-card-head">
            <div><h2><Activity :size="15" />Agent 协作任务总览</h2><p>按真实运行快照汇总；执行完成不等于交付验收通过</p></div>
            <RouterLink to="/agent" class="wb-link">打开 Agent 工作台 <ArrowUpRight :size="12" /></RouterLink>
          </div>
          <div class="wb-agent-columns">
            <section v-for="column in agentBoardColumns" :key="column.id" class="wb-agent-column" :class="`tone-${column.tone}`">
              <header><strong>{{ column.label }}</strong><span>{{ column.runs.length }}</span></header>
              <RouterLink v-for="run in column.runs" :key="run.id" :to="agentRunPath(run.id)" class="wb-agent-run">
                <div class="wb-agent-run-head"><strong>{{ run.task?.title || run.objective }}</strong><StatusPill :value="run.status" /></div>
                <small>{{ agentRoleLabel(run) }} · {{ run.provider }} · {{ run.branch || '普通文件夹' }}</small>
                <small class="wb-agent-gate">{{ agentGateLabel(run) }} · {{ run.changedFiles?.length || 0 }} 个改动 · {{ run.events.length }} 条事件</small>
              </RouterLink>
              <p v-if="!column.runs.length" class="wb-agent-empty">暂无</p>
            </section>
          </div>
        </section>
      </div>

      <aside class="wb-aside">
        <component v-for="widget in integrations.widgets.value" :is="widget.component" :key="widget.id" :today="today" :today-issues="todayIssues" :loading="issues.isPending.value" :error="issues.error.value" :jira-sync-status="jiraSyncStatus" @open-issue="openIssue" />
        <TeamPendingTasks /><PersonalTodos />

        <section class="wb-card">
          <div class="wb-card-head compact"><div><h2>工作入口</h2><p>常用研发与交付视图</p></div></div>
          <nav class="wb-shortcuts">
            <RouterLink v-for="item in shortcuts.filter(entry => !workspace || entry.path !== '/agent')" :key="item.path" :to="item.path"><span class="wb-metric-icon"><component :is="item.icon" :size="16" /></span><span><strong>{{ item.title }}</strong><small>{{ item.detail }}</small></span><ArrowUpRight :size="14" /></RouterLink>
          </nav>
        </section>
      </aside>
    </div>

    <el-drawer v-model="drawer" :title="title" size="min(920px, 94vw)" class="hub-drawer" destroy-on-close>
      <div v-if="selectedKey" class="wb-drawer-head">
        <span class="wb-key large">{{ selectedKey }}</span>
        <StatusPill v-if="selectedIssue" :value="selectedIssue.status" :label="selectedIssue.status" />
        <span v-if="selectedIssue" class="wb-dim">计划 {{ day(selectedIssue.startDate) }} → {{ day(selectedIssue.endDate || selectedIssue.dueDate) }}</span>
        <span class="wb-spacer"></span>
        <RouterLink v-if="selectedIssue" :to="`/tasks/list?q=${encodeURIComponent(selectedKey)}`" class="wb-link">在任务列表查看</RouterLink>
        <a v-if="jiraUrl" :href="jiraUrl" target="_blank" rel="noreferrer" class="wb-link">打开 Jira <ArrowUpRight :size="12" /></a>
      </div>
      <DeliveryRecords :records="selectedRecords" :errors="errors" :loading="loading" :incomplete="incomplete" />
      <template #footer><el-button @click="drawer = false">关闭</el-button></template>
    </el-drawer>
  </div>
</template>
<style scoped>
.wb{--wb-radius:12px;display:flex;flex-direction:column;gap:14px;color:var(--ui-text)}
.wb-hero{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:end;gap:12px 40px;padding:2px 2px 0}.wb-hero-title{display:flex;align-items:baseline;gap:16px}
.wb-eyebrow{margin:0;font-size:13px;color:var(--ui-muted);letter-spacing:.08em}
.wb-hero h1{margin:0;font:700 40px/1 var(--ds-display,serif);letter-spacing:.02em}
.wb-summary{max-width:38em;margin:0;padding-left:20px;border-left:1px solid var(--ui-border);font-size:14px;line-height:1.7;color:var(--ui-secondary)}
.wb-ruler{padding:2px 2px 0}
.wb-ruler-track{position:relative;height:42px;margin:0 14px;border-bottom:1px solid var(--ui-text)}
.wb-tick{position:absolute;bottom:0;width:1px;height:8px;background:var(--ui-border);transform:translateX(-50%)}.wb-tick.major{height:13px;background:var(--ui-muted)}
.wb-tick small{position:absolute;top:calc(100% + 10px);left:50%;transform:translateX(-50%);font:11px var(--ds-code,monospace);color:var(--ui-muted)}.wb-tick:not(.major) small{opacity:.55}
.wb-sync-mark{position:absolute;bottom:-5px;width:9px;height:9px;border:1.5px solid var(--ui-text);background:var(--ui-surface);transform:translateX(-50%) rotate(45deg)}
.wb-event{position:absolute;bottom:10px;width:10px;height:10px;padding:0;border:2px solid var(--ui-surface);border-radius:50%;background:var(--ui-muted);transform:translateX(-50%);cursor:pointer;transition:transform 160ms cubic-bezier(.2,.7,.2,1)}
.wb-event:nth-of-type(3n){bottom:19px}.wb-event:nth-of-type(3n+1){bottom:28px}
.wb-event:hover,.wb-event:focus-visible{transform:translateX(-50%) scale(1.5);outline:none}
.wb-event.primary{background:var(--ui-accent)}.wb-event.danger{background:var(--ui-danger)}.wb-event.warning{background:var(--ui-warning)}.wb-event.success{background:var(--ui-success)}
.wb-now{position:absolute;top:-4px;bottom:-4px;width:2px;background:var(--ui-accent);transform:translateX(-50%)}
.wb-now b{position:absolute;top:-15px;left:6px;font:600 11px var(--ds-code,monospace);color:var(--ui-accent);white-space:nowrap}
.wb-ruler-legend{display:flex;flex-wrap:wrap;gap:6px 20px;margin:24px 14px 0;font-size:12px;color:var(--ui-muted)}.wb-ruler-legend span{display:inline-flex;align-items:center;gap:7px}
.wb-ruler-legend i{display:inline-block}.wb-ruler-legend .dot{width:8px;height:8px;border-radius:50%;background:var(--ui-accent)}.wb-ruler-legend .diamond{width:7px;height:7px;border:1.5px solid var(--ui-text);transform:rotate(45deg)}.wb-ruler-legend .line{width:2px;height:12px;background:var(--ui-accent)}
.wb-alert{margin:0}

.wb-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.wb-metric{display:flex;align-items:center;gap:12px;min-width:0;padding:12px 16px;border:1px solid var(--ui-border);border-radius:var(--wb-radius);background:var(--ui-surface);color:var(--ui-text);text-align:left;font:inherit;cursor:pointer;transition:border-color .15s,box-shadow .15s,transform .15s}
.wb-metric:hover{border-color:var(--ui-accent);box-shadow:var(--ui-shadow);transform:translateY(-1px)}
.wb-metric.active{border-color:var(--ui-accent);box-shadow:0 0 0 3px var(--ui-accent-soft)}
.wb-metric-icon{display:grid;place-items:center;flex-shrink:0;width:34px;height:34px;border-radius:9px;background:var(--ui-raised);color:var(--ui-muted)}
.wb-metric-text{flex:1;min-width:0}.wb-metric-text>span{display:block;font-size:13px;font-weight:550}
.wb-metric-text small{display:block;margin-top:2px;font-size:11px;color:var(--ui-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wb-metric strong{font:600 28px/1 var(--ds-numeral,var(--sans));font-variant-numeric:tabular-nums;letter-spacing:-.5px;color:var(--ui-muted)}
.wb-metric.primary .wb-metric-icon{background:var(--ui-accent-soft);color:var(--ui-accent)}.wb-metric.primary strong{color:var(--ui-accent)}
.wb-metric.warning .wb-metric-icon{background:var(--ui-warning-bg);color:var(--ui-warning)}.wb-metric.warning strong{color:var(--ui-warning)}
.wb-metric.danger .wb-metric-icon{background:var(--ui-danger-bg);color:var(--ui-danger)}.wb-metric.danger strong{color:var(--ui-danger)}

.wb-grid{display:flex;flex-direction:column;gap:14px;min-width:0}
.wb-aside{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr) minmax(0,1fr);gap:14px;align-items:stretch}
.wb-aside>.wb-card{display:flex;flex-direction:column}
.wb-card{border:1px solid var(--ui-border);border-radius:var(--wb-radius);background:var(--ui-surface);overflow:hidden;min-width:0}
.wb-card-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 18px}
.wb-card-head.compact{padding:12px 16px 8px}
.wb-card-head h2{display:flex;align-items:center;gap:6px;margin:0;font-size:15px;font-weight:600}
.wb-card-head p{margin:2px 0 0;font-size:12px;color:var(--ui-muted)}
.wb-search{max-width:300px}.wb-search svg{color:var(--ui-muted)}
.wb-link{display:inline-flex;align-items:center;gap:3px;color:var(--ui-accent);font-size:12px;white-space:nowrap}.wb-link:hover{text-decoration:underline}
.wb-pad{padding:4px 16px 16px}

.wb-agent-board{overflow:hidden}.wb-agent-columns{display:grid;grid-template-columns:repeat(5,minmax(150px,1fr));gap:8px;padding:0 16px 14px;overflow-x:auto}.wb-agent-column{display:flex;flex-direction:column;min-width:150px;max-height:220px;padding:9px;border:1px solid var(--ui-border);border-radius:9px;background:var(--ui-raised);overflow-y:auto}.wb-agent-column.tone-primary{border-color:color-mix(in srgb,var(--ui-accent) 48%,var(--ui-border))}.wb-agent-column.tone-review{border-color:color-mix(in srgb,#a978ed 48%,var(--ui-border))}.wb-agent-column.tone-success{border-color:color-mix(in srgb,var(--ui-success) 48%,var(--ui-border))}.wb-agent-column.tone-danger{border-color:color-mix(in srgb,var(--ui-danger) 48%,var(--ui-border))}.wb-agent-column>header{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;font-size:12px}.wb-agent-column>header span{min-width:18px;padding:1px 4px;border-radius:5px;background:var(--ui-surface);color:var(--ui-muted);font:11px var(--mono);text-align:center}.wb-agent-run{display:block;margin-top:6px;padding:8px;border:1px solid var(--ui-border);border-radius:7px;background:var(--ui-surface);color:var(--ui-text);text-decoration:none;flex-shrink:0}.wb-agent-run:hover{border-color:var(--ui-accent);background:var(--ui-hover)}.wb-agent-run-head{display:flex;align-items:flex-start;justify-content:space-between;gap:5px}.wb-agent-run-head strong{display:-webkit-box;min-width:0;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2;font-size:11px;line-height:1.45}.wb-agent-run:deep(.status-pill){padding:1px 4px;font-size:9px}.wb-agent-run>small{display:block;margin-top:4px;overflow:hidden;color:var(--ui-muted);font-size:10px;text-overflow:ellipsis;white-space:nowrap}.wb-agent-run .wb-agent-gate{color:var(--ui-secondary)}.wb-agent-empty{margin:auto 0;padding:12px 0;color:var(--ui-muted);font-size:11px;text-align:center}

.wb-tabs{display:flex;gap:4px;margin:0 18px;padding:3px;border-radius:9px;background:var(--ui-raised);overflow-x:auto;width:fit-content;max-width:calc(100% - 36px)}
.wb-tabs button{display:inline-flex;align-items:center;gap:6px;flex-shrink:0;padding:6px 12px;border:0;border-radius:7px;background:transparent;color:var(--ui-secondary);font:inherit;font-size:12px;cursor:pointer}
.wb-tabs button span{min-width:18px;padding:0 5px;border-radius:9px;background:var(--ui-surface);color:var(--ui-muted);font:11px/18px var(--mono);text-align:center}
.wb-tabs button:hover{color:var(--ui-text)}
.wb-tabs button.active{background:var(--ui-surface);color:var(--ui-accent);font-weight:550;box-shadow:0 1px 3px var(--ui-shadow-color,#0000001a)}
.wb-tabs button.active span{background:var(--ui-accent-soft);color:var(--ui-accent)}

.wb-list{margin-top:10px;border-top:1px solid var(--ui-divider)}
.wb-row{position:relative;display:grid;grid-template-columns:minmax(0,1fr) 128px 96px 76px auto;align-items:center;gap:14px;padding:11px 18px 11px 21px;border-bottom:1px solid var(--ui-divider);transition:background .12s}
.wb-row::before{content:'';position:absolute;left:0;top:10px;bottom:10px;width:3px;border-radius:0 3px 3px 0;background:var(--ui-divider)}
.wb-row.primary::before{background:var(--ui-accent)}.wb-row.warning::before{background:var(--ui-warning)}.wb-row.danger::before{background:var(--ui-danger)}.wb-row.success::before{background:var(--ui-success)}
.wb-row:hover{background:var(--ui-hover)}
.wb-row-main{min-width:0;padding:0;border:0;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}
.wb-row-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:13px;font-weight:550;line-height:1.55}
.wb-row-main:hover .wb-row-title{color:var(--ui-accent)}
.wb-row-meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;margin-top:4px;font-size:11px;color:var(--ui-muted)}
.wb-tag{padding:1px 7px;border-radius:5px;background:var(--ui-raised);color:var(--ui-secondary)}
.wb-key{font-family:var(--mono);color:var(--ui-secondary)}.wb-key.large{font-size:13px;font-weight:600;color:var(--ui-text)}
.wb-dim{color:var(--ui-muted)}
.wb-path,.wb-branch{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wb-branch{display:inline-flex;align-items:center;gap:3px;font-family:var(--mono);color:var(--ui-secondary)}.wb-branch svg{flex-shrink:0;color:var(--ui-muted)}.wb-branch>span{overflow:hidden;text-overflow:ellipsis}
.wb-row-status{display:flex;flex-direction:column;align-items:flex-start;gap:3px}
.wb-hint{font-size:10px;color:var(--ui-muted)}
.wb-badge{display:inline-block;padding:3px 8px;border-radius:5px;font-size:11px;white-space:nowrap;background:var(--ui-raised);color:var(--ui-muted)}
.wb-badge.success{background:var(--ui-success-bg);color:var(--ui-success)}.wb-badge.danger{background:var(--ui-danger-bg);color:var(--ui-danger)}.wb-badge.warning{background:var(--ui-warning-bg);color:var(--ui-warning)}
.wb-row-time{font-size:11px;color:var(--ui-muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.wb-row-actions{display:flex;gap:4px}
.wb-icon-btn{display:grid;place-items:center;width:30px;height:30px;padding:0;border:1px solid var(--ui-border);border-radius:8px;background:var(--ui-surface);color:var(--ui-secondary);cursor:pointer;transition:all .12s}
.wb-icon-btn:hover{border-color:var(--ui-accent);color:var(--ui-accent);background:var(--ui-accent-soft)}
.wb-icon-btn.disabled{opacity:.35;cursor:not-allowed}.wb-icon-btn.disabled:hover{border-color:var(--ui-border);color:var(--ui-secondary);background:var(--ui-surface)}
.wb-list :deep(.el-empty){padding:18px 16px;border-bottom:1px solid var(--ui-divider)}
.wb-list :deep(.el-empty__description){margin-top:6px}
.wb-list :deep(.el-empty__bottom){margin-top:10px}
.wb-empty-actions{display:flex;flex-wrap:wrap;justify-content:center;gap:8px}
.wb-empty-btn{padding:5px 12px;border:1px solid var(--ui-border);border-radius:7px;background:var(--ui-surface);color:var(--ui-secondary);font:inherit;font-size:12px;cursor:pointer;transition:all .12s}
.wb-empty-btn:hover{border-color:var(--ui-accent);color:var(--ui-accent)}
.wb-empty-btn.primary{border-color:var(--ui-accent-soft);background:var(--ui-accent-soft);color:var(--ui-accent);font-weight:500}
.wb-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 18px;font-size:12px;color:var(--ui-muted)}

.wb-today{list-style:none;margin:0;padding:0 8px 8px;max-height:248px;overflow-y:auto}
.wb-today button{display:flex;align-items:center;gap:10px;width:100%;padding:6px 8px;border:0;border-radius:8px;background:transparent;color:var(--ui-text);text-align:left;font:inherit;cursor:pointer}
.wb-today button:hover{background:var(--ui-hover)}
.wb-today button>span:first-child{flex:1;min-width:0;display:flex;align-items:baseline;gap:6px}
.wb-today small{flex-shrink:0;font:11px var(--mono);color:var(--ui-muted)}
.wb-today strong{display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden;font-size:12px;font-weight:500;line-height:1.5}
.wb-more{padding:4px 8px 2px;font-size:12px}.wb-more a{color:var(--ui-accent)}
.wb-empty{margin:auto 0;padding:18px 16px;font-size:12px;color:var(--ui-muted);text-align:center}

.wb-sync dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:0;padding:0 16px}
.wb-sync dl>div{padding:8px 10px;border-radius:8px;background:var(--ui-raised)}
.wb-sync dt{font-size:11px;color:var(--ui-muted)}.wb-sync dd{margin:2px 0 0;font-size:12px;font-weight:550;font-variant-numeric:tabular-nums}.wb-sync dd.warn{color:var(--ui-warning)}
.wb-note{margin:auto 0 0;padding:10px 16px 12px;font-size:11px;line-height:1.6;color:var(--ui-muted)}

.wb-shortcuts{display:flex;flex-direction:column;justify-content:space-between;flex:1;padding:0 8px 8px}
.wb-shortcuts a{display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:8px;color:var(--ui-text)}
.wb-shortcuts a:hover{background:var(--ui-hover)}.wb-shortcuts a:hover>svg{color:var(--ui-accent)}
.wb-shortcuts .wb-metric-icon{width:28px;height:28px;border-radius:7px;background:var(--ui-accent-soft);color:var(--ui-accent)}
.wb-shortcuts a>span:nth-child(2){flex:1;min-width:0}
.wb-shortcuts strong{display:block;font-size:12px;font-weight:550;line-height:1.35}.wb-shortcuts small{display:block;font-size:11px;color:var(--ui-muted);line-height:1.35}
.wb-shortcuts a>svg{color:var(--ui-muted)}

.wb-drawer-head{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:12px 14px;margin-bottom:6px;border:1px solid var(--ui-border);border-radius:10px;background:var(--ui-raised);font-size:12px}
.wb-spacer{flex:1}

@media(max-width:1280px){.wb-row{grid-template-columns:minmax(0,1fr) 120px 88px auto}.wb-row-time{display:none}}
@media(max-width:1120px){.wb-aside{grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}}
@media(max-width:860px){.wb-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.wb-row{grid-template-columns:minmax(0,1fr) auto;row-gap:8px}.wb-row-status{flex-direction:row;align-items:center;grid-column:1}.wb-row-accept{grid-column:1}.wb-row-actions{grid-column:2;grid-row:1/span 3}}
@media(max-width:600px){.wb-hero{grid-template-columns:1fr}.wb-summary{padding-left:0;border-left:0}.wb-hero h1{font-size:34px}.wb-tick:not(.major) small{display:none}.wb-card-head{flex-direction:column;align-items:stretch}.wb-search{max-width:none}.wb-metric-text small{display:none}}
@container workspace-page (max-width:1040px){.wb-aside{grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}}
@container workspace-page (max-width:820px){.wb-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.wb-row{grid-template-columns:minmax(0,1fr) auto;row-gap:8px}.wb-row-time{display:none}.wb-row-status{flex-direction:row;align-items:center;grid-column:1}.wb-row-accept{grid-column:1}.wb-row-actions{grid-column:2;grid-row:1/span 3}}
</style>
