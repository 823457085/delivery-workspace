<script setup lang="ts">
/** 统一工作台复用同一读模型；嵌入 Agent 时由顶部导航提供入口，独立页面保留快捷入口。 */
import { computed, inject, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { CalendarDays, Terminal, FileCheck2, ArrowUpRight, Bot } from '@lucide/vue';
import { agentWorkspaceContext } from '../../shared/agent-workspace-context';
import { useWorkspacePanelState } from '../../shared/useWorkspacePanelState';
import { dateTime, day, safeUrl } from '../../shared/format';
import PageHeading from '../../shared/ui/PageHeading.vue';
import MetricStrip from '../../shared/ui/MetricStrip.vue';
import StatusPill from '../../shared/ui/StatusPill.vue';
import DeliveryRecords from './DeliveryRecords.vue';
import RefactorIntegrationPlan from './RefactorIntegrationPlan.vue';
import { useWorkbench } from './useWorkbench';
import { forIssue, hasDeliveryResult, issueKey, localDay, plannedToday, recordMatchesFilter, threadUrl, type DeliveryRecord, type DeliveryRecordFilter } from './domain';

const route = useRoute(), router = useRouter();
const workspace = inject(agentWorkspaceContext, undefined);
const { records, errors, loading, fetching, incomplete, refresh, runtime, issues, automation } = useWorkbench();
const { search, filter, page } = useWorkspacePanelState('today', () => ({ search: '', filter: 'actionable' as DeliveryRecordFilter, page: 1 }));
const focusedRecord = shallowRef<DeliveryRecord>();
const selectedKey = computed(() => typeof route.query.issue === 'string' ? issueKey(route.query.issue) : '');
const selectedIssue = computed(() => issues.data.value?.issues.find(issue => issue.key === selectedKey.value));
const jiraUrl = computed(() => safeUrl(selectedIssue.value?.url || (selectedKey.value && issues.data.value?.baseUrl ? `${issues.data.value.baseUrl.replace(/\/$/, '')}/browse/${selectedKey.value}` : '')));
const selectedRecords = computed(() => selectedKey.value ? forIssue(records.value, selectedKey.value) : focusedRecord.value ? records.value.filter(record => record.id === focusedRecord.value?.id) : []);
const drawer = computed({ get: () => !!selectedKey.value || !!focusedRecord.value, set: (open: boolean) => { if (!open) { focusedRecord.value = undefined; const { issue: _, ...query } = route.query; void router.replace({ query }); } } });
const title = computed(() => selectedIssue.value?.summary || selectedRecords.value[0]?.title || selectedKey.value);
const today = computed(() => localDay(new Date(issues.dataUpdatedAt.value || Date.now())));
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
const count = (filter: DeliveryRecordFilter) => records.value.filter(record => recordMatchesFilter(record, filter)).length;
const metrics = computed(() => [
  { label: '今日计划任务', value: issues.data.value && !issues.error.value ? todayIssues.value.length : undefined, note: '未完成且计划日期覆盖今天', tone: 'primary' },
  { label: 'Agent 执行中', value: runtime.data.value && !runtime.error.value ? runtime.data.value.runs.filter(run => run.status === 'running').length : undefined, note: '本机 Agent 当前运行快照' },
  { label: '等待审核', value: incomplete.value ? undefined : count('review'), note: '交付记录数', tone: 'warning' },
  { label: '阻塞 / 失败', value: incomplete.value ? undefined : count('blocked'), note: '交付记录数', tone: 'warning' },
]);
const tabDefinitions: { id: DeliveryRecordFilter; label: string }[] = [
  { id: 'actionable', label: '待处理' },
  { id: 'running', label: '执行中' },
  { id: 'review', label: '待审核' },
  { id: 'blocked', label: '阻塞' },
  { id: 'results', label: '已有结果' },
  { id: 'all', label: '全部记录' },
];
watch(() => route.query.filter, value => {
  const explicit = tabDefinitions.find(tab => tab.id === value);
  if (explicit) filter.value = explicit.id;
}, { immediate: true });
const tabs = computed(() => tabDefinitions.map(tab => ({
  ...tab,
  count: records.value.filter(record => recordMatchesFilter(record, tab.id)).length,
})));
const filtered = computed(() => {
  const term = search.value.trim().toLowerCase();
  return records.value.filter(record => recordMatchesFilter(record, filter.value) &&
    (!term || [record.title, ...record.issueKeys, record.workspacePath, record.branch, record.threadId].join(' ').toLowerCase().includes(term)));
});
const visible = computed(() => filtered.value.slice((page.value - 1) * 12, page.value * 12));
watch([search, filter], () => { page.value = 1; });
watch(filter, value => { if (workspace) void router.replace({ query: { ...route.query, filter: value } }); });
watch(() => filtered.value.length, length => { page.value = Math.min(page.value, Math.max(1, Math.ceil(length / 12))); });
function inspect(record: DeliveryRecord) { if (record.issueKeys[0]) openIssue(record.issueKeys[0]); else focusedRecord.value = record; }
function openIssue(key: string) { focusedRecord.value = undefined; void router.replace({ query: { ...route.query, issue: key } }); }
const shortcuts = [{ path: '/agent', title: 'Agent 工作台', detail: '会话与执行过程', icon: Bot }, { path: '/tasks/calendar', title: '任务日历', detail: '排期与需求', icon: CalendarDays }, { path: '/design', title: '需求开发', detail: '需求、方案与功能开发', icon: FileCheck2 }, { path: '/delivery/queue', title: '交付队列', detail: '执行与原始记录', icon: Terminal }];
</script>
<template>
  <PageHeading title="我的工作台" description="统一查看今日任务、原会话、执行结果和交付证据。" :loading="fetching || issues.isFetching.value" @refresh="refresh"><RouterLink v-if="!workspace" to="/agent"><el-button type="primary">打开 Agent 工作台 <ArrowUpRight :size="14" /></el-button></RouterLink></PageHeading>
  <el-alert v-for="error in errors" :key="error" :title="error" type="error" :closable="false" class="section-alert" />
  <el-alert v-if="issues.error.value" :title="`Jira 任务：${issues.error.value.message}`" type="error" :closable="false" class="section-alert" />
  <el-alert v-if="issues.data.value?.source === 'mock'" title="当前任务来源为模拟数据，不是实时 Jira 排期" type="warning" :closable="false" class="section-alert" />
  <MetricStrip :items="metrics" />
  <section v-if="jiraSyncStatus" class="surface jira-sync-status"><div><span>Jira 自动状态同步 · 每日 {{ jiraSyncStatus.schedule }}</span><strong>开始日期到达更新为“开发中”，结束日期到达且完成证据齐全更新为“已完成”</strong><p>只处理分配给当前用户的 Jira，不创建 Agent 会话、不创建子任务、不创建合并请求。上次 {{ jiraSyncStatus.lastRunAt }}，更新 {{ jiraSyncStatus.updatedCount }} 项，阻塞 {{ jiraSyncStatus.blockedCount }} 项；下次 {{ jiraSyncStatus.nextRunAt }}。</p></div><RouterLink to="/settings" class="hub-link">Jira 同步设置</RouterLink></section>
  <RefactorIntegrationPlan />
  <div class="workbench-top" :class="{ embedded: workspace }">
    <section class="surface"><div class="surface-header"><div><h2>今天要做</h2><p>{{ today }} · 以 Jira 计划日期为准</p></div><RouterLink to="/tasks/list" class="hub-link">全部任务</RouterLink></div>
      <el-skeleton v-if="issues.isPending.value" class="surface-body" :rows="3" animated />
      <div v-else-if="todayIssues.length" class="today-list"><button v-for="issue in todayIssues.slice(0, 5)" :key="issue.key" @click="openIssue(issue.key)"><div><small>{{ issue.key }}</small><strong>{{ issue.summary }}</strong></div><StatusPill :value="issue.status" /></button><p v-if="todayIssues.length > 5" class="source-footnote">共 {{ todayIssues.length }} 项，完整排期见任务日历</p></div>
      <el-empty v-else :description="issues.error.value ? '任务来源读取失败' : '今天没有已排期的未完成任务'" :image-size="45" />
    </section>
    <section v-if="!workspace" class="surface"><div class="surface-header"><h2>工作入口</h2></div><div class="workbench-shortcuts"><RouterLink v-for="item in shortcuts" :key="item.path" :to="item.path"><component :is="item.icon" :size="20" /><div><strong>{{ item.title }}</strong><small>{{ item.detail }}</small></div><ArrowUpRight :size="15" /></RouterLink></div></section>
  </div>
  <section class="surface">
    <div class="surface-header records-header"><div><h2>任务、会话与交付结果</h2><p>保留每次执行记录，按最近更新排序{{ incomplete ? ' · 部分来源尚未就绪' : '' }}</p></div><el-input v-model="search" placeholder="搜索任务、项目、分支或会话" clearable aria-label="搜索交付记录" /></div>
    <div class="record-filters" role="tablist" aria-label="交付记录筛选"><button v-for="tab in tabs" :key="tab.id" role="tab" :aria-selected="filter === tab.id" :class="{ active: filter === tab.id }" @click="filter = tab.id">{{ tab.label }} <span>{{ tab.count }}</span></button></div>
    <el-table v-loading="loading && !records.length" :data="visible" :empty-text="errors.length ? '来源读取失败或没有匹配记录' : '没有匹配的交付记录'">
      <el-table-column label="任务" min-width="265"><template #default="{ row }"><button class="record-title" @click="inspect(row)">{{ row.title || row.issueKeys[0] || '交付记录' }}</button><span class="row-secondary">{{ row.issueKeys.join(' · ') || '未关联 Jira' }} · {{ row.source }}</span></template></el-table-column>
      <el-table-column label="当前 Jira / Agent" min-width="170"><template #default="{ row }"><span v-for="issue in row.jiraStatuses" :key="issue.key" class="row-secondary">{{ issue.key }} · {{ issue.status }}</span><StatusPill v-if="row.agentStatus" :value="row.agentStatus" /><span v-else class="row-secondary">未检测到关联 Agent 运行</span></template></el-table-column>
      <el-table-column label="历史执行状态" width="120"><template #default="{ row }"><StatusPill :value="row.status" /></template></el-table-column>
      <el-table-column label="分支 / 工作区" min-width="185"><template #default="{ row }"><span class="record-branch">{{ row.branch || '未记录分支' }}</span><span class="row-secondary record-path" :title="row.workspacePath">{{ row.workspacePath || '未记录工作区' }}</span></template></el-table-column>
      <el-table-column label="更新" width="120"><template #default="{ row }"><span class="row-mono">{{ dateTime(row.updatedAt) }}</span></template></el-table-column>
      <el-table-column label="会话 / 结果" width="135" fixed="right"><template #default="{ row }"><a v-if="threadUrl(row.threadId)" :href="threadUrl(row.threadId)" class="hub-link">打开原会话</a><span v-else class="row-secondary">{{ row.clientThreadId ? '会话创建中' : '未关联会话' }}</span><el-button v-if="hasDeliveryResult(row)" link type="primary" @click="inspect(row)">查看交付结果</el-button><RouterLink v-else :to="row.detailPath" class="hub-link record-source-link">进入来源页面</RouterLink></template></el-table-column>
    </el-table>
    <div class="table-footer"><span>{{ filtered.length }} 条交付记录</span><el-pagination v-model:current-page="page" :total="filtered.length" :page-size="12" layout="prev, pager, next" /></div>
  </section>
  <el-drawer v-model="drawer" :title="title" size="min(920px, 94vw)" class="hub-drawer" destroy-on-close>
    <div v-if="selectedKey" class="inline-links"><strong>{{ selectedKey }}</strong><RouterLink v-if="selectedIssue" :to="`/tasks/list?q=${encodeURIComponent(selectedKey)}`" class="hub-link">在任务列表查看</RouterLink><a v-if="jiraUrl" :href="jiraUrl" target="_blank" rel="noreferrer">打开 Jira</a></div>
    <dl v-if="selectedIssue" class="detail-facts"><div><dt>Jira 状态</dt><dd><StatusPill :value="selectedIssue.status" /></dd></div><div><dt>计划日期</dt><dd>{{ day(selectedIssue.startDate) }} → {{ day(selectedIssue.endDate || selectedIssue.dueDate) }}</dd></div></dl>
    <DeliveryRecords :records="selectedRecords" :errors="errors" :loading="loading" />
    <template #footer><el-button @click="drawer = false">关闭</el-button></template>
  </el-drawer>
</template>
<style scoped>
.workbench-top.embedded{grid-template-columns:minmax(0,1fr)}
.jira-sync-status{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:16px 20px}.jira-sync-status>div{min-width:0}.jira-sync-status span{display:block;font-size:11px;color:var(--ui-muted)}.jira-sync-status strong{display:block;margin-top:5px;font-size:13px;font-weight:550}.jira-sync-status p{margin:5px 0 0;font-size:12px;color:var(--ui-secondary)}.jira-sync-status>.hub-link{white-space:nowrap}.workbench-top{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(260px,1fr);gap:20px}.today-list>button{display:flex;align-items:center;gap:16px;width:100%;text-align:left;padding:15px 20px;border:0;border-bottom:1px solid var(--ui-border);background:transparent;color:var(--ui-text);cursor:pointer}.today-list>button:hover{background:var(--ui-accent-soft)}.today-list>button>div:first-child{flex:1;min-width:0}.today-list strong{display:block;font-size:13px;font-weight:500;line-height:1.7}.today-list small{font:11px var(--mono);color:var(--ui-muted)}.workbench-shortcuts>a{display:flex;align-items:center;gap:14px;padding:17px 20px;border-bottom:1px solid var(--ui-border)}.workbench-shortcuts>a:last-child{border:0}.workbench-shortcuts>a:hover{background:var(--ui-accent-soft)}.workbench-shortcuts svg{color:var(--ui-accent)}.workbench-shortcuts div{flex:1}.workbench-shortcuts strong{font-size:13px;font-weight:500}.workbench-shortcuts small{display:block;font-size:11px;color:var(--ui-muted);margin-top:5px}.records-header .el-input{max-width:300px}.record-filters{display:flex;gap:8px;padding:0 20px 15px;flex-wrap:wrap}.record-filters button{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12px;padding:7px 11px;border:1px solid var(--ui-border);border-radius:6px;background:transparent;color:var(--ui-muted);cursor:pointer}.record-filters button span{min-width:18px;padding:0 5px;border-radius:9px;background:var(--ui-surface);font:10px/18px var(--mono);text-align:center}.record-filters button.active{color:var(--ui-accent);border-color:var(--ui-accent);background:var(--ui-accent-soft)}.record-filters button.active span{background:var(--ui-surface);color:var(--ui-accent)}.record-title{display:block;border:0;padding:0;text-align:left;font:inherit;font-weight:500;color:var(--ui-text);background:transparent;cursor:pointer;line-height:1.7}.record-title:hover{color:var(--ui-accent)}.record-branch{font-size:11px;overflow-wrap:anywhere}.record-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px}.el-table .el-button,.record-source-link{display:block;margin:7px 0 0}
@media(max-width:1000px){.workbench-top{grid-template-columns:1fr}.workbench-shortcuts{display:flex}.workbench-shortcuts>a{flex:1;border-bottom:0}}@media(max-width:600px){.jira-sync-status{align-items:flex-start;flex-direction:column}.records-header{align-items:stretch;flex-direction:column;gap:15px}.records-header .el-input{max-width:none}.workbench-shortcuts{display:block}.workbench-shortcuts>a{border-bottom:1px solid var(--ui-border)}}
</style>
