<script setup lang="ts">
import { useIntegrationPlugins } from '../../plugins/runtime';
const integrations = useIntegrationPlugins();
/** 统一工作台复用同一读模型；嵌入 Agent 时由顶部导航提供入口，独立页面保留快捷入口。 */
import { computed, defineAsyncComponent, inject, onBeforeUnmount, onMounted, shallowRef, useTemplateRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { CalendarDays, Terminal, FileCheck2, ArrowUpRight, Bot, Search, RefreshCw, Activity, CircleAlert, ClipboardCheck, Sun, ChevronRight, MessageSquare, Plug, GitBranch, LayoutGrid, List, Copy, Check } from '@lucide/vue';
import { agentProviderLabels } from '../../../shared/agent-runtime';
import { agentWorkspaceContext } from '../../shared/agent-workspace-context';
import { useWorkspacePanelState } from '../../shared/useWorkspacePanelState';
import { dateTime, day, safeUrl } from '../../shared/format';
import { useTheme } from '../../shared/theme/useTheme';
import PageHeading from '../../shared/ui/PageHeading.vue';

const ImmersivePhotoStage = defineAsyncComponent(() => import('../../shared/ui/ImmersivePhotoStage.vue'));
const CinematicVideoStage = defineAsyncComponent(() => import('../../shared/ui/CinematicVideoStage.vue'));
const { current: currentTheme } = useTheme();
import StatusPill from '../../shared/ui/StatusPill.vue';
import PersonalTodos from './PersonalTodos.vue';
import TeamPendingTasks from './TeamPendingTasks.vue';
const DeliveryRecords = defineAsyncComponent(() => import('./DeliveryRecords.vue'));
import { useWorkbench } from './useWorkbench';
import { deliveryAcceptanceLabels } from '../../../shared/delivery-acceptance';
import { agentRunPath, agentStatusLabel, deliveryRecordCount, deliveryRecordState, deliveryStatusLabel, forIssue, issueKey, localDay, plannedToday, threadUrl, type DeliveryRecord, type DeliveryRecordFilter, type DeliveryRecordState } from './domain';
import { buildAgentConversations } from '../agent-workbench/conversation';
import { agentTaskBoardColumn } from '../agent-workbench/agent-task-graph';
import { useHolyGrailAside } from '../../shared/ui/useHolyGrailAside';

const PAGE_SIZE = 15;
type RecordTab = DeliveryRecordState | 'all';
const route = useRoute(), router = useRouter();
const workspace = inject(agentWorkspaceContext, undefined);
const hgAsideActive = useHolyGrailAside(Boolean(workspace));
const { records, errors, loading, fetching, incomplete, refresh: refreshWorkbench, runtime, issues, automation } = useWorkbench({ applyDismissals: true });
type TaskFlowDispatch = { id: string; jiraKey: string; title: string; status: string; phase: string | null; error: string | null; updatedAt: string; taskUrl: string };
const dispatchLabels: Record<string, string> = {
  QUEUED: '等待本机领取', CLAIMED: '本机已领取', EXECUTING: '本机执行中', RUNNING: '执行中',
  SUCCEEDED: '已完成', FAILED: '失败', CANCELLED: '已取消', INTERRUPTED: '已中断',
};
const taskFlowDispatches = useQuery({
  queryKey: ['workbench-taskflow-dispatches'],
  queryFn: async ({ signal }): Promise<TaskFlowDispatch[] | null> => {
    const response = await fetch('/api/workspace/taskflow-dispatches', { signal });
    if (response.status === 404 || !response.headers.get('content-type')?.includes('application/json')) return null;
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message);
    return data.dispatches ?? null;
  },
  retry: false,
  refetchOnWindowFocus: query => query.state.data !== null,
  refetchInterval: query => query.state.data === null ? false : 15_000,
  refetchIntervalInBackground: false,
});
watch(taskFlowDispatches.error, error => { if (error?.message) ElMessage.error(error.message); });
const refresh = () => Promise.all([refreshWorkbench(), taskFlowDispatches.data.value === null ? undefined : taskFlowDispatches.refetch()]);
const { search, filter, page, viewMode } = useWorkspacePanelState('today', () => ({ search: '', filter: 'all' as RecordTab, page: 1, viewMode: 'cards' as 'cards' | 'list' }));
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
const searchInputRef = useTemplateRef<{ focus: () => void }>('searchInputRef');
const copiedBranchRowId = shallowRef('');
let copyBranchTimer: ReturnType<typeof setTimeout> | undefined;
async function copyBranch(rowId: string, branch: string) {
  if (!branch) return;
  try {
    await navigator.clipboard.writeText(branch);
    copiedBranchRowId.value = rowId;
    clearTimeout(copyBranchTimer);
    copyBranchTimer = setTimeout(() => {
      if (copiedBranchRowId.value === rowId) copiedBranchRowId.value = '';
    }, 1500);
    ElMessage.success(`已复制分支 ${branch}`);
  } catch {
    ElMessage.error('浏览器未允许复制');
  }
}
function handleWorkbenchKeydown(event: KeyboardEvent) {
  if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target as HTMLElement | null;
  if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return;
  if (document.querySelector('.el-overlay-dialog:not([style*="display: none"]), .el-drawer__wrapper')) return;
  event.preventDefault();
  searchInputRef.value?.focus();
}
const syncClock = () => {
  if (typeof document === 'undefined' || !document.hidden) clock.value = new Date();
};
onMounted(() => {
  clockTimer = setInterval(syncClock, 60_000);
  document.addEventListener('visibilitychange', syncClock);
  window.addEventListener('keydown', handleWorkbenchKeydown);
});
onBeforeUnmount(() => {
  clearInterval(clockTimer);
  clearTimeout(copyBranchTimer);
  document.removeEventListener('visibilitychange', syncClock);
  window.removeEventListener('keydown', handleWorkbenchKeydown);
});
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
  { id: 'running' as const, label: '正在运行', value: count('running'), note: '本机正在执行的任务', icon: Activity, tone: 'primary' },
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
  { path: '/agent', title: 'AI 对话', detail: '会话与执行过程', icon: Bot },
  { path: '/projects', title: '本地项目与 Git', detail: '目录扫描、代码与分支管理', icon: GitBranch },
  { path: '/design', title: '需求开发', detail: '需求、方案与功能开发', icon: FileCheck2 },
  { path: '/delivery/queue', title: '执行中心', detail: '自动巡检与执行记录', icon: Terminal },
  ...integrations.active.value.flatMap(plugin => plugin.views.map(view => ({path: view.path, title: view.label, detail: plugin.name, icon: Plug}))),
]);
const agentBoardDefinitions = [
  { id: 'queued', label: '待处理', tone: 'warning' },
  { id: 'running', label: '执行中', tone: 'primary' },
  { id: 'review', label: '待复核', tone: 'review' },
  { id: 'completed', label: '已完成', tone: 'success' },
  { id: 'blocked', label: '阻塞', tone: 'danger' },
] as const;
const agentAcceptanceByRunId = computed(() => new Map(records.value
  .filter(record => record.sourceKind === 'agent' && !!record.runId)
  .map(record => [record.runId!, record])));
function workbenchBoardColumn(run: { id: string; status: Parameters<typeof agentTaskBoardColumn>[0]; task?: { role: Parameters<typeof agentTaskBoardColumn>[1] }; changedFiles?: unknown[] }) {
  const base = agentTaskBoardColumn(run.status, run.task?.role || 'main');
  if (base === 'completed' && (run.changedFiles?.length || 0) > 0) {
    const acceptance = agentAcceptanceByRunId.value.get(run.id);
    if (acceptance?.acceptanceStatus !== 'accepted') return 'review' as const;
  }
  return base;
}
const agentBoardColumns = computed(() => {
  const cutoffMs = Date.now() - 3 * 24 * 60 * 60 * 1000;
  const latest = buildAgentConversations(runtime.data.value?.runs || [])
    .map(conversation => conversation.latest)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .filter((run, index) => !!run.task || ['queued', 'running'].includes(run.status) || index < 18 || Date.parse(run.updatedAt) >= cutoffMs);
  return agentBoardDefinitions.map(column => ({
    ...column,
    runs: latest.filter(run => workbenchBoardColumn(run) === column.id).slice(0, 8),
  }));
});
const agentBoardVisible = computed(() => !!runtime.data.value && !runtime.error.value && agentBoardColumns.value.some(column => column.runs.length));
function agentRoleLabel(run: { task?: { role: string } }) {
  return run.task?.role === 'reviewer' ? '复核 Agent' : run.task?.role === 'worker' ? '执行 Agent' : '主 Agent';
}
function agentGateLabel(run: { id: string; status: string; resultReady?: boolean; result?: string; error?: string; recovery?: { state: string } }) {
  if (run.recovery?.state === 'active') return '原进程仍在运行';
  if (run.recovery?.state === 'needs-review') return '等待确认恢复';
  if (run.recovery?.state === 'pending') return '正在核对状态';
  const acceptance = agentAcceptanceByRunId.value.get(run.id);
  if (acceptance?.acceptanceKnown === false) return '读取中';
  if (acceptance?.acceptanceStatus === 'accepted') return '人工验收通过';
  if (acceptance?.acceptanceStatus === 'rejected') return '人工验收未通过';
  if (acceptance?.acceptanceStatus === 'stale') return '需重新验收';
  if (run.status === 'completed' && run.resultReady) return '等待人工验收';
  if (run.status === 'completed') return '正在保存结果';
  if (['failed', 'interrupted', 'cancelled'].includes(run.status)) return '执行未通过';
  return run.result ? '结果已回传' : '执行中';
}
</script>
<template>
  <div class="wb" :class="{ embedded: workspace }">
    <PageHeading title="我的工作台" description="统一查看今日任务、原会话、执行结果和交付证据。" :loading="fetching || issues.isFetching.value" @refresh="refresh"><RouterLink v-if="!workspace" to="/agent"><el-button type="primary">进入 AI 对话 <ArrowUpRight :size="14" /></el-button></RouterLink></PageHeading>

    <CinematicVideoStage v-if="currentTheme.id === 'cinematic-video-hero'" mode="hero" compact>
      <h2>{{ weekday }} · <em>{{ monthDay }}</em> — {{ greeting }}</h2>
      <p>{{ summary }}</p>
    </CinematicVideoStage>

    <ImmersivePhotoStage v-else-if="currentTheme.id === 'immersive-photo'" mode="hero" compact>
      <h2>{{ weekday }} · <em>{{ monthDay }}</em> — {{ greeting }}</h2>
      <p>{{ summary }}</p>
    </ImmersivePhotoStage>

    <section class="wb-bento-deck" aria-label="今日指挥舱">
      <header class="wb-hero wb-bento-hero">
        <div class="wb-hero-top">
          <p class="wb-eyebrow">{{ weekday }} · {{ greeting }}</p>
          <span class="wb-live-clock"><i></i>{{ timeOf(clock) }}</span>
        </div>
        <h1 class="acid-chrome" :data-text="monthDay">{{ monthDay }}</h1>
        <div class="acid-tick-rail" aria-hidden="true"></div>
        <p class="wb-summary">{{ summary }}</p>
      </header>

      <section class="wb-metrics wb-bento-metrics" aria-label="工作台指标">
        <button v-for="item in metrics" :key="item.id" type="button" class="wb-metric" :class="[item.value ? item.tone : 'zero', { active: item.id === filter, featured: item.id === 'today' }]" @click="pickMetric(item.id)">
          <span class="wb-metric-icon"><component :is="item.icon" :size="16" /></span>
          <span class="wb-metric-text"><span>{{ item.label }}</span><small>{{ item.note }}</small></span>
          <strong>{{ item.value ?? '—' }}</strong>
        </button>
      </section>

      <section class="wb-ruler wb-bento-ruler" :aria-label="`今日交付刻度：${rulerEvents.length} 次交付活动，现在 ${timeOf(clock)}`">
        <div class="wb-ruler-head">
          <strong>今日交付节律</strong>
          <p class="wb-ruler-legend"><span><i class="dot"></i>活动 {{ rulerEvents.length }} 次</span><span v-if="syncTimes.length"><i class="diamond"></i>同步 {{ syncTimes.join('、') }}</span><span><i class="line"></i>当前 {{ timeOf(clock) }}</span></p>
        </div>
        <div class="wb-ruler-track">
          <span v-for="hour in rulerRange.hours" :key="hour" class="wb-tick" :class="{ major: hour % 2 === 0 }" :style="{ left: rulerAt(hour * 60) }"><small>{{ String(hour).padStart(2, '0') }}</small></span>
          <span v-for="time in syncTimes" :key="time" class="wb-sync-mark" :style="{ left: rulerAt(Number(time.split(':')[0]) * 60 + Number(time.split(':')[1])) }" :title="`Jira 自动同步 ${time}`"></span>
          <button v-for="item in rulerEvents" :key="item.record.id" type="button" class="wb-event" :class="tone(item.record)" :style="{ left: rulerAt(minutesOf(item.date)) }" :title="`${timeOf(item.date)} · ${item.record.title || item.record.issueKeys[0] || '交付记录'}`" @click="inspect(item.record)"></button>
          <span class="wb-now" :style="{ left: rulerAt(minutesOf(clock)) }"><b>{{ timeOf(clock) }}</b></span>
        </div>
      </section>
    </section>

    <el-alert v-for="error in errors" :key="error" :title="error" type="error" :closable="false" class="wb-alert" />
    <el-alert
      v-if="issues.error.value"
      :title="issues.error.value.message.includes('未配置鉴权') ? 'Jira 尚未配置连接凭据，可在「交付与连接设置」中填入 Jira 地址与 Token 后同步任务' : `Jira 任务：${issues.error.value.message}`"
      :type="issues.error.value.message.includes('未配置鉴权') ? 'info' : 'error'"
      :closable="false"
      class="wb-alert"
    />
    <el-alert v-if="issues.data.value?.source === 'mock'" title="当前任务来源为模拟数据，不是实时 Jira 排期" type="warning" :closable="false" class="wb-alert" />

    <div class="wb-grid wb-f-pattern" :class="{ 'is-hg-stage': hgAsideActive }">
      <Teleport defer to="#hg-aside-slot" :disabled="!hgAsideActive">
        <aside id="workbench-today" class="wb-aside" :class="{ 'is-teleported': hgAsideActive }">
          <component v-for="widget in integrations.widgets.value" :is="widget.component" :key="widget.id" :today="today" :today-issues="todayIssues" :loading="issues.isPending.value" :error="issues.error.value" :jira-sync-status="jiraSyncStatus" @open-issue="openIssue" />
          <section v-if="taskFlowDispatches.data.value" class="wb-card">
            <div class="wb-card-head compact"><h2>TaskFlow 派发</h2></div>
            <el-empty v-if="!taskFlowDispatches.data.value.length" description="暂无发给你的任务" :image-size="36" />
            <div v-else class="wb-shortcuts">
              <a v-for="dispatch in taskFlowDispatches.data.value" :key="dispatch.id" :href="safeUrl(dispatch.taskUrl)" target="_blank" rel="noreferrer">
                <span class="wb-metric-icon"><Activity :size="16" /></span>
                <span>
                  <strong>{{ dispatch.jiraKey }} · {{ dispatch.title }}</strong>
                  <small>{{ dispatchLabels[dispatch.status === 'RUNNING' ? dispatch.phase || dispatch.status : dispatch.status] || dispatch.status }} · {{ dateTime(dispatch.updatedAt) }}</small>
                  <small v-if="dispatch.error">{{ dispatch.error }}</small>
                </span>
                <ArrowUpRight :size="14" />
              </a>
            </div>
          </section>
          <TeamPendingTasks /><PersonalTodos />

          <section class="wb-card">
            <div class="wb-card-head compact"><div><h2>工作入口</h2><p>常用研发与交付视图</p></div></div>
            <nav class="wb-shortcuts">
              <RouterLink v-for="item in shortcuts.filter(entry => !workspace || entry.path !== '/agent')" :key="item.path" :to="item.path"><span class="wb-metric-icon"><component :is="item.icon" :size="16" /></span><span><strong>{{ item.title }}</strong><small>{{ item.detail }}</small></span><ArrowUpRight :size="14" /></RouterLink>
            </nav>
          </section>
        </aside>
      </Teleport>

      <div class="wb-main">
        <section id="workbench-records" class="wb-card wb-records">
          <div class="wb-card-head">
            <div><h2>任务、会话与交付结果</h2><p>按当前状态分类，保留每轮执行历史{{ incomplete ? ' · 部分来源尚未就绪' : '' }}</p></div>
            <div class="wb-head-controls">
              <el-input ref="searchInputRef" v-model="search" placeholder="搜索任务、Jira 或分支" clearable aria-label="搜索交付记录" class="wb-search" @keydown.esc="search = ''">
                <template #prefix><Search :size="14" /></template>
                <template #suffix><kbd v-if="!search" class="wb-slash-kbd">/</kbd></template>
              </el-input>
              <div class="wb-view-switch" role="group" aria-label="视图布局">
                <button type="button" :class="{ active: viewMode !== 'list' }" :aria-pressed="viewMode !== 'list'" title="双栏看板网格" @click="viewMode = 'cards'"><LayoutGrid :size="14" /><span>看板</span></button>
                <button type="button" :class="{ active: viewMode === 'list' }" :aria-pressed="viewMode === 'list'" title="紧凑列表视图" @click="viewMode = 'list'"><List :size="14" /><span>列表</span></button>
              </div>
            </div>
          </div>
          <div class="wb-tabs" role="tablist" aria-label="交付记录筛选">
            <button v-for="tab in tabs" :key="tab.id" type="button" role="tab" :aria-selected="filter === tab.id" :class="{ active: filter === tab.id }" @click="filter = tab.id">{{ tab.label }}<span>{{ tab.count }}</span></button>
          </div>

          <div v-loading="loading && !records.length" class="wb-list" :class="{ 'is-cards': viewMode !== 'list' }">
            <article v-for="row in visible" :key="row.id" class="wb-row" :class="tone(row)">
              <div class="wb-row-top">
                <span class="wb-row-meta">
                  <span class="wb-tag">{{ row.source }}</span>
                  <template v-if="row.jiraStatuses?.length"><button v-for="issue in row.jiraStatuses" :key="issue.key" type="button" class="wb-key is-interactive" :title="`查看 Jira ${issue.key} 详情与交付记录`" @click.stop="openIssue(issue.key)">{{ issue.key }} · {{ issue.status }}</button></template>
                  <template v-else-if="row.issueKeys.length"><button v-for="key in row.issueKeys" :key="key" type="button" class="wb-key is-interactive" :title="`查看 Jira ${key} 详情与交付记录`" @click.stop="openIssue(key)">{{ key }}</button></template>
                  <span v-else class="wb-dim">独立会话</span>
                </span>
                <div class="wb-row-status">
                  <StatusPill :value="primaryStatus(row).value" :label="primaryStatus(row).label" />
                  <span class="wb-hint">{{ primaryStatus(row).live ? '实时状态' : '历史记录' }}</span>
                </div>
              </div>
              <button type="button" class="wb-row-main" :title="`查看详情：${row.title || row.issueKeys[0] || '交付记录'}`" @click="inspect(row)">
                <span class="wb-row-title">{{ row.title || row.issueKeys[0] || '交付记录' }}</span>
                <span v-if="row.project || row.workspacePath || row.branch" class="wb-row-context">
                  <span v-if="row.project || row.workspacePath" class="wb-dim wb-path" :title="[row.project, row.workspacePath].filter(Boolean).join('\n')">{{ folder(row.project || row.workspacePath) }}</span>
                  <span v-if="row.branch" role="button" tabindex="0" class="wb-branch is-copyable" :title="`点击复制分支 ${row.branch}`" @click.stop="copyBranch(row.id, row.branch)" @keydown.enter.stop.prevent="copyBranch(row.id, row.branch)"><GitBranch :size="11" /><span>{{ row.branch }}</span><component :is="copiedBranchRowId === row.id ? Check : Copy" :size="10" class="wb-branch-copy" /></span>
                </span>
              </button>
              <div class="wb-row-bottom">
                <div class="wb-row-accept"><span class="wb-badge" :class="acceptanceTone(row)">{{ acceptanceLabel(row) }}</span></div>
                <time class="wb-row-time" :datetime="row.updatedAt" :title="dateTime(row.updatedAt)">{{ relative(row.updatedAt) }}</time>
                <div class="wb-row-actions">
                  <RouterLink v-if="row.runId" :to="agentRunPath(row.runId)" class="wb-icon-btn" title="打开 Agent 会话" aria-label="打开 Agent 会话"><MessageSquare :size="15" /></RouterLink>
                  <a v-else-if="threadUrl(row.threadId)" :href="threadUrl(row.threadId)" class="wb-icon-btn" title="打开原会话" aria-label="打开原会话"><ArrowUpRight :size="15" /></a>
                  <span v-else class="wb-icon-btn disabled" :title="row.clientThreadId ? '会话创建中' : '未关联会话'"><MessageSquare :size="15" /></span>
                  <button type="button" class="wb-icon-btn" title="详情与验收" aria-label="详情与验收" @click="inspect(row)"><ChevronRight :size="16" /></button>
                </div>
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

        <section v-if="agentBoardVisible" class="wb-card wb-agent-board" aria-label="AI 会话与任务看板">
          <div class="wb-card-head">
            <div><h2><Activity :size="15" />AI 会话与任务看板</h2><p>按实时状态分栏（有代码改动未验收自动归入「待复核」），点击卡片直达原对话</p></div>
            <RouterLink to="/agent" class="wb-link">进入 AI 对话 <ArrowUpRight :size="12" /></RouterLink>
          </div>
          <div class="wb-agent-columns">
            <section v-for="column in agentBoardColumns" :key="column.id" class="wb-agent-column" :class="`tone-${column.tone}`">
              <header><strong>{{ column.label }}</strong><span>{{ column.runs.length }}</span></header>
              <RouterLink v-for="run in column.runs" :key="run.id" :to="agentRunPath(run.id)" class="wb-agent-run">
                <div class="wb-agent-run-head"><strong>{{ run.task?.title || run.objective }}</strong><StatusPill :value="run.status" /></div>
                <small>{{ agentRoleLabel(run) }} · {{ agentProviderLabels[run.provider] || run.provider }} · <code class="wb-run-branch">{{ run.branch || '未绑定分支' }}</code></small>
                <small class="wb-agent-gate">{{ agentGateLabel(run) }} · {{ run.changedFiles?.length || 0 }} 个改动 · {{ run.events.length }} 条事件</small>
              </RouterLink>
              <p v-if="!column.runs.length" class="wb-agent-empty">暂无</p>
            </section>
          </div>
        </section>
      </div>
    </div>

    <el-drawer v-if="drawer" v-model="drawer" :title="title" size="min(920px, 94vw)" class="hub-drawer" append-to-body destroy-on-close>
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
.wb {
  --wb-radius: var(--r-2xl, 16px);
  display: flex;
  flex-direction: column;
  gap: 16px;
  color: var(--ui-text);
}
.wb-hero {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: end;
  gap: 12px 32px;
  padding: 0;
}
.wb-hero-title {
  display: flex;
  align-items: baseline;
  gap: 16px;
}
.wb-eyebrow {
  margin: 0;
  font-size: 12px;
  line-height: 16px;
  font-weight: 500;
  color: var(--ui-muted);
  letter-spacing: 0.04em;
  font-variant-numeric: tabular-nums;
}
.wb-hero h1 {
  margin: 0;
  font: 600 36px/40px var(--ds-display, var(--sans));
  letter-spacing: -0.03em;
  background: var(--ds-hero-gradient, linear-gradient(90deg, #000000 0%, #666666 100%));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.wb-summary {
  max-width: 42em;
  margin: 0;
  padding-left: 20px;
  border-left: 1px solid var(--ui-border);
  font-size: 14px;
  line-height: 20px;
  color: var(--ui-secondary);
}
.wb-ruler {
  padding: 4px 4px 0;
}
.wb-ruler-track {
  position: relative;
  height: 44px;
  margin: 0 16px;
  border-bottom: 1px solid var(--ui-border);
}
.wb-tick {
  position: absolute;
  bottom: 0;
  width: 1px;
  height: 8px;
  background: var(--ui-border);
  transform: translateX(-50%);
}
.wb-tick.major {
  height: 14px;
  background: var(--ui-muted);
}
.wb-tick small {
  position: absolute;
  top: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  font: 500 12px/16px var(--ds-code, var(--mono));
  font-variant-numeric: tabular-nums;
  color: var(--ui-muted);
}
.wb-tick:not(.major) small {
  opacity: 0.6;
}
.wb-sync-mark {
  position: absolute;
  bottom: -4px;
  width: 8px;
  height: 8px;
  border: 1.5px solid var(--ui-text);
  background: var(--ui-surface);
  transform: translateX(-50%) rotate(45deg);
}
.wb-event {
  position: absolute;
  bottom: 10px;
  width: 10px;
  height: 10px;
  padding: 0;
  border: 2px solid var(--ui-surface);
  border-radius: 9999px;
  background: var(--ui-muted);
  transform: translateX(-50%);
  cursor: pointer;
  transition: transform 300ms cubic-bezier(0.22, 1, 0.36, 1), background-color 300ms cubic-bezier(0.22, 1, 0.36, 1);
}
.wb-event:nth-of-type(3n) { bottom: 20px; }
.wb-event:nth-of-type(3n+1) { bottom: 30px; }
.wb-event:hover,
.wb-event:focus-visible {
  transform: translateX(-50%) scale(1.4);
  outline: none;
}
.wb-event.primary { background: var(--ui-accent); }
.wb-event.danger { background: var(--ui-danger); }
.wb-event.warning { background: var(--ui-warning); }
.wb-event.success { background: var(--ui-success); }
.wb-now {
  position: absolute;
  top: -4px;
  bottom: -4px;
  width: 2px;
  background: var(--ui-primary);
  transform: translateX(-50%);
}
.wb-now b {
  position: absolute;
  top: -22px;
  left: 50%;
  transform: translateX(-50%);
  padding: 2px 8px;
  border-radius: 9999px;
  background: var(--ui-primary);
  color: var(--ui-on-primary);
  font: 600 11px/16px var(--ds-code, var(--mono));
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  box-shadow: 0 2px 6px rgb(0 0 0 / 0.14);
}
.wb-ruler-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 20px;
  margin: 28px 16px 4px;
  font-size: 12px;
  line-height: 16px;
  color: var(--ui-muted);
}
.wb-ruler-legend span {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.wb-ruler-legend i { display: inline-block; }
.wb-ruler-legend .dot {
  width: 8px;
  height: 8px;
  border-radius: 9999px;
  background: var(--ui-accent);
}
.wb-ruler-legend .diamond {
  width: 7px;
  height: 7px;
  border: 1.5px solid var(--ui-text);
  transform: rotate(45deg);
}
.wb-ruler-legend .line {
  width: 2px;
  height: 12px;
  background: var(--ui-accent);
}
.wb-alert { margin: 0; }

.wb-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
}
.wb-metric {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--ui-border);
  border-radius: var(--wb-radius);
  background: var(--ui-surface);
  color: var(--ui-text);
  text-align: left;
  font: inherit;
  cursor: pointer;
  transition: border-color 300ms cubic-bezier(0.22, 1, 0.36, 1), background-color 300ms cubic-bezier(0.22, 1, 0.36, 1), transform 300ms cubic-bezier(0.22, 1, 0.36, 1);
}
.wb-metric:hover {
  border-color: var(--ui-accent);
  background: var(--ui-hover);
}
.wb-metric:active {
  transform: scale(0.98);
}
.wb-metric.active {
  border-color: var(--ui-accent);
  background: var(--ui-accent-soft);
  box-shadow: none;
}
.wb-metric-icon {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background: var(--ui-raised);
  color: var(--ui-muted);
}
.wb-metric-text {
  flex: 1;
  min-width: 0;
}
.wb-metric-text > span {
  display: block;
  font-size: 14px;
  line-height: 20px;
  font-weight: 500;
}
.wb-metric-text small {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  line-height: 16px;
  color: var(--ui-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wb-metric strong {
  font: 600 30px/36px var(--ds-numeral, var(--sans));
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
  color: var(--ui-muted);
}
.wb-metric.primary .wb-metric-icon { background: var(--ui-accent-soft); color: var(--ui-accent); }
.wb-metric.primary strong { color: var(--ui-accent); }
.wb-metric.warning .wb-metric-icon { background: var(--ui-warning-bg); color: var(--ui-warning); }
.wb-metric.warning strong { color: var(--ui-warning); }
.wb-metric.danger .wb-metric-icon { background: var(--ui-danger-bg); color: var(--ui-danger); }
.wb-metric.danger strong { color: var(--ui-danger); }

.wb-grid {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}
.wb-aside {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr) minmax(0, 1fr);
  gap: 16px;
  align-items: stretch;
}
.wb-aside > .wb-card {
  display: flex;
  flex-direction: column;
}
.wb-card {
  border: 1px solid var(--ui-border);
  border-radius: var(--wb-radius);
  background: var(--ui-surface);
  overflow: hidden;
  min-width: 0;
}
.wb-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 20px;
}
.wb-card-head.compact {
  padding: 16px 20px 10px;
}
.wb-card-head h2 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 600;
}
.wb-card-head p {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 16px;
  color: var(--ui-muted);
}
.wb-search { width: 280px; max-width: 100%; }
.wb-search svg { color: var(--ui-muted); }
.wb-slash-kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius-xs, 4px);
  background: var(--ui-raised);
  color: var(--ui-muted);
  font: 600 10.5px/1 var(--mono);
  pointer-events: none;
}
.wb-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--ui-accent);
  font-size: 12px;
  line-height: 16px;
  font-weight: 500;
  white-space: nowrap;
}
.wb-link:hover { text-decoration: underline; }
.wb-pad { padding: 8px 20px 20px; }

.wb-agent-board { overflow: hidden; }
.wb-agent-columns {
  display: grid;
  grid-template-columns: repeat(5, minmax(156px, 1fr));
  gap: 8px;
  padding: 0 20px 20px;
  overflow-x: auto;
}
.wb-agent-column {
  display: flex;
  flex-direction: column;
  min-width: 156px;
  max-height: 240px;
  padding: 8px;
  border: 1px solid var(--ui-border);
  border-radius: 12px;
  background: var(--ui-raised);
  overflow-y: auto;
}
.wb-agent-column.tone-primary { border-color: color-mix(in srgb, var(--ui-accent) 40%, var(--ui-border)); }
.wb-agent-column.tone-review { border-color: color-mix(in srgb, var(--ui-accent) 32%, var(--ui-border)); }
.wb-agent-column.tone-success { border-color: color-mix(in srgb, var(--ui-success) 40%, var(--ui-border)); }
.wb-agent-column.tone-danger { border-color: color-mix(in srgb, var(--ui-danger) 40%, var(--ui-border)); }
.wb-agent-column > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
  padding: 2px 4px;
  font-size: 12px;
  line-height: 16px;
  font-weight: 500;
}
.wb-agent-column > header span {
  min-width: 20px;
  padding: 2px 6px;
  border-radius: 6px;
  background: var(--ui-surface);
  color: var(--ui-muted);
  font: 500 12px/16px var(--mono);
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.wb-agent-run {
  display: block;
  margin-top: 6px;
  padding: 8px 10px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: var(--ui-surface);
  color: var(--ui-text);
  text-decoration: none;
  flex-shrink: 0;
  transition: border-color 300ms cubic-bezier(0.22, 1, 0.36, 1), background-color 300ms cubic-bezier(0.22, 1, 0.36, 1);
}
.wb-agent-run:hover {
  border-color: var(--ui-accent);
  background: var(--ui-hover);
}
.wb-agent-run-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 6px;
}
.wb-agent-run-head strong {
  display: -webkit-box;
  min-width: 0;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  font-size: 12px;
  line-height: 16px;
  font-weight: 500;
}
.wb-agent-run:deep(.status-pill) {
  padding: 2px 6px;
  font-size: 12px;
  line-height: 16px;
}
.wb-agent-run > small {
  display: block;
  margin-top: 4px;
  overflow: hidden;
  color: var(--ui-muted);
  font-size: 12px;
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wb-agent-run .wb-agent-gate { color: var(--ui-secondary); }
.wb-agent-empty {
  margin: auto 0;
  padding: 16px 0;
  color: var(--ui-muted);
  font-size: 12px;
  line-height: 16px;
  text-align: center;
}

.wb-tabs {
  display: flex;
  gap: 4px;
  margin: 0 20px;
  padding: 4px;
  border-radius: 12px;
  background: var(--ui-raised);
  overflow-x: auto;
  width: fit-content;
  max-width: calc(100% - 40px);
}
.wb-tabs button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  padding: 6px 12px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--ui-secondary);
  font: 500 12px/16px var(--sans);
  cursor: pointer;
  transition: background-color 300ms cubic-bezier(0.22, 1, 0.36, 1), color 300ms cubic-bezier(0.22, 1, 0.36, 1), transform 300ms cubic-bezier(0.22, 1, 0.36, 1);
}
.wb-tabs button:active { transform: scale(0.98); }
.wb-tabs button span {
  min-width: 20px;
  padding: 2px 6px;
  border-radius: 6px;
  background: var(--ui-surface);
  color: var(--ui-muted);
  font: 500 12px/16px var(--mono);
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.wb-tabs button:hover { color: var(--ui-text); background: var(--ui-hover); }
.wb-tabs button.active {
  background: var(--ui-primary);
  color: var(--ui-on-primary);
  font-weight: 600;
  box-shadow: 0 2px 6px rgb(0 0 0 / 0.14);
}
.wb-tabs button.active span {
  background: color-mix(in srgb, var(--ui-on-primary) 18%, transparent);
  color: var(--ui-on-primary);
}

.wb-head-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.wb-view-switch {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  background: var(--ui-raised);
}
.wb-view-switch button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--ui-secondary);
  font: 500 12px/16px var(--sans);
  cursor: pointer;
  transition: background-color 240ms cubic-bezier(0.22, 1, 0.36, 1), color 240ms cubic-bezier(0.22, 1, 0.36, 1);
}
.wb-view-switch button:hover { color: var(--ui-text); }
.wb-view-switch button.active {
  background: var(--ui-surface);
  border-color: var(--ui-border);
  color: var(--ui-text);
  font-weight: 600;
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.06);
}

.wb-list {
  display: grid;
  gap: 10px;
  margin-top: 14px;
  padding: 18px 20px 22px;
  border-top: 1px solid var(--ui-divider);
  background: color-mix(in srgb, var(--ui-raised) 48%, var(--ui-surface));
}
.wb-list.is-cards {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.wb-list.is-cards :deep(.el-empty) {
  grid-column: 1 / -1;
}
/* 紧凑列表模式 */
.wb-list:not(.is-cards) .wb-row {
  position: relative;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  padding: 12px 16px;
  border: 1px solid var(--ui-border);
  border-radius: 12px;
  background: var(--ui-surface);
  transition: border-color 240ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 240ms cubic-bezier(0.22, 1, 0.36, 1);
}
.wb-list:not(.is-cards) .wb-row-top {
  display: flex;
  flex-direction: column-reverse;
  align-items: flex-start;
  gap: 4px;
}
.wb-list:not(.is-cards) .wb-row-bottom {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* 双栏 Bento 交付卡片模式（默认） */
.wb-list.is-cards .wb-row {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 14px;
  min-height: 144px;
  padding: 18px 20px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius-lg, 14px);
  background: var(--ui-surface);
  box-shadow: 0 2px 6px -2px var(--ui-shadow-color);
  transition: border-color 240ms cubic-bezier(0.22, 1, 0.36, 1), transform 240ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 240ms cubic-bezier(0.22, 1, 0.36, 1);
}
.wb-row:hover {
  border-color: var(--ui-accent);
  box-shadow: var(--ds-shadow-hover);
}
.wb-list.is-cards .wb-row:hover {
  transform: translateY(-2px);
}
.wb-row-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.wb-row-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--ui-divider);
}
.wb-list:not(.is-cards) .wb-row-bottom {
  padding-top: 0;
  border-top: 0;
}
.wb-row-bottom .wb-row-time {
  margin-right: auto;
  margin-left: 6px;
}
.wb-row-main {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  font: inherit;
  cursor: pointer;
}
.wb-row-title {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 15px;
  font-weight: 600;
  line-height: 22px;
  letter-spacing: -0.01em;
  transition: color 240ms cubic-bezier(0.22, 1, 0.36, 1);
}
.wb-row-main:hover .wb-row-title {
  color: var(--ui-accent);
}
.wb-row-meta,
.wb-row-context {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  font-size: 12px;
  line-height: 16px;
  color: var(--ui-muted);
}
.wb-tag {
  padding: 2px 7px;
  border-radius: 6px;
  background: var(--ui-raised);
  color: var(--ui-secondary);
  font-size: 11.5px;
  font-weight: 500;
  line-height: 16px;
}
.wb-key {
  padding: 2px 7px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: var(--ui-accent-soft);
  font-family: var(--mono);
  font-size: 11.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--ui-accent);
}
.wb-key.is-interactive {
  cursor: pointer;
  transition: border-color 150ms ease, background-color 150ms ease;
}
.wb-key.is-interactive:hover {
  border-color: color-mix(in srgb, var(--ui-accent) 42%, var(--ui-border));
  background: color-mix(in srgb, var(--ui-accent) 18%, var(--ui-surface));
}
.wb-key.large {
  font-size: 14px;
  line-height: 20px;
  font-weight: 600;
  color: var(--ui-text);
}
.wb-dim { color: var(--ui-muted); }
.wb-path,
.wb-branch {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wb-branch {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: var(--ui-raised);
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--ui-secondary);
}
.wb-branch.is-copyable {
  cursor: pointer;
  transition: border-color 150ms ease, color 150ms ease;
}
.wb-branch.is-copyable:hover {
  border-color: var(--ui-accent);
  color: var(--ui-text);
}
.wb-branch-copy {
  opacity: 0.65;
}
.wb-branch.is-copyable:hover .wb-branch-copy {
  opacity: 1;
  color: var(--ui-accent);
}
.wb-run-branch {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ui-secondary);
}
.wb-branch svg { flex-shrink: 0; color: var(--ui-muted); }
.wb-branch > span { overflow: hidden; text-overflow: ellipsis; }
.wb-row-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.wb-list.is-cards .wb-hint { display: none; }
.wb-hint {
  font-size: 12px;
  line-height: 16px;
  color: var(--ui-muted);
}
@media (max-width: 1080px) {
  .wb-list.is-cards { grid-template-columns: minmax(0, 1fr); }
}
@container (max-width: 680px) {
  .wb-list.is-cards { grid-template-columns: minmax(0, 1fr); }
}
.wb-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 16px;
  font-weight: 500;
  white-space: nowrap;
  background: var(--ui-raised);
  color: var(--ui-muted);
}
.wb-badge.success { background: var(--ui-success-bg); color: var(--ui-success); }
.wb-badge.danger { background: var(--ui-danger-bg); color: var(--ui-danger); }
.wb-badge.warning { background: var(--ui-warning-bg); color: var(--ui-warning); }
.wb-row-time {
  font-size: 12px;
  line-height: 16px;
  color: var(--ui-muted);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.wb-row-actions {
  display: flex;
  gap: 6px;
}
.wb-icon-btn {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius-xs, 8px);
  background: var(--ui-surface);
  color: var(--ui-secondary);
  cursor: pointer;
  transition: background-color 220ms cubic-bezier(0.22, 1, 0.36, 1), border-color 220ms cubic-bezier(0.22, 1, 0.36, 1), color 220ms cubic-bezier(0.22, 1, 0.36, 1), transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
}
.wb-icon-btn:hover {
  border-color: var(--ui-accent);
  color: var(--ui-accent);
  background: var(--ui-accent-soft);
}
.wb-icon-btn:active:not(.disabled) {
  transform: scale(0.96);
}
.wb-icon-btn.disabled {
  opacity: 0.38;
  cursor: not-allowed;
}
.wb-icon-btn.disabled:hover {
  border-color: var(--ui-border);
  color: var(--ui-secondary);
  background: var(--ui-surface);
}
.wb-list :deep(.el-empty) {
  padding: 24px 16px;
  border-bottom: 1px solid var(--ui-divider);
}
.wb-list :deep(.el-empty__description) { margin-top: 8px; }
.wb-list :deep(.el-empty__bottom) { margin-top: 12px; }
.wb-empty-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
}
.wb-empty-btn {
  padding: 8px 12px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: var(--ui-surface);
  color: var(--ui-secondary);
  font: 500 12px/16px var(--sans);
  cursor: pointer;
  transition: background-color 300ms cubic-bezier(0.22, 1, 0.36, 1), border-color 300ms cubic-bezier(0.22, 1, 0.36, 1), color 300ms cubic-bezier(0.22, 1, 0.36, 1), transform 300ms cubic-bezier(0.22, 1, 0.36, 1);
}
.wb-empty-btn:hover {
  border-color: var(--ui-accent);
  color: var(--ui-accent);
}
.wb-empty-btn:active { transform: scale(0.98); }
.wb-empty-btn.primary {
  border-color: var(--ui-accent-soft);
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
  font-weight: 500;
}
.wb-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 20px;
  font-size: 12px;
  line-height: 16px;
  color: var(--ui-muted);
}

.wb-today {
  list-style: none;
  margin: 0;
  padding: 0 12px 12px;
  max-height: 256px;
  overflow-y: auto;
}
.wb-today button {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--ui-text);
  text-align: left;
  font: inherit;
  cursor: pointer;
  transition: background-color 300ms cubic-bezier(0.22, 1, 0.36, 1);
}
.wb-today button:hover { background: var(--ui-hover); }
.wb-today button > span:first-child {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.wb-today small {
  flex-shrink: 0;
  font: 500 12px/16px var(--mono);
  font-variant-numeric: tabular-nums;
  color: var(--ui-muted);
}
.wb-today strong {
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 12px;
  font-weight: 500;
  line-height: 16px;
}
.wb-more {
  padding: 6px 10px 4px;
  font-size: 12px;
  line-height: 16px;
}
.wb-more a { color: var(--ui-accent); }
.wb-empty {
  margin: auto 0;
  padding: 20px 16px;
  font-size: 12px;
  line-height: 16px;
  color: var(--ui-muted);
  text-align: center;
}

.wb-sync dl {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin: 0;
  padding: 0 20px;
}
.wb-sync dl > div {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--ui-raised);
}
.wb-sync dt {
  font-size: 12px;
  line-height: 16px;
  color: var(--ui-muted);
}
.wb-sync dd {
  margin: 4px 0 0;
  font-size: 14px;
  line-height: 20px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.wb-sync dd.warn { color: var(--ui-warning); }
.wb-note {
  margin: auto 0 0;
  padding: 12px 20px 16px;
  font-size: 12px;
  line-height: 16px;
  color: var(--ui-muted);
}

.wb-shortcuts {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  flex: 1;
  padding: 0 12px 12px;
}
.wb-shortcuts a {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  color: var(--ui-text);
  transition: background-color 300ms cubic-bezier(0.22, 1, 0.36, 1);
}
.wb-shortcuts a:hover { background: var(--ui-hover); }
.wb-shortcuts a:hover > svg { color: var(--ui-accent); }
.wb-shortcuts .wb-metric-icon {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
}
.wb-shortcuts a > span:nth-child(2) { flex: 1; min-width: 0; }
.wb-shortcuts strong {
  display: block;
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
}
.wb-shortcuts small {
  display: block;
  font-size: 12px;
  color: var(--ui-muted);
  line-height: 16px;
}
.wb-shortcuts a > svg { color: var(--ui-muted); }

.wb-drawer-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 14px 18px;
  margin-bottom: 14px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius, 12px);
  background: var(--ui-raised);
  font-size: 12.5px;
  line-height: 18px;
}
.wb-spacer { flex: 1; }

@media (max-width: 1280px) {
  .wb-row { grid-template-columns: minmax(0, 1fr) 120px 88px auto; }
  .wb-row-time { display: none; }
}
@media (max-width: 1120px) {
  .wb-aside { grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
}
@media (max-width: 860px) {
  .wb-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .wb-row { grid-template-columns: minmax(0, 1fr) auto; row-gap: 8px; }
  .wb-row-status { flex-direction: row; align-items: center; grid-column: 1; }
  .wb-row-accept { grid-column: 1; }
  .wb-row-actions { grid-column: 2; grid-row: 1 / span 3; }
}
@media (max-width: 600px) {
  .wb-hero { grid-template-columns: 1fr; }
  .wb-summary { padding-left: 0; border-left: 0; }
  .wb-hero h1 { font-size: 30px; line-height: 36px; }
  .wb-tick:not(.major) small { display: none; }
  .wb-card-head { flex-direction: column; align-items: stretch; }
  .wb-search { max-width: none; }
  .wb-metric-text small { display: none; }
}
@container workspace-page (max-width: 1040px) {
  .wb-aside { grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
}
@container workspace-page (max-width: 820px) {
  .wb-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .wb-row { grid-template-columns: minmax(0, 1fr) auto; row-gap: 8px; }
  .wb-row-time { display: none; }
  .wb-row-status { flex-direction: row; align-items: center; grid-column: 1; }
  .wb-row-accept { grid-column: 1; }
  .wb-row-actions { grid-column: 2; grid-row: 1 / span 3; }
}

.wb-aside.is-teleported {
  display: grid;
  grid-template-columns: minmax(0, 1fr) !important;
  gap: 14px;
  min-width: 0;
}
.wb-aside.is-teleported :deep(.wb-card) {
  margin: 0;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius);
  background: var(--ui-surface);
  box-shadow: none;
  overflow: hidden;
}
.wb-aside.is-teleported :deep(.wb-card-head) {
  padding: 12px 14px;
  border-bottom: 1px solid var(--ui-divider);
}
.wb-aside.is-teleported :deep(.wb-card-head h2) {
  font-size: 13.5px;
  line-height: 19px;
}
.wb-aside.is-teleported :deep(:is(.wb-today, .wb-shortcuts, .wb-sync dl, .personal-todos)) {
  padding-inline: 14px;
}
.wb-aside.is-teleported .wb-shortcuts a {
  padding: 8px;
  border-radius: var(--ds-radius-xs);
}
:global(:root[data-theme='acid'] .wb-aside.is-teleported .wb-shortcuts a:hover) {
  border-color: var(--acid-yellow, #e6ff00);
  box-shadow: 2px 2px 0 var(--acid-violet, #a020f0);
}
:global(:root[data-theme='acid'] .wb :is(.wb-card, .wb-row, .wb-view-switch, .wb-view-switch button, .wb-tabs, .wb-tabs button, .wb-badge, .wb-tag, .wb-icon-btn, .wb-drawer-head)) {
  border-radius: 0 !important;
}
</style>
