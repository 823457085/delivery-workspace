<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Folder, Plus, Terminal, RefreshCw } from '@lucide/vue';
import type { DeploymentBinding, DeploymentDashboard, DeploymentLog, DeploymentProject, DeploymentRun, DeploymentStart, DeploymentStatus, JenkinsJob, YunxiaoPipeline } from '../../../shared/deployments';
import { dateTime, safeUrl, searchMatches } from '../../shared/format';
import { useWorkspacePanelState } from '../../shared/useWorkspacePanelState';
import PageHeading from '../../shared/ui/PageHeading.vue';
import QueryState from '../../shared/ui/QueryState.vue';
import StatusPill from '../../shared/ui/StatusPill.vue';
import { deploymentApi } from './api';
import { mergeDeploymentProjects, parseDeploymentLinks, type NativeDeploymentProject } from './native-deployments';

const dashboard = shallowRef<DeploymentDashboard>();
const nativeProjects = shallowRef<NativeDeploymentProject[]>([]);
const nativeFor = (id: string) => nativeProjects.value.find(project => project.id === id);
const allProjects = computed(() => mergeDeploymentProjects(dashboard.value?.projects || [], nativeProjects.value));
const isConfigured = (id: string) => bindingsFor(id).length > 0 || !!nativeFor(id)?.environments.length;
const error = shallowRef<Error | null>(null), loading = ref(true), manualRefreshing = ref(false);
const { search, projectFilter } = useWorkspacePanelState('deployments', () => ({ search: '', projectFilter: '' }));
const labels: Record<DeploymentStatus, string> = { dispatching: '提交中', queued: '排队中', running: '执行中', success: '成功', failed: '失败', cancelled: '已取消', unknown: '待核对' };
const active = (run?: DeploymentRun) => !!run && ['dispatching', 'queued', 'running'].includes(run.status);
const pollable = (run?: DeploymentRun) => active(run) || !!run && run.provider === 'yunxiao' && !!run.pipelineRunId && run.status === 'unknown';
const projects = computed(() => allProjects.value.filter(item => isConfigured(item.id) && searchMatches([item.name, item.repository, item.paths], search.value)));
const selectedProject = computed(() => projects.value.find(project => project.id === projectFilter.value));
watch(projects, value => { if (dashboard.value && !value.some(project => project.id === projectFilter.value)) projectFilter.value = value[0]?.id || ''; }, { immediate: true });
const runs = computed(() => [...(dashboard.value?.runs || [])].filter(item => item.projectId === selectedProject.value?.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
const environmentCount = (id: string) => bindingsFor(id).length + (nativeFor(id)?.environments.length || 0);
const bindingsFor = (id: string) => dashboard.value?.bindings.filter(item => item.projectId === id) || [];
function latestRun(id: string) { return dashboard.value?.runs.filter(item => item.bindingId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]; }
function jenkinsJobUrl(binding: DeploymentBinding) { return safeUrl(`${dashboard.value?.config.baseUrl.replace(/\/+$/, '')}/${binding.jobFullName.split('/').map(part => `job/${encodeURIComponent(part)}`).join('/')}/`); }
const configured = computed(() => !!dashboard.value?.config.hasToken);
const cloudConfigured = computed(() => !!dashboard.value?.yunxiao?.hasToken);
const cloudSettingsOpen = ref(false), cloudToken = ref(''), cloudSaving = ref(false), cloudPreparing = ref('');
const cloudDeployOpen = ref(false), cloudSubmitting = ref(false), cloudAcknowledged = ref(false);
type CloudBinding = NativeDeploymentProject['environments'][number];
const cloudTarget = shallowRef<{ project: DeploymentProject; binding: CloudBinding }>();
const cloudPipeline = shallowRef<YunxiaoPipeline>();
const cloudBranches = ref<Record<string, string>>({});
watch(cloudSettingsOpen, open => { if (!open) cloudToken.value = ''; });
async function saveCloudSettings() {
  if (cloudSaving.value || !cloudToken.value.trim()) return;
  cloudSaving.value = true;
  try {
    await deploymentApi('/yunxiao/config', { body: { token: cloudToken.value.trim() } });
    if (disposed) return;
    cloudToken.value = ''; cloudSettingsOpen.value = false; await refresh(true);
    ElMessage.success('云效连接已保存');
    if (cloudTarget.value) await prepareCloud(cloudTarget.value.project, cloudTarget.value.binding);
  } catch (cause) { if (!disposed) ElMessage.error(message(cause)); }
  finally { cloudSaving.value = false; }
}
async function prepareCloud(project: DeploymentProject, binding: CloudBinding) {
  if (cloudPreparing.value || cloudSubmitting.value || active(latestRun(binding.url))) return;
  cloudTarget.value = { project, binding };
  if (!cloudConfigured.value) { cloudSettingsOpen.value = true; return; }
  cloudPreparing.value = binding.url;
  try {
    const pipeline = await deploymentApi<YunxiaoPipeline>('/yunxiao/prepare', { body: { projectId: project.id, environment: binding.environment } });
    if (disposed) return;
    cloudPipeline.value = pipeline;
    cloudBranches.value = Object.fromEntries(pipeline.sources.map(source => [source.repo, source.branch]));
    cloudAcknowledged.value = false; cloudDeployOpen.value = true;
  } catch (cause) { if (!disposed) ElMessage.error(message(cause)); }
  finally { cloudPreparing.value = ''; }
}
async function startCloudDeployment() {
  const target = cloudTarget.value;
  if (!target || cloudSubmitting.value || !cloudPipeline.value || Object.values(cloudBranches.value).some(branch => !branch.trim())
    || latestRun(target.binding.url)?.status === 'unknown' && !cloudAcknowledged.value) return;
  cloudSubmitting.value = true;
  const requestId = crypto.randomUUID();
  try {
    const run = await deploymentApi<DeploymentRun>('/yunxiao/runs', { body: { requestId, projectId: target.project.id,
      environment: target.binding.environment, branches: { ...cloudBranches.value }, acknowledgeUnknown: cloudAcknowledged.value } });
    if (disposed) return;
    cloudDeployOpen.value = false; await refresh(true); inspectRun(run);
    if (run.status === 'unknown') ElMessage.warning(run.error || '云效提交结果待核对，请勿重复提交');
    else ElMessage.success('部署请求已提交');
  } catch (cause) {
    if (disposed) return;
    cloudDeployOpen.value = false;
    ElMessage.error(message(cause)); await refresh(true);
    const accepted = dashboard.value?.runs.find(run => run.requestId === requestId);
    if (accepted) inspectRun(accepted);
  } finally { cloudSubmitting.value = false; }
}
let disposed = false, refreshingPromise: Promise<void> | undefined;
const readController = new AbortController();
async function refresh(afterWrite = false): Promise<void> {
  if (refreshingPromise) return afterWrite ? refreshingPromise.then(() => refresh(true)) : refreshingPromise;
  refreshingPromise = (async () => {
    try {
      const [value, response] = await Promise.all([deploymentApi<DeploymentDashboard>('', { signal: readController.signal }),
        fetch('/api/deployments/links', { signal: readController.signal, cache: 'no-store' }).then(response => response.status === 404
          ? fetch('/deployment-links.json', { signal: readController.signal, cache: 'no-store' }) : response)]);
      if (!response.ok && response.status !== 404) throw new Error('读取云效部署入口失败');
      const links = response.ok ? parseDeploymentLinks(await response.json()) : [];
      if (!disposed) { dashboard.value = value; nativeProjects.value = links; error.value = null; }
    }
    catch (cause) { if (!disposed) error.value = cause instanceof Error ? cause : new Error(String(cause)); }
    finally { if (!disposed) loading.value = false; refreshingPromise = undefined; }
  })();
  return refreshingPromise;
}

async function refreshManually() {
  if (manualRefreshing.value) return;
  manualRefreshing.value = true;
  try { await refresh(); }
  finally { manualRefreshing.value = false; }
}

const settingsOpen = ref(false), savingSettings = ref(false), checking = ref(false);
const connection = reactive({ baseUrl: '', username: '', token: '' });
function openSettings() {
  Object.assign(connection, { baseUrl: dashboard.value?.config.baseUrl || '', username: dashboard.value?.config.username || '', token: '' });
  settingsOpen.value = true;
}
watch(settingsOpen, open => { if (!open) connection.token = ''; });
async function saveSettings() {
  if (savingSettings.value || !connection.baseUrl.trim() || !connection.username.trim() || !configured.value && !connection.token) return;
  savingSettings.value = true;
  try {
    await deploymentApi('/config', { body: { baseUrl: connection.baseUrl.trim(), username: connection.username.trim(), ...(connection.token ? { token: connection.token } : {}) } });
    if (disposed) return;
    connection.token = ''; settingsOpen.value = false; jobs.value = [];
    ElMessage.success('Jenkins 连接已保存'); await refresh(true);
  } catch (cause) { if (!disposed) ElMessage.error(message(cause)); }
  finally { savingSettings.value = false; }
}
async function checkConnection() {
  if (checking.value) return;
  checking.value = true;
  try { const result = await deploymentApi<{ message: string }>('/connection/check', { body: {} }); if (!disposed) ElMessage.success(result.message); }
  catch (cause) { if (!disposed) ElMessage.error(message(cause)); }
  finally { checking.value = false; }
}

const bindingOpen = ref(false), savingBinding = ref(false), jobsLoading = ref(false);
const jobs = shallowRef<JenkinsJob[]>([]);
const bindingForm = reactive({ id: '', projectId: '', environment: '', jobFullName: '' });
const manualOpen = ref(false), savingManual = ref(false);
const manualForm = reactive({ projectId: '', environment: '', url: '' });
const validManualUrl = computed(() => {
  try { const url = new URL(manualForm.url.trim()); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }
  catch { return false; }
});
function addManualDeployment() {
  Object.assign(manualForm, { projectId: selectedProject.value?.id || allProjects.value[0]?.id || '', environment: '', url: '' });
  manualOpen.value = true;
}
async function saveManualDeployment() {
  if (savingManual.value || !manualForm.projectId || !manualForm.environment.trim() || !validManualUrl.value) return;
  const projectId = manualForm.projectId;
  savingManual.value = true;
  try {
    await deploymentApi('/bindings/manual', { body: { projectId, environment: manualForm.environment.trim(), url: manualForm.url.trim() } });
    if (disposed) return;
    search.value = ''; manualOpen.value = false;
    await refresh(true); projectFilter.value = projectId; ElMessage.success('部署配置已添加');
  } catch (cause) { if (!disposed) ElMessage.error(message(cause)); }
  finally { savingManual.value = false; }
}
let jobsPromise: Promise<boolean> | undefined;
async function readJobs() {
  if (jobsPromise) return jobsPromise;
  jobsLoading.value = true;
  jobsPromise = (async () => {
    try { const result = await deploymentApi<JenkinsJob[]>('/jobs', { signal: readController.signal }); if (!disposed) jobs.value = result; return !disposed; }
    catch (cause) { if (!disposed) ElMessage.error(message(cause)); return false; }
    finally { jobsLoading.value = false; jobsPromise = undefined; }
  })();
  return jobsPromise;
}
async function editBinding(project: DeploymentProject, binding?: DeploymentBinding) {
  if (!configured.value) { ElMessage.info('请先配置 Jenkins 连接'); openSettings(); return; }
  Object.assign(bindingForm, { id: binding?.id || '', projectId: project.id, environment: binding?.environment || '', jobFullName: binding?.jobFullName || '' });
  bindingOpen.value = true; await readJobs();
}
async function saveBinding() {
  if (savingBinding.value || !bindingForm.projectId || !bindingForm.environment.trim() || !bindingForm.jobFullName) return;
  savingBinding.value = true;
  try {
    await deploymentApi<DeploymentBinding>('/bindings', { body: { ...bindingForm, id: bindingForm.id || undefined, environment: bindingForm.environment.trim() } });
    if (disposed) return;
    bindingOpen.value = false; ElMessage.success('流水线关联已保存'); await refresh(true);
  } catch (cause) { if (!disposed) ElMessage.error(message(cause)); }
  finally { savingBinding.value = false; }
}
async function deleteBinding(binding: DeploymentBinding) {
  if (!await confirm('解除流水线关联', `解除“${binding.environment}”与 ${binding.jobFullName} 的关联？`)) return;
  try { await deploymentApi('/bindings/delete', { body: { id: binding.id } }); if (!disposed) { ElMessage.success('关联已解除'); await refresh(true); } }
  catch (cause) { if (!disposed) ElMessage.error(message(cause)); }
}

const deployOpen = ref(false), submitting = ref(false), preparingBinding = ref('');
const deployBinding = shallowRef<DeploymentBinding>(), deployJob = shallowRef<JenkinsJob>();
const parameters = ref<Record<string, string | boolean>>({}), acknowledgeUnknown = ref(false);
const unsupported = computed(() => deployJob.value?.parameters.filter(item => item.type === 'unsupported') || []);
const unknownDeployment = computed(() => !!deployBinding.value && latestRun(deployBinding.value.id)?.status === 'unknown');
const canDeploy = computed(() => !!deployJob.value?.buildable && !unsupported.value.length && !submitting.value && (!unknownDeployment.value || acknowledgeUnknown.value));
async function prepareDeployment(binding: DeploymentBinding) {
  if (preparingBinding.value || submitting.value || active(latestRun(binding.id))) return;
  preparingBinding.value = binding.id;
  const loaded = await readJobs();
  if (disposed) return;
  const job = jobs.value.find(item => item.fullName === binding.jobFullName);
  preparingBinding.value = '';
  if (!loaded) return;
  if (!job) { ElMessage.error('未读取到关联的 Jenkins 任务，请检查连接或重新关联'); return; }
  deployBinding.value = binding; deployJob.value = job; acknowledgeUnknown.value = false;
  parameters.value = Object.fromEntries(job.parameters.map(item => [item.name, item.type === 'boolean' ? item.defaultValue === true : item.type === 'password' ? '' : typeof item.defaultValue === 'string' ? item.defaultValue : item.type === 'choice' ? item.choices?.[0] || '' : '']));
  deployOpen.value = true;
}
watch(deployOpen, open => { if (!open) { parameters.value = {}; acknowledgeUnknown.value = false; } });
async function startDeployment() {
  const binding = deployBinding.value, job = deployJob.value;
  if (!binding || !job || !canDeploy.value) return;
  const previousUnknown = unknownDeployment.value;
  submitting.value = true;
  try {
    const requestId = crypto.randomUUID();
    const body: DeploymentStart = { bindingId: binding.id, requestId, parameters: { ...parameters.value }, ...(previousUnknown ? { acknowledgeUnknown: true } : {}) };
    try {
      const run = await deploymentApi<DeploymentRun>('/runs', { body });
      if (disposed) return;
      deployOpen.value = false; await refresh(true); inspectRun(run);
      if (run.status === 'unknown') ElMessage.warning('发布请求结果待核对，请先查看 Jenkins 和日志，勿直接重复提交');
      else ElMessage.success('部署请求已提交，请查看本次状态和日志');
    } catch (cause) {
      if (disposed) return;
      deployOpen.value = false;
      ElMessage.error(`${message(cause)}；提交结果未确认，请先核对 Jenkins，勿直接重试`);
      await refresh(true);
      const accepted = dashboard.value?.runs.find(item => item.requestId === requestId);
      if (accepted) inspectRun(accepted);
    }
  } finally { submitting.value = false; }
}

const logOpen = ref(false), selectedRun = shallowRef<DeploymentRun>();
const logText = ref(''), logOffset = ref(0), logTruncated = ref(false), logError = ref(''), followLog = ref(true), logMore = ref(true);
const logLoading = ref(false), manualLogRefreshing = ref(false);
const logJobId = ref('');
const logJobs = computed(() => (selectedRun.value?.steps || []).filter(step => step.jobId));
const logElement = ref<HTMLElement>();
let selectionVersion = 0, logBusy = false;
function inspectRun(run: DeploymentRun) {
  selectionVersion++; selectedRun.value = run; logJobId.value = ''; logText.value = ''; logOffset.value = 0; logTruncated.value = false; logError.value = ''; logMore.value = true; logOpen.value = true;
  logLoading.value = true;
  void readRunLog();
}
function changeLogJob() {
  selectionVersion++; logText.value = ''; logOffset.value = 0; logTruncated.value = false; logError.value = ''; logMore.value = true;
  logLoading.value = true;
  void readRunLog();
}
watch(runs, value => {
  if (selectedRun.value?.projectId === selectedProject.value?.id && value.some(run => run.id === selectedRun.value?.id)) return;
  if (value[0]) inspectRun(value[0]);
  else { selectionVersion++; selectedRun.value = undefined; logText.value = ''; logOffset.value = 0; logJobId.value = ''; logOpen.value = false; }
}, { immediate: true });
watch(logOpen, open => { if (!open) { selectionVersion++; selectedRun.value = undefined; logText.value = ''; } });
async function readRunLog(manual = false) {
  if (!logOpen.value || !selectedRun.value) return;
  if (manual) manualLogRefreshing.value = true;
  if (logBusy) return;
  const runId = selectedRun.value.id, version = selectionVersion;
  logBusy = true;
  try {
    const run = await deploymentApi<DeploymentRun>(`${selectedRun.value.provider === 'yunxiao' ? '/yunxiao' : ''}/runs/${encodeURIComponent(runId)}`, { signal: readController.signal });
    if (disposed || version !== selectionVersion) return;
    selectedRun.value = run;
    if (run.provider === 'yunxiao' && !logJobs.value.some(job => job.jobId === logJobId.value)) {
      logJobId.value = logJobs.value.find(job => ['RUNNING', 'RUNNABLE'].includes(job.status))?.jobId || logJobs.value[0]?.jobId || '';
      logText.value = ''; logOffset.value = 0;
    }
    if (run.provider === 'yunxiao' && !logJobId.value) { logMore.value = pollable(run); logError.value = ''; return; }
    const log = await deploymentApi<DeploymentLog>(`${run.provider === 'yunxiao' ? '/yunxiao' : ''}/runs/${encodeURIComponent(runId)}/log?start=${logOffset.value}${run.provider === 'yunxiao' ? `&jobId=${encodeURIComponent(logJobId.value)}` : ''}`, { signal: readController.signal });
    if (disposed || version !== selectionVersion) return;
    const bytes = new TextEncoder().encode(logText.value + log.text);
    if (bytes.byteLength > 1_048_576) { logTruncated.value = true; logText.value = new TextDecoder().decode(bytes.slice(-1_048_576)); }
    else logText.value += log.text;
    logOffset.value = log.nextOffset; logMore.value = log.moreData; logError.value = '';
    if (followLog.value) { await nextTick(); if (logElement.value) logElement.value.scrollTop = logElement.value.scrollHeight; }
  } catch (cause) {
    if (!disposed && version === selectionVersion) {
      const nextError = message(cause);
      if (logError.value !== nextError) ElMessage.error(nextError);
      logError.value = nextError;
    }
  }
  finally {
    logBusy = false;
    if (!disposed && version !== selectionVersion && logOpen.value) void readRunLog();
    else { logLoading.value = false; manualLogRefreshing.value = false; }
  }
}
let timer: ReturnType<typeof setInterval> | undefined, polling = false;
onMounted(() => {
  void refresh();
  timer = setInterval(async () => {
    if (polling || disposed) return;
    polling = true;
    try {
      if (dashboard.value?.runs.some(pollable)) await refresh();
      if (logOpen.value && (pollable(selectedRun.value) || logMore.value)) await readRunLog();
    } finally { polling = false; }
  }, 3000);
});
onBeforeUnmount(() => { disposed = true; if (timer) clearInterval(timer); readController.abort(); connection.token = ''; cloudToken.value = ''; parameters.value = {}; });
function message(cause: unknown) { return cause instanceof Error ? cause.message : String(cause); }
async function confirm(title: string, detail: string) {
  try { await ElMessageBox.confirm(detail, title, { confirmButtonText: '确认执行', cancelButtonText: '取消', type: 'warning', closeOnClickModal: false }); return !disposed; }
  catch { return false; }
}
</script>

<template>
  <section class="deployment-workspace">
    <PageHeading title="部署发布" description="在工作台发起云效与 Jenkins 部署，查看执行进度和结果。" :loading="manualRefreshing" @refresh="refreshManually">
      <el-button @click="cloudTarget = undefined; cloudSettingsOpen = true">云效设置</el-button>
      <el-button :loading="checking" :disabled="!configured" @click="checkConnection">检查 Jenkins</el-button>
      <el-button @click="openSettings">Jenkins 设置</el-button>
    </PageHeading>
    <QueryState :loading="loading" :error="error" :has-data="!!dashboard" @retry="refreshManually">
      <template v-if="dashboard">
        <div class="deployment-layout">
          <aside class="deployment-sidebar" aria-label="部署项目分类">
            <div class="sidebar-heading"><strong>项目分类</strong><span>{{ projects.length }}</span></div>
            <el-input v-model="search" placeholder="搜索项目或仓库" clearable aria-label="搜索部署项目" />
            <nav class="deployment-projects" aria-label="选择部署项目">
              <button v-for="project in projects" :key="project.id" type="button" :class="{ selected: project.id === projectFilter }" :aria-current="project.id === projectFilter ? 'page' : undefined" @click="projectFilter = project.id">
                <Folder :size="16" /><span><strong>{{ project.name }}</strong><small>{{ environmentCount(project.id) }} 个部署环境</small></span>
              </button>
              <p v-if="!projects.length" class="sidebar-empty">没有匹配的项目</p>
            </nav>
          </aside>

          <main class="deployment-main">
            <header class="deployment-project-heading">
              <div><h2>{{ selectedProject?.name || '项目部署' }}</h2><p>{{ selectedProject?.repository || '从左侧选择一个项目，查看部署环境和运行日志。' }}</p></div>
              <el-button type="primary" :disabled="!allProjects.length" @click="addManualDeployment"><Plus :size="15" /> 添加部署</el-button>
            </header>
            <template v-if="selectedProject">
              <section class="environment-section" aria-label="项目部署环境">
                <div class="section-heading"><h3>部署环境 <small>{{ environmentCount(selectedProject.id) }}</small></h3><el-button link @click="editBinding(selectedProject)">从 Jenkins 选择任务</el-button></div>
                <div v-if="environmentCount(selectedProject.id)" class="environment-grid">
                  <article v-for="binding in nativeFor(selectedProject.id)?.environments || []" :key="binding.url" class="environment-card">
                    <header><strong>{{ binding.environment }}</strong><el-tag size="small" effect="plain">云效</el-tag></header>
                    <p class="pipeline-name">{{ binding.name }}</p>
                    <a :href="safeUrl(binding.url)" target="_blank" rel="noopener noreferrer" class="pipeline-address">{{ binding.url }}</a>
                    <div class="environment-status"><StatusPill v-if="latestRun(binding.url)" :value="latestRun(binding.url)?.status" :label="latestRun(binding.url)?.result || labels[latestRun(binding.url)!.status]" /><span v-else>暂无运行记录</span><time v-if="latestRun(binding.url)">{{ dateTime(latestRun(binding.url)?.createdAt) }}</time></div>
                    <footer><el-button type="primary" plain size="small" :loading="cloudPreparing === binding.url || cloudSubmitting && cloudTarget?.binding.url === binding.url" :disabled="active(latestRun(binding.url)) || !!cloudPreparing || cloudSubmitting" @click="prepareCloud(selectedProject, binding)">部署</el-button><el-button v-if="latestRun(binding.url)" link @click="inspectRun(latestRun(binding.url)!)">查看日志</el-button></footer>
                  </article>
                  <article v-for="binding in bindingsFor(selectedProject.id)" :key="binding.id" class="environment-card">
                    <header><strong>{{ binding.environment }}</strong><el-tag size="small" type="info" effect="plain">Jenkins</el-tag></header>
                    <p class="pipeline-name">{{ binding.jobFullName }}</p>
                    <a :href="jenkinsJobUrl(binding)" target="_blank" rel="noopener noreferrer" class="pipeline-address">{{ jenkinsJobUrl(binding) }}</a>
                    <div class="environment-status"><StatusPill v-if="latestRun(binding.id)" :value="latestRun(binding.id)?.status" :label="latestRun(binding.id)?.result || labels[latestRun(binding.id)!.status]" /><span v-else>暂无运行记录</span><time v-if="latestRun(binding.id)">{{ dateTime(latestRun(binding.id)?.createdAt) }}</time></div>
                    <footer><el-button type="primary" plain size="small" :loading="preparingBinding === binding.id || submitting && deployBinding?.id === binding.id" :disabled="active(latestRun(binding.id)) || !!preparingBinding || submitting" @click="prepareDeployment(binding)">{{ latestRun(binding.id)?.status === 'unknown' ? '核对后重新发起' : '部署' }}</el-button><el-button v-if="latestRun(binding.id)" link @click="inspectRun(latestRun(binding.id)!)">查看日志</el-button><span class="environment-spacer"></span><el-button link @click="editBinding(selectedProject, binding)">设置</el-button><el-button link :disabled="active(latestRun(binding.id))" @click="deleteBinding(binding)">解除</el-button></footer>
                  </article>
                </div>
                <el-empty v-else description="还没有部署环境，点击“添加部署”填写流水线地址和环境。" :image-size="64" />
              </section>

              <section class="deployment-execution" aria-label="部署运行与日志">
                <aside class="run-history" aria-label="部署记录">
                  <div class="section-heading"><h3>部署记录</h3><small>{{ runs.length }} 条</small></div>
                  <div class="run-history-list"><button v-for="run in runs" :key="run.id" type="button" :class="{ selected: selectedRun?.id === run.id }" :aria-pressed="selectedRun?.id === run.id" @click="inspectRun(run)"><span><strong>{{ run.environment }}</strong><StatusPill :value="run.status" :label="run.result || labels[run.status]" /></span><small>{{ dateTime(run.createdAt) }}</small><small>{{ run.provider === 'yunxiao' ? `云效 #${run.pipelineRunId || '待返回'}` : run.buildNumber ? `Jenkins #${run.buildNumber}` : run.queueId ? `排队 #${run.queueId}` : '等待构建编号' }}</small></button></div>
                  <p v-if="!runs.length" class="history-empty">暂无运行记录</p>
                </aside>
                <div class="run-console">
                  <div class="section-heading"><h3><Terminal :size="16" /> 运行信息与日志</h3><span v-if="selectedRun" class="live-state">{{ pollable(selectedRun) || logMore ? '每 3 秒更新' : selectedRun.status === 'unknown' ? '状态待核对' : '运行已结束' }}</span></div>
                  <template v-if="selectedRun">
                    <div class="log-heading"><div><strong>{{ selectedRun.environment }}<template v-if="selectedRun.buildNumber"> · #{{ selectedRun.buildNumber }}</template><template v-else-if="selectedRun.pipelineRunId"> · #{{ selectedRun.pipelineRunId }}</template></strong><p>{{ selectedRun.jobFullName }}</p></div><StatusPill :value="selectedRun.status" :label="selectedRun.result || labels[selectedRun.status]" /></div>
                    <p v-if="selectedRun.status === 'unknown'" class="row-secondary">提交结果待核对，请先查看平台运行记录。</p><p v-if="selectedRun.error" class="row-secondary">{{ selectedRun.error }}</p>
                    <ol v-if="selectedRun.steps?.length" class="pipeline-steps" aria-label="流水线实时阶段"><li v-for="(step, index) in selectedRun.steps" :key="`${step.jobId || index}`"><span>{{ step.name }}</span><strong>{{ step.status }}</strong></li></ol>
                    <div class="log-tools">
                      <el-select v-if="selectedRun.provider === 'yunxiao' && logJobs.length" v-model="logJobId" aria-label="选择日志任务" @change="changeLogJob"><el-option v-for="job in logJobs" :key="job.jobId" :label="job.name" :value="job.jobId!" /></el-select>
                      <a v-if="safeUrl(selectedRun.buildUrl)" :href="safeUrl(selectedRun.buildUrl)" target="_blank" rel="noopener noreferrer">打开构建 ↗</a>
                      <el-checkbox v-model="followLog">跟随日志</el-checkbox><el-button size="small" :loading="manualLogRefreshing" @click="readRunLog(true)"><RefreshCw v-if="!manualLogRefreshing" :size="13" /> 刷新日志</el-button>
                    </div>
                    <p v-if="logTruncated" class="row-secondary">页面保留最近 1 MiB 日志，完整日志可在部署平台查看。</p>
                    <pre ref="logElement" class="deployment-log" aria-label="部署实时日志" :aria-busy="logLoading || manualLogRefreshing">{{ logText || (logLoading ? '正在读取日志…' : logError ? '日志读取未完成，请点击刷新日志重试。' : selectedRun.provider === 'yunxiao' && !logJobId ? '等待流水线返回任务日志。' : selectedRun.queueId && !selectedRun.buildNumber ? '正在排队，构建开始后显示日志。' : '暂无日志。') }}</pre>
                  </template>
                  <el-empty v-else description="部署后会在这里显示运行状态和实时日志，也可从左侧记录选择一次运行。" :image-size="64" />
                </div>
              </section>
            </template>
            <el-empty v-else description="请选择一个项目" :image-size="80" />
          </main>
        </div>
      </template>
    </QueryState>

    <el-dialog v-model="manualOpen" title="添加部署" width="min(600px, 94vw)" :close-on-click-modal="false" :close-on-press-escape="!savingManual" :show-close="!savingManual" destroy-on-close>
      <el-form label-position="top" :disabled="savingManual" @submit.prevent="saveManualDeployment">
        <el-form-item label="所属项目"><el-select v-model="manualForm.projectId" filterable class="full-width" aria-label="所属项目"><el-option v-for="project in allProjects" :key="project.id" :label="project.name" :value="project.id" /></el-select></el-form-item>
        <el-form-item label="环境"><el-input v-model="manualForm.environment" placeholder="例如 test、pre、prod 或自定义环境" maxlength="80" aria-label="部署环境" /></el-form-item>
        <el-form-item label="流水线地址"><el-input v-model="manualForm.url" placeholder="粘贴 Jenkins 任务或云效流水线的完整地址" autocomplete="url" aria-label="流水线地址" maxlength="2000" /></el-form-item>
      </el-form>
      <template #footer><el-button :disabled="savingManual" @click="manualOpen = false">取消</el-button><el-button type="primary" :loading="savingManual" :disabled="!manualForm.projectId || !manualForm.environment.trim() || !validManualUrl" @click="saveManualDeployment">保存部署</el-button></template>
    </el-dialog>
    <el-dialog v-model="cloudSettingsOpen" title="云效连接" width="min(560px, 94vw)" :close-on-click-modal="false" destroy-on-close>
      <el-form label-position="top" :disabled="cloudSaving" @submit.prevent="saveCloudSettings"><el-form-item label="个人访问令牌"><el-input v-model="cloudToken" type="password" autocomplete="new-password" :placeholder="cloudConfigured ? '已保存令牌，输入新令牌可更换' : '输入具有流水线读写权限的个人访问令牌'" /><span class="row-secondary">仅保存在本机数据目录的 yunxiao-credentials.json，页面不会读取原值。浏览器登录不替代 API 令牌。</span></el-form-item></el-form>
      <template #footer><el-button :disabled="cloudSaving" @click="cloudSettingsOpen = false">取消</el-button><el-button type="primary" :loading="cloudSaving" :disabled="!cloudToken.trim()" @click="saveCloudSettings">保存连接</el-button></template>
    </el-dialog>
    <el-dialog v-model="cloudDeployOpen" title="确认部署" width="min(660px, 94vw)" :close-on-click-modal="false" :close-on-press-escape="!cloudSubmitting" :show-close="!cloudSubmitting" destroy-on-close>
      <template v-if="cloudTarget && cloudPipeline"><dl class="deployment-facts"><dt>项目</dt><dd>{{ cloudTarget.project.name }}</dd><dt>环境</dt><dd>{{ cloudTarget.binding.environment }}</dd><dt>云效流水线</dt><dd>{{ cloudPipeline.name }}</dd></dl>
        <el-form label-position="top" :disabled="cloudSubmitting"><el-form-item v-for="source in cloudPipeline.sources" :key="source.repo" :label="source.repo"><el-input v-model="cloudBranches[source.repo]" placeholder="部署分支" :aria-label="`${source.repo} 部署分支`" /></el-form-item></el-form>
        <el-checkbox v-if="latestRun(cloudTarget.binding.url)?.status === 'unknown'" v-model="cloudAcknowledged" :disabled="cloudSubmitting">已核对上次提交结果，确认可重新发起</el-checkbox>
      </template>
      <template #footer><el-button :disabled="cloudSubmitting" @click="cloudDeployOpen = false">取消</el-button><el-button type="primary" :loading="cloudSubmitting" :disabled="!cloudPipeline || Object.values(cloudBranches).some(branch => !branch.trim()) || !!cloudTarget && latestRun(cloudTarget.binding.url)?.status === 'unknown' && !cloudAcknowledged" @click="startCloudDeployment">确认部署</el-button></template>
    </el-dialog>

    <el-dialog v-model="settingsOpen" title="Jenkins 连接" width="min(560px, 94vw)" :close-on-click-modal="false" destroy-on-close>
      <el-form label-position="top" :disabled="savingSettings" @submit.prevent="saveSettings"><el-form-item label="Jenkins 地址"><el-input v-model="connection.baseUrl" placeholder="https://jenkins.example.com" autocomplete="url" /></el-form-item><el-form-item label="用户名"><el-input v-model="connection.username" autocomplete="username" /></el-form-item><el-form-item label="API Token"><el-input v-model="connection.token" type="password" autocomplete="new-password" :placeholder="configured ? '已保存 Token，留空保留' : '输入 Jenkins API Token'" /><span class="row-secondary">{{ configured ? 'Token 已保存，页面不会读取原值。' : '请使用拥有对应任务读取、构建权限的账号。' }}</span></el-form-item></el-form>
      <template #footer><el-button :disabled="savingSettings" @click="settingsOpen = false">取消</el-button><el-button type="primary" :loading="savingSettings" :disabled="!connection.baseUrl.trim() || !connection.username.trim() || !configured && !connection.token" @click="saveSettings">保存连接</el-button></template>
    </el-dialog>
    <el-dialog v-model="bindingOpen" :title="bindingForm.id ? '设置流水线关联' : '关联流水线'" width="min(660px, 94vw)" :close-on-click-modal="false" destroy-on-close>
      <el-form label-position="top" :disabled="savingBinding"><el-form-item label="项目"><el-select v-model="bindingForm.projectId" filterable class="full-width"><el-option v-for="project in dashboard?.projects" :key="project.id" :label="project.name" :value="project.id" /></el-select></el-form-item><el-form-item label="环境名称"><el-input v-model="bindingForm.environment" placeholder="例如：测试、预发布、生产" maxlength="80" /></el-form-item><el-form-item label="Jenkins 任务"><div class="job-picker"><el-select v-model="bindingForm.jobFullName" :loading="jobsLoading" filterable placeholder="搜索并选择 Jenkins 任务" class="full-width"><el-option v-for="job in jobs" :key="job.fullName" :label="job.fullName" :value="job.fullName" /></el-select><el-button :loading="jobsLoading" @click="readJobs">刷新任务</el-button></div></el-form-item><p class="row-secondary">关联后点击部署将执行这个任务，请核对任务对应的环境与分支。</p></el-form>
      <template #footer><el-button :disabled="savingBinding" @click="bindingOpen = false">取消</el-button><el-button type="primary" :loading="savingBinding" :disabled="!bindingForm.projectId || !bindingForm.environment.trim() || !bindingForm.jobFullName" @click="saveBinding">保存关联</el-button></template>
    </el-dialog>
    <el-dialog v-model="deployOpen" :title="unknownDeployment ? '核对后重新发起部署' : '确认部署'" width="min(660px, 94vw)" :close-on-click-modal="false" :close-on-press-escape="!submitting" :show-close="!submitting" destroy-on-close>
      <template v-if="deployBinding && deployJob"><dl class="deployment-facts"><dt>项目</dt><dd>{{ dashboard?.projects.find(item => item.id === deployBinding?.projectId)?.name }}</dd><dt>环境</dt><dd>{{ deployBinding.environment }}</dd><dt>Jenkins 任务</dt><dd><a :href="safeUrl(deployJob.url)" target="_blank" rel="noopener noreferrer">{{ deployJob.fullName }} ↗</a></dd></dl><p class="row-secondary">确认后将按该 Jenkins 任务执行构建和部署。</p><template v-if="unknownDeployment"><p class="row-secondary">上次请求结果不确定，请先确认 Jenkins 中没有正在执行的同次构建；继续会提交新的构建。</p><p class="row-secondary">核对地址：<a :href="safeUrl(deployJob.url)" target="_blank" rel="noopener noreferrer">{{ deployJob.url }}</a></p><el-checkbox v-model="acknowledgeUnknown" :disabled="submitting">已在 Jenkins 核对，确认可重新发起</el-checkbox></template><p v-if="!deployJob.buildable" class="deployment-problem">当前 Jenkins 任务不可构建，请在 Jenkins 中核对任务状态。</p><p v-if="unsupported.length" class="deployment-problem">当前页面不支持这些任务参数：{{ unsupported.map(item => item.name).join('、') }}。请在 Jenkins 中发起该任务。</p><el-form label-position="top" :disabled="submitting"><el-form-item v-for="parameter in deployJob.parameters.filter(item => item.type !== 'unsupported')" :key="parameter.name" :label="parameter.name"><el-switch v-if="parameter.type === 'boolean'" v-model="parameters[parameter.name]" :aria-label="parameter.name" /><el-select v-else-if="parameter.type === 'choice'" v-model="parameters[parameter.name]" class="full-width" :aria-label="parameter.name"><el-option v-for="choice in parameter.choices" :key="choice" :label="choice" :value="choice" /></el-select><el-input v-else v-model="parameters[parameter.name]" :type="parameter.type === 'password' ? 'password' : 'text'" :autocomplete="parameter.type === 'password' ? 'new-password' : 'off'" :aria-label="parameter.name" /><span v-if="parameter.description" class="row-secondary">{{ parameter.description }}</span></el-form-item></el-form><p v-if="!deployJob.parameters.length" class="row-secondary">此 Jenkins 任务没有可填写参数。</p></template>
      <template #footer><el-button :disabled="submitting" @click="deployOpen = false">取消</el-button><el-button type="primary" :loading="submitting" :disabled="!canDeploy" @click="startDeployment">确认部署</el-button></template>
    </el-dialog>

  </section>
</template>

<style scoped>
.deployment-workspace{min-width:0}.deployment-layout{display:grid;grid-template-columns:240px minmax(0,1fr);align-items:start;border:1px solid var(--ui-border);border-radius:10px;background:var(--ui-surface);overflow:clip}
.deployment-sidebar{min-width:0;display:flex;flex-direction:column;gap:12px;position:sticky;top:0;align-self:start;box-sizing:border-box;padding:18px 12px;border-right:1px solid var(--ui-border);background:var(--ui-raised,var(--ui-bg))}.sidebar-heading{display:flex;justify-content:space-between;align-items:center;padding:0 6px;font-size:14px}.sidebar-heading>span{font-size:12px;color:var(--ui-muted)}.deployment-sidebar>.el-checkbox{margin:0 6px;height:24px}.deployment-projects{min-width:0;max-width:100%;display:flex;flex-direction:column;gap:5px;min-height:0;max-height:min(48dvh,26rem);overflow:auto;flex:1}.deployment-projects>button{display:flex;align-items:flex-start;gap:9px;width:100%;padding:12px 10px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--ui-text);text-align:left;cursor:pointer;font:inherit}.deployment-projects>button>svg{flex-shrink:0;margin-top:2px;color:var(--ui-muted)}.deployment-projects>button>span{min-width:0}.deployment-projects strong,.deployment-projects small{display:block;overflow-wrap:anywhere}.deployment-projects strong{font-size:13px;font-weight:550;line-height:1.55}.deployment-projects small{margin-top:4px;font-size:11px;color:var(--ui-muted)}.deployment-projects>button:hover{background:var(--ui-accent-soft)}.deployment-projects>button.selected{border-color:color-mix(in srgb,var(--ui-accent) 35%,transparent);background:var(--ui-accent-soft);color:var(--ui-accent)}.sidebar-empty,.history-empty{padding:12px;color:var(--ui-muted);font-size:12px}
.deployment-main{min-width:0;padding:20px 22px}.deployment-project-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding-bottom:18px;border-bottom:1px solid var(--ui-divider,var(--ui-border))}.deployment-project-heading>div{min-width:0}.deployment-project-heading h2{margin:0;font-size:19px;line-height:1.5}.deployment-project-heading p{margin:6px 0 0;color:var(--ui-muted);font-size:12px;overflow-wrap:anywhere}.deployment-project-heading>.el-button{flex-shrink:0}.deployment-project-heading :deep(.el-button>span){gap:5px}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 14px}.section-heading h3{display:flex;align-items:center;gap:7px;margin:0;font-size:14px;font-weight:550;line-height:1.6}.section-heading small,.live-state{color:var(--ui-muted);font-size:11px;font-weight:400}.environment-section{padding:18px 0 22px}.environment-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(230px,100%),1fr));gap:12px}.environment-card{display:flex;flex-direction:column;min-width:0;padding:14px;border:1px solid var(--ui-border);border-radius:8px;background:var(--ui-surface)}.environment-card>header{display:flex;align-items:center;gap:9px}.environment-card>header>strong{font-size:15px;overflow-wrap:anywhere}.pipeline-name{margin:10px 0 5px;font-size:12px;line-height:1.65;overflow-wrap:anywhere}.pipeline-address{display:block;color:var(--ui-muted);font:10px/1.6 var(--mono);overflow-wrap:anywhere;text-decoration:none}.pipeline-address:hover{color:var(--ui-accent);text-decoration:underline}.environment-status{display:flex;align-items:center;flex-wrap:wrap;gap:7px;margin:12px 0;color:var(--ui-muted);font-size:11px}.environment-card>footer{display:flex;align-items:center;flex-wrap:wrap;gap:7px;margin-top:auto;padding-top:10px;border-top:1px solid var(--ui-divider,var(--ui-border))}.environment-card>footer .el-button+.el-button{margin-left:0}.environment-spacer{flex:1}
.deployment-execution{display:grid;grid-template-columns:205px minmax(0,1fr);border:1px solid var(--ui-border);border-radius:8px;overflow:hidden}.run-history{min-width:0;padding:15px 10px;background:var(--ui-raised,var(--ui-bg));border-right:1px solid var(--ui-border)}.run-history>.section-heading{padding:0 4px}.run-history-list{display:flex;flex-direction:column;gap:7px;max-height:min(42dvh,340px);overflow:auto}.run-history-list>button{display:block;width:100%;padding:10px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--ui-text);text-align:left;cursor:pointer}.run-history-list>button>span{display:flex;align-items:center;justify-content:space-between;gap:8px}.run-history-list>button>span>strong{overflow-wrap:anywhere}.run-history-list>button>small{display:block;color:var(--ui-muted);font-size:10px;line-height:1.6;margin-top:4px}.run-history-list>button.selected{border-color:var(--ui-border);background:var(--ui-surface)}.run-history-list>button:hover{background:var(--ui-accent-soft)}.run-history-list :deep(.status-pill){padding:3px 5px;font-size:10px}
.run-console{min-width:0;padding:16px}.log-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.log-heading>div{min-width:0}.log-heading strong{font-size:14px}.log-heading p{margin:5px 0;color:var(--ui-muted);font:11px/1.6 var(--mono);overflow-wrap:anywhere}.pipeline-steps{display:flex;gap:8px;flex-wrap:wrap;padding:0;margin:12px 0;list-style:none}.pipeline-steps>li{display:flex;gap:10px;padding:5px 8px;border:1px solid var(--ui-border);border-radius:5px;font-size:11px;overflow-wrap:anywhere}.pipeline-steps>li>strong{font-size:10px;font-weight:500;color:var(--ui-muted)}.log-tools{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:14px 0 10px;font-size:12px}.log-tools :deep(.el-select){width:190px;max-width:100%}.log-tools a{color:var(--ui-accent)}.log-tools>.el-checkbox{margin-left:auto}.log-tools :deep(.el-button>span){gap:5px}.deployment-log{max-height:min(48dvh,360px);overflow:auto;box-sizing:border-box;margin:0;padding:14px;border:1px solid var(--ui-border);border-radius:6px;background:var(--ui-raised,var(--ui-bg));color:var(--ui-text);font:12px/1.75 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2}
.full-width,.job-picker{width:100%}.job-picker{display:flex;gap:8px}.job-picker>.el-select{flex:1;min-width:0}.job-picker>.el-button{flex:none}.deployment-facts{display:grid;grid-template-columns:86px minmax(0,1fr);gap:10px 14px;margin:0 0 20px;font-size:13px;line-height:1.7}.deployment-facts dt{color:var(--ui-muted)}.deployment-facts dd{margin:0;overflow-wrap:anywhere}.deployment-facts a{color:var(--ui-accent)}.deployment-problem{color:var(--ui-danger);font-size:13px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere}
@media(max-height:680px){.deployment-sidebar{position:static}}
@container workspace-page (max-width:1100px){.deployment-layout{grid-template-columns:205px minmax(0,1fr)}.deployment-main{padding:16px}.deployment-execution{grid-template-columns:175px minmax(0,1fr)}.run-console{padding:12px}.log-tools>.el-checkbox{margin-left:0}}
@container workspace-page (max-width:800px){.deployment-layout{grid-template-columns:minmax(0,1fr)}.deployment-sidebar{position:static;border-right:0;border-bottom:1px solid var(--ui-border);padding:14px}.deployment-projects{min-width:0;max-width:100%;display:flex;flex-direction:row;overflow:auto;max-height:150px}.deployment-projects>button{width:180px;flex:0 0 180px}.deployment-sidebar>.el-input{max-width:100%}.deployment-main{padding:14px}.deployment-execution{grid-template-columns:minmax(0,1fr)}.run-history{border-right:0;border-bottom:1px solid var(--ui-border)}.run-history-list{flex-direction:row}.run-history-list>button{min-width:165px;width:165px;flex-shrink:0}.deployment-project-heading{gap:12px}.deployment-project-heading h2{font-size:17px}.deployment-log{max-height:min(48dvh,320px)}}
@media(max-width:550px){.deployment-layout{grid-template-columns:minmax(0,1fr)}.deployment-sidebar{position:static;border-right:0;border-bottom:1px solid var(--ui-border)}.deployment-projects{flex-direction:row}.deployment-projects>button{flex:0 0 160px}.deployment-main{padding:12px}.deployment-project-heading{flex-wrap:wrap}.deployment-execution{grid-template-columns:minmax(0,1fr)}.run-history{border-right:0;border-bottom:1px solid var(--ui-border)}.run-history-list{flex-direction:row}.run-history-list>button{flex:0 0 165px}.job-picker{flex-direction:column}.deployment-facts{grid-template-columns:70px minmax(0,1fr)}.log-tools>.el-checkbox{margin-left:0}.log-tools{gap:8px}.log-tools :deep(.el-select){width:100%}}
</style>
