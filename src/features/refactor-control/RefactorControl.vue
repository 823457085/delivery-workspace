<script setup lang="ts">
/** 模块、问题、后台任务和结果共用同一范围；历史结论与本轮验证分开展示。 */
import { computed, inject, shallowRef, useTemplateRef, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useRouter } from 'vue-router';
import { ArrowUpRight, Check, ChevronRight, Download, FolderGit2, MoreHorizontal, Play, RefreshCw, Search, Settings2 } from '@lucide/vue';
import { refactorActions, refactorActionLabels, refactorConclusionLabels, refactorJobActive, refactorJobLabel,
  type RefactorAction, type RefactorConfig, type RefactorJob, type RefactorLaunch, type RefactorModule, type RefactorPreview } from '../../../shared/refactor-control';
import { agentWorkspaceContext } from '../../shared/agent-workspace-context';
import { useAgentRuntimeSnapshot } from '../../shared/useAgentRuntimeSnapshot';
import { useWorkspacePanelState } from '../../shared/useWorkspacePanelState';
import AgentMarkdown from '../agent-workbench/AgentMarkdown.vue';
import RefactorLaunchDialog from './RefactorLaunchDialog.vue';
import RefactorConfigDrawer from './RefactorConfigDrawer.vue';
import RefactorTeamRoster from './RefactorTeamRoster.vue';
import RefactorDocumentsPanel from './RefactorDocumentsPanel.vue';
import RefactorProjectsPanel from './RefactorProjectsPanel.vue';
import AgentAvatar from '../agent-workbench/AgentAvatar.vue';
import { agentProviderLabels } from '../../../shared/agent-runtime';
import { refactorTeamStateLabels } from '../../../shared/refactor-control';
import { exportRefactorResults, refactorArtifactUrl, useRefactorControl } from './useRefactorControl';

const control = useRefactorControl();
const runtime = useAgentRuntimeSnapshot();
const workspace = inject(agentWorkspaceContext, undefined);
const { tab, moduleFilter, search } = useWorkspacePanelState('refactor-control', () => ({ tab: 'documents', moduleFilter: '', search: '' }));
const selectedModules = shallowRef<string[]>([]), selectedIssues = shallowRef<string[]>([]);
const launchOpen = shallowRef(false), configOpen = shallowRef(false), moduleDetail = shallowRef(''), jobDetail = shallowRef('');
const issueDetail = shallowRef(''), issuePage = shallowRef(1);
const issuePageSize = 10;
const issueViewport = useTemplateRef<HTMLElement>('issueViewport');
const launchDialog = useTemplateRef<InstanceType<typeof RefactorLaunchDialog>>('launchDialog');
const configDrawer = useTemplateRef<InstanceType<typeof RefactorConfigDrawer>>('configDrawer');
const selection = shallowRef<{ action: RefactorAction; moduleIds: string[]; issueIds: string[]; interfaceIds?: string[]; version?: string; retestMode?: RefactorLaunch['retestMode']; branches?: RefactorLaunch['branches'] }>({ action: 'integrate', moduleIds: [], issueIds: [] });
const stopping = shallowRef('');
const router = useRouter();
const nodeLabels: Record<string, string> = { pending: '待开始', queued: '排队中', running: '进行中', completed: '已完成', failed: '失败',
  interrupted: '已中断', cancelled: '已停止', blocked: '遇到阻碍', waiting_input: '等待回复', needs_reconciliation: '待核对', skipped: '已跳过' };
const data = computed(() => control.dashboard.data.value);
const modules = computed(() => data.value?.source?.modules || []);
const jobs = computed(() => data.value?.jobs || []);
const allIssues = computed(() => modules.value.flatMap(module => module.issues));
const matched = (text: string) => !search.value.trim() || text.toLowerCase().includes(search.value.trim().toLowerCase());
const visibleModules = computed(() => modules.value.filter(module => (!moduleFilter.value || module.id === moduleFilter.value)
  && matched([module.title, module.module, ...module.interfaces.flatMap(item => [item.name, item.path, item.page])].join(' '))));
const visibleIssues = computed(() => allIssues.value.filter(issue => (!moduleFilter.value || issue.moduleId === moduleFilter.value) && matched(`${issue.id} ${issue.summary} ${issue.kind} ${issue.moduleTitle}`)));
const pagedIssues = computed(() => visibleIssues.value.slice((issuePage.value - 1) * issuePageSize, issuePage.value * issuePageSize));
const currentIssue = computed(() => allIssues.value.find(issue => `${issue.moduleId}/${issue.id}` === issueDetail.value));
const visibleJobs = computed(() => jobs.value.filter(job => (!moduleFilter.value || job.moduleId === moduleFilter.value) && matched(`${job.moduleTitle} ${refactorActionLabels[job.action]} ${job.version} ${job.id}`)));
const resultJobs = computed(() => visibleJobs.value.filter(job => !refactorJobActive(job)));
const currentModule = computed(() => modules.value.find(module => module.id === moduleDetail.value));
const currentJob = computed(() => jobs.value.find(job => job.id === jobDetail.value));
const eligibleIssues = computed(() => visibleIssues.value.filter(issue => !issue.eligibility));
const chosenIssues = computed(() => eligibleIssues.value.filter(issue => selectedIssues.value.includes(`${issue.moduleId}/${issue.id}`)));
const executable = computed(() => modules.value.flatMap(module => module.interfaces.filter(item => item.category === '本轮联调')));
const confirmed = computed(() => executable.value.filter(item => item.reviewStatus === '已联调').length);
const activeJobs = computed(() => jobs.value.filter(refactorJobActive));
const waitingJobs = computed(() => activeJobs.value.filter(job => job.team && ['blocked', 'needs_decision', 'needs_reconciliation', 'waiting_input', 'awaiting_plan'].includes(job.team.state)));
const tabs = computed(() => [{ id: 'documents', label: '联调文档', count: undefined }, { id: 'projects', label: '项目组', count: undefined }, { id: 'modules', label: '模块进度', count: modules.value.length }, { id: 'issues', label: '问题与复测', count: allIssues.value.length },
  { id: 'jobs', label: '执行任务', count: jobs.value.length }, { id: 'results', label: '结果产物', count: jobs.value.filter(job => !refactorJobActive(job)).length }]);
watch(modules, value => {
  if (moduleFilter.value && !value.some(module => module.id === moduleFilter.value)) moduleFilter.value = '';
  selectedModules.value = selectedModules.value.filter(id => value.some(module => module.id === id && !module.deferred));
});
watch([moduleFilter, search], () => { issuePage.value = 1; });
watch(() => visibleIssues.value.length, count => { issuePage.value = Math.min(issuePage.value, Math.max(1, Math.ceil(count / issuePageSize))); });
watch([issuePage, moduleFilter, search], () => { issueViewport.value?.scrollTo({ top: 0 }); }, { flush: 'post' });
function time(value?: string) { return value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '尚无记录'; }
function scopeCount(module: RefactorModule) { return module.interfaces.filter(item => item.category === '本轮联调').length; }
function confirmedCount(module: RefactorModule) { return module.interfaces.filter(item => item.category === '本轮联调' && item.reviewStatus === '已联调').length; }
function latest(moduleId: string, action: RefactorAction) { return jobs.value.find(job => job.moduleId === moduleId && job.action === action); }
function phase(moduleId: string, action: RefactorAction) { const job = latest(moduleId, action); return job ? refactorJobLabel(job) : '尚未发起'; }
function tone(job?: RefactorJob) {
  if (!job || job.status === 'cancelled' || ['cancelled', 'interrupted'].includes(job.runStatus || '') || job.team && ['cancelled', 'taken_over'].includes(job.team.state)) return '';
  if (job.team && ['blocked', 'needs_decision', 'needs_reconciliation', 'rejected'].includes(job.team.state)) return 'failed';
  if (job.status === 'failed' || job.runStatus === 'failed' || job.report?.status === 'failed') return 'failed';
  return refactorJobActive(job) ? 'active' : job.report?.status === 'passed' ? 'passed' : '';
}
function openTeam(job: RefactorJob) { if (job.groupRoomId) { void router.push({ path: '/agent', query: { group: '1', room: job.groupRoomId } }); return; } workspace?.openRun(job.team?.conversationId || job.runId); }
function owner(job?: RefactorJob) { return job?.team?.nodes.filter(node => ['running', 'queued', 'waiting_input'].includes(node.status)).map(node => node.label).join(' / '); }
function toggleAllModules(checked: boolean) { selectedModules.value = checked ? visibleModules.value.filter(module => !module.deferred).map(module => module.id) : []; }
function toggleAllIssues(checked: boolean) { selectedIssues.value = checked ? eligibleIssues.value.map(issue => `${issue.moduleId}/${issue.id}`) : []; }
function openAction(action: RefactorAction, moduleId?: string) {
  const ids = moduleId ? [moduleId] : selectedModules.value.length ? selectedModules.value : visibleModules.value.filter(module => !module.deferred).map(module => module.id);
  const issues = action === 'retest' ? moduleId ? allIssues.value.filter(issue => issue.moduleId === moduleId && !issue.eligibility) : chosenIssues.value : [];
  selection.value = { action, moduleIds: action === 'retest' ? [...new Set(issues.map(issue => issue.moduleId))] : ids, issueIds: issues.map(issue => issue.id) };
  if (!selection.value.moduleIds.length) { ElMessage.info(action === 'retest' ? '先选择需要复测的问题' : '当前没有可执行模块'); return; }
  launchOpen.value = true;
}
async function launchDocument(value: { action: 'integrate' | 'retest'; moduleIds: string[]; issueIds: string[]; interfaceIds: string[] }) {
  await control.dashboard.refetch();
  if (!data.value) { ElMessage.info('重构配置尚未读取，请刷新后重试'); return; }
  selection.value = value; launchOpen.value = true;
}
function retestOne(moduleId: string, issueId: string) { selection.value = { action: 'retest', moduleIds: [moduleId], issueIds: [issueId] }; launchOpen.value = true; }
async function start(launch: RefactorLaunch, preview: RefactorPreview, requestId: string) {
  try {
    const result = await control.start(launch, preview, requestId);
    launchOpen.value = false; tab.value = 'jobs';
    ElMessage.success(result.reused ? '已找到原批次，未重复派发' : `${result.jobIds.length} 个模块任务已排队`);
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); }
  finally { launchDialog.value?.finish(); }
}
async function configure(config: RefactorConfig, revision: string) {
  try { await control.configure(config, revision); configOpen.value = false; ElMessage.success('项目来源与工作区已保存'); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); }
  finally { configDrawer.value?.finish(); }
}
async function stop(job: RefactorJob) {
  if (stopping.value) return; stopping.value = job.id;
  try { await control.stop(job.id); ElMessage.success('已停止所选任务'); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); }
  finally { stopping.value = ''; }
}
function retry(job: RefactorJob) { selection.value = { action: job.action, moduleIds: [job.moduleId], issueIds: job.issueIds, interfaceIds: job.action === 'integrate' ? job.targetIds : [], version: job.version,
  retestMode: job.retestMode || 'deployed', branches: job.localPlan ? [{ workspacePath: job.localPlan.sourceWorkspacePath, ref: job.localPlan.ref }] : [] }; launchOpen.value = true; }
function exportResults(format: 'md' | 'json') { exportRefactorResults(format, selectedModules.value.length ? selectedModules.value : moduleFilter.value ? [moduleFilter.value] : []); }
</script>

<template>
  <section class="refactor-control" :class="{ 'refactor-issues-view': tab === 'issues' }" aria-label="重构可视化管理">
    <div class="control-shell">
    <aside class="control-sidebar">
    <header class="control-heading">
      <div><div class="control-eyebrow"><span class="control-project">APEX</span><span>重构交付</span><i></i><span>{{ data?.config.environment || '环境未配置' }}</span></div><h1>重构管理</h1><p class="control-tagline">你的 AI 团队，贯穿开发、联调与复测。</p></div>
    </header>
    <nav class="control-view-nav" aria-label="重构管理视图"><button v-for="item in tabs" :id="`refactor-view-${item.id}`" :key="item.id" type="button" :aria-current="tab === item.id ? 'page' : undefined" :aria-controls="'refactor-view-content'" :class="{ selected: tab === item.id }" @click="tab = item.id">{{ item.label }}<span v-if="item.count !== undefined">{{ item.count }}</span></button></nav>
      <div class="control-heading-actions"><button class="control-icon" type="button" aria-label="刷新重构进度" :disabled="control.dashboard.isFetching.value" @click="control.refresh()"><RefreshCw :size="16" :class="{ spinning: control.dashboard.isFetching.value }" /></button><button class="control-button" type="button" @click="['documents', 'projects'].includes(tab) ? tab = 'projects' : configOpen = true" :disabled="!data"><Settings2 :size="15" />项目配置</button><el-dropdown v-if="!['documents', 'projects'].includes(tab)" trigger="click" @command="exportResults"><button class="control-button" type="button" :disabled="!data"><Download :size="15" />导出结果</button><template #dropdown><el-dropdown-menu><el-dropdown-item command="md">导出 Markdown</el-dropdown-item><el-dropdown-item command="json">导出 JSON</el-dropdown-item></el-dropdown-menu></template></el-dropdown><button v-if="!['documents', 'projects'].includes(tab)" class="control-button primary" type="button" :disabled="!modules.length" @click="openAction('integrate')"><Play :size="14" />触发联调</button></div>
    </aside>
    <section id="refactor-view-content" class="control-content" :aria-labelledby="`refactor-view-${tab}`">
    <div v-if="!['documents', 'projects'].includes(tab)" class="control-content-toolbar"><label class="control-search"><Search :size="15" /><input v-model="search" type="search" aria-label="搜索重构模块、接口或问题" placeholder="搜索模块、接口或问题" maxlength="200" /></label></div>
    <RefactorDocumentsPanel v-if="tab === 'documents'" @launch="launchDocument" @changed="control.dashboard.refetch()" @projects="tab = 'projects'" />
    <RefactorProjectsPanel v-else-if="tab === 'projects'" @changed="control.dashboard.refetch()" />
    <template v-else>
    <div v-if="data?.source" class="control-source"><FolderGit2 :size="14" /><span :title="data.config.workspacePath">{{ data.source.workspace.branch }}</span><code>{{ data.source.workspace.head.slice(0, 8) || '普通目录' }}</code><small v-if="data.source.workspace.dirty">有本地改动</small><span class="source-path" :title="data.config.workspacePath">{{ data.config.workspacePath }}</span><span class="source-sync">台账更新 {{ time(data.source.sourceUpdatedAt) }}</span></div>
    <el-skeleton v-if="control.dashboard.isPending.value" :rows="9" animated />
    <template v-else-if="data">
      <el-empty v-if="!data.source" description="资料来源暂不可读，请检查项目配置" :image-size="70"><el-button @click="configOpen = true">项目配置</el-button></el-empty>
      <template v-else>
      <component :is="tab === 'issues' ? 'details' : 'div'" :class="{ 'control-overview': tab === 'issues' }">
      <summary v-if="tab === 'issues'" class="control-overview-summary"><span>本轮接口 <strong>{{ executable.length }}</strong></span><span>人工确认 <strong>{{ confirmed }}/{{ executable.length }}</strong></span><span>问题 <strong>{{ allIssues.length }}</strong></span><span>后台任务 <strong>{{ activeJobs.length }}</strong></span><span class="control-overview-toggle">进度与团队配置<ChevronRight :size="13" /></span></summary>
      <div class="control-metrics" aria-label="重构关键进度">
        <article><span>本轮接口</span><strong>{{ executable.length.toLocaleString() }}</strong><small>{{ modules.length }} 个模块 · {{ data.config.assignee }}</small></article>
        <article><span>人工确认</span><strong>{{ confirmed }}<em>/ {{ executable.length }}</em></strong><small>自动检查与人工验收分别记录</small></article>
        <article><span>台账待处理问题</span><strong>{{ allIssues.filter(issue => !/已关闭|已撤销/.test(issue.status) && issue.eligibility !== '暂不联调').length }}</strong><small>{{ allIssues.filter(issue => !issue.eligibility).length }} 项可申请复测</small></article>
        <article><span>后台任务</span><strong>{{ activeJobs.filter(job => job.status !== 'queued' && !waitingJobs.includes(job)).length }}<em>执行 / {{ activeJobs.filter(job => job.status === 'queued').length }} 排队</em></strong><small>{{ waitingJobs.length ? `${waitingJobs.length} 项等待处理，可进入团队协作` : '离开页面后继续推进' }}</small></article>
      </div>
      <RefactorTeamRoster v-if="data.groupConfig" :config="data.groupConfig" :runtimes="runtime.data.value?.runtimes || []" />
      </component>
      <div class="control-layout">
        <nav class="control-modules" aria-label="重构模块筛选">
          <label class="control-mobile-filter">模块范围<el-select v-model="moduleFilter" aria-label="模块范围" :empty-values="[null, undefined]"><el-option value="" label="全部模块" /><el-option v-for="module in modules" :key="module.id" :value="module.id" :label="module.title" /></el-select></label>
          <div class="module-nav-heading"><span>工作范围</span><small>{{ modules.length }}</small></div>
          <button type="button" :class="{ selected: !moduleFilter }" @click="moduleFilter = ''"><span>全部模块</span><strong>{{ executable.length }}</strong></button>
          <button v-for="module in modules" :key="module.id" type="button" :class="{ selected: moduleFilter === module.id, deferred: module.deferred }" @click="moduleFilter = module.id"><span>{{ module.title }}<small>{{ module.deferred ? '暂不联调' : `${module.issues.length} 个问题` }}</small></span><strong>{{ scopeCount(module) }}</strong></button>
          <p>历史实测保留原结论与时间，本轮复测保留新的版本和证据。</p>
        </nav>
        <main class="control-main" :class="{ 'issues-main': tab === 'issues' }">

          <template v-if="tab === 'modules'">
            <div class="control-selection"><label><input type="checkbox" aria-label="选择当前可执行模块" :checked="!!selectedModules.length && visibleModules.filter(module => !module.deferred).every(module => selectedModules.includes(module.id))" @change="toggleAllModules(($event.target as HTMLInputElement).checked)" />{{ selectedModules.length ? `已选 ${selectedModules.length} 个模块` : '按模块推进' }}</label><div><button type="button" @click="openAction('develop')">开发实现</button><button type="button" @click="openAction('style-check')">检查样式</button><button type="button" @click="openAction('style-fix')">修改样式</button></div></div>
            <div v-if="visibleModules.length" class="control-matrix" role="table" aria-label="模块开发联调复测进度">
              <div class="matrix-heading" role="row"><span></span><span role="columnheader">模块 / 验收进度</span><span role="columnheader">开发</span><span role="columnheader">联调</span><span role="columnheader">复测</span><span role="columnheader">操作</span></div>
              <div v-for="module in visibleModules" :key="module.id" class="matrix-row" role="row" :class="{ deferred: module.deferred }">
                <label class="matrix-checkbox"><input v-model="selectedModules" type="checkbox" :value="module.id" :disabled="module.deferred" :aria-label="`选择模块 ${module.title}`" /></label>
                <div class="matrix-module"><button type="button" @click="moduleDetail = module.id">{{ module.title }}<ChevronRight :size="13" /></button><small>{{ scopeCount(module) }} 条本轮接口 · {{ module.issues.length }} 个问题</small><div class="module-progress" :aria-label="`人工确认 ${confirmedCount(module)} / ${scopeCount(module)}`"><i :style="{ width: `${scopeCount(module) ? confirmedCount(module) / scopeCount(module) * 100 : 0}%` }"></i></div><small>{{ module.deferred ? '保留历史，本轮暂不联调' : `人工确认 ${confirmedCount(module)} / ${scopeCount(module)}` }}</small></div>
                <div class="matrix-phase"><small class="phase-label">开发</small><span :class="['phase-state', tone(latest(module.id, 'develop'))]">{{ phase(module.id, 'develop') }}</span><small v-if="owner(latest(module.id, 'develop'))">{{ owner(latest(module.id, 'develop')) }}</small><button v-if="latest(module.id, 'style-check') || latest(module.id, 'style-fix')" type="button" class="phase-style" @click="jobDetail = (latest(module.id, 'style-fix') || latest(module.id, 'style-check'))!.id">样式检查记录 <ArrowUpRight :size="11" /></button></div>
                <div class="matrix-phase"><small class="phase-label">联调</small><span :class="['phase-state', tone(latest(module.id, 'integrate'))]">{{ latest(module.id, 'integrate') ? phase(module.id, 'integrate') : '待发起本轮' }}</span><small v-if="owner(latest(module.id, 'integrate'))">{{ owner(latest(module.id, 'integrate')) }}</small><small>历史通过 {{ module.interfaces.filter(item => ['已通过', '已修复'].includes(item.previousStatus)).length }}</small></div>
                <div class="matrix-phase"><small class="phase-label">复测</small><span :class="['phase-state', tone(latest(module.id, 'retest'))]">{{ phase(module.id, 'retest') }}</span><small v-if="owner(latest(module.id, 'retest'))">{{ owner(latest(module.id, 'retest')) }}</small><small>{{ time(latest(module.id, 'retest')?.createdAt) }}</small></div>
                <div class="matrix-actions"><button type="button" class="row-launch" :disabled="module.deferred" :aria-label="`联调 ${module.title}`" @click="openAction('integrate', module.id)"><Play :size="12" />联调</button><el-dropdown trigger="click" :disabled="module.deferred" @command="openAction($event, module.id)"><button type="button" class="control-icon" :disabled="module.deferred" :aria-label="`${module.title}更多操作`"><MoreHorizontal :size="16" /></button><template #dropdown><el-dropdown-menu><el-dropdown-item v-for="action in refactorActions.filter(action => action !== 'integrate')" :key="action" :command="action">{{ refactorActionLabels[action] }}</el-dropdown-item></el-dropdown-menu></template></el-dropdown></div>
              </div>
            </div>
            <el-empty v-else description="当前范围没有模块，可调整筛选或项目配置" :image-size="70" />
          </template>
          <template v-else-if="tab === 'issues'">
            <div class="control-selection"><label><input type="checkbox" aria-label="选择当前筛选全部可复测问题" :checked="!!chosenIssues.length && chosenIssues.length === eligibleIssues.length" :indeterminate.prop="!!chosenIssues.length && chosenIssues.length < eligibleIssues.length" @change="toggleAllIssues(($event.target as HTMLInputElement).checked)" />全选筛选结果</label><span class="issues-selected-count">当前范围已选 {{ chosenIssues.length }} / {{ eligibleIssues.length }} 项</span><button class="control-button primary" type="button" :disabled="!chosenIssues.length" @click="openAction('retest')"><Play :size="13" />批量复测<span v-if="chosenIssues.length">{{ chosenIssues.length }}</span></button></div>
            <div v-if="visibleIssues.length" ref="issueViewport" class="control-issues" role="table" aria-label="问题与复测列表">
              <div class="issues-heading" role="row"><span role="columnheader"></span><span role="columnheader">编号 / 问题</span><span role="columnheader">模块 / 类型</span><span role="columnheader">当前状态</span><span role="columnheader">操作</span></div>
              <article v-for="issue in pagedIssues" :key="`${issue.moduleId}/${issue.id}`" class="issue-row" role="row">
                <label class="issue-checkbox" role="cell"><input v-model="selectedIssues" type="checkbox" :value="`${issue.moduleId}/${issue.id}`" :disabled="!!issue.eligibility" :aria-label="`选择问题 ${issue.id}`" /></label>
                <div class="issue-summary" role="cell"><code>{{ issue.id }}</code><button class="issue-title" type="button" :title="issue.summary" @click="issueDetail = `${issue.moduleId}/${issue.id}`">{{ issue.summary }}</button></div>
                <div class="issue-classification" role="cell"><span>{{ issue.moduleTitle }}</span><small>{{ issue.kind }}</small></div>
                <p class="issue-state" role="cell" :title="issue.eligibility || issue.status">{{ issue.eligibility || issue.status }}</p>
                <div class="issue-actions" role="cell"><button class="issue-detail-link" type="button" :aria-label="`查看问题 ${issue.id} 详情`" @click="issueDetail = `${issue.moduleId}/${issue.id}`">详情</button><button type="button" class="row-launch" :disabled="!!issue.eligibility" @click="retestOne(issue.moduleId, issue.id)">复测<ArrowUpRight :size="13" /></button></div>
              </article>
            </div><el-empty v-else description="当前范围没有问题记录" :image-size="70" />
            <footer class="issues-pagination"><span>共 {{ visibleIssues.length }} 个问题 · 每页 {{ issuePageSize }} 条</span><el-pagination v-model:current-page="issuePage" :page-size="issuePageSize" :total="visibleIssues.length" :pager-count="5" layout="prev, pager, next" /></footer>
          </template>
          <template v-else-if="tab === 'jobs'">
            <div class="control-list-heading"><h2>执行队列</h2><span>{{ activeJobs.length }} 项排队或执行 · 每 5 秒更新</span></div>
            <div v-if="visibleJobs.length" class="control-jobs"><article v-for="job in visibleJobs" :key="job.id" class="job-row"><div class="job-sequence"><i :class="tone(job)"><Check v-if="job.report?.status === 'passed'" :size="13" /><Play v-else :size="11" /></i><span></span></div><div class="job-main"><button type="button" @click="jobDetail = job.id">{{ refactorActionLabels[job.action] }}<span>{{ job.moduleTitle }}</span><ArrowUpRight :size="13" /></button><p>{{ job.currentStep || job.report?.summary || job.error || '等待本轮结果回读' }}</p><small>{{ time(job.createdAt) }} · {{ job.collaborationMode === 'automatic' ? `${job.teamName || '我的 AI 团队'} · 配置 v${job.teamRevision}` : `${job.provider} / ${job.model || 'CLI 默认'}` }} · {{ job.targetIds.length }} 个目标<span v-if="job.version"> · {{ job.version }}</span></small></div><div class="job-actions"><span :class="['job-status', tone(job)]">{{ refactorJobLabel(job) }}</span><button v-if="refactorJobActive(job)" type="button" :disabled="!!stopping" @click="stop(job)">停止</button><button v-else type="button" @click="retry(job)">重新发起</button><button v-if="job.groupRoomId || (job.runId || job.team) && workspace" type="button" @click="openTeam(job)">{{ job.team ? '进入团队协作' : '查看会话' }}</button></div></article></div><el-empty v-else description="还没有执行任务，可从模块发起联调、开发或样式检查" :image-size="70" />
          </template>
          <template v-else>
            <div class="control-list-heading"><h2>结果产物</h2><span>保留每轮环境、版本和现场证据</span></div>
            <div v-if="resultJobs.length" class="control-results"><article v-for="job in resultJobs" :key="job.id"><div><span :class="['job-status', tone(job)]">{{ refactorJobLabel(job) }}</span><small>{{ time(job.createdAt) }}</small></div><h3>{{ job.moduleTitle }}<span>{{ refactorActionLabels[job.action] }}</span></h3><p>{{ job.report?.summary || job.reportError || job.error || '执行器已结束，尚无可核对的结构化报告' }}</p><footer><code>{{ job.environment }} · {{ job.version || '未填写版本' }}</code><button type="button" @click="jobDetail = job.id">查看结果与证据<ArrowUpRight :size="14" /></button></footer></article></div><el-empty v-else description="完成任务后，这里会保留结果和现场证据" :image-size="70" />
          </template>
        </main>
      </div>
      <footer class="control-footnote"><span>来源：{{ data.config.sourceRoot }}</span><span>历史记录、自动检查与人工验收独立保留</span></footer>
      </template>

    </template>
    </template>
    <el-empty v-if="!['documents', 'projects'].includes(tab) && !data && !control.dashboard.isPending.value" description="重构数据暂不可读" :image-size="70"><el-button @click="control.dashboard.refetch()">重新读取</el-button></el-empty>
    </section>
    </div>
    <RefactorLaunchDialog v-if="data" ref="launchDialog" v-model="launchOpen" :data="data" :runtimes="runtime.data.value?.runtimes || []" :selection="selection" @start="start" />
    <RefactorConfigDrawer v-if="data" ref="configDrawer" v-model="configOpen" :data="data" @save="configure" />
    <el-drawer :model-value="!!issueDetail" :title="currentIssue?.summary || '问题详情'" size="min(760px, 96vw)" append-to-body @update:model-value="!$event && (issueDetail = '')"><div v-if="currentIssue" class="refactor-detail"><dl><dt>问题编号</dt><dd>{{ currentIssue.id }}</dd><dt>模块</dt><dd>{{ currentIssue.moduleTitle }}</dd><dt>类型</dt><dd>{{ currentIssue.kind }}</dd><dt>状态</dt><dd>{{ currentIssue.status }}</dd><template v-if="currentIssue.eligibility"><dt>复测条件</dt><dd>{{ currentIssue.eligibility }}</dd></template></dl><AgentMarkdown v-if="currentIssue.description" class="issue-detail-description" :source="currentIssue.description" /><a v-if="currentIssue.report?.startsWith('/integration-runs/')" class="hub-link" :href="`/api/agent-runtimes/refactor-control/source-artifact?file=${encodeURIComponent(currentIssue.report)}`" target="_blank" rel="noopener noreferrer">查看原报告<ArrowUpRight :size="12" /></a><p v-if="!currentIssue.retest && !currentIssue.eligibility">复测时先从原报告核对原请求和测试条件</p></div><template #footer><el-button @click="issueDetail = ''">关闭</el-button></template></el-drawer>
    <el-drawer :model-value="!!moduleDetail" :title="currentModule?.title || '模块详情'" size="min(880px, 96vw)" append-to-body @update:model-value="!$event && (moduleDetail = '')"><div v-if="currentModule" class="refactor-detail"><p>{{ currentModule.previousStatus }} · 台账更新 {{ time(currentModule.updatedAt) }}</p><div v-for="item in currentModule.interfaces" :key="item.id" class="detail-interface"><h3>{{ item.name }}<span>{{ item.reviewStatus }}</span></h3><code>{{ item.method }} {{ item.path }}</code><p>{{ item.page }} · {{ item.previousStatus }}</p><p>{{ item.previousResult || '尚无历史实测结论' }}</p><small>{{ time(item.checkedAt) }}</small></div></div></el-drawer>
    <el-drawer :model-value="!!jobDetail" title="任务结果与证据" size="min(880px, 96vw)" append-to-body @update:model-value="!$event && (jobDetail = '')"><div v-if="currentJob" class="refactor-detail"><div class="detail-job-heading"><h2>{{ currentJob.moduleTitle }} · {{ refactorActionLabels[currentJob.action] }}</h2><span :class="['job-status', tone(currentJob)]">{{ refactorJobLabel(currentJob) }}</span></div><dl><dt>环境 / 版本</dt><dd>{{ currentJob.environment }} / {{ currentJob.version || '未填写' }}</dd><dt>代码基准</dt><dd><code>{{ currentJob.sourceHead || '普通目录' }}</code></dd><template v-if="currentJob.localPlan"><dt>复测分支</dt><dd>{{ currentJob.localPlan.branch }}</dd><dt>独立工作区</dt><dd>{{ currentJob.localRuntime?.workspacePath || (refactorJobActive(currentJob) ? '正在准备' : '准备未完成') }}</dd><dt>本地页面</dt><dd><a v-if="currentJob.localRuntime?.state === 'running'" :href="currentJob.localRuntime.baseUrl" target="_blank" rel="noopener noreferrer">{{ currentJob.localRuntime.baseUrl }}</a><span v-else>{{ currentJob.localRuntime ? `${currentJob.localRuntime.baseUrl}（已停止）` : refactorJobActive(currentJob) ? '正在准备' : '未启动' }}</span></dd></template><dt>任务编号</dt><dd><code>{{ currentJob.id }}</code></dd></dl><section v-if="currentJob.team" class="refactor-team-progress" aria-label="本轮团队协作">
        <header><h3>本轮团队协作</h3><span>{{ refactorTeamStateLabels[currentJob.team.state] }}</span></header>
        <p v-if="currentJob.team.reason">{{ currentJob.team.reason }}</p>
        <p v-if="currentJob.team.workspacePath" class="team-candidate-path">团队工作区：{{ currentJob.team.workspacePath }}</p>
        <ol><li v-for="node in currentJob.team.nodes" :key="node.id"><AgentAvatar :provider="node.provider" :model="node.model" :size="28" /><div><strong>{{ node.label }}</strong><span :class="{ active: ['running', 'queued'].includes(node.status) }">{{ nodeLabels[node.status] || node.status }}</span><small>{{ node.actual ? '运行配置' : '岗位配置' }} · {{ agentProviderLabels[node.provider] }} / {{ node.model }}</small><p v-if="node.error">{{ node.error }}</p></div><button v-if="node.runId && workspace" type="button" @click="workspace.openRun(node.runId)">日志<ArrowUpRight :size="12" /></button></li></ol>
      </section><template v-if="currentJob.report"><AgentMarkdown :source="currentJob.report.summary" /><article v-for="item in currentJob.report.items" :key="item.targetId" class="detail-result"><header><code>{{ item.targetId }}</code><span>{{ refactorConclusionLabels[item.status] }}</span></header><AgentMarkdown :source="item.actual" /><div v-if="item.expected">预期：<AgentMarkdown :source="item.expected" /></div><div><a v-for="file in item.evidence" :key="file" :href="refactorArtifactUrl(currentJob.id, file)" target="_blank" rel="noopener noreferrer">{{ file }}<ArrowUpRight :size="12" /></a></div></article><h3>执行检查</h3><div v-for="check in currentJob.report.checks" :key="check.name">{{ check.name }} · {{ refactorConclusionLabels[check.status] }}<AgentMarkdown :source="check.detail" /></div><h3 v-if="currentJob.report.changedFiles.length">改动文件</h3><p v-for="file in currentJob.report.changedFiles" :key="file"><code>{{ file }}</code></p></template><p v-else>{{ currentJob.reportError || currentJob.error || currentJob.currentStep || '等待任务生成本轮结果与证据' }}</p><el-button v-if="currentJob.groupRoomId || (currentJob.runId || currentJob.team) && workspace" @click="openTeam(currentJob)">{{ currentJob.team ? '进入团队协作 / 回复问题' : '查看原始会话' }}</el-button><details v-if="currentJob.runResult" class="detail-transcript"><summary>执行器回复</summary><AgentMarkdown :source="currentJob.runResult" /></details></div></el-drawer>
  </section>
</template>

<style src="./refactor-control.css"></style>
<style scoped>.issue-detail-description{white-space:pre-wrap;overflow-wrap:anywhere}</style>
