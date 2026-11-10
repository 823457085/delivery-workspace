<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { ExternalLink, History, Play, Square, Terminal } from '@lucide/vue';
import { projectEnvironments, type LaunchSnapshot, type ProjectEnvironment, type ProjectExecution } from '../../../shared/project-launch';

const props = defineProps<{ workspacePaths: string[] }>();
const client = useQueryClient(), workspace = ref(''), recordsOpen = ref(false), busy = ref('');
const actionKind = ref<'install' | 'run' | 'build'>('run'), environment = ref<ProjectEnvironment>('dev'), legacySelection = ref('');
const now = ref(Date.now());
let disposed = false, operation = 0, timer: ReturnType<typeof setInterval> | undefined;
let lastReadError = '';
let launchTab: { tab: Window; configId: string; executionId?: string } | undefined;
const observed = new Map<string, ProjectExecution['state']>();
const logElements = new Map<string, HTMLElement>(), readingLogs = new Set<string>();
onMounted(() => { timer = setInterval(() => { now.value = Date.now(); }, 1000); });
onBeforeUnmount(() => { disposed = true; operation++; closeLaunchTab(); clearInterval(timer); logElements.clear(); readingLogs.clear(); });
const base = '/api/projects/launch';
const key = (path: string) => ['project-launch', path];
const selectionKey = (path: string) => `delivery:launch-selection:${path}`;
watch(() => props.workspacePaths, paths => {
  if (!paths.includes(workspace.value)) workspace.value = paths[0] || '';
}, { immediate: true });
watch(workspace, path => {
  operation++; busy.value = ''; recordsOpen.value = false;
  closeLaunchTab();
  lastReadError = '';
  observed.clear(); logElements.clear(); readingLogs.clear();
  actionKind.value = 'run'; environment.value = 'dev'; legacySelection.value = '';
  try {
    const saved = localStorage.getItem(selectionKey(path)) || '';
    if (saved.startsWith('{')) {
      const value = JSON.parse(saved);
      if (['install', 'run', 'build'].includes(value.kind)) actionKind.value = value.kind;
      if (projectEnvironments.includes(value.environment)) environment.value = value.environment;
    } else legacySelection.value = saved;
  } catch { /* 无效或旧选择不影响项目命令发现。 */ }
}, { immediate: true });
const currentRequest = (path: string, token: number) => !disposed && workspace.value === path && token === operation;
async function request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<LaunchSnapshot> {
  const response = await fetch(base + path, { method, signal, ...(body === undefined ? {} : {
    headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: JSON.stringify(body),
  }) });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.message === 'string' ? result.message : '项目指令操作失败');
  return result;
}
const query = useQuery({ queryKey: computed(() => key(workspace.value)), enabled: computed(() => !!workspace.value),
  queryFn: ({ queryKey, signal }) => request('GET', `?path=${encodeURIComponent(queryKey[1]!)}`, undefined, signal),
  retry: false, refetchIntervalInBackground: true,
  refetchInterval: query => query.state.data?.executions?.some(item => item.state === 'running') ? 1000
    : query.state.data?.statuses.some(item => ['running', 'starting'].includes(item.state)) ? 5000 : false,
});
const snapshot = computed(() => query.data.value);
watch(query.error, error => {
  if (!error) lastReadError = '';
  else if (!disposed && error.message !== lastReadError) { lastReadError = error.message; ElMessage.error(error.message); }
});
const categories = [{ kind: 'install', label: '安装' }, { kind: 'run', label: '启动' }, { kind: 'build', label: '构建' }] as const;
const environmentCommand = (value: ProjectEnvironment) => snapshot.value?.commands?.find(item => item.kind === actionKind.value && item.environment === value);
const command = computed(() => actionKind.value === 'install' ? snapshot.value?.commands?.find(item => item.kind === 'install') : environmentCommand(environment.value));
const selected = computed(() => command.value?.id || '');
const config = computed(() => snapshot.value?.configs.find(item => item.id === command.value?.configId));
const status = computed(() => snapshot.value?.statuses.find(item => item.configId === command.value?.configId));
const executions = computed(() => [...(snapshot.value?.executions || [])]
  .sort((left, right) => right.startedAt.localeCompare(left.startedAt)).slice(0, 10));
const selectedExecution = computed(() => executions.value.find(item => item.commandId === selected.value));
const runningExecution = computed(() => executions.value.find(item => item.commandId === selected.value && item.state === 'running'));
const runningCount = computed(() => snapshot.value?.executions?.filter(item => item.state === 'running').length || 0);
const serviceRunning = computed(() => command.value?.kind === 'run' && ['running', 'starting'].includes(status.value?.state || ''));
const currentAddress = computed(() => command.value?.kind === 'run' && config.value
  ? runningAddress(snapshot.value, config.value.id) : undefined);
const canExecute = computed(() => !busy.value && !!command.value && !runningCount.value && !serviceRunning.value);
const feedback = computed(() => snapshot.value?.discoveryMessage ?? runningExecution.value?.message
  ?? (command.value?.kind === 'run' ? status.value?.message : undefined) ?? selectedExecution.value?.message ?? '');
const executionLabels = { running: '进行中', succeeded: '成功', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
const recordLabel = computed(() => runningCount.value ? `进行中 ${runningCount.value}` : executions.value[0]
  ? `最近${executionLabels[executions.value[0].state]}` : '');
watch([actionKind, environment], () => {
  if (!workspace.value) return;
  try { localStorage.setItem(selectionKey(workspace.value), JSON.stringify({ kind: actionKind.value, environment: environment.value })); }
  catch { /* Selection can remain in memory. */ }
});
watch(() => snapshot.value?.commands, commands => {
  if (!commands || !legacySelection.value) return;
  const previous = commands.find(item => item.id === legacySelection.value || item.configId === legacySelection.value);
  if (previous && ['install', 'run', 'build'].includes(previous.kind)) {
    actionKind.value = previous.kind as typeof actionKind.value;
    if (previous.environment) environment.value = previous.environment;
  }
  legacySelection.value = '';
}, { immediate: true });
function completion(entry: ProjectExecution) {
  if (entry.state === 'succeeded') ElMessage.success(entry.message);
  else if (entry.state === 'failed' || entry.state === 'interrupted') ElMessage.error(entry.message);
  else if (entry.state === 'cancelled') ElMessage.info(entry.message);
}
function localAddress(value: string | undefined, port?: number) {
  if (!value) return;
  try {
    const url = new URL(value);
    const actualPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash && (port === undefined || actualPort === port)) return value;
  } catch { /* 仅接受有效的本机访问地址。 */ }
}
function verifiedPort(entry: ProjectExecution) {
  if (entry.kind !== 'run' || entry.state !== 'succeeded') return;
  const port = Number(/^启动完成，端口 (\d+) 已由本配置进程监听/.exec(entry.message)?.[1]);
  return port >= 1 && port <= 65535 ? port : undefined;
}
function recordedAddress(entry: ProjectExecution) {
  const port = verifiedPort(entry);
  if (!port) return;
  // 实际启动器可能启用了配置静态识别不到的 HTTPS，仅采信与已验证端口匹配的 Local 地址。
  return [...entry.logs.matchAll(/(?:^|[ \t])Local:[ \t]+(\S+)/gm)]
    .reverse().map(match => localAddress(match[1], port)).find(Boolean);
}
function runningAddress(data: LaunchSnapshot | undefined, configId: string) {
  const current = data?.statuses.find(item => item.configId === configId);
  if (current?.state !== 'running') return;
  const latest = data?.executions.find(item => item.kind === 'run' && item.configId === configId);
  return (current.managed !== false && latest && current.port === verifiedPort(latest) && recordedAddress(latest))
    || localAddress(current.url, current.port);
}
function historyAddress(entry: ProjectExecution) {
  const address = recordedAddress(entry);
  if (address) return address;
  const current = snapshot.value?.statuses.find(item => item.configId === entry.configId);
  const port = verifiedPort(entry);
  if (port && current?.state === 'running' && current.managed !== false && current.port === port
    && snapshot.value?.executions.find(item => item.kind === 'run' && item.configId === entry.configId)?.id === entry.id) {
    return localAddress(current.url, current.port);
  }
}
function closeLaunchTab(address?: string) {
  const tab = launchTab?.tab;
  launchTab = undefined;
  try {
    if (!tab || tab.closed || tab.location.href !== 'about:blank') return;
    if (address) tab.location.replace(address);
    else tab.close();
  } catch { /* 用户已关闭或导航到其他页面。 */ }
}
function prepareLaunchTab(configId: string) {
  closeLaunchTab();
  try {
    const tab = window.open('about:blank', '_blank');
    if (!tab) return;
    launchTab = { tab, configId };
    tab.opener = null;
    tab.document.title = '正在启动项目';
    tab.document.body.textContent = '正在等待项目启动成功…';
  } catch { closeLaunchTab(); }
}
function finishLaunchTab(data: LaunchSnapshot) {
  if (!launchTab?.executionId) return;
  const entry = data.executions.find(item => item.id === launchTab?.executionId);
  if (!entry || entry.state === 'running') return;
  const current = data.statuses.find(item => item.configId === launchTab?.configId);
  if (entry.state === 'succeeded' && current?.state === 'starting') return;
  closeLaunchTab(entry.state === 'succeeded' ? runningAddress(data, launchTab.configId) : undefined);
}
watch(snapshot, data => { if (data) finishLaunchTab(data); });
watch(() => snapshot.value?.executions, entries => {
  for (const entry of entries || []) {
    if (observed.get(entry.id) === 'running' && entry.state !== 'running') completion(entry);
    observed.set(entry.id, entry.state);
  }
}, { immediate: true });
function duration(entry: ProjectExecution) {
  if (entry.state !== 'running' && !entry.finishedAt) return '—';
  const end = entry.finishedAt ? Date.parse(entry.finishedAt) : now.value;
  const seconds = Math.max(0, Math.floor((end - Date.parse(entry.startedAt)) / 1000)) || 0;
  return seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}
function time(value: string) { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString(); }
function setLogElement(id: string, node: unknown) {
  if (node instanceof HTMLElement) { logElements.set(id, node); if (!readingLogs.has(id)) node.scrollTop = node.scrollHeight; }
  else logElements.delete(id);
}
function rememberLogScroll(id: string, event: Event) {
  const node = event.target as HTMLElement;
  if (node.scrollHeight - node.clientHeight - node.scrollTop > 24) readingLogs.add(id);
  else readingLogs.delete(id);
}
watch(() => snapshot.value?.executions, async () => {
  await nextTick();
  if (disposed) return;
  logElements.forEach((node, id) => { if (!readingLogs.has(id)) node.scrollTop = node.scrollHeight; });
});
async function execute() {
  if (!canExecute.value || !command.value) return;
  const path = workspace.value, token = ++operation, chosen = command.value;
  const existing = new Set(snapshot.value?.executions?.map(entry => entry.id));
  busy.value = 'execute';
  if (chosen.kind === 'run' && chosen.configId) prepareLaunchTab(chosen.configId);
  try {
    const result = await request('POST', '/execute', { workspacePath: path, commandId: chosen.id, fingerprint: chosen.fingerprint });
    if (disposed) return;
    if (!currentRequest(path, token)) { void client.invalidateQueries({ queryKey: key(path) }); return; }
    const entry = result.executions.find(item => item.commandId === chosen.id && !existing.has(item.id));
    if (entry) { if (entry.state !== 'running') completion(entry); observed.set(entry.id, entry.state); }
    if (launchTab) {
      if (entry) {
        launchTab.executionId = entry.id;
        finishLaunchTab(result);
      } else closeLaunchTab(runningAddress(result, launchTab.configId));
    }
    client.setQueryData(key(path), result);
  } catch (error) {
    if (currentRequest(path, token)) {
      closeLaunchTab();
      ElMessage.error(error instanceof Error ? error.message : '执行失败');
    }
    if (!disposed) void client.invalidateQueries({ queryKey: key(path) });
  } finally { if (currentRequest(path, token)) busy.value = ''; }
}
async function cancelExecution(entry: ProjectExecution) {
  if (busy.value || entry.state !== 'running') return;
  const path = workspace.value, token = ++operation;
  busy.value = `cancel:${entry.id}`;
  try {
    const result = await request('POST', '/cancel', { workspacePath: path, executionId: entry.id });
    if (disposed) return;
    if (currentRequest(path, token)) client.setQueryData(key(path), result);
    else void client.invalidateQueries({ queryKey: key(path) });
  } catch (error) { if (currentRequest(path, token)) ElMessage.error(error instanceof Error ? error.message : '取消失败'); }
  finally { if (currentRequest(path, token)) busy.value = ''; }
}
async function stop() {
  if (busy.value || !config.value) return;
  const path = workspace.value, token = ++operation, configId = config.value.id;
  const pending = !!runningExecution.value;
  busy.value = 'stop';
  try {
    const result = await request('POST', '/action', { workspacePath: path, configId, action: 'stop' });
    if (disposed) return;
    if (!currentRequest(path, token)) { void client.invalidateQueries({ queryKey: key(path) }); return; }
    client.setQueryData(key(path), result);
    const current = result.statuses.find(item => item.configId === configId);
    if (current && !pending && currentRequest(path, token)) {
      if (current.state === 'failed' || current.state === 'conflict') ElMessage.error(current.message);
      else ElMessage.success(current.message);
    }
  } catch (error) { if (currentRequest(path, token)) ElMessage.error(error instanceof Error ? error.message : '停止失败'); }
  finally { if (currentRequest(path, token)) busy.value = ''; }
}
</script>

<template>
  <div v-if="workspacePaths.length" class="project-launch" aria-label="项目启动配置">
    <el-select v-if="workspacePaths.length > 1" v-model="workspace" size="small" aria-label="运行项目" class="launch-project">
      <el-option v-for="path in workspacePaths" :key="path" :value="path" :label="path.split('/').filter(Boolean).at(-1)" />
    </el-select>
    <el-select v-model="actionKind" size="small" aria-label="项目操作" :disabled="!!busy" class="launch-action">
      <el-option v-for="item in categories" :key="item.kind" :value="item.kind" :label="item.label" />
    </el-select>
    <el-select v-if="actionKind !== 'install'" v-model="environment" size="small" aria-label="项目环境" :disabled="!!busy || query.isFetching.value && !snapshot" class="launch-environment">
      <el-option v-for="item in projectEnvironments" :key="item" :value="item" :label="item" :disabled="!environmentCommand(item)">
        <span>{{ item }}</span><small v-if="snapshot && !environmentCommand(item)" class="launch-unavailable">未配置</small>
      </el-option>
    </el-select>
    <el-popover v-if="command" title="执行命令" trigger="click" :width="'min(560px, 90vw)'" placement="top-start">
      <template #reference><el-button size="small" aria-label="预览完整执行命令" :title="command.command"><Terminal :size="13" />命令</el-button></template>
      <code class="launch-full-command">{{ command.command }}</code>
    </el-popover>
    <el-button v-if="serviceRunning && status?.managed !== false" size="small" aria-label="停止当前环境" :loading="busy === 'stop'" :disabled="!!busy" @click="stop"><Square :size="13" />停止</el-button>
    <el-button v-else-if="runningExecution" size="small" aria-label="取消当前指令" :loading="busy === `cancel:${runningExecution.id}`" :disabled="!!busy" @click="cancelExecution(runningExecution)"><Square :size="13" />取消</el-button>
    <el-button v-else-if="!serviceRunning" size="small" aria-label="执行所选项目指令" :title="command?.command || '请选择项目指令'" :loading="busy === 'execute'" :disabled="!canExecute" @click="execute"><Play :size="13" />执行</el-button>
    <el-button size="small" class="launch-record-button" aria-label="查看项目执行记录" @click="recordsOpen = true"><History :size="13" />执行记录<span v-if="recordLabel" :class="{ 'launch-active': runningCount }">{{ recordLabel }}</span></el-button>
    <span v-if="feedback" class="launch-status" :title="feedback">{{ feedback }}</span>
    <a v-if="currentAddress" class="launch-address" :href="currentAddress" target="_blank" rel="noopener noreferrer" aria-label="打开运行页面" :title="currentAddress"><ExternalLink :size="13" />{{ currentAddress }}</a>
    <el-drawer v-model="recordsOpen" title="项目执行记录" size="min(680px, 96vw)" append-to-body destroy-on-close class="project-launch-records">
      <p class="launch-directory">{{ workspace }}</p>
      <p class="launch-history-hint">最近 {{ executions.length }} 条执行记录</p>
      <el-empty v-if="!executions.length" description="暂无执行记录" :image-size="60" />
      <article v-for="entry in executions" :key="entry.id" class="launch-record" :data-execution-id="entry.id">
        <header><strong>{{ entry.name }}</strong><span :data-state="entry.state">{{ executionLabels[entry.state] }}</span>
          <el-button v-if="entry.state === 'running'" size="small" :loading="busy === `cancel:${entry.id}`" :disabled="!!busy" @click="cancelExecution(entry)">取消</el-button>
        </header>
        <code class="launch-full-command">{{ entry.command }}</code>
        <p class="launch-record-message" role="status">{{ entry.message }}</p>
        <a v-if="historyAddress(entry)" class="launch-address launch-record-address" :href="historyAddress(entry)" target="_blank" rel="noopener noreferrer"><ExternalLink :size="13" />{{ historyAddress(entry) }}</a>
        <p class="launch-record-meta">{{ time(entry.startedAt) }} · 耗时 {{ duration(entry) }}<template v-if="entry.exitCode !== undefined"> · 退出码 {{ entry.exitCode }}</template></p>
        <pre v-if="entry.logs" :ref="node => setLogElement(entry.id, node)" class="launch-record-log" tabindex="0" :aria-label="`${entry.name} 执行日志`" @scroll.passive="rememberLogScroll(entry.id, $event)">{{ entry.logs }}</pre>
        <p v-if="entry.logTruncated" class="launch-history-hint">仅显示最近的日志</p>
      </article>
    </el-drawer>
  </div>
</template>

<style scoped>
.project-launch{display:flex;align-items:center;flex-wrap:wrap;flex:0 0 auto;gap:6px;min-width:0;max-width:100%}.project-launch :deep(.launch-action.el-select){flex:0 0 90px;width:90px;min-width:0}.project-launch :deep(.launch-environment.el-select){flex:0 0 116px;width:116px;min-width:0;max-width:100%}.launch-project{width:150px;max-width:100%}.project-launch :deep(.el-button+.el-button){margin-left:0}.project-launch :deep(.el-button){padding:6px 8px}.launch-status{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--agent-muted)}.launch-unavailable{float:right;margin-left:14px;color:var(--el-text-color-placeholder)}.project-launch>a{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--agent-accent)}.launch-directory{font-size:12px;overflow-wrap:anywhere;color:var(--el-text-color-secondary);margin:0 0 16px}
.launch-full-command{display:block;max-width:100%;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.6}.launch-record-button :deep(span){gap:5px}.launch-record-button span{font-size:10px;color:var(--el-text-color-secondary)}.launch-record-button .launch-active{color:var(--el-color-primary)}.launch-history-hint{font-size:12px;color:var(--el-text-color-secondary);line-height:1.6}.launch-record{min-width:0;padding:16px 0;border-top:1px solid var(--el-border-color-light)}.launch-record header{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:10px}.launch-record header strong{min-width:0;overflow-wrap:anywhere;font-size:14px}.launch-record header>span{font-size:12px;color:var(--el-text-color-secondary)}.launch-record header>span[data-state=succeeded]{color:var(--el-color-success)}.launch-record header>span[data-state=failed],.launch-record header>span[data-state=interrupted]{color:var(--el-color-danger)}.launch-record header>.el-button{margin-left:auto}.launch-record-message{margin:10px 0 6px;font-size:13px;line-height:1.6;overflow-wrap:anywhere}.launch-record-meta{margin:0 0 10px;font-size:11px;color:var(--el-text-color-secondary);overflow-wrap:anywhere}.launch-record-log{max-width:100%;max-height:260px;overflow:auto;margin:12px 0 0;padding:12px;border-radius:6px;background:var(--el-fill-color-light);font:11px/1.6 var(--font-mono,monospace);white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2}
.project-launch-sidebar{width:100%;align-content:flex-start}.project-launch-sidebar :deep(.launch-action.el-select),.project-launch-sidebar :deep(.launch-environment.el-select){flex:1 1 calc(50% - 3px);width:auto}.project-launch-sidebar .launch-project{flex:1 0 100%;width:100%}.project-launch-sidebar .launch-status{flex:1 0 100%;max-width:100%}
.launch-address{display:inline-flex;align-items:center;gap:5px;max-width:100%;font-size:12px;overflow-wrap:anywhere;color:var(--el-color-primary)}.launch-address svg{flex-shrink:0}.launch-address:hover{text-decoration:underline}.project-launch-sidebar .launch-address{flex-basis:100%}.launch-record-address{margin-bottom:6px}
@media(max-width:600px){.launch-status{max-width:160px}.launch-record-log{max-height:220px;padding:8px}}
</style>
