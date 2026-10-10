<script setup lang="ts">
/** 计划、真实 Codex 队列及巡检历史共享原 automation 快照，不混入实验室运行。 */
import { computed, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useWorkspacePanelState } from '../../shared/useWorkspacePanelState';
import { useAgentRuntimeSnapshot } from '../../shared/useAgentRuntimeSnapshot';
import { executionEntries, executionScope, type ExecutionScope } from './execution-entries';
import type { AutomationData, PlanItem, Job, ScanRun } from '../../../shared/hub';
import { useSource, useSourceActions, sourceUrl } from '../../shared/api';
import { isDone, safeUrl, searchMatches, dateTime } from '../../shared/format';
import PageHeading from '../../shared/ui/PageHeading.vue';
import MetricStrip from '../../shared/ui/MetricStrip.vue';
import QueryState from '../../shared/ui/QueryState.vue';
import RecordDrawer from '../../shared/ui/RecordDrawer.vue';
import StatusPill from '../../shared/ui/StatusPill.vue';
import WorkspaceContextLinks from '../../shared/ui/WorkspaceContextLinks.vue';
import PlanTable from './PlanTable.vue';
import ExecutionTable from './ExecutionTable.vue';
import RunTable from './RunTable.vue';
const props = defineProps<{ mode: string }>();
const route = useRoute();
const router = useRouter();
const query = useSource<AutomationData>('automation');
const runtime = useAgentRuntimeSnapshot();
const { data, isPending, isFetching, error } = query;
const actions = useSourceActions();
const { search, filter, page, scope } = useWorkspacePanelState(`execution:${props.mode}`, () => ({ search: '', filter: 'all', page: 1, scope: 'active' as ExecutionScope }));
const drawer = shallowRef(false);
const selectedPlanId = shallowRef(''), selectedJobId = shallowRef(''), selectedRunId = shallowRef('');
const selectedPlan = computed(() => data.value?.plan.find((item) => item.issue.key === selectedPlanId.value));
const selectedJob = computed(() => data.value?.jobs.find((item) => item.id === selectedJobId.value));
const selectedRun = computed(() => data.value?.runs.find((item) => item.id === selectedRunId.value));
const title = computed(() => props.mode === 'plan' ? '执行计划' : props.mode === 'queue' ? '当前执行' : '巡检记录');
const plans = computed(() => (data.value?.plan || []).filter((item) => searchMatches([item.issue.key, item.issue.summary, item.action, item.workspace?.path], search.value) && (filter.value === 'all' || filter.value === 'open' && !isDone(item.issue) || filter.value === 'actionable' && item.dispatchable || filter.value === 'blocked' && (item.dependencyKeys?.length > 0 || ['waiting','blocked'].includes(item.jobStatus)))));
const entries = computed(() => executionEntries(runtime.data.value?.runs || [], data.value?.jobs || []));
const scopes: { id: ExecutionScope; label: string }[] = [{ id: 'active', label: '执行 / 排队' }, { id: 'attention', label: '需关注' }, { id: 'history', label: '历史记录' }, { id: 'all', label: '全部' }];
const jobs = computed(() => entries.value.filter(item => (scope.value === 'all' || executionScope(item.status) === scope.value)
  && searchMatches([item.title, item.job?.issueKey, item.workspacePath, item.branch, item.summary], search.value)
  && (filter.value === 'all' || item.status === filter.value)));
const runs = computed(() => (data.value?.runs || []).filter((item) => searchMatches(item, search.value)));
const total = computed(() => props.mode === 'plan' ? plans.value.length : props.mode === 'queue' ? jobs.value.length : runs.value.length);
const metrics = computed(() => props.mode === 'queue' ? scopes.filter(item => item.id !== 'all').map(item => ({
  label: item.label, value: runtime.error.value || error.value ? undefined : entries.value.filter(entry => executionScope(entry.status) === item.id).length,
  note: '按执行记录分组，不代表 Jira 任务状态',
})) : [
  { label: '原系统计划', value: data.value?.plan.length, note: `最近来源 ${data.value?.lastRun?.source || '未记录'}` },
  { label: 'Codex 队列记录', value: data.value?.jobs.length, note: '包含已完成与阻塞历史' },
  { label: '运行 / 派发中', value: data.value?.jobs.filter((item) => ['running','dispatched','dispatching'].includes(item.status)).length, note: '以原任务状态为准', tone: 'primary' },
  { label: '巡检历史', value: data.value?.runs.length, note: `下次 ${dateTime(data.value?.nextRun)}` },
]);
const statusOptions = computed(() => [...new Set(entries.value.filter(item => scope.value === 'all' || executionScope(item.status) === scope.value).map(item => item.status))]);
watch(scope, () => { filter.value = 'all'; page.value = 1; });
watch(total, count => { page.value = Math.min(page.value, Math.max(1, Math.ceil(count / 20))); });
function refresh() { return Promise.all([query.refetch(), ...(props.mode === 'queue' ? [runtime.refetch()] : [])]); }
function detailLocation(kind: 'plan' | 'job' | 'run', id: string) {
  if (route.query[kind] === id) return;
  const { plan: _plan, job: _job, run: _run, ...query } = route.query;
  void router.replace({ query: { ...query, [kind]: id } });
}
function inspectPlan(value: PlanItem) { selectedPlanId.value = value.issue.key; selectedJobId.value = ''; selectedRunId.value = ''; drawer.value = true; detailLocation('plan', value.issue.key); }
function inspectJob(value: Job) { selectedJobId.value = value.id; selectedPlanId.value = ''; selectedRunId.value = ''; drawer.value = true; detailLocation('job', value.id); }
function inspectRun(value: ScanRun) { selectedRunId.value = value.id; selectedPlanId.value = ''; selectedJobId.value = ''; drawer.value = true; detailLocation('run', value.id); }
const selected = computed(() => selectedPlan.value || selectedJob.value || selectedRun.value);
const detailTitle = computed(() => selectedPlan.value?.issue.summary || selectedJob.value?.title || `巡检记录 ${selectedRun.value?.localDate || ''}`);
watch(() => props.mode, () => { filter.value = 'all'; search.value = ''; page.value = 1; drawer.value = false; });
watch([() => route.query.plan, () => route.query.job, () => route.query.run, () => data.value], () => {
  const plan = data.value?.plan.find(item => item.issue.key === route.query.plan);
  const job = data.value?.jobs.find(item => item.id === route.query.job);
  const run = data.value?.runs.find(item => item.id === route.query.run);
  if (plan) inspectPlan(plan);
  else if (job) inspectJob(job);
  else if (run) inspectRun(run);
}, { immediate: true });
watch(drawer, open => {
  if (open) return;
  const { plan: _plan, job: _job, run: _run, ...query } = route.query;
  void router.replace({ query });
});
</script>
<template>
  <PageHeading :title="title" description="查看当前执行、计划与巡检历史。" :loading="isFetching || (mode === 'queue' && runtime.isFetching.value)" @refresh="refresh"><el-button v-if="mode === 'plan'" type="primary" @click="actions.execute('scan', {}, '确认立即巡检', '原系统巡检可能按已有设置创建 Codex 任务、推进 Jira 或创建 MR；这不是单纯刷新列表。确认现在执行原巡检吗？')">立即巡检</el-button></PageHeading>
  <MetricStrip :items="metrics" />
  <el-alert v-if="mode === 'plan' && data?.lastRun?.source === 'mock'" class="section-alert" title="原执行计划最近一次巡检使用 mock 数据，以下为原系统保存的计划，不是当前实时 Jira 任务。" description="真实 Jira 内容已单独接入“任务日历”；本面板不会自行触发巡检来覆盖这些计划。" type="warning" :closable="false" show-icon />
  <QueryState :loading="isPending || (mode === 'queue' && runtime.isPending.value)" :error="error || (mode === 'queue' ? runtime.error.value : null)" :has-data="!!data || (mode === 'queue' && !!runtime.data.value)" @retry="refresh"><div class="surface"><div v-if="mode === 'queue'" class="filter-bar"><el-radio-group v-model="scope" aria-label="执行记录范围"><el-radio-button v-for="item in scopes" :key="item.id" :value="item.id">{{ item.label }}</el-radio-button></el-radio-group></div><div class="filter-bar"><el-input v-model="search" placeholder="搜索任务、工作区或结果" clearable @input="page = 1" /><el-select v-if="mode === 'plan'" v-model="filter" aria-label="任务范围" @change="page = 1"><el-option label="全部任务" value="all" /><el-option label="未完成" value="open" /><el-option label="可执行" value="actionable" /><el-option label="等待 / 阻塞" value="blocked" /></el-select><el-select v-if="mode === 'queue'" v-model="filter" aria-label="队列状态" @change="page = 1"><el-option label="全部状态" value="all" /><el-option v-for="value in statusOptions" :key="value" :value="value" :label="value" /></el-select><span class="filter-count">共 {{ total }} 条记录</span></div><PlanTable v-if="mode === 'plan'" :items="plans.slice((page - 1) * 20, page * 20)" @inspect="inspectPlan" /><ExecutionTable v-else-if="mode === 'queue'" :items="jobs.slice((page - 1) * 20, page * 20)" @inspect="inspectJob" /><RunTable v-else :items="runs.slice((page - 1) * 20, page * 20)" @inspect="inspectRun" /><div class="table-footer"><span>{{ mode === 'queue' ? 'Agent 当前轮次与自动化任务，按会话关联去重' : mode === 'runs' ? '巡检历史，不是 Agent 对话轮次' : '计划快照；当前 Jira 状态请查看任务' }}</span><el-pagination v-model:current-page="page" :total="total" :page-size="20" layout="prev, pager, next" /></div></div></QueryState>
  <RecordDrawer v-model="drawer" :title="detailTitle" :record="selected">
    <WorkspaceContextLinks v-if="selectedPlan || selectedJob" :issue-key="selectedPlan?.issue.key || selectedJob?.issueKey" :workspace-path="selectedPlan?.workspace?.path || selectedJob?.workspacePath" :thread-id="selectedJob?.threadId" :prompt="`@Jira:${selectedPlan?.issue.key || selectedJob?.issueKey} 请核对当前任务、执行结果和下一步，先只读分析。`" />
    <template v-if="selectedPlan"><div class="inline-links"><a :href="safeUrl(selectedPlan.issue.url)" target="_blank">打开 {{ selectedPlan.issue.key }}</a></div><dl class="detail-facts"><div><dt>分类 / 模型</dt><dd>{{ selectedPlan.categoryLabel }} · {{ selectedPlan.model }}</dd></div><div><dt>下一步</dt><dd>{{ selectedPlan.action }}</dd></div><div><dt>工作区</dt><dd>{{ selectedPlan.workspace?.path || '未匹配' }}</dd></div><div><dt>依赖</dt><dd>{{ selectedPlan.dependencyKeys?.join('、') || '无记录' }}</dd></div></dl><section class="detail-section"><h3>任务描述</h3><pre class="detail-text">{{ selectedPlan.issue.description || '来源没有描述' }}</pre></section></template>
    <template v-else-if="selectedJob"><StatusPill :value="selectedJob.status" /><dl class="detail-facts"><div><dt>工作区 / 分支</dt><dd>{{ selectedJob.workspacePath }}<br>{{ selectedJob.branch }}</dd></div><div><dt>真实任务 ID</dt><dd>{{ selectedJob.threadId || selectedJob.clientThreadId || '未创建' }}</dd></div><div><dt>模型 / 尝试次数</dt><dd>{{ selectedJob.model }} · {{ selectedJob.attempts }} 次</dd></div><div><dt>更新时间</dt><dd>{{ dateTime(selectedJob.updatedAt) }}</dd></div></dl><div class="inline-links"><a :href="safeUrl(selectedJob.issueUrl)" target="_blank">Jira 事项</a><a v-if="safeUrl(selectedJob.mrUrl)" :href="safeUrl(selectedJob.mrUrl)" target="_blank">合并请求</a><a v-if="safeUrl(selectedJob.artifactUrl)" :href="safeUrl(selectedJob.artifactUrl)" target="_blank">方案文档</a><a v-if="selectedJob.i18nXlsxPath" :href="sourceUrl('artifact', { id: selectedJob.id, type: 'i18n' })" target="_blank">多语言 Excel</a><a v-if="selectedJob.selfTestReportPath" :href="sourceUrl('artifact', { id: selectedJob.id, type: 'report' })" target="_blank">自测报告</a><a v-for="(_, index) in selectedJob.selfTestScreenshots" :key="index" :href="sourceUrl('artifact', { id: selectedJob.id, type: 'screenshot', index: String(index) })" target="_blank">自测截图 {{ index + 1 }}</a></div><section class="detail-section"><h3>结果与阻塞</h3><el-alert v-if="selectedJob.error" :title="selectedJob.error" type="error" :closable="false" /><pre class="detail-text">{{ selectedJob.result || '等待回传结果' }}</pre></section><section class="detail-section"><h3>完整会话输入</h3><pre class="detail-text">{{ selectedJob.prompt || '未记录输入' }}</pre></section><div class="inline-links"><el-button v-if="['blocked','cancelled'].includes(selectedJob.status)" type="primary" @click="actions.execute('job-update', { id: selectedJob.id, status: 'pending' }, '确认重新排队', '这会将原 Codex 任务重新排队，现有调度器可能开始执行。')">重新排队</el-button><el-button v-if="['waiting','pending','dispatching','dispatched','running'].includes(selectedJob.status)" type="danger" plain @click="actions.execute('job-update', { id: selectedJob.id, status: 'cancelled' }, '确认停止队列任务', '这会更新原队列任务状态；不保证已运行的工具或会话被强制终止。')">停止队列任务</el-button></div></template>
    <template v-else-if="selectedRun"><dl class="detail-facts"><div><dt>触发 / 来源</dt><dd>{{ selectedRun.trigger }} / {{ selectedRun.source }}</dd></div><div><dt>运行时间</dt><dd>{{ dateTime(selectedRun.startedAt) }} → {{ dateTime(selectedRun.completedAt) }}</dd></div><div><dt>读取 Jira / 工作区</dt><dd>{{ selectedRun.issueCount }} / {{ selectedRun.workspaceCount }}</dd></div><div><dt>新增任务</dt><dd>{{ selectedRun.enqueuedCount }}</dd></div></dl><section class="detail-section"><h3>Jira 状态推进明细</h3><el-table :data="selectedRun.transitionResults || []"><el-table-column prop="issueKey" label="Jira" width="115" /><el-table-column prop="reason" label="原因" min-width="170" /><el-table-column prop="message" label="响应" min-width="220" /></el-table></section></template>
  </RecordDrawer>
</template>
