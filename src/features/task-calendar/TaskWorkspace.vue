<script setup lang="ts">
/** 日历、列表与统计共享同一查询结果；日期字段沿用来源，不用演示任务填空。 */
import { computed, shallowRef, watch } from 'vue';
import { useWorkspacePanelState } from '../../shared/useWorkspacePanelState';
import { useRoute, useRouter } from 'vue-router';
import type { JiraIssue, IssueResponse } from '../../../shared/hub';
import { useSource } from '../../shared/api';
import { countBy, day, isDone, safeUrl, dateTime } from '../../shared/format';
import PageHeading from '../../shared/ui/PageHeading.vue';
import QueryState from '../../shared/ui/QueryState.vue';
import MetricStrip from '../../shared/ui/MetricStrip.vue';
import StatusPill from '../../shared/ui/StatusPill.vue';
import RecordDrawer from '../../shared/ui/RecordDrawer.vue';
import TaskFilters, { type TaskFilter } from './TaskFilters.vue';
import WorkdayCalendar from './WorkdayCalendar.vue';
import TaskDelivery from '../workbench/TaskDelivery.vue';
const props = defineProps<{ mode: string }>();
const route = useRoute();
const router = useRouter();
const { filters, applied, page, calendarDate, activeDateField } = useWorkspacePanelState('tasks', () => ({
  filters: { assignee: 'currentUser()', projects: '', versions: '', keyword: '', start: '', end: '', dateField: 'updated', allTime: true, includeSubtasks: true, includeDone: false, maxResults: '5000', sortOrder: 'default' } as TaskFilter,
  applied: { allTime: 'true', includeSubtasks: 'true', includeDone: 'false', maxResults: '5000' } as Record<string, string>,
  page: 1, calendarDate: new Date(), activeDateField: 'updated',
}));
const localQuery = computed(() => typeof route.query.q === 'string' ? route.query.q.toLowerCase() : '');
const locatingIssue = computed(() => /^[a-z][a-z0-9_]*-\d+$/i.test(localQuery.value));
// 编号定位不受之前的日期、项目或未完成筛选影响；清除定位后恢复原筛选。
const queryParams = computed(() => locatingIssue.value
  ? { allTime: 'true', includeSubtasks: 'true', includeDone: 'true', maxResults: '5000' }
  : applied.value);
const query = useSource<IssueResponse>('issues', queryParams);
const { data, isPending, isFetching, error } = query;
const selected = shallowRef<JiraIssue>(), drawer = shallowRef(false);
const items = computed(() => (data.value?.issues || []).filter((item) => !localQuery.value || (locatingIssue.value ? item.key.toLowerCase() === localQuery.value : `${item.key} ${item.summary}`.toLowerCase().includes(localQuery.value))));
const visible = computed(() => items.value.slice((page.value - 1) * 20, page.value * 20));
const metrics = computed(() => [
  { label: '查询任务', value: data.value ? items.value.length : undefined, note: `服务端匹配 ${data.value?.total ?? '—'} 条` },
  { label: '未完成', value: data.value ? items.value.filter((item) => !isDone(item)).length : undefined, note: '按 Jira 状态分类', tone: 'primary' },
  { label: '已完成', value: data.value ? items.value.filter(isDone).length : undefined, note: '不按截止日期推断', tone: 'success' },
  { label: '子任务', value: data.value ? items.value.filter((item) => item.parent).length : undefined, note: '保留父子关系' },
]);
const stats = computed(() => [{ title: '按项目', rows: countBy(items.value, (item) => item.projectName) }, { title: '按状态', rows: countBy(items.value, (item) => item.status) }, { title: '按任务类型', rows: countBy(items.value, (item) => item.issueType) }, { title: '按优先级', rows: countBy(items.value, (item) => item.priority) }]);
const dated = computed(() => {
  const groups = new Map<string, JiraIssue[]>();
  for (const item of items.value) {
    const value = activeDateField.value === 'created' ? item.created : activeDateField.value === 'duedate' ? item.dueDate : activeDateField.value === 'resolutiondate' ? item.resolutionDate : item.updated;
    if (value) { const key = day(value); groups.set(key, [...(groups.get(key) || []), item]); }
  }
  return groups;
});
const dailyDrawer = shallowRef(false), selectedDay = shallowRef('');
const dailyItems = computed(() => dated.value.get(selectedDay.value) || []);
function inspect(issue: JiraIssue) { selected.value = issue; drawer.value = true; void router.replace({ query: { ...route.query, task: issue.key } }); }
function inspectDay(value: string) { selectedDay.value = value; dailyDrawer.value = true; }
async function clearLocation() { const { q: _q, task: _task, ...query } = route.query; await router.replace({ query }); drawer.value = false; }
function search() { applied.value = Object.fromEntries(Object.entries(filters.value).map(([key, value]) => [key, String(value ?? '')])); activeDateField.value = filters.value.dateField; page.value = 1; }
watch([() => props.mode, localQuery], () => { page.value = 1; });
watch(() => items.value.length, length => { page.value = Math.min(page.value, Math.max(1, Math.ceil(length / 20))); });
watch([() => route.query.task, () => data.value], () => {
  const issue = data.value?.issues.find(item => item.key === route.query.task);
  if (issue) { selected.value = issue; drawer.value = true; }
}, { immediate: true });
watch(drawer, open => { if (!open && route.query.task) { const { task: _task, ...query } = route.query; void router.replace({ query }); } });
</script>
<template>
  <PageHeading :title="mode === 'calendar' ? '任务日历' : mode === 'stats' ? '任务统计' : '任务列表'" description="读取原 Jira 查询接口，保留人员、项目、版本、时间和父子任务关系。" :loading="isFetching" @refresh="query.refetch()" />
  <div v-if="locatingIssue" class="inline-links"><span>定位 {{ route.query.q }} · 包含已完成任务</span><el-button link type="primary" @click="clearLocation">返回原筛选</el-button></div>
  <div v-else class="surface"><TaskFilters v-model="filters" :loading="isFetching" @search="search" /></div>
  <el-alert v-if="data?.source === 'mock'" class="section-alert" type="warning" title="原接口当前返回模拟来源，不是 Jira 实时任务。" :closable="false" show-icon />
  <MetricStrip :items="metrics" />
  <QueryState :loading="isPending" :error="error" :has-data="!!data" @retry="query.refetch()">
    <div v-if="mode === 'list'" class="surface"><div class="surface-header"><h2>任务明细</h2><span class="row-secondary">{{ localQuery ? `定位 ${route.query.q}` : '点击详情查看完整描述与父子关系' }}</span></div><el-table :data="visible"><el-table-column label="Jira 任务" min-width="330"><template #default="{ row }"><a :href="safeUrl(row.url)" target="_blank" class="hub-link">{{ row.key }}</a><strong class="row-title">{{ row.summary }}</strong><span v-if="row.parent" class="row-secondary">父任务 {{ row.parent.key }}</span></template></el-table-column><el-table-column label="状态 / 优先级" width="130"><template #default="{ row }"><StatusPill :value="row.status" /><span class="row-secondary">{{ row.priority }} · {{ row.issueType }}</span></template></el-table-column><el-table-column label="项目 / 版本" min-width="150"><template #default="{ row }">{{ row.projectName }}<span class="row-secondary">{{ row.fixVersions?.join('、') || '未设置版本' }}</span></template></el-table-column><el-table-column label="计划日期" width="130"><template #default="{ row }"><span class="row-mono">{{ day(row.startDate) }}</span><span class="row-secondary">至 {{ day(row.endDate || row.dueDate) }}</span></template></el-table-column><el-table-column label="操作" width="75" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="inspect(row)">详情</el-button></template></el-table-column></el-table><div class="table-footer"><span>本页 {{ visible.length }} 条 / 共 {{ items.length }} 条</span><el-pagination v-model:current-page="page" :total="items.length" :page-size="20" layout="prev, pager, next" /></div></div>
    <div v-else-if="mode === 'calendar'" class="surface task-calendar"><WorkdayCalendar v-model="calendarDate" :items-by-day="dated" @inspect="inspect" @select-day="inspectDay" /><p class="source-footnote calendar-note">当前按{{ activeDateField === 'updated' ? '更新时间' : activeDateField === 'created' ? '创建时间' : activeDateField === 'duedate' ? '截止日期' : '解决时间' }}归入日历；周六、周日按休息日展示，没有对应日期的任务仍保留在任务列表中。</p></div>
    <div v-else class="task-stats"><section v-for="group in stats" :key="group.title" class="surface"><div class="surface-header"><h2>{{ group.title }}</h2></div><div class="surface-body"><div v-for="row in group.rows" :key="row.label" class="stat-row"><span>{{ row.label }}</span><el-progress :percentage="Math.round(row.value / Math.max(items.length, 1) * 100)" :show-text="false" :stroke-width="7" /><strong>{{ row.value }}</strong></div></div></section></div>
    <p class="source-footnote">来源 {{ data?.source }} · {{ data?.jql }} · 页面读取于 {{ dateTime(query.dataUpdatedAt.value) }}</p>
  </QueryState>
  <RecordDrawer v-model="drawer" :title="selected?.summary || '任务详情'" :subtitle="selected?.key" :record="selected"><template v-if="selected"><div class="inline-links"><a :href="safeUrl(selected.url)" target="_blank">打开 {{ selected.key }}</a></div><dl class="detail-facts"><div><dt>状态</dt><dd><StatusPill :value="selected.status" /></dd></div><div><dt>人员 / 项目</dt><dd>{{ selected.assignee }} · {{ selected.projectName }}</dd></div><div><dt>计划时间</dt><dd>{{ day(selected.startDate) }} → {{ day(selected.endDate || selected.dueDate) }}</dd></div><div><dt>版本</dt><dd>{{ selected.fixVersions?.join('、') || '未设置' }}</dd></div></dl><TaskDelivery v-if="drawer" :issue-key="selected.key" /><section class="detail-section"><h3>完整任务描述</h3><pre class="detail-text">{{ selected.description || '来源没有提供描述。' }}</pre></section><section class="detail-section"><h3>父子任务关系</h3><p v-if="selected.parent">父任务：{{ selected.parent.key }} {{ selected.parent.summary }}</p><el-table :data="selected.subtasks || []"><el-table-column prop="key" label="子任务" width="120" /><el-table-column prop="summary" label="摘要" min-width="220" /><el-table-column label="状态" width="120"><template #default="{ row }"><StatusPill :value="row.status" /></template></el-table-column></el-table></section></template></RecordDrawer>
  <el-drawer v-model="dailyDrawer" :title="`${selectedDay} · ${dailyItems.length} 项任务`" size="min(620px, 94vw)"><div v-for="item in dailyItems" :key="item.key" class="day-issue" @click="inspect(item)"><strong>{{ item.key }} · {{ item.summary }}</strong><StatusPill :value="item.status" /></div><el-empty v-if="!dailyItems.length" description="该日期没有匹配任务" /></el-drawer>
</template>
<style scoped>
.calendar-note{padding:0 20px 15px}.task-stats{display:grid;grid-template-columns:1fr 1fr;gap:20px}.stat-row{display:flex;align-items:center;gap:15px;margin:18px 0}.stat-row>span{font-size:12px;color:var(--ui-secondary);width:120px;flex-shrink:0}.stat-row .el-progress{flex:1}.stat-row strong{font:12px var(--mono);width:28px;text-align:right;color:var(--ui-secondary)}.day-issue{padding:17px 0;border-bottom:1px solid var(--ui-border);display:flex;align-items:center;gap:14px;cursor:pointer}.day-issue strong{flex:1;font-size:13px;line-height:1.8;font-weight:500}@media(max-width:1000px){.task-stats{grid-template-columns:1fr}.task-calendar{overflow:hidden}}
</style>
