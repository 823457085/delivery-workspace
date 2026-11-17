<script setup lang="ts">
/** 日历、列表与统计共享同一查询结果；列表模式融合 Plane / Huly / Linear 风格快速筛选、阶段胶囊、看板切换与 j/k 键盘分诊流。 */
import { computed, defineAsyncComponent, inject, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch } from 'vue';
import type { InputInstance, TableInstance } from 'element-plus';
import { Check, ChevronRight, Columns3, ExternalLink, GitBranch, List, Search, Sparkles } from '@lucide/vue';
import { ElMessage } from 'element-plus';
import { useWorkspacePanelState } from '../../shared/useWorkspacePanelState';
import { useRoute, useRouter } from 'vue-router';
import type { JiraIssue, IssueResponse } from '../../../shared/hub';
import { useSource } from '../../shared/api';
import { countBy, day, isDone, safeUrl, dateTime } from '../../shared/format';
import { agentWorkspaceContext } from '../../shared/agent-workspace-context';
import { jiraQuickPrompt } from '../agent-workbench/agent-quick-actions';
import PageHeading from '../../shared/ui/PageHeading.vue';
import QueryState from '../../shared/ui/QueryState.vue';
import MetricStrip from '../../shared/ui/MetricStrip.vue';
import StatusPill from '../../shared/ui/StatusPill.vue';
import TaskFilters from './TaskFilters.vue';
import { advancedTaskDefaults, buildMonthCalendar, groupTasksByDate, matchesPlannedFilter, taskQueryParams, type TaskFilter } from './calendar-domain';
import {
  buildIssueKanbanColumns,
  classifyIssueStage,
  stepIssueSelection,
  suggestIssueBranchName,
  type IssueStageId,
} from './task-triage-studio';
import { buildGanttWindowDays, summarizeTaskHealth } from './calendar-timeline-studio';

const JiraIssueDrawer = defineAsyncComponent(() => import('../jira-issue/JiraIssueDrawer.vue'));
const WorkdayCalendar = defineAsyncComponent(() => import('./WorkdayCalendar.vue'));
const props = defineProps<{ mode: string }>();
const route = useRoute();
const router = useRouter();
const workspace = inject(agentWorkspaceContext, undefined);
const { filters, applied, page, tableScrollTop, calendarDate, activeDateField, listLayout, stageFilter, quickSearch } = useWorkspacePanelState('tasks', () => ({
  filters: { ...advancedTaskDefaults, projects: '', keyword: '', includeSubtasks: true, includeDone: false } as TaskFilter,
  applied: { dateField: 'planned', allTime: 'true', includeSubtasks: 'true', includeDone: 'false', maxResults: '5000' } as Record<string, string>,
  page: 1,
  tableScrollTop: 0,
  calendarDate: new Date(),
  activeDateField: 'planned',
  listLayout: 'table' as 'table' | 'kanban',
  stageFilter: 'all' as 'all' | IssueStageId,
  quickSearch: '',
}));

const quickSearchInputRef = ref<InputInstance>();
const focusedIssueKey = shallowRef('');
const copiedBranchKey = shallowRef('');
const calendarMode = shallowRef<'month' | 'gantt'>('month');
let copiedBranchTimer: ReturnType<typeof setTimeout> | undefined;

const localQuery = computed(() => typeof route.query.q === 'string' ? route.query.q.toLowerCase() : '');
const locatingIssue = computed(() => /^[a-z][a-z0-9_]*-\d+$/i.test(localQuery.value));
// 编号定位不受之前的日期、项目或未完成筛选影响；清除定位后恢复原筛选。
const queryParams = computed<Record<string, string>>(() => {
  if (locatingIssue.value) return { issueKey: localQuery.value.toUpperCase(), allTime: 'true', includeDone: 'true', maxResults: '1' };
  if (props.mode !== 'calendar') return applied.value;
  const cells = calendarMode.value === 'gantt' ? buildGanttWindowDays(calendarDate.value) : buildMonthCalendar(calendarDate.value);
  return taskQueryParams(applied.value, { start: cells[0].day, end: cells.at(-1)!.day });
});
const query = useSource<IssueResponse>('issues', queryParams);
const { data, isPending, isFetching, error } = query;
const selected = shallowRef<JiraIssue>(), drawer = shallowRef(false);
const taskTable = useTemplateRef<TableInstance>('taskTable');

const baseItems = computed(() => (data.value?.issues || []).filter((item) =>
  (locatingIssue.value || matchesPlannedFilter(item, applied.value)) &&
  (!localQuery.value || (locatingIssue.value ? item.key.toLowerCase() === localQuery.value : `${item.key} ${item.summary}`.toLowerCase().includes(localQuery.value)))));

const quickNeedle = computed(() => (quickSearch.value || '').trim().toLowerCase());
const quickMatchedItems = computed(() => {
  if (!quickNeedle.value) return baseItems.value;
  return baseItems.value.filter(item =>
    `${item.key} ${item.summary} ${item.projectName} ${item.assignee || ''} ${item.status || ''} ${(item.fixVersions || []).join(' ')}`
      .toLowerCase()
      .includes(quickNeedle.value));
});

const kanbanColumnsAll = computed(() => buildIssueKanbanColumns(quickMatchedItems.value));
const stagePills = computed(() => [
  { id: 'all' as const, label: '全部', count: quickMatchedItems.value.length },
  ...kanbanColumnsAll.value.map(col => ({ id: col.id, label: col.label, count: col.issues.length })),
]);

const items = computed(() => {
  if (props.mode !== 'list') return baseItems.value;
  if (stageFilter.value === 'all') return quickMatchedItems.value;
  return quickMatchedItems.value.filter(item => classifyIssueStage(item) === stageFilter.value);
});

const kanbanColumns = computed(() => buildIssueKanbanColumns(items.value));
const visible = computed(() => items.value.slice((page.value - 1) * 20, page.value * 20));
const navigableKeys = computed(() =>
  (listLayout.value === 'kanban' ? items.value : visible.value).map(item => item.key));

const metrics = computed(() => [
  { label: '查询任务', value: data.value ? items.value.length : undefined, note: `服务端匹配 ${data.value?.total ?? '—'} 条` },
  { label: '未完成', value: data.value ? items.value.filter((item) => !isDone(item)).length : undefined, note: '按 Jira 状态分类', tone: 'primary' },
  { label: '已完成', value: data.value ? items.value.filter(isDone).length : undefined, note: '不按截止日期推断', tone: 'success' },
  { label: '子任务', value: data.value ? items.value.filter((item) => item.parent).length : undefined, note: '保留父子关系' },
]);
const health = computed(() => summarizeTaskHealth(items.value));
const stats = computed(() => [
  { key: 'project', title: '按项目分布', rows: countBy(items.value, (item) => item.projectName) },
  { key: 'status', title: '按状态流转', rows: countBy(items.value, (item) => item.status) },
  { key: 'assignee', title: '按经办人负载', rows: countBy(items.value, (item) => item.assignee || '未指派') },
  { key: 'type', title: '按事项类型', rows: countBy(items.value, (item) => item.issueType) },
  { key: 'priority', title: '按优先级分布', rows: countBy(items.value, (item) => item.priority) },
]);

function drilldownFromStat(label: string) {
  const clean = label === '未指派' ? '' : label;
  stageFilter.value = 'all';
  quickSearch.value = clean;
  if (route.path === '/agent') {
    void router.push({ path: '/agent', query: { ...route.query, view: 'tasks' } });
  } else {
    void router.push({ path: '/tasks/list' });
  }
}
const dated = computed(() => groupTasksByDate(items.value, activeDateField.value, calendarDate.value));
const dateFieldLabel = computed(() => ({ planned: '计划日期区间', updated: '更新时间', created: '创建时间', duedate: '截止日期', resolutiondate: '解决时间' } as Record<string, string>)[activeDateField.value] || '计划日期区间');
const dailyDrawer = shallowRef(false), selectedDay = shallowRef('');
const dailyItems = computed(() => dated.value.get(selectedDay.value) || []);

function inspect(issue: JiraIssue) {
  focusedIssueKey.value = issue.key;
  selected.value = issue;
  drawer.value = true;
  void router.replace({ query: { ...route.query, task: issue.key } });
}
function inspectDay(value: string) { selectedDay.value = value; dailyDrawer.value = true; }
async function clearLocation() { const { q: _q, task: _task, ...query } = route.query; await router.replace({ query }); drawer.value = false; }
function search(next: TaskFilter) {
  applied.value = Object.fromEntries(Object.entries(next).map(([key, value]) => [key, String(value)]));
  activeDateField.value = next.dateField;
  page.value = 1;
  resetTableScroll();
}
async function copySuggestedBranch(issue: JiraIssue) {
  const branch = suggestIssueBranchName(issue.key, issue.issueType);
  if (!branch) return;
  try {
    await navigator.clipboard.writeText(branch);
    copiedBranchKey.value = issue.key;
    if (copiedBranchTimer) clearTimeout(copiedBranchTimer);
    copiedBranchTimer = setTimeout(() => {
      if (copiedBranchKey.value === issue.key) copiedBranchKey.value = '';
    }, 1600);
    ElMessage.success(`已复制分支名 ${branch}`);
  } catch {
    ElMessage.error('浏览器未允许复制');
  }
}
function sendIssueToAi(issue: JiraIssue) {
  workspace?.compose(jiraQuickPrompt(issue));
}
function rowClassName({ row }: { row: JiraIssue }) {
  return row.key === focusedIssueKey.value ? 'is-triage-focused' : '';
}
function resetTableScroll() { tableScrollTop.value = 0; taskTable.value?.setScrollTop(0); }
function rememberTableScroll({ scrollTop }: { scrollTop: number }) { tableScrollTop.value = scrollTop; }

function onTriageKeydown(event: KeyboardEvent) {
  if (props.mode !== 'list' || drawer.value || dailyDrawer.value) return;
  const target = event.target as HTMLElement | null;
  if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return;
  if (document.querySelector('.el-dialog, .el-drawer, .cmd-palette-backdrop')) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  if (event.key === '/') {
    event.preventDefault();
    quickSearchInputRef.value?.focus();
    return;
  }
  if (event.key === 'j' || event.key === 'k') {
    if (!navigableKeys.value.length) return;
    event.preventDefault();
    const nextKey = stepIssueSelection(navigableKeys.value, focusedIssueKey.value, event.key === 'j' ? 1 : -1);
    focusedIssueKey.value = nextKey;
    document.querySelector<HTMLElement>(`[data-issue-key="${CSS.escape(nextKey)}"]`)?.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (event.key === 'Enter' && focusedIssueKey.value) {
    const issue = items.value.find(item => item.key === focusedIssueKey.value);
    if (issue) {
      event.preventDefault();
      inspect(issue);
    }
  }
}

onMounted(() => document.addEventListener('keydown', onTriageKeydown));
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onTriageKeydown);
  if (copiedBranchTimer) clearTimeout(copiedBranchTimer);
});

watch([() => props.mode, localQuery, quickNeedle, stageFilter], () => { page.value = 1; });
watch(page, resetTableScroll, { flush: 'post' });
watch(taskTable, (table, _previous, onCleanup) => {
  if (!table || !tableScrollTop.value) return;
  const frame = requestAnimationFrame(() => table.setScrollTop(tableScrollTop.value));
  onCleanup(() => cancelAnimationFrame(frame));
}, { flush: 'post' });
watch(() => items.value.length, length => { page.value = Math.min(page.value, Math.max(1, Math.ceil(length / 20))); });
watch([() => route.query.task, () => data.value], () => {
  const issue = data.value?.issues.find(item => item.key === route.query.task);
  if (issue) { selected.value = issue; drawer.value = true; }
}, { immediate: true });
watch(drawer, open => { if (!open && route.query.task) { const { task: _task, ...query } = route.query; void router.replace({ query }); } });
</script>
<template>
  <section class="task-workspace">
  <PageHeading :title="mode === 'calendar' ? '任务日历' : mode === 'stats' ? '任务统计' : '任务列表'" description="读取原 Jira 查询接口，支持阶段分诊胶囊、列表/看板双视图与键盘快捷操作。" :loading="isFetching" @refresh="query.refetch()" />
  <header v-if="!workspace" class="task-heading">
    <h1>{{ mode === 'calendar' ? '任务日历' : mode === 'stats' ? '任务统计' : '任务列表' }}</h1>
  </header>
  <MetricStrip :items="metrics" />
  <div class="task-board" :class="'task-board--' + mode">
    <aside class="task-side" aria-label="Jira 任务筛选">
      <div v-if="locatingIssue" class="inline-links"><span>定位 {{ route.query.q }} · 包含已完成任务</span><el-button link type="primary" @click="clearLocation">返回原筛选</el-button></div>
      <div v-else class="surface task-filter-surface"><TaskFilters v-model="filters" :loading="isFetching" @search="search" /></div>
    </aside>
    <div class="task-main">
      <el-alert v-if="data?.source === 'mock'" class="section-alert" type="warning" title="原接口当前返回模拟来源，不是 Jira 实时任务。" :closable="false" show-icon />
      <QueryState :loading="isPending" :error="error" :has-data="!!data" @retry="query.refetch()">
        <div v-if="mode === 'list'" class="surface task-list">
          <div class="task-triage-bar" role="toolbar" aria-label="快速分诊与视图切换">
            <div class="task-triage-search">
              <el-input
                ref="quickSearchInputRef"
                v-model="quickSearch"
                clearable
                placeholder="秒筛单号、标题、经办人或项目"
                aria-label="快速筛选当前任务结果"
                @keydown.esc="quickSearch = ''"
              >
                <template #prefix><Search :size="14" /></template>
                <template v-if="!quickSearch" #suffix><kbd class="task-kbd-hint">/</kbd></template>
              </el-input>
            </div>
            <div class="task-stage-pills" role="tablist" aria-label="按阶段快速过滤">
              <button
                v-for="pill in stagePills"
                :key="pill.id"
                type="button"
                role="tab"
                class="task-stage-pill"
                :class="{ 'is-active': stageFilter === pill.id }"
                :aria-selected="stageFilter === pill.id"
                @click="stageFilter = pill.id"
              >
                <span>{{ pill.label }}</span>
                <b>{{ pill.count }}</b>
              </button>
            </div>
            <div class="task-triage-right">
              <span class="task-shortcut-hint" title="在非输入态按 j / k 上下选中事项，按 Enter 打开详情抽屉">
                <kbd>j</kbd><kbd>k</kbd> 移动 · <kbd>↵</kbd> 详情
              </span>
              <div class="task-view-switch" role="group" aria-label="切换列表或看板视图">
                <button
                  type="button"
                  :class="{ 'is-active': listLayout === 'table' }"
                  :aria-pressed="listLayout === 'table'"
                  @click="listLayout = 'table'"
                >
                  <List :size="13" /><span>列表</span>
                </button>
                <button
                  type="button"
                  :class="{ 'is-active': listLayout === 'kanban' }"
                  :aria-pressed="listLayout === 'kanban'"
                  @click="listLayout = 'kanban'"
                >
                  <Columns3 :size="13" /><span>看板</span>
                </button>
              </div>
            </div>
          </div>

          <template v-if="listLayout === 'table'">
            <el-table
              ref="taskTable"
              :data="visible"
              :row-class-name="rowClassName"
              :scrollbar-tabindex="0"
              class="task-table"
              aria-label="Jira 任务明细"
              @row-click="(row: JiraIssue) => { focusedIssueKey = row.key; }"
              @scroll="rememberTableScroll"
            >
              <el-table-column label="Jira 任务" min-width="310">
                <template #default="{ row }">
                  <div class="task-identity" :data-issue-key="row.key">
                    <div class="task-title-meta">
                      <button type="button" class="task-key-pill" :title="`打开 ${row.key} 详情抽屉`" @click.stop="inspect(row)">
                        {{ row.key }}
                      </button>
                      <a :href="safeUrl(row.url)" target="_blank" rel="noopener noreferrer" class="task-ext-link" :title="`在 Jira 新标签页打开 ${row.key}`" @click.stop>
                        <ExternalLink :size="11" />
                      </a>
                      <span v-if="row.parent" class="row-secondary">父任务 {{ row.parent.key }}</span>
                    </div>
                    <div class="task-micro-actions">
                      <button
                        type="button"
                        class="task-micro-chip"
                        :class="{ 'is-copied': copiedBranchKey === row.key }"
                        :title="`复制推荐分支名 ${suggestIssueBranchName(row.key, row.issueType)}`"
                        @click.stop="copySuggestedBranch(row)"
                      >
                        <Check v-if="copiedBranchKey === row.key" :size="11" />
                        <GitBranch v-else :size="11" />
                        <span>{{ copiedBranchKey === row.key ? '已复制' : '分支' }}</span>
                      </button>
                      <button
                        v-if="workspace"
                        type="button"
                        class="task-micro-chip is-ai"
                        :title="`将 ${row.key} 带入 AI 对话分析或修复`"
                        @click.stop="sendIssueToAi(row)"
                      >
                        <Sparkles :size="11" /><span>AI 处理</span>
                      </button>
                      <el-button class="task-detail-button" link type="primary" :aria-label="`${row.key} 详情`" @click.stop="inspect(row)">详情<ChevronRight :size="13" aria-hidden="true" /></el-button>
                    </div>
                  </div>
                  <strong class="row-title task-summary" :title="row.summary" @click="inspect(row)">{{ row.summary }}</strong>
                  <dl class="task-people" aria-label="任务人员"><div><dt>经办人</dt><dd>{{ row.assignee || '—' }}</dd></div><div><dt>报告人</dt><dd>{{ row.reporter || '—' }}</dd></div></dl>
                </template>
              </el-table-column>
              <el-table-column label="项目 / 版本" min-width="138"><template #default="{ row }"><span class="task-project" :title="row.projectName">{{ row.projectName }}</span><span class="row-secondary task-version" :title="row.fixVersions?.join('、')">{{ row.fixVersions?.join('、') || '未设置版本' }}</span></template></el-table-column>
              <el-table-column label="计划日期" width="136"><template #default="{ row }"><div class="task-dates"><span class="row-mono">{{ day(row.startDate) }}</span><span class="row-secondary">至 {{ day(row.endDate || row.dueDate) }}</span></div></template></el-table-column>
              <el-table-column label="状态 / 优先级" width="130"><template #default="{ row }"><div class="task-status"><StatusPill :value="row.status" /><span class="row-secondary">{{ row.priority }} · {{ row.issueType }}</span></div></template></el-table-column>
            </el-table>
            <div class="table-footer"><span>本页 {{ visible.length }} 条 / 共 {{ items.length }} 条</span><el-pagination v-model:current-page="page" :total="items.length" :page-size="20" layout="prev, pager, next" /></div>
          </template>

          <div v-else class="task-kanban-board" role="region" aria-label="Jira 状态看板">
            <section v-for="col in kanbanColumns" :key="col.id" class="task-kanban-lane" :data-tone="col.tone">
              <header class="task-kanban-head">
                <span class="task-kanban-dot" :data-tone="col.tone"></span>
                <h3>{{ col.label }}</h3>
                <b>{{ col.issues.length }}</b>
              </header>
              <div class="task-kanban-cards">
                <article
                  v-for="card in col.issues"
                  :key="card.key"
                  :data-issue-key="card.key"
                  class="task-kanban-card"
                  :class="{ 'is-focused': focusedIssueKey === card.key }"
                  tabindex="0"
                  @click="inspect(card)"
                  @keydown.enter.prevent="inspect(card)"
                >
                  <div class="task-kanban-card-top">
                    <span class="task-key-pill">{{ card.key }}</span>
                    <span class="task-kanban-priority">{{ card.priority || card.issueType }}</span>
                  </div>
                  <strong class="task-kanban-summary">{{ card.summary }}</strong>
                  <div class="task-kanban-meta">
                    <span>{{ card.projectName }}</span>
                    <span v-if="card.assignee">· {{ card.assignee }}</span>
                  </div>
                  <footer class="task-kanban-foot" @click.stop>
                    <StatusPill :value="card.status" />
                    <div class="task-micro-actions">
                      <button
                        type="button"
                        class="task-micro-chip"
                        :class="{ 'is-copied': copiedBranchKey === card.key }"
                        :title="`复制推荐分支名 ${suggestIssueBranchName(card.key, card.issueType)}`"
                        @click="copySuggestedBranch(card)"
                      >
                        <Check v-if="copiedBranchKey === card.key" :size="11" />
                        <GitBranch v-else :size="11" />
                        <span>{{ copiedBranchKey === card.key ? '已复制' : '分支' }}</span>
                      </button>
                      <button
                        v-if="workspace"
                        type="button"
                        class="task-micro-chip is-ai"
                        @click="sendIssueToAi(card)"
                      >
                        <Sparkles :size="11" /><span>AI</span>
                      </button>
                    </div>
                  </footer>
                </article>
                <p v-if="!col.issues.length" class="task-kanban-empty">暂无此阶段事项</p>
              </div>
            </section>
          </div>
        </div>
        <div v-else-if="mode === 'calendar'" class="surface task-calendar"><WorkdayCalendar v-model="calendarDate" v-model:mode="calendarMode" :items-by-day="dated" :items="items" :date-field="activeDateField" @inspect="inspect" @select-day="inspectDay" /><p class="source-footnote calendar-note">当前按{{ dateFieldLabel }}归入日历与双周甘特；周六、周日按休息日展示，没有对应日期的任务仍保留在任务列表中。</p></div>
        <div v-else class="task-stats-studio">
          <div class="task-health-strip">
            <article class="surface task-health-tile">
              <span>整体完成率</span>
              <strong>{{ health.completionRate }}%</strong>
              <small>已完成 {{ health.doneCount }} / {{ health.total }} 项</small>
            </article>
            <article class="surface task-health-tile" :class="{ 'is-danger': health.overdueCount > 0 }">
              <span>逾期未完事项</span>
              <strong>{{ health.overdueCount }}</strong>
              <small>{{ health.overdueCount ? '计划结束早于今日' : '当前无逾期阻塞' }}</small>
            </article>
            <article class="surface task-health-tile" :class="{ 'is-warn': health.unscheduledCount > 0 }">
              <span>待补排期事项</span>
              <strong>{{ health.unscheduledCount }}</strong>
              <small>{{ health.unscheduledCount ? '未填写起止或截止日' : '全部未完事项已排期' }}</small>
            </article>
            <article class="surface task-health-tile">
              <span>协作经办人</span>
              <strong>{{ health.assigneeCount }}</strong>
              <small>点击下方任意分布行可直达列表筛选</small>
            </article>
          </div>
          <div class="task-stats">
            <section v-for="group in stats" :key="group.title" class="surface">
              <div class="surface-header">
                <h2>{{ group.title }}</h2>
                <span class="row-secondary">{{ group.rows.length }} 组 · 点击穿透列表</span>
              </div>
              <div class="surface-body">
                <button
                  v-for="row in group.rows"
                  :key="row.label"
                  type="button"
                  class="stat-row stat-row-btn"
                  :title="`在任务列表中筛选「${row.label}」`"
                  @click="drilldownFromStat(row.label)"
                >
                  <span>{{ row.label }}</span>
                  <el-progress :percentage="Math.round(row.value / Math.max(items.length, 1) * 100)" :show-text="false" :stroke-width="7" />
                  <small class="stat-pct">{{ Math.round(row.value / Math.max(items.length, 1) * 100) }}%</small>
                  <strong>{{ row.value }}</strong>
                  <ChevronRight :size="13" class="stat-chevron" />
                </button>
              </div>
            </section>
          </div>
        </div>
        <p class="source-footnote task-source"><span>来源 {{ data?.source }} · 页面读取于 {{ dateTime(query.dataUpdatedAt.value) }}</span><span class="task-source-query" :title="data?.jql">{{ data?.jql }}</span><span v-if="data && (data.truncated || data.total > data.issues.length)">当前仅返回 {{ data.issues.length }} / {{ data.total }} 项，请缩小查询范围。</span></p>
      </QueryState>
    </div>
  </div>
  <JiraIssueDrawer v-if="drawer || typeof route.query.task === 'string'" v-model="drawer" :issue="selected" :issue-key="typeof route.query.task==='string'?route.query.task:undefined" @changed="query.refetch()" @inspect="key=>router.replace({query:{...route.query,task:key}})" />
  <el-drawer v-if="dailyDrawer" v-model="dailyDrawer" class="task-daily-drawer" :title="`${selectedDay} · ${dailyItems.length} 项任务`" size="min(620px, 94vw)" append-to-body>
    <div v-for="item in dailyItems" :key="item.key" class="day-issue" @click="inspect(item)">
      <span class="task-key-pill">{{ item.key }}</span>
      <strong>{{ item.summary }}</strong>
      <div class="task-micro-actions" @click.stop>
        <button type="button" class="task-micro-chip" :class="{ 'is-copied': copiedBranchKey === item.key }" @click="copySuggestedBranch(item)">
          <Check v-if="copiedBranchKey === item.key" :size="11" /><GitBranch v-else :size="11" /><span>分支</span>
        </button>
        <button v-if="workspace" type="button" class="task-micro-chip is-ai" @click="sendIssueToAi(item)">
          <Sparkles :size="11" /><span>AI</span>
        </button>
      </div>
      <StatusPill :value="item.status" />
    </div>
    <el-empty v-if="!dailyItems.length" description="该日期没有匹配任务" />
  </el-drawer>
  </section>
</template>
<style scoped>
.task-workspace { min-width: 0; }
.task-heading { margin: 0 0 24px; }
.task-heading h1 { margin: 0; color: var(--ui-text); font-size: 18px; font-weight: 600; line-height: 1.5; }
.task-workspace .surface.task-filter-surface { margin-bottom: 0; border-bottom: 1px solid var(--ui-divider); }
.task-workspace .task-filter-surface :deep(.task-filters) { padding-block: 12px; }
.task-list { margin-bottom: 0; }

/* Plane / Huly Triage Toolbar */
.task-triage-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 10px;
  padding: 11px 14px;
  border-bottom: 1px solid var(--ui-divider);
  background: color-mix(in srgb, var(--ui-raised) 52%, var(--ui-surface));
}
.task-triage-search {
  flex: 1 1 210px;
  max-width: 280px;
  min-width: 170px;
}
.task-kbd-hint,
.task-shortcut-hint kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border: 1px solid var(--ui-border);
  border-radius: 4px;
  background: var(--ui-surface);
  color: var(--ui-muted);
  font: 500 10.5px/1 var(--mono);
}
.task-stage-pills {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
}
.task-stage-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 9px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius-xs, 6px);
  background: var(--ui-surface);
  color: var(--ui-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: border-color .14s ease, background .14s ease, color .14s ease;
}
.task-stage-pill:hover {
  border-color: color-mix(in srgb, var(--ui-accent) 42%, var(--ui-border));
  color: var(--ui-text);
}
.task-stage-pill.is-active {
  border-color: color-mix(in srgb, var(--ui-accent) 50%, transparent);
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
  font-weight: 600;
}
.task-stage-pill b {
  font: 600 11px/1 var(--mono);
  font-variant-numeric: tabular-nums;
  opacity: 0.85;
}
.task-triage-right {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
}
.task-shortcut-hint {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--ui-muted);
  font-size: 11px;
  white-space: nowrap;
}
.task-view-switch {
  display: inline-flex;
  padding: 2px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius-xs, 6px);
  background: var(--ui-surface);
}
.task-view-switch > button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--ui-secondary);
  font-size: 11.5px;
  cursor: pointer;
}
.task-view-switch > button.is-active {
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
  font-weight: 600;
}

.task-identity { display: flex; align-items: center; justify-content: space-between; gap: 4px 8px; }
.task-title-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 6px; min-width: 0; }
.task-title-meta .row-secondary { margin: 0; }
.task-key-pill {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border: 1px solid color-mix(in srgb, var(--ui-accent) 26%, var(--ui-border));
  border-radius: 5px;
  background: color-mix(in srgb, var(--ui-accent-soft) 55%, var(--ui-surface));
  color: var(--ui-accent);
  font: 600 11.5px/1.45 var(--mono);
  cursor: pointer;
}
.task-key-pill:hover {
  border-color: var(--ui-accent);
  background: var(--ui-accent-soft);
}
.task-ext-link {
  display: inline-flex;
  align-items: center;
  color: var(--ui-muted);
  padding: 2px;
}
.task-ext-link:hover { color: var(--ui-accent); }

.task-micro-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.task-micro-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 22px;
  padding: 0 6px;
  border: 1px solid var(--ui-border);
  border-radius: 5px;
  background: var(--ui-surface);
  color: var(--ui-secondary);
  font-size: 11px;
  cursor: pointer;
}
.task-micro-chip:hover {
  border-color: var(--ui-accent);
  color: var(--ui-accent);
}
.task-micro-chip.is-copied {
  border-color: var(--ui-success, #10b981);
  color: var(--ui-success, #10b981);
}
.task-micro-chip.is-ai {
  border-color: color-mix(in srgb, var(--ui-accent) 32%, var(--ui-border));
  color: var(--ui-accent);
}

.task-table :deep(tr.is-triage-focused > td.el-table__cell) {
  background: color-mix(in srgb, var(--ui-accent-soft) 55%, var(--ui-surface)) !important;
}
.task-table :deep(tr.is-triage-focused > td.el-table__cell:first-child) {
  box-shadow: inset 2.5px 0 0 var(--ui-accent);
}

.task-table :deep(.task-detail-button.el-button) { flex-shrink: 0; min-height: 22px; padding: 0 4px; border-radius: 5px; font-size: 11.5px; }
.task-table :deep(.task-detail-button.el-button:hover) { background: var(--ui-accent-soft); }
.task-workspace .task-list :deep(.task-table td.el-table__cell) { padding-block: 7px; vertical-align: top; }
.task-table :deep(td:not(:first-child) .cell) { padding-top: 5px; }
.task-table :deep(.el-scrollbar__wrap:focus-visible) { outline: 2px solid var(--ui-accent); outline-offset: -2px; }
.task-workspace .task-summary {
  display: -webkit-box;
  margin: 3px 0 0;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow-wrap: anywhere;
  font-size: 13px;
  font-weight: 550;
  line-height: 1.45;
  cursor: pointer;
}
.task-workspace .task-summary:hover { color: var(--ui-accent); }
.task-people { display: flex; flex-wrap: wrap; gap: 2px 12px; margin: 2px 0 0; font-size: 11px; line-height: 1.45; }
.task-people > div { display: flex; align-items: baseline; gap: 5px; min-width: 0; max-width: 100%; }
.task-people dt { flex: none; color: var(--ui-muted); }
.task-people dd { margin: 0; color: var(--ui-secondary); overflow-wrap: anywhere; }
.task-project, .task-version { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-list :is(.task-version, .task-status > .row-secondary, .task-dates > .row-secondary) { margin-top: 2px; }
.task-dates { white-space: nowrap; }
.task-status { display: flex; flex-direction: column; align-items: flex-start; }

/* Plane / Linear Kanban View */
.task-kanban-board {
  display: grid;
  grid-template-columns: repeat(4, minmax(215px, 1fr));
  gap: 10px;
  padding: 12px 14px 14px;
  overflow-x: auto;
  align-items: start;
}
.task-kanban-lane {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 10px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius-sm, 8px);
  background: color-mix(in srgb, var(--ui-raised) 68%, var(--ui-surface));
}
.task-kanban-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 2px 4px;
  border-bottom: 1px solid var(--ui-divider);
}
.task-kanban-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ui-muted);
}
.task-kanban-dot[data-tone='primary'] { background: var(--ui-accent); }
.task-kanban-dot[data-tone='warning'] { background: #f59e0b; }
.task-kanban-dot[data-tone='success'] { background: #10b981; }
.task-kanban-head h3 {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ui-text);
}
.task-kanban-head b {
  margin-left: auto;
  font: 600 11px/1.4 var(--mono);
  font-variant-numeric: tabular-nums;
  color: var(--ui-muted);
}
.task-kanban-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: min(62dvh, 560px);
  overflow-y: auto;
}
.task-kanban-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 11px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius-xs, 7px);
  background: var(--ui-surface);
  cursor: pointer;
  transition: border-color .14s ease, transform .14s ease;
}
.task-kanban-card:hover,
.task-kanban-card.is-focused {
  border-color: var(--ui-accent);
}
.task-kanban-card.is-focused {
  box-shadow: inset 2.5px 0 0 var(--ui-accent);
}
.task-kanban-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.task-kanban-priority {
  font-size: 11px;
  color: var(--ui-muted);
}
.task-kanban-summary {
  font-size: 12.5px;
  font-weight: 560;
  line-height: 1.45;
  color: var(--ui-text);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
}
.task-kanban-meta {
  font-size: 11px;
  color: var(--ui-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-kanban-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--ui-divider);
}
.task-kanban-empty {
  margin: 0;
  padding: 18px 8px;
  text-align: center;
  font-size: 11.5px;
  color: var(--ui-muted);
}

:root[data-theme='acid'] .task-stage-pill,
:root[data-theme='acid'] .task-view-switch,
:root[data-theme='acid'] .task-view-switch > button,
:root[data-theme='acid'] .task-key-pill,
:root[data-theme='acid'] .task-micro-chip,
:root[data-theme='acid'] .task-kanban-lane,
:root[data-theme='acid'] .task-kanban-card,
:root[data-theme='acid'] .task-kbd-hint {
  border-radius: 0 !important;
}

.task-workspace .task-source { display: flex; flex-wrap: wrap; gap: 2px 12px; margin: 8px 0 0; font-size: 11px; }
.task-source-query { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ui-muted); }
.calendar-note{padding:0 20px 15px}
.task-stats-studio { display: flex; flex-direction: column; gap: 14px; }
.task-health-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.task-health-tile {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  margin: 0 !important;
}
.task-health-tile span { font-size: 11.5px; color: var(--ui-muted); }
.task-health-tile strong { font: 650 20px/1.2 var(--mono); font-variant-numeric: tabular-nums; color: var(--ui-text); }
.task-health-tile small { font-size: 11px; color: var(--ui-secondary); }
.task-health-tile.is-danger strong { color: #ef4444; }
.task-health-tile.is-warn strong { color: #f59e0b; }

.task-stats{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.stat-row{display:flex;align-items:center;gap:10px;margin:4px 0}
.stat-row-btn {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background .12s ease, border-color .12s ease;
}
.stat-row-btn:hover {
  background: var(--ui-hover);
  border-color: var(--ui-border);
}
.stat-chevron { color: var(--ui-muted); flex-shrink: 0; opacity: 0.65; }
.stat-row-btn:hover .stat-chevron { color: var(--ui-accent); opacity: 1; }
.stat-row>span{font-size:12.5px;color:var(--ui-secondary);width:128px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.stat-row .el-progress{flex:1;--el-color-primary:var(--ui-accent)}.stat-row :deep(.el-progress-bar__outer){background-color:var(--ui-raised);border:1px solid var(--ui-border)}.stat-row :deep(.el-progress-bar__inner){background-color:var(--ui-accent)}.stat-pct{width:38px;text-align:right;color:var(--ui-muted);font:11.5px var(--mono);font-variant-numeric:tabular-nums}.stat-row strong{font:600 12px var(--mono);font-variant-numeric:tabular-nums;width:28px;text-align:right;color:var(--ui-text)}
.day-issue{padding:12px 0;border-bottom:1px solid var(--ui-border);display:flex;align-items:center;gap:10px;cursor:pointer}
.day-issue strong{flex:1;min-width:0;font-size:13px;line-height:1.5;font-weight:500;color:var(--ui-text)}
:global(.task-daily-drawer.el-drawer) { color: var(--ui-text); background: var(--ui-bg); }
:global(.task-daily-drawer .el-drawer__header) { margin-bottom: 0; padding: 14px 18px; border-bottom: 1px solid var(--ui-border); color: var(--ui-text); }
:root[data-theme='acid'] .stat-row-btn { border-radius: 0 !important; }
@media(max-width:1000px){.task-stats{grid-template-columns:1fr}.task-health-strip{grid-template-columns:repeat(2,minmax(0,1fr))}.task-calendar{overflow:hidden}.task-shortcut-hint{display:none}}
@container workspace-page (max-width:780px){.task-shortcut-hint{display:none}.task-kanban-board{grid-template-columns:repeat(2,minmax(210px,1fr))}}
@container workspace-page (max-width:600px){.task-heading{margin-bottom:16px}.task-workspace .task-list .table-footer{align-items:flex-start;flex-wrap:wrap;gap:8px}}
</style>
