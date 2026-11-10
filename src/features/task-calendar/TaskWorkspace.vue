<script setup lang="ts">
/** 日历、列表与统计共享同一查询结果；布局按标题、指标、筛选和结果分层，保留来源字段与现有查询行为，不拆分额外状态。 */
import { computed, shallowRef, useTemplateRef, watch } from 'vue';
import type { TableInstance } from 'element-plus';
import { ChevronRight } from '@lucide/vue';
import { useWorkspacePanelState } from '../../shared/useWorkspacePanelState';
import { useRoute, useRouter } from 'vue-router';
import type { JiraIssue, IssueResponse } from '../../../shared/hub';
import { useSource } from '../../shared/api';
import { countBy, day, isDone, safeUrl, dateTime } from '../../shared/format';
import PageHeading from '../../shared/ui/PageHeading.vue';
import QueryState from '../../shared/ui/QueryState.vue';
import MetricStrip from '../../shared/ui/MetricStrip.vue';
import StatusPill from '../../shared/ui/StatusPill.vue';
import JiraIssueDrawer from '../jira-issue/JiraIssueDrawer.vue';
import TaskFilters from './TaskFilters.vue';
import WorkdayCalendar from './WorkdayCalendar.vue';
import TaskDelivery from '../workbench/TaskDelivery.vue';
import { advancedTaskDefaults, groupTasksByDate, matchesPlannedFilter, taskQueryParams, type TaskFilter } from './calendar-domain';
const props = defineProps<{ mode: string }>();
const route = useRoute();
const router = useRouter();
const { filters, applied, page, tableScrollTop, calendarDate, activeDateField } = useWorkspacePanelState('tasks', () => ({
  filters: { ...advancedTaskDefaults, projects: '', keyword: '', includeSubtasks: true, includeDone: false } as TaskFilter,
  applied: { dateField: 'planned', allTime: 'true', includeSubtasks: 'true', includeDone: 'false', maxResults: '5000' } as Record<string, string>,
  page: 1, tableScrollTop: 0, calendarDate: new Date(), activeDateField: 'planned',
}));
const localQuery = computed(() => typeof route.query.q === 'string' ? route.query.q.toLowerCase() : '');
const locatingIssue = computed(() => /^[a-z][a-z0-9_]*-\d+$/i.test(localQuery.value));
// 编号定位不受之前的日期、项目或未完成筛选影响；清除定位后恢复原筛选。
const queryParams = computed(() => locatingIssue.value
  ? { allTime: 'true', includeSubtasks: 'true', includeDone: 'true', maxResults: '5000' }
  : taskQueryParams(applied.value));
const query = useSource<IssueResponse>('issues', queryParams);
const { data, isPending, isFetching, error } = query;
const selected = shallowRef<JiraIssue>(), drawer = shallowRef(false);
const taskTable = useTemplateRef<TableInstance>('taskTable');
const items = computed(() => (data.value?.issues || []).filter((item) =>
  (locatingIssue.value || matchesPlannedFilter(item, applied.value)) &&
  (!localQuery.value || (locatingIssue.value ? item.key.toLowerCase() === localQuery.value : `${item.key} ${item.summary}`.toLowerCase().includes(localQuery.value)))));
const visible = computed(() => items.value.slice((page.value - 1) * 20, page.value * 20));
const metrics = computed(() => [
  { label: '查询任务', value: data.value ? items.value.length : undefined, note: `服务端匹配 ${data.value?.total ?? '—'} 条` },
  { label: '未完成', value: data.value ? items.value.filter((item) => !isDone(item)).length : undefined, note: '按 Jira 状态分类', tone: 'primary' },
  { label: '已完成', value: data.value ? items.value.filter(isDone).length : undefined, note: '不按截止日期推断', tone: 'success' },
  { label: '子任务', value: data.value ? items.value.filter((item) => item.parent).length : undefined, note: '保留父子关系' },
]);
const stats = computed(() => [{ title: '按项目', rows: countBy(items.value, (item) => item.projectName) }, { title: '按状态', rows: countBy(items.value, (item) => item.status) }, { title: '按任务类型', rows: countBy(items.value, (item) => item.issueType) }, { title: '按优先级', rows: countBy(items.value, (item) => item.priority) }]);
const dated = computed(() => groupTasksByDate(items.value, activeDateField.value, calendarDate.value));
const dateFieldLabel = computed(() => ({ planned: '计划日期区间', updated: '更新时间', created: '创建时间', duedate: '截止日期', resolutiondate: '解决时间' } as Record<string, string>)[activeDateField.value] || '计划日期区间');
const dailyDrawer = shallowRef(false), selectedDay = shallowRef('');
const dailyItems = computed(() => dated.value.get(selectedDay.value) || []);
function inspect(issue: JiraIssue) { selected.value = issue; drawer.value = true; void router.replace({ query: { ...route.query, task: issue.key } }); }
function inspectDay(value: string) { selectedDay.value = value; dailyDrawer.value = true; }
async function clearLocation() { const { q: _q, task: _task, ...query } = route.query; await router.replace({ query }); drawer.value = false; }
function search(next: TaskFilter) {
  applied.value = Object.fromEntries(Object.entries(next).map(([key, value]) => [key, String(value)]));
  activeDateField.value = next.dateField;
  page.value = 1;
  resetTableScroll();
}
function resetTableScroll() { tableScrollTop.value = 0; taskTable.value?.setScrollTop(0); }
function rememberTableScroll({ scrollTop }: { scrollTop: number }) { tableScrollTop.value = scrollTop; }
watch([() => props.mode, localQuery], () => { page.value = 1; });
watch(page, resetTableScroll, { flush: 'post' });
watch(taskTable, (table, _previous, onCleanup) => {
  if (!table || !tableScrollTop.value) return;
  // 等表格注册各列并确定滚动高度后，再恢复离开列表时的位置。
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
  <PageHeading :title="mode === 'calendar' ? '任务日历' : mode === 'stats' ? '任务统计' : '任务列表'" description="读取原 Jira 查询接口，保留人员、项目、版本、时间和父子任务关系。" :loading="isFetching" @refresh="query.refetch()" />
  <header class="task-heading">
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
          <div class="surface-header task-list-heading"><h2>任务明细</h2><span class="row-secondary">{{ localQuery ? `定位 ${route.query.q}` : '点击详情查看完整描述与父子关系' }}</span></div>
          <el-table ref="taskTable" :data="visible" :scrollbar-tabindex="0" class="task-table" aria-label="Jira 任务明细" @scroll="rememberTableScroll">
            <el-table-column label="Jira 任务" min-width="300">
              <template #default="{ row }">
                <div class="task-identity">
                  <div class="task-title-meta">
                    <a :href="safeUrl(row.url)" target="_blank" class="hub-link">{{ row.key }}</a>
                    <span v-if="row.parent" class="row-secondary">父任务 {{ row.parent.key }}</span>
                  </div>
                  <el-button class="task-detail-button" link type="primary" :aria-label="`${row.key} 详情`" @click="inspect(row)">详情<ChevronRight :size="13" aria-hidden="true" /></el-button>
                </div>
                <strong class="row-title task-summary" :title="row.summary">{{ row.summary }}</strong>
                <dl class="task-people" aria-label="任务人员"><div><dt>经办人</dt><dd>{{ row.assignee || '—' }}</dd></div><div><dt>报告人</dt><dd>{{ row.reporter || '—' }}</dd></div></dl>
              </template>
            </el-table-column>
            <el-table-column label="项目 / 版本" min-width="138"><template #default="{ row }"><span class="task-project" :title="row.projectName">{{ row.projectName }}</span><span class="row-secondary task-version" :title="row.fixVersions?.join('、')">{{ row.fixVersions?.join('、') || '未设置版本' }}</span></template></el-table-column>
            <el-table-column label="计划日期" width="136"><template #default="{ row }"><div class="task-dates"><span class="row-mono">{{ day(row.startDate) }}</span><span class="row-secondary">至 {{ day(row.endDate || row.dueDate) }}</span></div></template></el-table-column>
            <el-table-column label="状态 / 优先级" width="130"><template #default="{ row }"><div class="task-status"><StatusPill :value="row.status" /><span class="row-secondary">{{ row.priority }} · {{ row.issueType }}</span></div></template></el-table-column>
          </el-table>
          <div class="table-footer"><span>本页 {{ visible.length }} 条 / 共 {{ items.length }} 条</span><el-pagination v-model:current-page="page" :total="items.length" :page-size="20" layout="prev, pager, next" /></div>
        </div>
        <div v-else-if="mode === 'calendar'" class="surface task-calendar"><WorkdayCalendar v-model="calendarDate" :items-by-day="dated" @inspect="inspect" @select-day="inspectDay" /><p class="source-footnote calendar-note">当前按{{ dateFieldLabel }}归入日历；周六、周日按休息日展示，没有对应日期的任务仍保留在任务列表中。</p></div>
        <div v-else class="task-stats"><section v-for="group in stats" :key="group.title" class="surface"><div class="surface-header"><h2>{{ group.title }}</h2></div><div class="surface-body"><div v-for="row in group.rows" :key="row.label" class="stat-row"><span>{{ row.label }}</span><el-progress :percentage="Math.round(row.value / Math.max(items.length, 1) * 100)" :show-text="false" :stroke-width="7" /><strong>{{ row.value }}</strong></div></div></section></div>
        <p class="source-footnote task-source"><span>来源 {{ data?.source }} · 页面读取于 {{ dateTime(query.dataUpdatedAt.value) }}</span><span class="task-source-query" :title="data?.jql">{{ data?.jql }}</span><span v-if="activeDateField === 'planned' && data && data.total > data.issues.length">当前仅返回 {{ data.issues.length }} / {{ data.total }} 项，计划日历可能不完整，请缩小项目或人员范围。</span></p>
      </QueryState>
    </div>
  </div>
  <JiraIssueDrawer v-model="drawer" :issue="selected" :issue-key="typeof route.query.task==='string'?route.query.task:undefined" @changed="query.refetch()" @inspect="key=>router.replace({query:{...route.query,task:key}})" />
  <el-drawer v-model="dailyDrawer" :title="`${selectedDay} · ${dailyItems.length} 项任务`" size="min(620px, 94vw)" append-to-body><div v-for="item in dailyItems" :key="item.key" class="day-issue" @click="inspect(item)"><strong>{{ item.key }} · {{ item.summary }}</strong><StatusPill :value="item.status" /></div><el-empty v-if="!dailyItems.length" description="该日期没有匹配任务" /></el-drawer>
  </section>
</template>
<style scoped>
.task-workspace { min-width: 0; }
.task-heading { margin: 0 0 24px; }
.task-heading h1 { margin: 0; color: var(--ui-text); font-size: 18px; font-weight: 600; line-height: 1.5; }
.task-workspace .surface.task-filter-surface { margin-bottom: 0; border-bottom: 1px solid var(--ui-divider); }
.task-workspace .task-filter-surface :deep(.task-filters) { padding-block: 12px; }
.task-list { margin-bottom: 0; }
.task-list-heading > .row-secondary { margin: 0; font-size: 12px; }
.task-identity { display: flex; align-items: center; justify-content: space-between; gap: 4px 10px; }
.task-title-meta { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0 10px; min-width: 0; }
.task-title-meta .row-secondary { margin: 0; }
.task-table :deep(.task-detail-button.el-button) { flex-shrink: 0; min-height: 24px; padding: 0 4px; border-radius: 6px; }
.task-table :deep(.task-detail-button.el-button:hover) { background: var(--ui-accent-soft); }
.task-workspace .task-list :deep(.task-table td.el-table__cell) { padding-block: 6px; vertical-align: top; }
.task-table :deep(td:not(:first-child) .cell) { padding-top: 5px; }
.task-table :deep(.el-scrollbar__wrap:focus-visible) { outline: 2px solid var(--ui-accent); outline-offset: -2px; }
.task-workspace .task-summary {
  display: -webkit-box;
  margin: 0;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow-wrap: anywhere;
  font-size: 13px;
  font-weight: 550;
  line-height: 1.45;
}
.task-people { display: flex; flex-wrap: wrap; gap: 2px 12px; margin: 2px 0 0; font-size: 11px; line-height: 1.45; }
.task-people > div { display: flex; align-items: baseline; gap: 5px; min-width: 0; max-width: 100%; }
.task-people dt { flex: none; color: var(--ui-muted); }
.task-people dd { margin: 0; color: var(--ui-secondary); overflow-wrap: anywhere; }
.task-project, .task-version { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-list :is(.task-version, .task-status > .row-secondary, .task-dates > .row-secondary) { margin-top: 2px; }
.task-dates { white-space: nowrap; }
.task-status { display: flex; flex-direction: column; align-items: flex-start; }
.task-workspace .task-source { display: flex; flex-wrap: wrap; gap: 2px 12px; margin: 8px 0 0; font-size: 11px; }
.task-source-query { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ui-muted); }
.calendar-note{padding:0 20px 15px}.task-stats{display:grid;grid-template-columns:1fr 1fr;gap:20px}.stat-row{display:flex;align-items:center;gap:15px;margin:18px 0}.stat-row>span{font-size:12px;color:var(--ui-secondary);width:120px;flex-shrink:0}.stat-row .el-progress{flex:1}.stat-row strong{font:12px var(--mono);width:28px;text-align:right;color:var(--ui-secondary)}.day-issue{padding:17px 0;border-bottom:1px solid var(--ui-border);display:flex;align-items:center;gap:14px;cursor:pointer}.day-issue strong{flex:1;font-size:13px;line-height:1.8;font-weight:500}@media(max-width:1000px){.task-stats{grid-template-columns:1fr}.task-calendar{overflow:hidden}}
@container workspace-page (max-width:600px){.task-heading{margin-bottom:16px}.task-workspace .task-list .task-list-heading{align-items:flex-start;flex-direction:column;justify-content:center;gap:4px}.task-workspace .task-list .table-footer{align-items:flex-start;flex-wrap:wrap;gap:8px}}
</style>
