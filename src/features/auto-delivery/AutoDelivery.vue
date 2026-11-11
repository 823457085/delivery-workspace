<script setup lang="ts">
import { useIntegrationPlugins } from '../../plugins/runtime';
const integrations = useIntegrationPlugins();
import AgentMarkdown from '../agent-workbench/AgentMarkdown.vue';
import JiraDescription from '../jira-issue/JiraDescription.vue';
/** 执行中心复用已有运行与巡检快照；切换视图和刷新都不触发派发。 */
import { computed, shallowRef, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { useRoute, useRouter } from 'vue-router';
import { useWorkspacePanelState } from '../../shared/useWorkspacePanelState';
import { useAgentRuntimeSnapshot } from '../../shared/useAgentRuntimeSnapshot';
import { executionEntries, executionScope, type ExecutionScope } from './execution-entries';
import { readGroupDashboard } from '../agent-workbench/group-chat-api';
import { readTeamTasks } from '../agent-workbench/team-api';
import { planItems, projectRoutingLabel, type PlanFilter } from './plan-list';
import type { AutomationData, PlanItem, Job, ScanRun } from '../../../shared/hub';
import { useSource, useSourceActions, sourceUrl } from '../../shared/api';
import { safeUrl, searchMatches, dateTime } from '../../shared/format';
import PageHeading from '../../shared/ui/PageHeading.vue';
import MetricStrip from '../../shared/ui/MetricStrip.vue';
import QueryState from '../../shared/ui/QueryState.vue';
import RecordDrawer from '../../shared/ui/RecordDrawer.vue';
import StatusPill from '../../shared/ui/StatusPill.vue';
import WorkspaceContextLinks from '../../shared/ui/WorkspaceContextLinks.vue';
import { deliveryJobQuickPrompt, jiraQuickPrompt } from '../agent-workbench/agent-quick-actions';
import PlanTable from './PlanTable.vue';
import ExecutionTable from './ExecutionTable.vue';
import RunTable from './RunTable.vue';
const props = defineProps<{ mode: string }>();
const route = useRoute();
const router = useRouter();
const center = shallowRef<HTMLElement>();
type ExecutionTab = 'queue' | 'plan' | 'runs';
const mode = computed<ExecutionTab>(() => {
  const value = route.query.executionTab || route.query.view || props.mode;
  return value === 'plan' || value === 'runs' ? value : 'queue';
});
const query = useSource<AutomationData>('automation');
const runtime = useAgentRuntimeSnapshot();
const groupDashboard = useQuery({ queryKey: ['agent-group-chat'], queryFn: ({ signal }) => readGroupDashboard(signal), retry: false,
  enabled: computed(() => mode.value === 'queue'), refetchInterval: computed(() => mode.value === 'queue' ? 3000 : false) });
const teamTasks = useQuery({ queryKey: ['agent-team-chat', 'tasks'], queryFn: ({ signal }) => readTeamTasks(signal), retry: false,
  enabled: computed(() => mode.value === 'queue'), refetchInterval: computed(() => mode.value === 'queue' ? 3000 : false) });
const executionReady = computed(() => !!runtime.data.value && !!groupDashboard.data.value && !!teamTasks.data.value);
const executionError = computed(() => runtime.error.value || groupDashboard.error.value || teamTasks.error.value);
const executionPending = computed(() => runtime.isPending.value || groupDashboard.isPending.value || teamTasks.isPending.value);
const executionFetching = computed(() => runtime.isFetching.value || groupDashboard.isFetching.value || teamTasks.isFetching.value);
const { data, isPending, isFetching, error } = query;
const actions = useSourceActions();
// 三个视图各自保留筛选与页码，避免切换后把计划的“未完成”重置为全部历史。
const queueState = useWorkspacePanelState('execution:queue', () => ({ search: '', filter: 'all', page: 1, scope: 'active' as ExecutionScope }));
const planState = useWorkspacePanelState('execution:plan', () => ({ search: '', filter: 'open', page: 1, scope: 'active' as ExecutionScope }));
const runState = useWorkspacePanelState('execution:runs', () => ({ search: '', filter: 'all', page: 1, scope: 'active' as ExecutionScope }));
const panelState = computed(() => mode.value === 'plan' ? planState : mode.value === 'runs' ? runState : queueState);
const search = computed({ get: () => panelState.value.search.value, set: value => { panelState.value.search.value = value; } });
const filter = computed({ get: () => panelState.value.filter.value, set: value => { panelState.value.filter.value = value; } });
const page = computed({ get: () => panelState.value.page.value, set: value => { panelState.value.page.value = value; } });
const scope = queueState.scope;
const drawer = shallowRef(false);
let switchingTab = false;
const selectedPlanId = shallowRef(''), selectedJobId = shallowRef(''), selectedRunId = shallowRef('');
const selectedPlan = computed(() => data.value?.plan.find((item) => item.issue.key === selectedPlanId.value));
const selectedJob = computed(() => data.value?.jobs.find((item) => item.id === selectedJobId.value));
const selectedRouting = computed(() => selectedPlan.value?.projectRouting || selectedJob.value?.projectRouting);
const selectedRun = computed(() => data.value?.runs.find((item) => item.id === selectedRunId.value));
const tabs: { id: ExecutionTab; label: string }[] = [{ id: 'queue', label: '实际执行' }, { id: 'plan', label: '自动化计划' }, { id: 'runs', label: '巡检日志' }];
const plans = computed(() => planItems(data.value?.plan || [], search.value, filter.value as PlanFilter));
const entries = computed(() => executionReady.value ? executionEntries(runtime.data.value?.runs || [], data.value?.jobs || [], runtime.data.value?.conversationTitles || {},
  { rooms: groupDashboard.data.value!.rooms, tasks: teamTasks.data.value! }) : []);
const scopes: { id: ExecutionScope; label: string }[] = [{ id: 'active', label: '执行 / 排队' }, { id: 'attention', label: '需关注' }, { id: 'history', label: '历史记录' }, { id: 'all', label: '全部' }];
const sourceReady = computed(() => !!data.value && !error.value && (mode.value !== 'queue' || executionReady.value && !executionError.value));
const executionCounts = computed(() => {
  if (!data.value || !executionReady.value || error.value || executionError.value) return undefined;
  const counts: Record<ExecutionScope, number> = { active: 0, attention: 0, history: 0, all: entries.value.length };
  for (const item of entries.value) counts[executionScope(item.status)]++;
  return counts;
});
const jobs = computed(() => entries.value.filter(item => (scope.value === 'all' || executionScope(item.status) === scope.value)
  && searchMatches([item.title, item.run?.objective, item.run?.result, item.job?.issueKey, item.workspacePath, item.branch, item.summary], search.value)
  && (filter.value === 'all' || item.status === filter.value)));
const runs = computed(() => (data.value?.runs || []).filter((item) => searchMatches(item, search.value)));
const total = computed(() => mode.value === 'plan' ? plans.value.length : mode.value === 'queue' ? jobs.value.length : runs.value.length);
const metrics = computed(() => mode.value === 'plan' ? [
  { label: '未完成计划', value: data.value ? planItems(data.value.plan, '', 'open').length : undefined, note: '按最近一次巡检快照' },
  { label: '符合派发规则', value: data.value ? planItems(data.value.plan, '', 'eligible').length : undefined, note: '仍受工作区和自动派发设置约束' },
  { label: '等待前置任务', value: data.value ? planItems(data.value.plan, '', 'dependencies').length : undefined, note: '有依赖或未完成子任务' },
] : [
  { label: '已保存巡检', value: data.value?.runs.length, note: '巡检日志，与 Agent 对话轮次分开' },
  { label: '最近新增任务', value: data.value?.lastRun?.enqueuedCount, note: `最近巡检 ${dateTime(data.value?.lastRun?.completedAt)}` },
  { label: '最近状态推进', value: data.value?.lastRun?.transitionUpdatedCount, note: `阻塞 ${data.value?.lastRun?.transitionBlockedCount ?? '—'} 项` },
]);
const statusOptions = computed(() => [...new Set(entries.value.filter(item => scope.value === 'all' || executionScope(item.status) === scope.value).map(item => item.status))]);
const hasFilters = computed(() => !!search.value.trim() || (mode.value === 'queue' ? filter.value !== 'all' : mode.value === 'plan' && filter.value !== 'open'));
const emptyDescription = computed(() => {
  if (hasFilters.value) return mode.value === 'plan' ? '没有匹配的自动化计划' : mode.value === 'runs' ? '没有匹配的巡检日志' : '没有匹配的执行记录';
  if (mode.value === 'plan') return data.value?.plan.length ? '最近巡检中没有未完成计划' : '尚无自动化计划';
  if (mode.value === 'runs') return '尚无巡检日志';
  return ({ active: '当前没有执行或排队任务', attention: '当前没有需关注的执行记录', history: '暂无历史执行记录', all: '暂无执行记录' })[scope.value];
});
function clearFilters() { search.value = ''; filter.value = mode.value === 'plan' ? 'open' : 'all'; page.value = 1; }
watch(scope, () => { queueState.filter.value = 'all'; queueState.page.value = 1; });
watch(total, count => { page.value = Math.min(page.value, Math.max(1, Math.ceil(count / 20))); }, { immediate: true });
function refresh() { return Promise.all([query.refetch(), ...(mode.value === 'queue' ? [runtime.refetch(), groupDashboard.refetch(), teamTasks.refetch()] : [])]); }
async function selectTab(value: string | number) {
  const { plan: _plan, job: _job, run: _run, ...query } = route.query;
  switchingTab = true;
  drawer.value = false;
  try {
    await router.replace({ query: { ...query, view: 'queue', executionTab: String(value) } });
    center.value?.closest('.workspace-panel-content')?.scrollTo({ top: 0 });
  }
  finally { switchingTab = false; }
}
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
watch([() => route.query.plan, () => route.query.job, () => route.query.run, () => data.value], () => {
  const plan = data.value?.plan.find(item => item.issue.key === route.query.plan);
  const job = data.value?.jobs.find(item => item.id === route.query.job);
  const run = data.value?.runs.find(item => item.id === route.query.run);
  if (plan) inspectPlan(plan);
  else if (job) inspectJob(job);
  else if (run) inspectRun(run);
}, { immediate: true });
watch(drawer, open => {
  if (open || switchingTab) return;
  if (!route.query.plan && !route.query.job && !route.query.run) return;
  const { plan: _plan, job: _job, run: _run, ...query } = route.query;
  void router.replace({ query });
});
</script>
<template>
  <PageHeading title="执行中心" description="实际执行、自动化计划与巡检日志。" :loading="isFetching || (mode === 'queue' && executionFetching)" @refresh="refresh">
    <el-button v-if="mode !== 'queue'" type="primary" :loading="actions.pending.value" :disabled="!integrations.capability('issues.read')" title="需要已接入的任务提供者" @click="actions.execute('scan', {}, '确认立即巡检', '巡检会按现有策略执行，可能创建 AI 任务、推进 Jira 或创建合并请求。确认立即巡检吗？')">立即巡检</el-button>
  </PageHeading>
  <section ref="center" class="execution-center" aria-label="执行中心">
    <div class="execution-board">
      <div class="execution-navigation">
        <div class="execution-heading">
          <div><h1>执行中心</h1><p>查看正在发生的执行、自动化判定与巡检结果。</p></div>
          <RouterLink to="/agent?view=settings&amp;settingsTab=automation" class="hub-link">自动交付设置</RouterLink>
        </div>
        <el-tabs :model-value="mode" class="execution-tabs" aria-label="执行中心视图" @update:model-value="selectTab">
          <el-tab-pane v-for="item in tabs" :key="item.id" :name="item.id" :label="item.label" />
        </el-tabs>
      </div>
      <aside class="execution-summary" aria-label="执行信息">
        <div class="execution-context">
          <template v-if="mode === 'queue'"><span>Agent 最近执行与自动化队列；同一会话展示当前轮次。</span></template>
          <template v-else>
            <span>最近巡检 {{ dateTime(data?.lastRun?.completedAt) }} · 来源 {{ data?.lastRun?.source || '未记录' }}</span>
            <span v-if="data">定时巡检{{ data.settings.enabled ? '已开启' : '已暂停' }} · 自动创建任务{{ data.settings.autoCreateCodex ? '已开启' : '已关闭' }}</span>
            <span v-if="data?.settings.enabled && data.nextRun">下次 {{ dateTime(data.nextRun) }}</span>
            <span v-if="data?.running">巡检进行中</span>
          </template>
          <RouterLink v-if="mode === 'plan'" to="/tasks/list" class="hub-link">查看当前 Jira 任务</RouterLink>
        </div>
        <p v-if="mode === 'plan'" class="execution-note">以下为巡检时的计划快照；刷新只重读已保存结果。符合派发规则仍需工作区就绪并开启自动创建任务。<template v-if="data?.lastRun?.source === 'mock'">此快照使用模拟数据。</template></p>
      </aside>
    </div>
    <MetricStrip v-if="mode !== 'queue'" :items="metrics" />
    <QueryState :loading="isPending || (mode === 'queue' && executionPending)" :error="error || (mode === 'queue' ? executionError : null)" :has-data="mode === 'queue' ? !!data && executionReady : !!data" @retry="refresh">
      <div class="surface execution-records">
        <div v-if="mode === 'queue'" class="filter-bar execution-scopes">
          <el-radio-group v-model="scope" aria-label="执行记录范围"><el-radio-button v-for="item in scopes" :key="item.id" :value="item.id">{{ item.label }} <span class="scope-count">{{ executionCounts?.[item.id] ?? '—' }}</span></el-radio-button></el-radio-group>
        </div>
        <div class="filter-bar">
          <el-input v-model="search" :placeholder="mode === 'plan' ? '搜索事项、判定或工作区' : mode === 'runs' ? '搜索巡检时间或结果' : '搜索任务、工作区或结果'" clearable @input="page = 1" />
          <el-select v-if="mode === 'plan'" v-model="filter" aria-label="计划范围" @change="page = 1">
            <el-option label="未完成计划" value="open" /><el-option label="符合派发规则" value="eligible" /><el-option label="等待前置任务" value="dependencies" /><el-option label="队列阻塞" value="blocked" /><el-option label="项目 / 工作区待核对" value="unmatched" /><el-option label="全部计划（含历史）" value="all" />
          </el-select>
          <el-select v-if="mode === 'queue'" v-model="filter" aria-label="执行状态" @change="page = 1"><el-option label="全部状态" value="all" /><el-option v-for="value in statusOptions" :key="value" :value="value" :label="value" /></el-select>
          <span class="filter-count"><template v-if="sourceReady">共 {{ total }} 条{{ mode === 'plan' ? '计划' : '记录' }}</template><template v-else>—</template></span>
        </div>
        <el-empty v-if="!total && sourceReady" :description="emptyDescription" :image-size="64">
          <template v-if="sourceReady">
            <el-button v-if="hasFilters" @click="clearFilters">清除筛选</el-button>
            <template v-else-if="mode === 'queue' && scope === 'active'">
              <el-button v-if="executionCounts?.attention" @click="scope = 'attention'">查看需关注（{{ executionCounts.attention }}）</el-button>
              <el-button @click="selectTab('plan')">查看自动化计划</el-button>
            </template>
            <el-button v-else-if="mode === 'plan' && data?.plan.length" @click="filter = 'all'">查看全部计划</el-button>
          </template>
        </el-empty>
        <template v-else-if="total">
          <PlanTable v-if="mode === 'plan'" :items="plans.slice((page - 1) * 20, page * 20)" @inspect="inspectPlan" />
          <ExecutionTable v-else-if="mode === 'queue'" :items="jobs.slice((page - 1) * 20, page * 20)" @inspect="inspectJob" />
          <RunTable v-else :items="runs.slice((page - 1) * 20, page * 20)" @inspect="inspectRun" />
        </template>
        <div v-if="total" class="table-footer"><span>{{ mode === 'queue' ? '最近执行快照与自动化记录，不代表全部会话历史或 Jira 完成状态' : mode === 'runs' ? '巡检日志，不是 Agent 对话轮次' : '未完成优先，按目标日期由近到远' }}</span><el-pagination v-if="total > 20" v-model:current-page="page" :total="total" :page-size="20" layout="prev, pager, next" /></div>
      </div>
    </QueryState>
  </section>
  <RecordDrawer v-model="drawer" :title="detailTitle" :record="selected">
    <WorkspaceContextLinks v-if="selectedPlan || selectedJob" :issue-key="selectedPlan?.issue.key || selectedJob?.issueKey" :workspace-path="selectedPlan?.workspace?.path || selectedJob?.workspacePath" :thread-id="selectedJob?.threadId" :prompt="selectedJob ? deliveryJobQuickPrompt(selectedJob) : selectedPlan ? jiraQuickPrompt(selectedPlan.issue) : ''" />
    <section v-if="selectedPlan || selectedJob" class="detail-section"><h3>项目匹配</h3><dl class="detail-facts"><div><dt>选中项目</dt><dd>{{ projectRoutingLabel(selectedRouting) }}</dd></div><div v-if="selectedRouting?.reason"><dt>匹配依据</dt><dd>{{ selectedRouting.reason }}</dd></div><template v-if="selectedRouting?.profile"><div><dt>仓库 / 本机路径</dt><dd>{{ selectedRouting.profile.repositoryUrl }}<br>{{ selectedRouting.profile.localPath || '未指定本机路径' }}</dd></div><div><dt>运行环境 / 启动命令</dt><dd>{{ selectedRouting.profile.runtimeEnvironment }}<br>{{ selectedRouting.profile.runtimeCommand }}</dd></div><div><dt>目标分支</dt><dd>{{ selectedRouting.profile.targetBranch }}</dd></div></template><div v-if="selectedRouting?.candidates.length && selectedRouting.status !== 'matched'"><dt>候选项目</dt><dd>{{ selectedRouting.candidates.map(profile => profile.name).join('、') }}</dd></div></dl><RouterLink v-if="selectedRouting && selectedRouting.status !== 'matched'" to="/settings?settingsTab=automation" class="hub-link">核对项目匹配配置</RouterLink></section>
    <template v-if="selectedPlan"><div class="inline-links"><a :href="safeUrl(selectedPlan.issue.url)" target="_blank">打开 {{ selectedPlan.issue.key }}</a></div><dl class="detail-facts"><div><dt>快照中的分类 / 模型</dt><dd>{{ selectedPlan.categoryLabel }} · {{ selectedPlan.model }}</dd></div><div><dt>下一步</dt><dd>{{ selectedPlan.action }}</dd></div><div><dt>工作区</dt><dd>{{ selectedPlan.workspace?.path || '未匹配' }}</dd></div><div><dt>依赖</dt><dd>{{ selectedPlan.dependencyKeys?.join('、') || '无记录' }}</dd></div></dl><section class="detail-section"><h3>任务描述</h3><JiraDescription class="detail-text" :text="selectedPlan.issue.description || '来源没有描述'" :base-url="selectedPlan.issue.url" /></section></template>
    <template v-else-if="selectedJob"><StatusPill :value="selectedJob.status" /><dl class="detail-facts"><div><dt>工作区 / 分支</dt><dd>{{ selectedJob.workspacePath }}<br>{{ selectedJob.branch }}</dd></div><div><dt>真实任务 ID</dt><dd>{{ selectedJob.threadId || selectedJob.clientThreadId || '未创建' }}</dd></div><div><dt>模型 / 尝试次数</dt><dd>{{ selectedJob.model }} · {{ selectedJob.attempts }} 次</dd></div><div><dt>更新时间</dt><dd>{{ dateTime(selectedJob.updatedAt) }}</dd></div></dl><div class="inline-links"><a :href="safeUrl(selectedJob.issueUrl)" target="_blank">Jira 事项</a><a v-if="safeUrl(selectedJob.mrUrl)" :href="safeUrl(selectedJob.mrUrl)" target="_blank">合并请求</a><a v-if="safeUrl(selectedJob.artifactUrl)" :href="safeUrl(selectedJob.artifactUrl)" target="_blank">方案文档</a><a v-if="selectedJob.i18nXlsxPath" :href="sourceUrl('artifact', { id: selectedJob.id, type: 'i18n' })" target="_blank">多语言 Excel</a><a v-if="selectedJob.selfTestReportPath" :href="sourceUrl('artifact', { id: selectedJob.id, type: 'report' })" target="_blank">自测报告</a><a v-for="(_, index) in selectedJob.selfTestScreenshots" :key="index" :href="sourceUrl('artifact', { id: selectedJob.id, type: 'screenshot', index: String(index) })" target="_blank">自测截图 {{ index + 1 }}</a></div><section class="detail-section"><h3>结果与阻塞</h3><el-alert v-if="selectedJob.error" :title="selectedJob.error" type="error" :closable="false" /><AgentMarkdown class="detail-text" :source="selectedJob.result || '等待回传结果'" /></section><section class="detail-section"><h3>完整会话输入</h3><AgentMarkdown class="detail-text" :source="selectedJob.prompt || '未记录输入'" /></section><div class="inline-links"><el-button v-if="['blocked','cancelled'].includes(selectedJob.status)" type="primary" :disabled="!integrations.capability('issues.read')" @click="actions.execute('job-update', { id: selectedJob.id, status: 'pending' }, '确认重新排队', '这会将原 Codex 任务重新排队，现有调度器可能开始执行。')">重新排队</el-button><el-button v-if="['waiting','pending','dispatching','dispatched','running'].includes(selectedJob.status)" type="danger" plain @click="actions.execute('job-update', { id: selectedJob.id, status: 'cancelled' }, '确认停止队列任务', '这会更新原队列任务状态；不保证已运行的工具或会话被强制终止。')">停止队列任务</el-button></div></template>
    <template v-else-if="selectedRun"><dl class="detail-facts"><div><dt>触发 / 来源</dt><dd>{{ selectedRun.trigger }} / {{ selectedRun.source }}</dd></div><div><dt>运行时间</dt><dd>{{ dateTime(selectedRun.startedAt) }} → {{ dateTime(selectedRun.completedAt) }}</dd></div><div><dt>读取 Jira / 工作区</dt><dd>{{ selectedRun.issueCount }} / {{ selectedRun.workspaceCount }}</dd></div><div><dt>新增任务</dt><dd>{{ selectedRun.enqueuedCount }}</dd></div></dl><section class="detail-section"><h3>Jira 状态推进明细</h3><el-table :data="selectedRun.transitionResults || []"><el-table-column prop="issueKey" label="Jira" width="115" /><el-table-column prop="reason" label="原因" min-width="170" /><el-table-column prop="message" label="响应" min-width="220" /></el-table></section></template>
  </RecordDrawer>
</template>

<style scoped>
.execution-center{min-width:0}
.execution-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:12px}
.execution-heading h1{margin:0;font-size:20px;font-weight:600}
.execution-heading p,.execution-note{margin:6px 0 12px;color:var(--ui-muted);font-size:12px;line-height:1.7}
.execution-heading>a{flex-shrink:0;font-size:12px}
.execution-tabs :deep(.el-tabs__header){margin-bottom:12px}
.execution-tabs :deep(.el-tabs__content){display:none}
.execution-context{display:flex;flex-wrap:wrap;gap:6px 18px;align-items:center;margin-bottom:12px;color:var(--ui-secondary);font-size:12px;line-height:1.7}
.execution-context>a{margin-left:auto}
.execution-center :deep(.hub-metrics){grid-template-columns:repeat(3,minmax(0,1fr)) !important}
.execution-center :deep(.hub-metrics .metric-card){display:block;min-height:0;padding:14px 18px}
.execution-center :deep(.hub-metrics .metric-card strong){display:block;margin:5px 0;font-size:28px;line-height:1.15}
.execution-center :deep(.hub-metrics .metric-card small){display:block;font-size:11px;line-height:1.5}
.execution-records{min-width:0}
.execution-scopes :deep(.el-radio-group){display:flex;flex-wrap:wrap;gap:4px}
.execution-scopes :deep(.el-radio-button__inner){border:1px solid var(--ui-border);border-radius:5px;box-shadow:none}
.scope-count{margin-left:5px;font-variant-numeric:tabular-nums;opacity:.75}
.execution-records :deep(.el-empty){padding:40px 16px}
.execution-records :deep(.el-empty__bottom){display:flex;justify-content:center;flex-wrap:wrap;gap:8px}
.execution-records :deep(.el-empty__bottom .el-button){margin-left:0}
.execution-center :deep(.execution-cards){display:none}
@container workspace-page (max-width:620px){
  .execution-heading{align-items:flex-start}.execution-heading h1{font-size:18px}.execution-context>a{margin-left:0}
  .execution-records .filter-count{margin-left:0}.execution-records .table-footer>span{flex-basis:100%}
  .execution-center :deep(.hub-metrics .metric-card){padding:12px 10px;border-top:0;border-right:1px solid var(--ui-divider)}
  .execution-center :deep(.hub-metrics .metric-card:last-child){border-right:0}.execution-center :deep(.hub-metrics .metric-card>span){font-size:11px}
  .execution-center :deep(.execution-desktop){display:none}
  .execution-center :deep(.execution-cards){display:grid;gap:0;list-style:none;margin:0;padding:0}
  .execution-center :deep(.execution-card){min-width:0;padding:16px 0;border-top:1px solid var(--ui-divider);font-size:12px;line-height:1.6}
  .execution-center :deep(.execution-card-header){display:flex;align-items:flex-start;gap:10px;justify-content:space-between}
  .execution-center :deep(.execution-card-header>.status-pill){flex-shrink:0}
  .execution-center :deep(.execution-card-title){min-width:0;font-size:13px;overflow-wrap:anywhere;color:var(--ui-text)}
  .execution-center :deep(.execution-card-title strong){display:block;margin-top:3px;font-weight:550}
  .execution-center :deep(.execution-card-meta){margin:6px 0;color:var(--ui-muted);overflow-wrap:anywhere}
  .execution-center :deep(.execution-card-result){margin:10px 0;white-space:pre-line;overflow-wrap:anywhere;color:var(--ui-secondary);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
  .execution-center :deep(.execution-card-facts){display:grid;gap:7px;margin:10px 0}
  .execution-center :deep(.execution-card-facts>div){display:grid;grid-template-columns:88px minmax(0,1fr);gap:10px}
  .execution-center :deep(.execution-card-facts dt){color:var(--ui-muted)}
  .execution-center :deep(.execution-card-facts dd){margin:0;overflow-wrap:anywhere}
  .execution-center :deep(.execution-card-actions){display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:8px;margin-top:10px}
  .execution-center :deep(.execution-card-actions .el-button){margin:0;min-height:32px}
}
</style>
