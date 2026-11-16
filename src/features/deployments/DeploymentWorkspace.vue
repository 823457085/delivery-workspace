<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import type { InputInstance } from 'element-plus';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ArrowDownToLine, Check, Copy, Download, Folder, Plus, RefreshCw, Search, Terminal } from '@lucide/vue';
import type { DeploymentBinding, DeploymentDashboard, DeploymentLog, DeploymentProject, DeploymentRun, DeploymentStart, DeploymentStatus, JenkinsJob, YunxiaoPipeline } from '../../../shared/deployments';
import { dateTime, safeUrl, searchMatches } from '../../shared/format';
import { useWorkspacePanelState } from '../../shared/useWorkspacePanelState';
import PageHeading from '../../shared/ui/PageHeading.vue';
import MetricStrip from '../../shared/ui/MetricStrip.vue';
import QueryState from '../../shared/ui/QueryState.vue';
import StatusPill from '../../shared/ui/StatusPill.vue';
import { classifyEnvironmentTier, environmentTierLabel } from '../system-catalog/catalog-studio';
import { deploymentApi } from './api';
import { parseStructuredLogLines, stripAnsiCodes } from './deployment-studio';
import { mergeDeploymentProjects, parseDeploymentLinks, type NativeDeploymentProject } from './native-deployments';

const dashboard = shallowRef<DeploymentDashboard>();
const nativeProjects = shallowRef<NativeDeploymentProject[]>([]);
const nativeFor = (id: string) => nativeProjects.value.find(project => project.id === id);
const allProjects = computed(() => mergeDeploymentProjects(dashboard.value?.projects || [], nativeProjects.value));
const isConfigured = (id: string) => bindingsFor(id).length > 0 || !!nativeFor(id)?.environments.length;
const error = shallowRef<Error | null>(null), loading = ref(true), manualRefreshing = ref(false);
const { search, projectFilter, providerFilter } = useWorkspacePanelState('deployments', () => ({
  search: '',
  projectFilter: '',
  providerFilter: 'all' as 'all' | 'yunxiao' | 'jenkins',
}));
const searchInputRef = ref<InputInstance>();
const copiedToken = shallowRef('');
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

const labels: Record<DeploymentStatus, string> = { dispatching: '提交中', queued: '排队中', running: '发布中', success: '已成功', failed: '失败', cancelled: '已取消', unknown: '待确认' };
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

const totalCloudEnvs = computed(() => nativeProjects.value.reduce((sum, item) => sum + item.environments.length, 0));
const totalJenkinsEnvs = computed(() => dashboard.value?.bindings.length || 0);
const activeRunCount = computed(() => (dashboard.value?.runs || []).filter(run => pollable(run)).length);
const metrics = computed(() => [
  {
    label: '已接入部署项目',
    value: dashboard.value ? allProjects.value.filter(item => isConfigured(item.id)).length : undefined,
    note: `共 ${allProjects.value.length} 个候选仓库`,
  },
  {
    label: '多环境发布入口',
    value: dashboard.value ? totalCloudEnvs.value + totalJenkinsEnvs.value : undefined,
    note: `云效 ${totalCloudEnvs.value} · Jenkins ${totalJenkinsEnvs.value}`,
    tone: 'primary' as const,
  },
  {
    label: '运行 / 排队中',
    value: dashboard.value ? activeRunCount.value : undefined,
    note: `历史记录 ${dashboard.value?.runs.length ?? 0} 条`,
    tone: activeRunCount.value > 0 ? ('warning' as const) : undefined,
  },
  {
    label: '平台凭据状态',
    value: configured.value && cloudConfigured.value
      ? '双平台就绪'
      : configured.value
        ? 'Jenkins 就绪'
        : cloudConfigured.value
          ? '云效就绪'
          : '待配置',
    note: `${configured.value ? 'Jenkins ✓' : 'Jenkins 未配'} · ${cloudConfigured.value ? '云效 ✓' : '云效未配'}`,
    tone: configured.value || cloudConfigured.value ? ('success' as const) : ('warning' as const),
  },
]);

const selectedCloudBindings = computed(() => selectedProject.value ? (nativeFor(selectedProject.value.id)?.environments || []) : []);
const selectedJenkinsBindings = computed(() => selectedProject.value ? bindingsFor(selectedProject.value.id) : []);
const visibleCloudBindings = computed(() => providerFilter.value === 'jenkins' ? [] : selectedCloudBindings.value);
const visibleJenkinsBindings = computed(() => providerFilter.value === 'yunxiao' ? [] : selectedJenkinsBindings.value);

async function copyQuickText(value: string, tokenKey: string, label: string) {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    copiedToken.value = tokenKey;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      if (copiedToken.value === tokenKey) copiedToken.value = '';
    }, 1500);
    ElMessage.success(`已复制${label}`);
  } catch {
    ElMessage.error('浏览器未允许复制');
  }
}

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
const connection = reactive({ baseUrl: 'https://jenkins.hahabianli.com', username: 'lizirui', token: '' });
function openSettings() {
  Object.assign(connection, { baseUrl: dashboard.value?.config.baseUrl || 'https://jenkins.hahabianli.com', username: dashboard.value?.config.username || 'lizirui', token: '' });
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

const resolvingRun = ref(false);
async function resolveStuckRun(run: DeploymentRun, resolution: 'cancelled' | 'failed' = 'cancelled') {
  if (resolvingRun.value || !['dispatching', 'queued', 'running', 'unknown'].includes(run.status)) return;
  if (!await confirm(
    '人工核对并标记部署已结束',
    `请先在 ${run.provider === 'yunxiao' ? '云效' : 'Jenkins'} 确认“${run.environment} · ${run.jobFullName}”已不再运行或已被清理。此操作仅更新本地状态以解除环境部署与安全重启锁定，不会远程中止平台任务。`,
  )) return;
  resolvingRun.value = true;
  try {
    const endpoint = run.provider === 'yunxiao' ? '/yunxiao/runs/resolve' : '/runs/resolve';
    const updated = await deploymentApi<DeploymentRun>(endpoint, { body: { id: run.id, resolution } });
    if (disposed) return;
    selectedRun.value = updated;
    ElMessage.success('已标记该部署记录为已结束');
    await refresh(true);
  } catch (cause) {
    if (!disposed) ElMessage.error(message(cause));
  } finally {
    resolvingRun.value = false;
  }
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
const logKeyword = ref('');
const logLevelFilter = ref<'all' | 'issues'>('all');
const logJobs = computed(() => (selectedRun.value?.steps || []).filter(step => step.jobId));
const logElement = ref<HTMLElement>();
const parsedLog = computed(() => parseStructuredLogLines(logText.value, {
  keyword: logKeyword.value,
  levelFilter: logLevelFilter.value,
}));
const logIssueCount = computed(() => parsedLog.value.errorCount + parsedLog.value.warnCount);

function scrollLogToBottom() {
  if (logElement.value) logElement.value.scrollTop = logElement.value.scrollHeight;
}
function downloadLogFile() {
  const clean = stripAnsiCodes(logText.value || '');
  if (!clean.trim()) return;
  const blob = new Blob([clean], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const projSlug = (selectedProject.value?.name || 'deploy').replace(/[^A-Za-z0-9\u4e00-\u9fa5_-]+/g, '-');
  const envSlug = (selectedRun.value?.environment || 'log').replace(/[^A-Za-z0-9\u4e00-\u9fa5_-]+/g, '-');
  link.href = url;
  link.download = `${projSlug}-${envSlug}.log`;
  link.click();
  URL.revokeObjectURL(url);
}

let selectionVersion = 0, logBusy = false;
function inspectRun(run: DeploymentRun) {
  selectionVersion++; selectedRun.value = run; logJobId.value = ''; logText.value = ''; logOffset.value = 0; logTruncated.value = false; logError.value = ''; logMore.value = true; logOpen.value = true;
  logKeyword.value = ''; logLevelFilter.value = 'all';
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
    if (followLog.value) { await nextTick(); scrollLogToBottom(); }
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

function onDeployKeydown(event: KeyboardEvent) {
  if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target as HTMLElement | null;
  if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return;
  if (document.querySelector('.el-dialog, .el-drawer, .cmd-palette-backdrop')) return;
  event.preventDefault();
  searchInputRef.value?.focus();
}

let timer: ReturnType<typeof setInterval> | undefined, polling = false;
onMounted(() => {
  document.addEventListener('keydown', onDeployKeydown);
  void refresh();
  timer = setInterval(async () => {
    if (polling || disposed || (typeof document !== 'undefined' && document.hidden)) return;
    polling = true;
    try {
      if (dashboard.value?.runs.some(pollable)) await refresh();
      if (logOpen.value && (pollable(selectedRun.value) || logMore.value)) await readRunLog();
    } finally { polling = false; }
  }, 3000);
});
onBeforeUnmount(() => {
  disposed = true;
  document.removeEventListener('keydown', onDeployKeydown);
  if (timer) clearInterval(timer);
  if (copiedTimer) clearTimeout(copiedTimer);
  readController.abort();
  connection.token = ''; cloudToken.value = ''; parameters.value = {};
});
function message(cause: unknown) { return cause instanceof Error ? cause.message : String(cause); }
async function confirm(title: string, detail: string) {
  try { await ElMessageBox.confirm(detail, title, { confirmButtonText: '确认执行', cancelButtonText: '取消', type: 'warning', closeOnClickModal: false }); return !disposed; }
  catch { return false; }
}
</script>

<template>
  <section class="deployment-workspace">
    <PageHeading title="部署发布" description="在工作台统一发起云效与 Jenkins 多环境发布，支持结构化日志检索与异常定位。" :loading="manualRefreshing" @refresh="refreshManually">
      <el-button @click="cloudTarget = undefined; cloudSettingsOpen = true">云效设置</el-button>
      <el-button :loading="checking" :disabled="!configured" @click="checkConnection">检查 Jenkins</el-button>
      <el-button @click="openSettings">Jenkins 设置</el-button>
    </PageHeading>
    <MetricStrip :items="metrics" />
    <QueryState :loading="loading" :error="error" :has-data="!!dashboard" @retry="refreshManually">
      <template v-if="dashboard">
        <div class="deployment-layout">
          <aside class="deployment-sidebar" aria-label="部署项目分类">
            <div class="sidebar-heading"><strong>项目分类</strong><span>{{ projects.length }}</span></div>
            <el-input
              ref="searchInputRef"
              v-model="search"
              placeholder="搜索项目或仓库"
              clearable
              aria-label="搜索部署项目"
              @keydown.esc="search = ''"
            >
              <template #prefix><Search :size="14" /></template>
              <template v-if="!search" #suffix><kbd class="deploy-kbd">/</kbd></template>
            </el-input>
            <nav class="deployment-projects" aria-label="选择部署项目">
              <button v-for="project in projects" :key="project.id" type="button" :class="{ selected: project.id === projectFilter }" :aria-current="project.id === projectFilter ? 'page' : undefined" @click="projectFilter = project.id">
                <Folder :size="15" />
                <span>
                  <strong>{{ project.name }}</strong>
                  <small>{{ environmentCount(project.id) }} 个环境<template v-if="nativeFor(project.id)?.environments.length"> · 云效 {{ nativeFor(project.id)?.environments.length }}</template><template v-if="bindingsFor(project.id).length"> · Jenkins {{ bindingsFor(project.id).length }}</template></small>
                </span>
              </button>
              <p v-if="!projects.length" class="sidebar-empty">没有匹配的项目</p>
            </nav>
          </aside>

          <main class="deployment-main">
            <header class="deployment-project-heading">
              <div>
                <h2>{{ selectedProject?.name || '项目部署' }}</h2>
                <p class="deployment-repo-sub">{{ selectedProject?.repository || '从左侧选择一个项目，查看部署环境和运行日志。' }}</p>
              </div>
              <el-button type="primary" :disabled="!allProjects.length" @click="addManualDeployment"><Plus :size="15" /> 添加部署</el-button>
            </header>
            <template v-if="selectedProject">
              <section class="environment-section" aria-label="项目部署环境">
                <div class="section-heading">
                  <div class="section-heading-left">
                    <h3>部署环境 <small>{{ environmentCount(selectedProject.id) }}</small></h3>
                    <div class="deploy-provider-pills" role="tablist" aria-label="按部署平台过滤">
                      <button type="button" class="deploy-provider-pill" :class="{ 'is-active': providerFilter === 'all' }" @click="providerFilter = 'all'">
                        全部 <b>{{ selectedCloudBindings.length + selectedJenkinsBindings.length }}</b>
                      </button>
                      <button v-if="selectedCloudBindings.length" type="button" class="deploy-provider-pill" :class="{ 'is-active': providerFilter === 'yunxiao' }" @click="providerFilter = 'yunxiao'">
                        云效 <b>{{ selectedCloudBindings.length }}</b>
                      </button>
                      <button v-if="selectedJenkinsBindings.length" type="button" class="deploy-provider-pill" :class="{ 'is-active': providerFilter === 'jenkins' }" @click="providerFilter = 'jenkins'">
                        Jenkins <b>{{ selectedJenkinsBindings.length }}</b>
                      </button>
                    </div>
                  </div>
                  <el-button link @click="editBinding(selectedProject)">从 Jenkins 选择任务</el-button>
                </div>
                <div v-if="visibleCloudBindings.length || visibleJenkinsBindings.length" class="environment-grid">
                  <article v-for="binding in visibleCloudBindings" :key="binding.url" class="environment-card" :data-tier="classifyEnvironmentTier(binding.environment)">
                    <header>
                      <span class="deploy-tier-badge" :data-tier="classifyEnvironmentTier(binding.environment)">{{ environmentTierLabel(classifyEnvironmentTier(binding.environment)) }}</span>
                      <strong>{{ binding.environment }}</strong>
                      <el-tag size="small" effect="plain">云效</el-tag>
                    </header>
                    <p class="pipeline-name">{{ binding.name }}</p>
                    <a :href="safeUrl(binding.url)" target="_blank" rel="noopener noreferrer" class="pipeline-address">{{ binding.url }}</a>
                    <div class="environment-status"><StatusPill v-if="latestRun(binding.url)" :value="latestRun(binding.url)?.status" :label="latestRun(binding.url)?.result || labels[latestRun(binding.url)!.status]" /><span v-else>暂无运行记录</span><time v-if="latestRun(binding.url)">{{ dateTime(latestRun(binding.url)?.createdAt) }}</time></div>
                    <footer>
                      <el-button type="primary" plain size="small" :loading="cloudPreparing === binding.url || cloudSubmitting && cloudTarget?.binding.url === binding.url" :disabled="active(latestRun(binding.url)) || !!cloudPreparing || cloudSubmitting" @click="prepareCloud(selectedProject, binding)">部署</el-button>
                      <el-button v-if="latestRun(binding.url)" link @click="inspectRun(latestRun(binding.url)!)">查看日志</el-button>
                      <span class="environment-spacer"></span>
                      <button type="button" class="deploy-copy-chip" :class="{ 'is-copied': copiedToken === binding.url }" title="复制流水线地址" @click="copyQuickText(binding.url, binding.url, '流水线地址')">
                        <Check v-if="copiedToken === binding.url" :size="11" /><Copy v-else :size="11" />
                        <span>{{ copiedToken === binding.url ? '已复制' : '复制' }}</span>
                      </button>
                    </footer>
                  </article>
                  <article v-for="binding in visibleJenkinsBindings" :key="binding.id" class="environment-card" :data-tier="classifyEnvironmentTier(binding.environment)">
                    <header>
                      <span class="deploy-tier-badge" :data-tier="classifyEnvironmentTier(binding.environment)">{{ environmentTierLabel(classifyEnvironmentTier(binding.environment)) }}</span>
                      <strong>{{ binding.environment }}</strong>
                      <el-tag size="small" type="info" effect="plain">Jenkins</el-tag>
                    </header>
                    <p class="pipeline-name">{{ binding.jobFullName }}</p>
                    <a :href="jenkinsJobUrl(binding)" target="_blank" rel="noopener noreferrer" class="pipeline-address">{{ jenkinsJobUrl(binding) }}</a>
                    <div class="environment-status"><StatusPill v-if="latestRun(binding.id)" :value="latestRun(binding.id)?.status" :label="latestRun(binding.id)?.result || labels[latestRun(binding.id)!.status]" /><span v-else>暂无运行记录</span><time v-if="latestRun(binding.id)">{{ dateTime(latestRun(binding.id)?.createdAt) }}</time></div>
                    <footer>
                      <el-button type="primary" plain size="small" :loading="preparingBinding === binding.id || submitting && deployBinding?.id === binding.id" :disabled="active(latestRun(binding.id)) || !!preparingBinding || submitting" @click="prepareDeployment(binding)">{{ latestRun(binding.id)?.status === 'unknown' ? '核对后重新发起' : '部署' }}</el-button>
                      <el-button v-if="latestRun(binding.id)" link @click="inspectRun(latestRun(binding.id)!)">查看日志</el-button>
                      <span class="environment-spacer"></span>
                      <button type="button" class="deploy-copy-chip" :class="{ 'is-copied': copiedToken === binding.id }" title="复制任务地址" @click="copyQuickText(jenkinsJobUrl(binding) || '', binding.id, '任务地址')">
                        <Check v-if="copiedToken === binding.id" :size="11" /><Copy v-else :size="11" />
                      </button>
                      <el-button link @click="editBinding(selectedProject, binding)">设置</el-button>
                      <el-button link :disabled="active(latestRun(binding.id))" @click="deleteBinding(binding)">解除</el-button>
                    </footer>
                  </article>
                </div>
                <el-empty v-else description="当前筛选下暂无部署环境，可切换筛选或点击“添加部署”。" :image-size="64" />
              </section>

              <section class="deployment-execution" aria-label="部署运行与日志">
                <aside class="run-history" aria-label="部署记录">
                  <div class="section-heading"><h3>部署记录</h3><small>{{ runs.length }} 条</small></div>
                  <div class="run-history-list"><button v-for="run in runs" :key="run.id" type="button" :class="{ selected: selectedRun?.id === run.id }" :aria-pressed="selectedRun?.id === run.id" @click="inspectRun(run)"><span><strong>{{ run.environment }}</strong><StatusPill :value="run.status" :label="run.result || labels[run.status]" /></span><small>{{ dateTime(run.createdAt) }}</small><small>{{ run.provider === 'yunxiao' ? `云效 #${run.pipelineRunId || '待返回'}` : run.buildNumber ? `Jenkins #${run.buildNumber}` : run.queueId ? `排队 #${run.queueId}` : '等待构建编号' }}</small></button></div>
                  <p v-if="!runs.length" class="history-empty">暂无运行记录</p>
                </aside>
                <div class="run-console">
                  <div class="section-heading"><h3><Terminal :size="16" /> 运行信息与结构化日志</h3><span v-if="selectedRun" class="live-state">{{ pollable(selectedRun) || logMore ? '自动刷新中' : selectedRun.status === 'unknown' ? '状态待核对' : '运行已结束' }}</span></div>
                  <template v-if="selectedRun">
                    <div class="log-heading"><div><strong>{{ selectedRun.environment }}<template v-if="selectedRun.buildNumber"> · #{{ selectedRun.buildNumber }}</template><template v-else-if="selectedRun.pipelineRunId"> · #{{ selectedRun.pipelineRunId }}</template></strong><p>{{ selectedRun.jobFullName }}</p></div><StatusPill :value="selectedRun.status" :label="selectedRun.result || labels[selectedRun.status]" /></div>
                    <p v-if="selectedRun.status === 'unknown'" class="row-secondary">提交结果待核对，请先查看平台运行记录。</p><p v-if="selectedRun.error" class="row-secondary">{{ selectedRun.error }}</p>
                    <ol v-if="selectedRun.steps?.length" class="pipeline-steps" aria-label="流水线实时阶段"><li v-for="(step, index) in selectedRun.steps" :key="`${step.jobId || index}`"><span>{{ step.name }}</span><strong>{{ step.status }}</strong></li></ol>
                    <div class="log-tools">
                      <el-select v-if="selectedRun.provider === 'yunxiao' && logJobs.length" v-model="logJobId" aria-label="选择日志任务" @change="changeLogJob"><el-option v-for="job in logJobs" :key="job.jobId" :label="job.name" :value="job.jobId!" /></el-select>
                      <el-input v-model="logKeyword" clearable placeholder="检索日志行…" class="log-search-input" aria-label="检索日志关键字" @keydown.esc="logKeyword = ''">
                        <template #prefix><Search :size="13" /></template>
                      </el-input>
                      <div class="log-level-pills" role="group" aria-label="日志级别过滤">
                        <button type="button" class="deploy-provider-pill" :class="{ 'is-active': logLevelFilter === 'all' }" @click="logLevelFilter = 'all'">
                          全部 <b>{{ parsedLog.totalLines }}</b>
                        </button>
                        <button type="button" class="deploy-provider-pill is-issue-pill" :class="{ 'is-active': logLevelFilter === 'issues' }" @click="logLevelFilter = logLevelFilter === 'issues' ? 'all' : 'issues'">
                          异常 / 告警 <b>{{ logIssueCount }}</b>
                        </button>
                      </div>
                      <a v-if="safeUrl(selectedRun.buildUrl)" :href="safeUrl(selectedRun.buildUrl)" target="_blank" rel="noopener noreferrer">打开构建 ↗</a>
                      <el-checkbox v-model="followLog">跟随</el-checkbox>
                      <button v-if="logText" type="button" class="deploy-copy-chip" :class="{ 'is-copied': copiedToken === 'log' }" title="复制纯文本日志" @click="copyQuickText(stripAnsiCodes(logText), 'log', '构建日志')">
                        <Check v-if="copiedToken === 'log'" :size="12" /><Copy v-else :size="12" /><span>复制日志</span>
                      </button>
                      <button v-if="logText" type="button" class="deploy-copy-chip" title="下载 .log 文件" @click="downloadLogFile">
                        <Download :size="12" /><span>.log</span>
                      </button>
                      <button v-if="parsedLog.lines.length > 10" type="button" class="deploy-copy-chip" title="跳至日志底部" @click="scrollLogToBottom">
                        <ArrowDownToLine :size="12" />
                      </button>
                      <el-button size="small" :loading="manualLogRefreshing" @click="readRunLog(true)"><RefreshCw v-if="!manualLogRefreshing" :size="13" /> 刷新</el-button>
                      <el-button
                        v-if="['dispatching', 'queued', 'running', 'unknown'].includes(selectedRun.status)"
                        size="small"
                        type="warning"
                        plain
                        :loading="resolvingRun"
                        title="已在远端平台确认结束或构建已删除时，解除本机排队/待确认锁定"
                        @click="resolveStuckRun(selectedRun)"
                      >标记已结束</el-button>
                    </div>
                    <p v-if="logTruncated" class="row-secondary">页面只显示最近 1 MB 日志，完整内容请点上方“打开构建”查看。</p>

                    <div v-if="parsedLog.lines.length" ref="logElement" class="deployment-log deployment-log-studio" role="log" aria-label="部署实时日志" :aria-busy="logLoading || manualLogRefreshing">
                      <div v-for="entry in parsedLog.lines" :key="entry.lineNumber" class="deploy-log-line" :data-level="entry.level">
                        <span class="deploy-log-ln">{{ entry.lineNumber }}</span>
                        <span class="deploy-log-txt">{{ entry.text }}</span>
                      </div>
                    </div>
                    <pre v-else ref="logElement" class="deployment-log" aria-label="部署实时日志" :aria-busy="logLoading || manualLogRefreshing">{{ logText ? '当前过滤条件下没有匹配的日志行。' : (logLoading ? '正在读取日志…' : logError ? '日志读取未完成，请点击刷新重试。' : selectedRun.provider === 'yunxiao' && !logJobId ? '等待流水线返回任务日志。' : selectedRun.queueId && !selectedRun.buildNumber ? '正在排队，构建开始后显示日志。' : '暂无日志。') }}</pre>
                  </template>
                  <el-empty v-else description="部署后会在这里显示运行状态和结构化实时日志，也可从左侧记录选择一次运行。" :image-size="64" />
                </div>
              </section>
            </template>
            <el-empty v-else description="请选择一个项目" :image-size="80" />
          </main>
        </div>
      </template>
    </QueryState>

    <el-dialog v-if="manualOpen" v-model="manualOpen" title="添加部署" width="min(600px, 94vw)" :close-on-click-modal="false" :close-on-press-escape="!savingManual" :show-close="!savingManual" destroy-on-close>
      <el-form label-position="top" :disabled="savingManual" @submit.prevent="saveManualDeployment">
        <el-form-item label="所属项目"><el-select v-model="manualForm.projectId" filterable class="full-width" aria-label="所属项目"><el-option v-for="project in allProjects" :key="project.id" :label="project.name" :value="project.id" /></el-select></el-form-item>
        <el-form-item label="环境"><el-input v-model="manualForm.environment" placeholder="例如 test、pre、prod 或自定义环境" maxlength="80" aria-label="部署环境" /></el-form-item>
        <el-form-item label="流水线地址"><el-input v-model="manualForm.url" placeholder="粘贴 Jenkins 任务或云效流水线的完整地址" autocomplete="url" aria-label="流水线地址" maxlength="2000" /></el-form-item>
      </el-form>
      <template #footer><el-button :disabled="savingManual" @click="manualOpen = false">取消</el-button><el-button type="primary" :loading="savingManual" :disabled="!manualForm.projectId || !manualForm.environment.trim() || !validManualUrl" @click="saveManualDeployment">保存部署</el-button></template>
    </el-dialog>
    <el-dialog v-if="cloudSettingsOpen" v-model="cloudSettingsOpen" title="云效连接" width="min(560px, 94vw)" :close-on-click-modal="false" destroy-on-close>
      <el-form label-position="top" :disabled="cloudSaving" @submit.prevent="saveCloudSettings"><el-form-item label="个人访问令牌"><el-input v-model="cloudToken" type="password" autocomplete="new-password" :placeholder="cloudConfigured ? '已保存令牌，输入新令牌可更换' : '输入具有流水线读写权限的个人访问令牌'" /><span class="row-secondary">令牌仅保存在本机，页面不会回显原值。</span></el-form-item></el-form>
      <template #footer><el-button :disabled="cloudSaving" @click="cloudSettingsOpen = false">取消</el-button><el-button type="primary" :loading="cloudSaving" :disabled="!cloudToken.trim()" @click="saveCloudSettings">保存连接</el-button></template>
    </el-dialog>
    <el-dialog v-if="cloudDeployOpen" v-model="cloudDeployOpen" title="确认部署" width="min(660px, 94vw)" :close-on-click-modal="false" :close-on-press-escape="!cloudSubmitting" :show-close="!cloudSubmitting" destroy-on-close>
      <template v-if="cloudTarget && cloudPipeline"><dl class="deployment-facts"><dt>项目</dt><dd>{{ cloudTarget.project.name }}</dd><dt>环境</dt><dd>{{ cloudTarget.binding.environment }}</dd><dt>云效流水线</dt><dd>{{ cloudPipeline.name }}</dd></dl>
        <el-form label-position="top" :disabled="cloudSubmitting"><el-form-item v-for="source in cloudPipeline.sources" :key="source.repo" :label="source.repo"><el-input v-model="cloudBranches[source.repo]" placeholder="部署分支" :aria-label="`${source.repo} 部署分支`" /></el-form-item></el-form>
        <el-checkbox v-if="latestRun(cloudTarget.binding.url)?.status === 'unknown'" v-model="cloudAcknowledged" :disabled="cloudSubmitting">已核对上次提交结果，确认可重新发起</el-checkbox>
      </template>
      <template #footer><el-button :disabled="cloudSubmitting" @click="cloudDeployOpen = false">取消</el-button><el-button type="primary" :loading="cloudSubmitting" :disabled="!cloudPipeline || Object.values(cloudBranches).some(branch => !branch.trim()) || !!cloudTarget && latestRun(cloudTarget.binding.url)?.status === 'unknown' && !cloudAcknowledged" @click="startCloudDeployment">确认部署</el-button></template>
    </el-dialog>

    <el-dialog v-if="settingsOpen" v-model="settingsOpen" title="Jenkins 连接" width="min(560px, 94vw)" :close-on-click-modal="false" destroy-on-close>
      <el-form label-position="top" :disabled="savingSettings" @submit.prevent="saveSettings"><el-form-item label="Jenkins 地址"><el-input v-model="connection.baseUrl" placeholder="https://jenkins.example.com" autocomplete="url" /></el-form-item><el-form-item label="用户名"><el-input v-model="connection.username" autocomplete="username" /></el-form-item><el-form-item label="API Token"><el-input v-model="connection.token" type="password" autocomplete="new-password" :placeholder="configured ? '已保存 Token，留空保留' : '输入 Jenkins API Token'" /><span class="row-secondary">{{ configured ? 'Token 已保存，页面不会读取原值。' : '请使用拥有对应任务读取、构建权限的账号。' }}</span></el-form-item></el-form>
      <template #footer><el-button :disabled="savingSettings" @click="settingsOpen = false">取消</el-button><el-button type="primary" :loading="savingSettings" :disabled="!connection.baseUrl.trim() || !connection.username.trim() || !configured && !connection.token" @click="saveSettings">保存连接</el-button></template>
    </el-dialog>
    <el-dialog v-if="bindingOpen" v-model="bindingOpen" :title="bindingForm.id ? '设置流水线关联' : '关联流水线'" width="min(660px, 94vw)" :close-on-click-modal="false" destroy-on-close>
      <el-form label-position="top" :disabled="savingBinding"><el-form-item label="项目"><el-select v-model="bindingForm.projectId" filterable class="full-width"><el-option v-for="project in dashboard?.projects" :key="project.id" :label="project.name" :value="project.id" /></el-select></el-form-item><el-form-item label="环境名称"><el-input v-model="bindingForm.environment" placeholder="例如：测试、预发布、生产" maxlength="80" /></el-form-item><el-form-item label="Jenkins 任务"><div class="job-picker"><el-select v-model="bindingForm.jobFullName" :loading="jobsLoading" filterable placeholder="搜索并选择 Jenkins 任务" class="full-width"><el-option v-for="job in jobs" :key="job.fullName" :label="job.fullName" :value="job.fullName" /></el-select><el-button :loading="jobsLoading" @click="readJobs">刷新任务</el-button></div></el-form-item><p class="row-secondary">关联后点击部署将执行这个任务，请核对任务对应的环境与分支。</p></el-form>
      <template #footer><el-button :disabled="savingBinding" @click="bindingOpen = false">取消</el-button><el-button type="primary" :loading="savingBinding" :disabled="!bindingForm.projectId || !bindingForm.environment.trim() || !bindingForm.jobFullName" @click="saveBinding">保存关联</el-button></template>
    </el-dialog>
    <el-dialog v-if="deployOpen" v-model="deployOpen" :title="unknownDeployment ? '核对后重新发起部署' : '确认部署'" width="min(660px, 94vw)" :close-on-click-modal="false" :close-on-press-escape="!submitting" :show-close="!submitting" destroy-on-close>
      <template v-if="deployBinding && deployJob"><dl class="deployment-facts"><dt>项目</dt><dd>{{ dashboard?.projects.find(item => item.id === deployBinding?.projectId)?.name }}</dd><dt>环境</dt><dd>{{ deployBinding.environment }}</dd><dt>Jenkins 任务</dt><dd><a :href="safeUrl(deployJob.url)" target="_blank" rel="noopener noreferrer">{{ deployJob.fullName }} ↗</a></dd></dl><p class="row-secondary">确认后将按该 Jenkins 任务执行构建和部署。</p><template v-if="unknownDeployment"><p class="row-secondary">上次请求结果不确定，请先确认 Jenkins 中没有正在执行的同次构建；继续会提交新的构建。</p><p class="row-secondary">核对地址：<a :href="safeUrl(deployJob.url)" target="_blank" rel="noopener noreferrer">{{ deployJob.url }}</a></p><el-checkbox v-model="acknowledgeUnknown" :disabled="submitting">已在 Jenkins 核对，确认可重新发起</el-checkbox></template><p v-if="!deployJob.buildable" class="deployment-problem">当前 Jenkins 任务不可构建，请在 Jenkins 中核对任务状态。</p><p v-if="unsupported.length" class="deployment-problem">当前页面不支持这些任务参数：{{ unsupported.map(item => item.name).join('、') }}。请在 Jenkins 中发起该任务。</p><el-form label-position="top" :disabled="submitting"><el-form-item v-for="parameter in deployJob.parameters.filter(item => item.type !== 'unsupported')" :key="parameter.name" :label="parameter.name"><el-switch v-if="parameter.type === 'boolean'" v-model="parameters[parameter.name]" :aria-label="parameter.name" /><el-select v-else-if="parameter.type === 'choice'" v-model="parameters[parameter.name]" class="full-width" :aria-label="parameter.name"><el-option v-for="choice in parameter.choices" :key="choice" :label="choice" :value="choice" /></el-select><el-input v-else v-model="parameters[parameter.name]" :type="parameter.type === 'password' ? 'password' : 'text'" :autocomplete="parameter.type === 'password' ? 'new-password' : 'off'" :aria-label="parameter.name" /><span v-if="parameter.description" class="row-secondary">{{ parameter.description }}</span></el-form-item></el-form><p v-if="!deployJob.parameters.length" class="row-secondary">此 Jenkins 任务没有可填写参数。</p></template>
      <template #footer><el-button :disabled="submitting" @click="deployOpen = false">取消</el-button><el-button type="primary" :loading="submitting" :disabled="!canDeploy" @click="startDeployment">确认部署</el-button></template>
    </el-dialog>

  </section>
</template>

<style scoped>
.deployment-workspace{min-width:0}
.deployment-layout{display:grid;grid-template-columns:236px minmax(0,1fr);align-items:stretch;min-height:calc(100dvh - 248px);border:1px solid var(--ui-border);border-radius:var(--ds-radius-lg,10px);background:var(--ui-surface);overflow:clip}
.deployment-sidebar{min-width:0;display:flex;flex-direction:column;gap:10px;box-sizing:border-box;padding:14px 10px;border-right:1px solid var(--ui-border);background:var(--ui-raised,var(--ui-bg))}
.sidebar-heading{display:flex;justify-content:space-between;align-items:center;padding:0 6px;font-size:13px}
.sidebar-heading>span{font:600 11.5px/1 var(--mono);color:var(--ui-muted)}
.deploy-kbd{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border:1px solid var(--ui-border);border-radius:4px;background:var(--ui-surface);color:var(--ui-muted);font:500 10.5px/1 var(--mono)}
.deployment-projects{min-width:0;max-width:100%;display:flex;flex-direction:column;gap:4px;min-height:0;overflow:auto;flex:1}
.deployment-projects>button{display:flex;align-items:flex-start;gap:8px;width:100%;padding:9px 10px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--ui-text);text-align:left;cursor:pointer;font:inherit}
.deployment-projects>button>svg{flex-shrink:0;margin-top:2px;color:var(--ui-muted)}
.deployment-projects>button>span{min-width:0}
.deployment-projects strong,.deployment-projects small{display:block;overflow-wrap:anywhere}
.deployment-projects strong{font-size:13px;font-weight:550;line-height:1.45}
.deployment-projects small{margin-top:3px;font-size:11px;color:var(--ui-muted)}
.deployment-projects>button:hover{background:var(--ui-accent-soft)}
.deployment-projects>button.selected{border-color:color-mix(in srgb,var(--ui-accent) 35%,transparent);background:var(--ui-accent-soft);color:var(--ui-accent);box-shadow:inset 2.5px 0 0 var(--ui-accent)}
.sidebar-empty,.history-empty{padding:12px;color:var(--ui-muted);font-size:12px}

.deployment-main{min-width:0;display:flex;flex-direction:column;padding:16px 20px}
.deployment-project-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding-bottom:14px;border-bottom:1px solid var(--ui-divider,var(--ui-border))}
.deployment-project-heading>div{min-width:0}
.deployment-project-heading h2{margin:0;font-size:16px;line-height:1.4}
.deployment-repo-sub{margin:4px 0 0;color:var(--ui-muted);font:11.5px/1.5 var(--mono);overflow-wrap:anywhere}
.deployment-project-heading>.el-button{flex-shrink:0}
.deployment-project-heading :deep(.el-button>span){gap:5px}

.section-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin:0 0 12px}
.section-heading-left{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.section-heading h3{display:flex;align-items:center;gap:7px;margin:0;font-size:13.5px;font-weight:600;line-height:1.5}
.section-heading small,.live-state{color:var(--ui-muted);font-size:11px;font-weight:400}

.deploy-provider-pills,.log-level-pills{display:inline-flex;align-items:center;gap:5px;flex-wrap:wrap}
.deploy-provider-pill{display:inline-flex;align-items:center;gap:4px;height:25px;padding:0 8px;border:1px solid var(--ui-border);border-radius:6px;background:var(--ui-raised);color:var(--ui-secondary);font-size:11.5px;cursor:pointer}
.deploy-provider-pill:hover{border-color:color-mix(in srgb,var(--ui-accent) 42%,var(--ui-border));color:var(--ui-text)}
.deploy-provider-pill.is-active{border-color:color-mix(in srgb,var(--ui-accent) 48%,transparent);background:var(--ui-accent-soft);color:var(--ui-accent);font-weight:600}
.deploy-provider-pill.is-issue-pill.is-active{border-color:color-mix(in srgb,#ef4444 48%,transparent);background:color-mix(in srgb,#ef4444 12%,var(--ui-surface));color:#ef4444}
.deploy-provider-pill b{font:600 10.5px/1 var(--mono);font-variant-numeric:tabular-nums}

.environment-section{padding:14px 0 16px}
.environment-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:12px}
.environment-card{display:flex;flex-direction:column;min-width:0;padding:13px 14px;border:1px solid var(--ui-border);border-radius:8px;background:var(--ui-surface);transition:border-color .14s ease}
.environment-card:hover{border-color:color-mix(in srgb,var(--ui-accent) 36%,var(--ui-border))}
.environment-card[data-tier='prod']{box-shadow:inset 0 2px 0 color-mix(in srgb,#ef4444 65%,transparent)}
.environment-card>header{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.environment-card>header>strong{font-size:13.5px;overflow-wrap:anywhere}

.deploy-tier-badge{display:inline-flex;align-items:center;padding:1px 5px;border:1px solid var(--ui-border);border-radius:4px;background:var(--ui-raised);color:var(--ui-muted);font:700 9.5px/1.35 var(--mono);letter-spacing:.03em}
.deploy-tier-badge[data-tier='prod']{color:#ef4444;border-color:color-mix(in srgb,#ef4444 35%,var(--ui-border));background:color-mix(in srgb,#ef4444 10%,var(--ui-surface))}
.deploy-tier-badge[data-tier='stage']{color:#8b5cf6;border-color:color-mix(in srgb,#8b5cf6 35%,var(--ui-border));background:color-mix(in srgb,#8b5cf6 10%,var(--ui-surface))}
.deploy-tier-badge[data-tier='test']{color:#10b981;border-color:color-mix(in srgb,#10b981 35%,var(--ui-border));background:color-mix(in srgb,#10b981 10%,var(--ui-surface))}
.deploy-tier-badge[data-tier='dev']{color:#3b82f6;border-color:color-mix(in srgb,#3b82f6 35%,var(--ui-border));background:color-mix(in srgb,#3b82f6 10%,var(--ui-surface))}

.pipeline-name{margin:8px 0 4px;font-size:12px;line-height:1.5;overflow-wrap:anywhere;color:var(--ui-text)}
.pipeline-address{display:block;color:var(--ui-muted);font:10.5px/1.5 var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-decoration:none}
.pipeline-address:hover{color:var(--ui-accent);text-decoration:underline}
.environment-status{display:flex;align-items:center;flex-wrap:wrap;gap:7px;margin:10px 0;color:var(--ui-muted);font-size:11px}
.environment-card>footer{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:auto;padding-top:9px;border-top:1px solid var(--ui-divider,var(--ui-border))}
.environment-card>footer .el-button+.el-button{margin-left:0}
.environment-spacer{flex:1}

.deploy-copy-chip{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 7px;border:1px solid var(--ui-border);border-radius:5px;background:var(--ui-surface);color:var(--ui-secondary);font-size:11px;cursor:pointer}
.deploy-copy-chip:hover{border-color:var(--ui-accent);color:var(--ui-accent)}
.deploy-copy-chip.is-copied{border-color:#10b981;color:#10b981}

.deployment-execution{display:grid;grid-template-columns:205px minmax(0,1fr);flex:1;min-height:290px;border:1px solid var(--ui-border);border-radius:8px;overflow:hidden}
.run-history{min-width:0;padding:14px 10px;background:var(--ui-raised,var(--ui-bg));border-right:1px solid var(--ui-border)}
.run-history>.section-heading{padding:0 4px}
.run-history-list{display:flex;flex-direction:column;gap:6px;max-height:min(46dvh,380px);overflow:auto}
.run-history-list>button{display:block;width:100%;padding:9px 10px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--ui-text);text-align:left;cursor:pointer}
.run-history-list>button>span{display:flex;align-items:center;justify-content:space-between;gap:8px}
.run-history-list>button>span>strong{overflow-wrap:anywhere}
.run-history-list>button>small{display:block;color:var(--ui-muted);font-size:10px;line-height:1.6;margin-top:4px}
.run-history-list>button.selected{border-color:var(--ui-border);background:var(--ui-surface);box-shadow:inset 2px 0 0 var(--ui-accent)}
.run-history-list>button:hover{background:var(--ui-accent-soft)}
.run-history-list :deep(.status-pill){padding:3px 5px;font-size:10px}

.run-console{min-width:0;display:flex;flex-direction:column;padding:14px 16px}
.run-console :deep(.el-empty){margin:auto 0}
.log-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.log-heading>div{min-width:0}
.log-heading strong{font-size:14px}
.log-heading p{margin:5px 0;color:var(--ui-muted);font:11px/1.6 var(--mono);overflow-wrap:anywhere}
.pipeline-steps{display:flex;gap:8px;flex-wrap:wrap;padding:0;margin:12px 0;list-style:none}
.pipeline-steps>li{display:flex;gap:10px;padding:5px 8px;border:1px solid var(--ui-border);border-radius:5px;font-size:11px;overflow-wrap:anywhere}
.pipeline-steps>li>strong{font-size:10px;font-weight:500;color:var(--ui-muted)}

.log-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:12px 0 10px;font-size:12px}
.log-tools :deep(.el-select){width:170px;max-width:100%}
.log-search-input{width:175px;max-width:100%}
.log-tools a{color:var(--ui-accent);text-decoration:none}
.log-tools a:hover{text-decoration:underline}
.log-tools>.el-checkbox{margin-left:auto}
.log-tools :deep(.el-button>span){gap:5px}

.deployment-log{max-height:min(48dvh,360px);overflow:auto;box-sizing:border-box;margin:0;padding:12px 14px;border:1px solid var(--ui-border);border-radius:6px;background:var(--ui-raised,var(--ui-bg));color:var(--ui-text);font:12px/1.7 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2}
.deployment-log-studio{padding:6px 0;white-space:normal}
.deploy-log-line{display:grid;grid-template-columns:44px minmax(0,1fr);gap:10px;padding:1px 12px 1px 8px;border-left:2px solid transparent;font:11.5px/1.65 var(--mono)}
.deploy-log-line:hover{background:color-mix(in srgb,var(--ui-hover) 70%,transparent)}
.deploy-log-line[data-level='error']{border-left-color:#ef4444;background:color-mix(in srgb,#ef4444 9%,transparent);color:#ef4444}
.deploy-log-line[data-level='warn']{border-left-color:#f59e0b;background:color-mix(in srgb,#f59e0b 8%,transparent)}
.deploy-log-line[data-level='success']{border-left-color:#10b981;color:#10b981}
.deploy-log-ln{text-align:right;color:var(--ui-muted);user-select:none;font-variant-numeric:tabular-nums;opacity:.72}
.deploy-log-txt{white-space:pre-wrap;overflow-wrap:anywhere}

:global(:root[data-theme='acid']) .deployment-layout,
:global(:root[data-theme='acid']) .environment-card,
:global(:root[data-theme='acid']) .deploy-tier-badge,
:global(:root[data-theme='acid']) .deploy-provider-pill,
:global(:root[data-theme='acid']) .deploy-copy-chip,
:global(:root[data-theme='acid']) .deployment-execution,
:global(:root[data-theme='acid']) .deployment-log,
:global(:root[data-theme='acid']) .deploy-kbd {
  border-radius: 0 !important;
}

.full-width,.job-picker{width:100%}.job-picker{display:flex;gap:8px}.job-picker>.el-select{flex:1;min-width:0}.job-picker>.el-button{flex:none}.deployment-facts{display:grid;grid-template-columns:86px minmax(0,1fr);gap:10px 14px;margin:0 0 20px;font-size:13px;line-height:1.7}.deployment-facts dt{color:var(--ui-muted)}.deployment-facts dd{margin:0;overflow-wrap:anywhere}.deployment-facts a{color:var(--ui-accent)}.deployment-problem{color:var(--ui-danger);font-size:13px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere}
@media(max-height:680px){.deployment-sidebar{position:static}}
@container workspace-page (max-width:1100px){.deployment-layout{grid-template-columns:205px minmax(0,1fr)}.deployment-main{padding:16px}.deployment-execution{grid-template-columns:175px minmax(0,1fr)}.run-console{padding:12px}.log-tools>.el-checkbox{margin-left:0}}
@container workspace-page (max-width:800px){.deployment-layout{grid-template-columns:minmax(0,1fr)}.deployment-sidebar{position:static;border-right:0;border-bottom:1px solid var(--ui-border);padding:14px}.deployment-projects{min-width:0;max-width:100%;display:flex;flex-direction:row;overflow:auto;max-height:150px}.deployment-projects>button{width:180px;flex:0 0 180px}.deployment-sidebar>.el-input{max-width:100%}.deployment-main{padding:14px}.deployment-execution{grid-template-columns:minmax(0,1fr)}.run-history{border-right:0;border-bottom:1px solid var(--ui-border)}.run-history-list{flex-direction:row}.run-history-list>button{min-width:165px;width:165px;flex-shrink:0}.deployment-project-heading{gap:12px}.deployment-project-heading h2{font-size:17px}.deployment-log{max-height:min(48dvh,320px)}}
@media(max-width:550px){.deployment-layout{grid-template-columns:minmax(0,1fr)}.deployment-sidebar{position:static;border-right:0;border-bottom:1px solid var(--ui-border)}.deployment-projects{flex-direction:row}.deployment-projects>button{flex:0 0 160px}.deployment-main{padding:12px}.deployment-project-heading{flex-wrap:wrap}.deployment-execution{grid-template-columns:minmax(0,1fr)}.run-history{border-right:0;border-bottom:1px solid var(--ui-border)}.run-history-list{flex-direction:row}.run-history-list>button{flex:0 0 165px}.job-picker{flex-direction:column}.deployment-facts{grid-template-columns:70px minmax(0,1fr)}.log-tools>.el-checkbox{margin-left:0}.log-tools{gap:8px}.log-tools :deep(.el-select){width:100%}}
</style>
