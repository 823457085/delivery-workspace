<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import {
  Copy,
  ExternalLink,
  Folder,
  GitBranch,
  LayoutGrid,
  List,
  Play,
  Plus,
  RadioTower,
  RotateCw,
  Square,
  Terminal,
  Trash2,
} from '@lucide/vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  parsePortList,
  type PortActionRequest,
  type PortActionResult,
  type PortActionType,
  type PortListener,
  type PortProject,
  type PortSnapshot,
  type PortStoppedService,
} from '../../../shared/port-monitor';
import type { LocalProject, ProjectsData } from '../../../shared/hub';
import PageHeading from '../../shared/ui/PageHeading.vue';
import MetricStrip from '../../shared/ui/MetricStrip.vue';
import { shortPath } from '../../shared/format';
import AgentMarkdown from '../agent-workbench/AgentMarkdown.vue';
import { markdownCodeBlock } from '../agent-workbench/markdown';

type RowState = 'listening' | 'stopped' | 'errored' | 'available';
type StatusTab = 'all' | 'listening' | 'stopped' | 'pm2' | 'standalone';
type ViewMode = 'cards' | 'table';

type PortRow = {
  key: string;
  port: number;
  rowState: RowState;
  listener?: PortListener;
  listeners: PortListener[];
  stopped?: PortStoppedService;
  project?: PortProject;
  groupId: string;
  groupName: string;
  service: string;
  mode: string;
  manager: string;
  command: string;
  launchCommand: string;
  cwd: string;
  user: string;
  pid?: number;
  processName: string;
  isSelf: boolean;
};

type PortProjectGroup = {
  id: string;
  name: string;
  rows: PortRow[];
  listeningCount: number;
  stoppedCount: number;
  portsLabel: string;
  workspaceSample: string;
};

const autoRefreshSeconds = 30;
const data = ref<PortSnapshot>();
const fetching = ref(false);
const actingKey = ref('');
const portFilter = ref('');
const keyword = ref('');
const projectGroupFilter = ref('all');
const statusTab = ref<StatusTab>('all');
const viewMode = ref<ViewMode>('cards');
const selectedRowKey = ref('');
const detailsVisible = ref(false);
const detailsContent = ref<HTMLElement>();
const autoRefresh = ref(true);

const createDialogVisible = ref(false);
const creating = ref(false);
const loadingProjects = ref(false);
const localProjects = shallowRef<LocalProject[]>([]);
const createForm = reactive({
  selectedProjectPath: '',
  cwd: '',
  port: '',
  preset: 'pnpm-dev',
  command: 'pnpm dev -- --host 0.0.0.0',
  usePm2: true,
  pm2Name: '',
});

let timer: ReturnType<typeof setInterval> | undefined;
let debounce: ReturnType<typeof setTimeout> | undefined;
let controller: AbortController | undefined;
let disposed = false;

const currentBrowserPort = typeof window !== 'undefined' && window.location.port ? Number(window.location.port) : 0;
const selfPort = computed(() => data.value?.selfPort || currentBrowserPort || 0);

const filterState = computed(() => {
  try {
    return { ports: parsePortList(portFilter.value), error: '' };
  } catch (cause) {
    return { ports: [], error: cause instanceof Error ? cause.message : String(cause) };
  }
});

function resolveGroupMeta(project?: PortProject, rowState?: RowState): { id: string; name: string } {
  if (project?.name) {
    return { id: `project:${project.name}`, name: project.name };
  }
  if (rowState === 'available') {
    return { id: 'group:available', name: '空闲检查端口' };
  }
  return { id: 'group:standalone', name: '其他独立服务' };
}

const allRows = computed<PortRow[]>(() => {
  const result: PortRow[] = [];
  const stoppedList = data.value?.stopped || [];
  const stoppedByPort = new Map<number, PortStoppedService[]>();
  for (const item of stoppedList) {
    if (item.port > 0) {
      stoppedByPort.set(item.port, [...(stoppedByPort.get(item.port) || []), item]);
    }
  }
  const consumedStoppedIds = new Set<string>();

  for (const portEntry of data.value?.ports || []) {
    const processes = new Map<number, PortListener[]>();
    for (const listener of portEntry.listeners) {
      processes.set(listener.pid, [...(processes.get(listener.pid) || []), listener]);
    }
    if (processes.size > 0) {
      for (const listeners of processes.values()) {
        const primary = listeners[0];
        const isSelf = !!(selfPort.value && portEntry.port === selfPort.value);
        const group = resolveGroupMeta(primary.project, 'listening');
        result.push({
          key: `run:${portEntry.port}:${primary.pid}`,
          port: portEntry.port,
          rowState: 'listening',
          listener: primary,
          listeners,
          project: primary.project,
          groupId: group.id,
          groupName: group.name,
          service: primary.service,
          mode: primary.mode,
          manager: primary.manager,
          command: primary.command,
          launchCommand: primary.launchCommand,
          cwd: primary.cwd,
          user: primary.user,
          pid: primary.pid,
          processName: primary.process,
          isSelf,
        });
      }
    } else {
      const matchingStopped = stoppedByPort.get(portEntry.port) || [];
      if (matchingStopped.length > 0) {
        for (const stopped of matchingStopped) {
          consumedStoppedIds.add(stopped.id);
          result.push(stoppedToRow(stopped));
        }
      } else {
        const group = resolveGroupMeta(undefined, 'available');
        result.push({
          key: `avail:${portEntry.port}`,
          port: portEntry.port,
          rowState: 'available',
          listeners: [],
          groupId: group.id,
          groupName: group.name,
          service: '空闲端口',
          mode: '',
          manager: '',
          command: '',
          launchCommand: '',
          cwd: '—',
          user: '—',
          processName: '—',
          isSelf: false,
        });
      }
    }
  }

  for (const stopped of stoppedList) {
    if (consumedStoppedIds.has(stopped.id)) continue;
    result.push(stoppedToRow(stopped));
  }

  return result.sort((a, b) => {
    const aHasPort = a.port > 0 ? 0 : 1;
    const bHasPort = b.port > 0 ? 0 : 1;
    if (aHasPort !== bHasPort) return aHasPort - bHasPort;
    if (a.port !== b.port) return a.port - b.port;
    return (a.project?.name || a.manager || a.service).localeCompare(b.project?.name || b.manager || b.service, 'zh-CN');
  });
});

function stoppedToRow(stopped: PortStoppedService): PortRow {
  const rowState: RowState = stopped.state === 'errored' ? 'errored' : 'stopped';
  const group = resolveGroupMeta(stopped.project, rowState);
  return {
    key: `stop:${stopped.id}`,
    port: stopped.port,
    rowState,
    listeners: [],
    stopped,
    project: stopped.project,
    groupId: group.id,
    groupName: group.name,
    service: stopped.service,
    mode: stopped.mode,
    manager: stopped.manager,
    command: stopped.command,
    launchCommand: stopped.launchCommand,
    cwd: stopped.cwd,
    user: stopped.user,
    processName: stopped.process,
    isSelf: false,
  };
}

const keywordFilteredRows = computed(() => {
  const term = keyword.value.trim().toLowerCase();
  if (!term) return allRows.value;
  return allRows.value.filter(row =>
    [
      row.port > 0 ? String(row.port) : '',
      row.pid,
      row.project?.name,
      row.project?.branch,
      row.service,
      row.mode,
      row.manager,
      row.command,
      row.launchCommand,
      row.cwd,
    ]
      .join(' ')
      .toLowerCase()
      .includes(term),
  );
});

const projectGroups = computed<PortProjectGroup[]>(() => {
  const map = new Map<string, PortRow[]>();
  for (const row of keywordFilteredRows.value) {
    if (!map.has(row.groupId)) map.set(row.groupId, []);
    map.get(row.groupId)!.push(row);
  }
  const groups: PortProjectGroup[] = [];
  for (const [id, list] of map.entries()) {
    const listeningCount = list.filter(r => r.rowState === 'listening').length;
    const stoppedCount = list.filter(r => r.rowState === 'stopped' || r.rowState === 'errored').length;
    const ports = [...new Set(list.filter(r => r.port > 0).map(r => r.port))];
    const portsLabel = ports.length
      ? `端口 ${ports.slice(0, 3).join(', ')}${ports.length > 3 ? '…' : ''}`
      : '未分配端口';
    const sampleRow = list.find(r => r.project?.workspacePath) || list.find(r => r.cwd && r.cwd !== '—');
    const workspaceSample = sampleRow?.project?.workspacePath || sampleRow?.cwd || '';
    groups.push({
      id,
      name: list[0].groupName,
      rows: list,
      listeningCount,
      stoppedCount,
      portsLabel,
      workspaceSample,
    });
  }
  return groups.sort((a, b) => {
    if (a.id.startsWith('group:') !== b.id.startsWith('group:')) {
      return a.id.startsWith('group:') ? 1 : -1;
    }
    if (b.listeningCount !== a.listeningCount) return b.listeningCount - a.listeningCount;
    if (b.rows.length !== a.rows.length) return b.rows.length - a.rows.length;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
});

watch(projectGroups, groups => {
  if (projectGroupFilter.value !== 'all' && !groups.some(g => g.id === projectGroupFilter.value)) {
    projectGroupFilter.value = 'all';
  }
});

const selectedProjectGroup = computed(() =>
  projectGroups.value.find(g => g.id === projectGroupFilter.value),
);

const groupFilteredRows = computed(() => {
  if (projectGroupFilter.value === 'all') return keywordFilteredRows.value;
  return keywordFilteredRows.value.filter(r => r.groupId === projectGroupFilter.value);
});

const allListeningCount = computed(() =>
  keywordFilteredRows.value.filter(r => r.rowState === 'listening').length,
);

const tabCounts = computed(() => {
  const base = groupFilteredRows.value;
  return {
    all: base.length,
    listening: base.filter(r => r.rowState === 'listening').length,
    stopped: base.filter(r => r.rowState === 'stopped' || r.rowState === 'errored').length,
    pm2: base.filter(r => !!r.manager).length,
    standalone: base.filter(r => !r.manager && r.rowState !== 'available').length,
  };
});

const rows = computed(() => {
  const base = groupFilteredRows.value;
  switch (statusTab.value) {
    case 'listening':
      return base.filter(r => r.rowState === 'listening');
    case 'stopped':
      return base.filter(r => r.rowState === 'stopped' || r.rowState === 'errored');
    case 'pm2':
      return base.filter(r => !!r.manager);
    case 'standalone':
      return base.filter(r => !r.manager && r.rowState !== 'available');
    default:
      return base;
  }
});

const selectedRow = computed<PortRow | undefined>(() =>
  rows.value.find(r => r.key === selectedRowKey.value),
);

function openDetails(row: PortRow) {
  selectedRowKey.value = row.key;
  detailsVisible.value = true;
}
watch(selectedRowKey, () => { if (detailsContent.value) detailsContent.value.scrollTop = 0; }, { flush: 'post' });

watch(
  rows,
  list => {
    if (!list.some(r => r.key === selectedRowKey.value)) {
      if (detailsVisible.value) {
        detailsVisible.value = false;
        selectedRowKey.value = '';
      } else selectedRowKey.value = list[0]?.key || '';
    }
  },
  { immediate: true },
);

const stoppedCount = computed(() => data.value?.summary.stoppedCount ?? (data.value?.stopped?.length || 0));

const metrics = computed(() => [
  { label: '运行项目', value: data.value?.summary.projectCount, note: '活跃与托管项目去重' },
  {
    label: '监听端口',
    value: data.value?.summary.listeningPorts,
    note: portFilter.value.trim() ? '指定端口实际监听' : '项目服务实际监听',
    tone: 'success',
  },
  {
    label: '运行进程',
    value: data.value?.summary.processCount,
    note: stoppedCount.value ? `另有 ${stoppedCount.value} 个已停止服务` : '同一进程的多个地址合并展示',
  },
  {
    label: 'PM2 托管 / 当前展示',
    value: data.value ? `${data.value.summary.pm2Count ?? 0} / ${rows.value.length}` : undefined,
    note: '支持开启、重启、关闭与删除操作',
  },
]);

async function refresh() {
  if (disposed || filterState.value.error) return;
  controller?.abort();
  const current = new AbortController();
  controller = current;
  fetching.value = true;
  try {
    const ports = filterState.value.ports;
    const response = await fetch(`/api/ports${ports.length ? `?ports=${ports.join(',')}` : ''}`, {
      cache: 'no-store',
      signal: current.signal,
    });
    const body = (await response.json()) as PortSnapshot & { message?: string };
    if (!response.ok) throw new Error(body.message || `端口扫描失败（HTTP ${response.status}）`);
    if (!disposed && controller === current) data.value = body;
  } catch (cause) {
    if (!disposed && !current.signal.aborted) {
      ElMessage.error(cause instanceof Error ? cause.message : String(cause));
    }
  } finally {
    if (controller === current) fetching.value = false;
  }
}

async function runPortAction(payload: PortActionRequest, opKey: string) {
  if (actingKey.value) return;
  actingKey.value = opKey;
  try {
    const response = await fetch('/api/ports/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        ports: portFilter.value.trim() || undefined,
      }),
    });
    const result = (await response.json()) as PortActionResult & { message?: string };
    if (!response.ok) throw new Error(result.message || `操作失败（HTTP ${response.status}）`);
    if (result.snapshot && !disposed) {
      data.value = result.snapshot;
    } else if (!result.selfRestarting) {
      await refresh();
    }
    ElMessage.success(result.message || '操作已完成');
    return result;
  } catch (cause) {
    if (!disposed) {
      ElMessage.error(cause instanceof Error ? cause.message : String(cause));
    }
    return undefined;
  } finally {
    if (!disposed) actingKey.value = '';
  }
}

function rowTitleLabel(row: PortRow) {
  const parts = [
    row.project?.name || row.service,
    row.port > 0 ? `端口 ${row.port}` : '',
    row.manager ? `PM2: ${row.manager}` : row.pid ? `PID ${row.pid}` : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

async function onStartRow(row: PortRow) {
  if (row.rowState === 'listening') return;
  if (row.rowState === 'available') {
    openCreateDialog(row.port);
    return;
  }
  await runPortAction(
    {
      action: 'start',
      port: row.port || undefined,
      manager: row.manager || undefined,
      stoppedId: row.stopped?.id,
      cwd: row.cwd !== '—' ? row.cwd : undefined,
      command: row.command || undefined,
    },
    `${row.key}:start`,
  );
}

async function onRestartRow(row: PortRow) {
  if (row.rowState === 'available') return;
  if (row.isSelf) {
    try {
      await ElMessageBox.confirm(
        `确认重启当前工作台服务（${rowTitleLabel(row)}）吗？重启期间页面会短暂断开并自动恢复。`,
        '确认重启工作台',
        { confirmButtonText: '立即重启', cancelButtonText: '取消', type: 'warning' },
      );
    } catch {
      return;
    }
  }
  await runPortAction(
    {
      action: 'restart',
      port: row.port || undefined,
      pid: row.pid,
      manager: row.manager || undefined,
      stoppedId: row.stopped?.id,
      cwd: row.cwd !== '—' ? row.cwd : undefined,
      command: row.command || undefined,
    },
    `${row.key}:restart`,
  );
}

async function onStopRow(row: PortRow) {
  if (row.rowState !== 'listening' || row.isSelf) return;
  try {
    await ElMessageBox.confirm(
      `确认关闭「${rowTitleLabel(row)}」吗？关闭后将停止进程并释放端口，记录会保留为“已停止”，随时可点击“开启”恢复。`,
      '确认关闭服务',
      { confirmButtonText: '确认关闭', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return;
  }
  await runPortAction(
    {
      action: 'stop',
      port: row.port || undefined,
      pid: row.pid,
      manager: row.manager || undefined,
      cwd: row.cwd !== '—' ? row.cwd : undefined,
      command: row.command || undefined,
      service: row.service,
      mode: row.mode,
      project: row.project,
    },
    `${row.key}:stop`,
  );
}

async function onDeleteRow(row: PortRow) {
  if (row.rowState === 'available' || row.isSelf) return;
  const desc = row.manager
    ? `确认删除「${rowTitleLabel(row)}」吗？该操作将停止进程并从 PM2 托管列表中彻底移除。`
    : `确认删除「${rowTitleLabel(row)}」吗？该操作将停止进程并移除该条服务记录。`;
  try {
    await ElMessageBox.confirm(desc, '确认删除服务', {
      confirmButtonText: '确认删除',
      cancelButtonText: '取消',
      type: 'error',
    });
  } catch {
    return;
  }
  await runPortAction(
    {
      action: 'delete',
      port: row.port || undefined,
      pid: row.pid,
      manager: row.manager || undefined,
      stoppedId: row.stopped?.id,
      cwd: row.cwd !== '—' ? row.cwd : undefined,
    },
    `${row.key}:delete`,
  );
}

async function loadLocalProjects() {
  if (localProjects.value.length > 0 || loadingProjects.value) return;
  loadingProjects.value = true;
  try {
    const response = await fetch('/api/source/projects', { cache: 'no-store' });
    if (response.ok) {
      const body = (await response.json()) as ProjectsData;
      if (Array.isArray(body.projects)) {
        localProjects.value = body.projects;
      }
    }
  } catch {
    /* Optional project list */
  } finally {
    loadingProjects.value = false;
  }
}

function updatePresetCommand() {
  const p = Number(createForm.port);
  const portArg = Number.isInteger(p) && p >= 1 && p <= 65535 ? ` --port ${p}` : '';
  if (createForm.preset === 'pnpm-dev') {
    createForm.command = `pnpm dev -- --host 0.0.0.0${portArg}`;
  } else if (createForm.preset === 'npm-dev') {
    createForm.command = `npm run dev -- --host 0.0.0.0${portArg}`;
  } else if (createForm.preset === 'pnpm-preview') {
    createForm.command = `pnpm preview -- --host 0.0.0.0${portArg}`;
  }
  if (createForm.cwd) {
    const base = createForm.cwd.split('/').filter(Boolean).at(-1) || 'service';
    createForm.pm2Name = `${base}${portArg ? `-${p}` : ''}`.replace(/[^a-zA-Z0-9_-]/g, '-');
  }
}

function onSelectProject(projectPath: string) {
  createForm.cwd = projectPath;
  updatePresetCommand();
}

function openCreateDialog(defaultPort?: number, defaultCwd?: string) {
  createForm.port = defaultPort && defaultPort > 0 ? String(defaultPort) : '';
  if (defaultCwd && defaultCwd !== '—') {
    createForm.cwd = defaultCwd;
    createForm.selectedProjectPath = defaultCwd;
  }
  createForm.preset = 'pnpm-dev';
  updatePresetCommand();
  createDialogVisible.value = true;
  void loadLocalProjects();
}

function openCreateDialogForCurrent() {
  const sampleCwd = selectedProjectGroup.value?.workspaceSample || undefined;
  openCreateDialog(undefined, sampleCwd);
}

async function submitCreateService() {
  if (creating.value) return;
  const cwd = createForm.cwd.trim();
  const cmd = createForm.command.trim();
  if (!cwd) {
    ElMessage.warning('请选择或填写工作区目录');
    return;
  }
  if (!cmd) {
    ElMessage.warning('请填写启动命令');
    return;
  }
  const portNum = createForm.port.trim() ? Number(createForm.port.trim()) : undefined;
  if (portNum !== undefined && (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535)) {
    ElMessage.warning('端口号需为 1–65535 的整数');
    return;
  }
  creating.value = true;
  try {
    const res = await runPortAction(
      {
        action: 'create',
        cwd,
        command: cmd,
        port: portNum,
        usePm2: createForm.usePm2,
        pm2Name: createForm.pm2Name.trim() || undefined,
      },
      'create:service',
    );
    if (res?.ok) {
      createDialogVisible.value = false;
    }
  } finally {
    creating.value = false;
  }
}

function refreshAutomatically() {
  if (autoRefresh.value && document.visibilityState === 'visible' && !fetching.value && !actingKey.value) {
    void refresh();
  }
}

function resetTimer() {
  clearInterval(timer);
  timer = autoRefresh.value && document.visibilityState === 'visible'
    ? setInterval(refreshAutomatically, autoRefreshSeconds * 1_000)
    : undefined;
}

function handleVisibilityChange() {
  resetTimer();
  refreshAutomatically();
}

async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    ElMessage.success('已复制');
  } catch {
    ElMessage.error('浏览器未允许复制');
  }
}

function addressLabel(listener: PortListener) {
  const address = listener.address.includes(':') ? `[${listener.address}]` : listener.address;
  return `${address}:${listener.port}`;
}

function scopeLabel(scope: PortListener['scope']) {
  return { loopback: '仅本机', lan: '指定网卡', all: '所有网卡', unknown: '未知范围' }[scope];
}

function statusText(state: RowState) {
  return state === 'listening'
    ? '已监听'
    : state === 'errored'
      ? '异常停止'
      : state === 'stopped'
        ? '已停止'
        : '未监听';
}

function isRowActing(row: PortRow, action?: PortActionType) {
  if (!actingKey.value) return false;
  return action ? actingKey.value === `${row.key}:${action}` : actingKey.value.startsWith(`${row.key}:`);
}

function buildConsolePreview(row: PortRow): string {
  if (row.rowState === 'available') {
    return `# 端口 ${row.port} 当前空闲\n本次扫描未发现监听该端口的 TCP 进程，可点击右上角「开启」在此端口启动项目服务。`;
  }
  const lines = [
    `项目名称: ${row.project?.name || '非项目进程'}`,
    `服务类型: ${row.service}${row.mode ? ` (模式 ${row.mode})` : ''}`,
    `当前状态: ${statusText(row.rowState)}${row.port > 0 ? ` · 端口 ${row.port}` : ''}`,
    `托管方式: ${row.manager ? `PM2 (${row.manager})` : '独立进程'}${row.pid ? ` · PID ${row.pid}` : ''}`,
    `工作目录: ${row.cwd || '—'}`,
  ];
  if (row.project?.branch) {
    lines.push(`Git 分支: ${row.project.branch}`);
  }
  if (row.listeners.length) {
    lines.push(
      `监听地址: ${row.listeners.map(l => `${addressLabel(l)} (${scopeLabel(l.scope)})`).join(', ')}`,
    );
  }
  const sections = ['## 服务概览', markdownCodeBlock(lines.join('\n')), '## 实际启动 / 进程命令', markdownCodeBlock(row.command || '—', 'sh')];
  if (row.launchCommand && row.launchCommand !== row.command) {
    sections.push('## PM2 托管启动配置', markdownCodeBlock(row.launchCommand, 'sh'));
  }
  return sections.join('\n\n');
}

watch(portFilter, () => {
  controller?.abort();
  if (debounce) clearTimeout(debounce);
  data.value = undefined;
  debounce = setTimeout(() => {
    void refresh();
  }, 300);
});
watch(autoRefresh, resetTimer);
onMounted(() => {
  document.addEventListener('visibilitychange', handleVisibilityChange);
  handleVisibilityChange();
});
onBeforeUnmount(() => {
  disposed = true;
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  controller?.abort();
  if (timer) clearInterval(timer);
  if (debounce) clearTimeout(debounce);
});
</script>

<template>
  <section class="port-monitor-page">
    <PageHeading
      title="项目端口检测"
      description="按项目分类检测本机端口占用、工作区与分支状态，支持一键开启、重启、关闭与删除服务。"
      :loading="fetching"
      @refresh="refresh"
    >
      <el-switch v-model="autoRefresh" :active-text="`每 ${autoRefreshSeconds} 秒刷新`" :aria-label="`每 ${autoRefreshSeconds} 秒刷新`" />
      <el-button type="primary" @click="openCreateDialogForCurrent()">
        <Plus :size="14" />
        <span>开启服务</span>
      </el-button>
    </PageHeading>

    <MetricStrip :items="metrics" />

    <div class="port-layout">
      <!-- 左侧：项目分类导航（对齐项目部署布局） -->
      <aside class="port-sidebar" aria-label="端口项目分类">
        <div class="sidebar-heading">
          <strong>项目分类</strong>
          <span>{{ projectGroups.length }}</span>
        </div>

        <el-input
          v-model="keyword"
          clearable
          placeholder="搜索项目、分支、服务或 PID"
          aria-label="搜索项目、分支、服务或 PID"
        />
        <el-input
          v-model="portFilter"
          clearable
          placeholder="检查端口，如 5179 或 5173-5199"
          aria-label="检查端口"
        />
        <p v-if="filterState.error" class="sidebar-error">{{ filterState.error }}</p>

        <nav class="port-projects" aria-label="选择项目分类">
          <button
            type="button"
            :class="{ selected: projectGroupFilter === 'all' }"
            :aria-current="projectGroupFilter === 'all' ? 'page' : undefined"
            @click="projectGroupFilter = 'all'"
          >
            <RadioTower :size="16" />
            <span>
              <strong>全部项目服务</strong>
              <small>{{ allListeningCount }} 个监听 · 共 {{ keywordFilteredRows.length }} 项</small>
            </span>
          </button>

          <button
            v-for="group in projectGroups"
            :key="group.id"
            type="button"
            :class="{ selected: projectGroupFilter === group.id }"
            :aria-current="projectGroupFilter === group.id ? 'page' : undefined"
            @click="projectGroupFilter = group.id"
          >
            <Folder :size="16" />
            <span>
              <strong>{{ group.name }}</strong>
              <small>
                {{ group.listeningCount }} 个监听<template v-if="group.stoppedCount"> · {{ group.stoppedCount }} 个已停止</template>
                · {{ group.portsLabel }}
              </small>
            </span>
          </button>

          <p v-if="!projectGroups.length && !fetching" class="sidebar-empty">没有匹配的项目服务</p>
        </nav>

        <div class="sidebar-footer">
          <span>最近扫描 {{ data?.scannedAt ? new Date(data.scannedAt).toLocaleTimeString() : '—' }}</span>
        </div>
      </aside>

      <!-- 右侧：主工作区（顶部标题 + 状态筛选 + 服务卡片/表格） -->
      <main class="port-main">
        <header class="port-project-heading">
          <div>
            <h2>{{ selectedProjectGroup ? selectedProjectGroup.name : '全部项目服务' }}</h2>
            <p>
              {{
                selectedProjectGroup?.workspaceSample
                  ? `${selectedProjectGroup.workspaceSample} · ${selectedProjectGroup.portsLabel}`
                  : '查看本机监听端口与 PM2 托管服务。'
              }}
            </p>
          </div>
          <div class="heading-actions">
            <div class="view-mode-switch" role="group" aria-label="视图切换">
              <button
                type="button"
                :class="{ active: viewMode === 'cards' }"
                :aria-pressed="viewMode === 'cards'"
                title="卡片网格视图"
                @click="viewMode = 'cards'"
              >
                <LayoutGrid :size="14" />
                <span>卡片</span>
              </button>
              <button
                type="button"
                :class="{ active: viewMode === 'table' }"
                :aria-pressed="viewMode === 'table'"
                title="表格列表视图"
                @click="viewMode = 'table'"
              >
                <List :size="14" />
                <span>表格</span>
              </button>
            </div>
          </div>
        </header>

        <div class="port-toolbar-row">
          <div class="port-status-tabs" role="tablist" aria-label="服务状态筛选">
            <button type="button" :class="{ active: statusTab === 'all' }" @click="statusTab = 'all'">
              全部 <span>{{ tabCounts.all }}</span>
            </button>
            <button type="button" :class="{ active: statusTab === 'listening' }" @click="statusTab = 'listening'">
              已监听 <span>{{ tabCounts.listening }}</span>
            </button>
            <button type="button" :class="{ active: statusTab === 'stopped' }" @click="statusTab = 'stopped'">
              已停止 <span>{{ tabCounts.stopped }}</span>
            </button>
            <button type="button" :class="{ active: statusTab === 'pm2' }" @click="statusTab = 'pm2'">
              PM2 托管 <span>{{ tabCounts.pm2 }}</span>
            </button>
            <button type="button" :class="{ active: statusTab === 'standalone' }" @click="statusTab = 'standalone'">
              独立进程 <span>{{ tabCounts.standalone }}</span>
            </button>
          </div>
          <span class="filter-count">当前展示 {{ rows.length }} 项</span>
        </div>

        <div v-if="fetching && !data" class="surface-body">
          <el-skeleton :rows="6" animated />
        </div>

        <template v-else>
          <!-- 顶部区域：端口服务卡片网格 或 表格视图 -->
          <section class="environment-section" aria-label="端口服务环境">
            <div class="section-heading">
              <h3>
                端口服务实例
                <small>{{ rows.length }}</small>
              </h3>
            </div>

            <template v-if="rows.length">
              <!-- 卡片网格视图（参考项目部署环境卡片） -->
              <div v-if="viewMode === 'cards'" class="environment-grid" role="region" aria-label="端口服务卡片" tabindex="0">
                <article
                  v-for="row in rows"
                  :key="row.key"
                  class="environment-card port-service-card"
                  :class="{ selected: selectedRow?.key === row.key }"
                  @click="openDetails(row)"
                >
                  <header>
                    <div class="card-port-headline">
                      <template v-if="row.port > 0">
                        <a
                          v-if="row.rowState === 'listening'"
                          :href="`http://localhost:${row.port}`"
                          target="_blank"
                          rel="noopener noreferrer"
                          class="port-number port-link"
                          :title="`在浏览器打开 http://localhost:${row.port}`"
                          @click.stop
                        >
                          <span>{{ row.port }}</span>
                          <ExternalLink :size="12" />
                        </a>
                        <strong v-else class="port-number">{{ row.port }}</strong>
                      </template>
                      <span v-else class="port-number is-unassigned">未定端口</span>
                      <span v-if="row.isSelf" class="self-badge">当前工作台</span>
                    </div>

                    <span
                      class="port-status-pill"
                      :class="{
                        'is-listening': row.rowState === 'listening',
                        'is-stopped': row.rowState === 'stopped',
                        'is-errored': row.rowState === 'errored',
                        'is-available': row.rowState === 'available',
                      }"
                    >
                      <i class="status-dot"></i>
                      {{ statusText(row.rowState) }}
                    </span>
                  </header>

                  <div class="card-project-line">
                    <strong>{{ row.project?.name || '非项目进程' }}</strong>
                    <span>{{ row.service }}</span>
                    <span v-if="row.mode" class="mode-badge">模式 {{ row.mode }}</span>
                  </div>

                  <div class="card-badges-row">
                    <span v-if="row.manager" class="manager-badge is-pm2">PM2 · {{ row.manager }}</span>
                    <span v-else-if="row.rowState !== 'available'" class="manager-badge">独立进程</span>
                    <span v-if="row.pid" class="manager-badge">PID {{ row.pid }}</span>
                    <span v-if="row.listeners[0]" class="manager-badge">
                      {{ addressLabel(row.listeners[0]) }} · {{ scopeLabel(row.listeners[0].scope) }}
                    </span>
                  </div>

                  <div v-if="row.rowState !== 'available'" class="card-workspace-box">
                    <div class="branch-row">
                      <span class="branch-pill">
                        <GitBranch :size="12" />
                        <span>{{ row.project?.branch || (row.project ? '无 Git 分支' : '—') }}</span>
                      </span>
                    </div>
                    <div class="cwd-line">
                      <code :title="row.project?.workspacePath || row.cwd">
                        {{ shortPath(row.project?.workspacePath || row.cwd) }}
                      </code>
                      <button
                        v-if="(row.project?.workspacePath || row.cwd) && (row.project?.workspacePath || row.cwd) !== '—'"
                        type="button"
                        title="复制工作区目录"
                        aria-label="复制工作区目录"
                        @click.stop="copy(row.project?.workspacePath || row.cwd)"
                      >
                        <Copy :size="12" />
                      </button>
                    </div>
                  </div>
                  <p v-else class="card-empty-note">当前端口未发现 TCP 监听进程，可点击开启服务。</p>

                  <footer @click.stop>
                    <button class="service-details-trigger" type="button" :aria-label="`查看端口 ${row.port || '未定'} 服务详情`" aria-haspopup="dialog" @click="openDetails(row)">详情 <ExternalLink :size="12" /></button>
                    <div class="port-actions" role="group" :aria-label="`端口 ${row.port || row.service} 操作`">
                      <button
                        type="button"
                        class="port-op-btn is-start"
                        :disabled="row.rowState === 'listening' || !!actingKey"
                        :title="row.rowState === 'listening' ? '服务已在运行中' : '开启该服务'"
                        @click="onStartRow(row)"
                      >
                        <Play :size="12" />
                        <span>{{ isRowActing(row, 'start') ? '开启中' : '开启' }}</span>
                      </button>
                      <button
                        type="button"
                        class="port-op-btn is-restart"
                        :disabled="row.rowState === 'available' || !!actingKey"
                        :title="row.rowState === 'available' ? '空闲端口请先点击开启' : '重启该服务'"
                        @click="onRestartRow(row)"
                      >
                        <RotateCw :size="12" :class="{ 'is-spinning': isRowActing(row, 'restart') }" />
                        <span>{{ isRowActing(row, 'restart') ? '重启中' : '重启' }}</span>
                      </button>
                      <button
                        type="button"
                        class="port-op-btn is-stop"
                        :disabled="row.rowState !== 'listening' || row.isSelf || !!actingKey"
                        :title="
                          row.isSelf
                            ? '当前工作台服务不支持直接关闭'
                            : row.rowState !== 'listening'
                              ? '服务当前未在监听'
                              : '关闭该服务并释放端口'
                        "
                        @click="onStopRow(row)"
                      >
                        <Square :size="12" />
                        <span>{{ isRowActing(row, 'stop') ? '关闭中' : '关闭' }}</span>
                      </button>
                      <button
                        type="button"
                        class="port-op-btn is-delete"
                        :disabled="row.rowState === 'available' || row.isSelf || !!actingKey"
                        :title="
                          row.isSelf
                            ? '当前工作台服务不可删除'
                            : row.rowState === 'available'
                              ? '空闲端口无需删除'
                              : '停止并移除该服务记录'
                        "
                        @click="onDeleteRow(row)"
                      >
                        <Trash2 :size="12" />
                        <span>{{ isRowActing(row, 'delete') ? '删除中' : '删除' }}</span>
                      </button>
                    </div>
                  </footer>
                </article>
              </div>

              <!-- 表格视图 -->
              <div v-else class="port-table-wrap">
                <el-table
                  :data="rows"
                  :scrollbar-tabindex="0"
                  row-key="key"
                  class="port-table"
                  empty-text="没有匹配的项目服务"
                  @row-click="openDetails"
                >
                  <el-table-column label="端口 / 状态" width="132">
                    <template #default="{ row }">
                      <div class="port-cell">
                        <div class="port-number-row">
                          <template v-if="row.port > 0">
                            <a
                              v-if="row.rowState === 'listening'"
                              :href="`http://localhost:${row.port}`"
                              target="_blank"
                              rel="noopener noreferrer"
                              class="port-number port-link"
                              @click.stop
                            >
                              <span>{{ row.port }}</span>
                              <ExternalLink :size="12" />
                            </a>
                            <strong v-else class="port-number">{{ row.port }}</strong>
                          </template>
                          <span v-else class="port-number is-unassigned">未定端口</span>
                        </div>
                        <div class="port-status">
                          <span
                            class="port-status-pill"
                            :class="{
                              'is-listening': row.rowState === 'listening',
                              'is-stopped': row.rowState === 'stopped',
                              'is-errored': row.rowState === 'errored',
                              'is-available': row.rowState === 'available',
                            }"
                          >
                            <i class="status-dot"></i>
                            {{ statusText(row.rowState) }}
                          </span>
                        </div>
                      </div>
                    </template>
                  </el-table-column>

                  <el-table-column label="项目 / 服务" min-width="210">
                    <template #default="{ row }">
                      <div v-if="row.rowState !== 'available'" class="service-cell">
                        <div class="project-title-row">
                          <span class="row-title">{{ row.project?.name || '非项目进程' }}</span>
                          <span v-if="row.isSelf" class="self-badge">当前工作台</span>
                        </div>
                        <div class="service-meta-row">
                          <span class="row-secondary">{{ row.service }}</span>
                          <span v-if="row.mode" class="mode-badge">模式 {{ row.mode }}</span>
                        </div>
                        <div class="manager-row">
                          <span v-if="row.manager" class="manager-badge is-pm2">PM2 · {{ row.manager }}</span>
                          <span v-else class="manager-badge">独立进程</span>
                        </div>
                      </div>
                      <span v-else class="row-secondary">未发现 TCP 监听进程</span>
                    </template>
                  </el-table-column>

                  <el-table-column label="实际工作区 / 当前分支" min-width="240">
                    <template #default="{ row }">
                      <div v-if="row.rowState !== 'available'" class="workspace-cell">
                        <div class="branch-row">
                          <span class="branch-pill">
                            <GitBranch :size="12" />
                            <span>{{ row.project?.branch || (row.project ? '无 Git 分支' : '—') }}</span>
                          </span>
                        </div>
                        <div class="cwd-line">
                          <code :title="row.project?.workspacePath || row.cwd">
                            {{ shortPath(row.project?.workspacePath || row.cwd) }}
                          </code>
                          <button
                            v-if="(row.project?.workspacePath || row.cwd) && (row.project?.workspacePath || row.cwd) !== '—'"
                            type="button"
                            title="复制工作区目录"
                            @click.stop="copy(row.project?.workspacePath || row.cwd)"
                          >
                            <Copy :size="12" />
                          </button>
                        </div>
                      </div>
                      <span v-else class="row-secondary">—</span>
                    </template>
                  </el-table-column>

                  <el-table-column label="进程 / 地址" min-width="160">
                    <template #default="{ row }">
                      <template v-if="row.rowState === 'listening'">
                        <span class="row-title">{{ row.processName }} · PID {{ row.pid }}</span>
                        <div v-for="listener in row.listeners" :key="listener.address" class="listener-line">
                          <code>{{ addressLabel(listener) }}</code>
                          <small>{{ scopeLabel(listener.scope) }}</small>
                        </div>
                      </template>
                      <template v-else-if="row.rowState === 'stopped' || row.rowState === 'errored'">
                        <span class="row-title is-muted">{{ row.processName }}</span>
                        <span class="row-mono">{{ row.stopped?.pmId !== undefined ? `PM2 #${row.stopped.pmId}` : '已释放监听' }}</span>
                      </template>
                      <span v-else class="row-secondary">—</span>
                    </template>
                  </el-table-column>

                  <el-table-column label="操作" width="288" fixed="right" align="right">
                    <template #default="{ row }">
                      <div class="port-actions" @click.stop>
                        <button type="button" class="port-op-btn" :aria-label="`查看端口 ${row.port || '未定'} 服务详情`" aria-haspopup="dialog" @click="openDetails(row)">详情</button>
                        <button
                          type="button"
                          class="port-op-btn is-start"
                          :disabled="row.rowState === 'listening' || !!actingKey"
                          @click="onStartRow(row)"
                        >
                          <Play :size="12" />
                          <span>{{ isRowActing(row, 'start') ? '开启中' : '开启' }}</span>
                        </button>
                        <button
                          type="button"
                          class="port-op-btn is-restart"
                          :disabled="row.rowState === 'available' || !!actingKey"
                          @click="onRestartRow(row)"
                        >
                          <RotateCw :size="12" :class="{ 'is-spinning': isRowActing(row, 'restart') }" />
                          <span>{{ isRowActing(row, 'restart') ? '重启中' : '重启' }}</span>
                        </button>
                        <button
                          type="button"
                          class="port-op-btn is-stop"
                          :disabled="row.rowState !== 'listening' || row.isSelf || !!actingKey"
                          @click="onStopRow(row)"
                        >
                          <Square :size="12" />
                          <span>{{ isRowActing(row, 'stop') ? '关闭中' : '关闭' }}</span>
                        </button>
                        <button
                          type="button"
                          class="port-op-btn is-delete"
                          :disabled="row.rowState === 'available' || row.isSelf || !!actingKey"
                          @click="onDeleteRow(row)"
                        >
                          <Trash2 :size="12" />
                          <span>{{ isRowActing(row, 'delete') ? '删除中' : '删除' }}</span>
                        </button>
                      </div>
                    </template>
                  </el-table-column>
                </el-table>
              </div>
            </template>

            <el-empty v-else description="当前筛选条件下没有匹配的服务实例" :image-size="64" />
          </section>
        </template>
      </main>
    </div>

    <el-drawer v-model="detailsVisible" title="服务运行详情" size="min(1080px, 96vw)" class="port-details-drawer" append-to-body destroy-on-close>
      <!-- 服务列表与详情在固定抽屉内展示，无需滚动至卡片列表底部。 -->
      <section class="deployment-execution" aria-label="服务运行信息与命令配置">
        <aside class="run-history" aria-label="服务实例列表">
          <div class="section-heading">
            <h3>服务记录</h3>
            <small>{{ rows.length }} 项</small>
          </div>
          <div class="run-history-list">
            <button
              v-for="row in rows"
              :key="row.key"
              type="button"
              :class="{ selected: selectedRow?.key === row.key }"
              :aria-pressed="selectedRow?.key === row.key"
              @click="selectedRowKey = row.key"
            >
              <span>
                <strong>{{ row.port > 0 ? `:${row.port}` : '未定' }} · {{ row.project?.name || row.service }}</strong>
                <span
                  class="mini-status-tag"
                  :class="{
                    'is-listening': row.rowState === 'listening',
                    'is-stopped': row.rowState === 'stopped',
                    'is-errored': row.rowState === 'errored',
                  }"
                >
                  {{ statusText(row.rowState) }}
                </span>
              </span>
              <small>{{ row.manager ? `PM2 · ${row.manager}` : row.pid ? `PID ${row.pid}` : row.service }}</small>
              <small>{{ shortPath(row.project?.workspacePath || row.cwd) }}</small>
            </button>
          </div>
          <p v-if="!rows.length" class="history-empty">暂无服务记录</p>
        </aside>

        <div class="run-console">
          <div class="section-heading">
            <h3>
              <Terminal :size="16" />
              <span>运行信息与启动配置</span>
            </h3>
            <span class="live-state">{{ autoRefresh ? `每 ${autoRefreshSeconds} 秒自动更新` : '手动刷新模式' }}</span>
          </div>

          <template v-if="selectedRow">
            <div class="log-heading">
              <div>
                <strong>
                  {{ selectedRow.port > 0 ? `端口 ${selectedRow.port}` : '未定端口' }}
                  · {{ selectedRow.project?.name || selectedRow.service }}
                  <template v-if="selectedRow.mode"> ({{ selectedRow.mode }})</template>
                </strong>
                <p>{{ selectedRow.project?.workspacePath || selectedRow.cwd }}</p>
              </div>
              <div class="console-header-right">
                <a
                  v-if="selectedRow.port > 0 && selectedRow.rowState === 'listening'"
                  :href="`http://localhost:${selectedRow.port}`"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="open-browser-link"
                >
                  打开本地服务 ↗
                </a>
                <el-button
                  v-if="selectedRow.command"
                  size="small"
                  @click="copy(selectedRow.command)"
                >
                  复制命令
                </el-button>
                <el-button
                  v-if="selectedRow.cwd && selectedRow.cwd !== '—'"
                  size="small"
                  @click="copy(selectedRow.project?.workspacePath || selectedRow.cwd)"
                >
                  复制工作区
                </el-button>
              </div>
            </div>

            <div ref="detailsContent" class="service-markdown" aria-label="服务进程与启动配置"><AgentMarkdown :source="buildConsolePreview(selectedRow)" /></div>
          </template>
          <el-empty v-else description="当前服务已不在列表中，请重新选择服务。" :image-size="64" />
        </div>
      </section>
    </el-drawer>

    <!-- 开启新端口服务弹窗 -->
    <el-dialog
      v-model="createDialogVisible"
      title="开启项目端口服务"
      width="560px"
      destroy-on-close
    >
      <el-form label-position="top" class="create-service-form">
        <el-form-item label="选择本地项目工作区（可选）">
          <el-select
            v-model="createForm.selectedProjectPath"
            filterable
            clearable
            placeholder="从已扫描的本地工作区中快速选择"
            :loading="loadingProjects"
            style="width: 100%"
            @change="onSelectProject"
          >
            <el-option
              v-for="item in localProjects"
              :key="item.path"
              :label="`${item.displayName || item.projectName} (${item.branch || '无分支'}) — ${item.displayPath}`"
              :value="item.path"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="工作区目录 (cwd)" required>
          <el-input
            v-model="createForm.cwd"
            placeholder="例如 /Users/yourname/Projects/example"
            @input="updatePresetCommand"
          />
        </el-form-item>

        <div class="form-row-2col">
          <el-form-item label="指定端口（可选）">
            <el-input
              v-model="createForm.port"
              placeholder="如 5180"
              @input="updatePresetCommand"
            />
          </el-form-item>

          <el-form-item label="常用命令模板">
            <el-select v-model="createForm.preset" style="width: 100%" @change="updatePresetCommand">
              <el-option label="pnpm dev" value="pnpm-dev" />
              <el-option label="npm run dev" value="npm-dev" />
              <el-option label="pnpm preview" value="pnpm-preview" />
              <el-option label="自定义命令" value="custom" />
            </el-select>
          </el-form-item>
        </div>

        <el-form-item label="启动命令" required>
          <el-input
            v-model="createForm.command"
            placeholder="例如 pnpm dev -- --host 0.0.0.0 --port 5180"
          />
        </el-form-item>

        <div class="form-row-2col">
          <el-form-item label="托管方式">
            <el-switch
              v-model="createForm.usePm2"
              active-text="使用 PM2 托管（支持后续一键开启/重启）"
            />
          </el-form-item>

          <el-form-item v-if="createForm.usePm2" label="PM2 服务名称">
            <el-input v-model="createForm.pm2Name" placeholder="自动根据目录与端口生成" />
          </el-form-item>
        </div>
      </el-form>

      <template #footer>
        <el-button @click="createDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="submitCreateService">
          立即开启
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.port-monitor-page {
  min-width: 0;
}

.port-monitor-page :deep(.hub-metrics.hub-metrics > .metric-card) {
  min-height: 82px;
  padding: 12px 18px;
}

.port-monitor-page :deep(.hub-metrics.hub-metrics > .metric-card strong) {
  font: 600 26px/1.3 var(--sans, sans-serif);
  margin: 4px 0;
}

.port-monitor-page :deep(.hub-metrics.hub-metrics > .metric-card small) {
  font-size: 11px;
}

/* 左右分栏主布局（与项目部署 DeploymentWorkspace 保持一致） */
.port-layout {
  display: grid;
  grid-template-columns: 248px minmax(0, 1fr);
  align-items: start;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  background: var(--ui-surface);
  overflow: clip;
}

.port-sidebar {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  position: sticky;
  top: 0;
  align-self: start;
  box-sizing: border-box;
  padding: 18px 12px;
  border-right: 1px solid var(--ui-border);
  background: var(--ui-raised, var(--ui-bg));
}

.sidebar-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 6px;
  font-size: 14px;
}

.sidebar-heading > span {
  font-size: 12px;
  color: var(--ui-muted);
}

.sidebar-error {
  margin: 0 4px;
  color: var(--ui-danger);
  font-size: 11px;
  line-height: 1.5;
}

.port-projects {
  min-width: 0;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-height: 0;
  max-height: min(48dvh, 26rem);
  overflow: auto;
  flex: 1;
}

.port-projects > button {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  width: 100%;
  padding: 11px 10px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--ui-text);
  text-align: left;
  cursor: pointer;
  font: inherit;
}

.port-projects > button > svg {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--ui-muted);
}

.port-projects > button > span {
  min-width: 0;
}

.port-projects strong,
.port-projects small {
  display: block;
  overflow-wrap: anywhere;
}

.port-projects strong {
  font-size: 13px;
  font-weight: 550;
  line-height: 1.5;
}

.port-projects small {
  margin-top: 4px;
  font-size: 11px;
  color: var(--ui-muted);
  line-height: 1.45;
}

.port-projects > button:hover {
  background: var(--ui-accent-soft);
}

.port-projects > button.selected {
  border-color: color-mix(in srgb, var(--ui-accent) 35%, transparent);
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
}

.port-projects > button.selected > svg {
  color: var(--ui-accent);
}

.sidebar-empty,
.history-empty {
  padding: 12px;
  color: var(--ui-muted);
  font-size: 12px;
}

.sidebar-footer {
  padding: 6px 6px 0;
  border-top: 1px solid var(--ui-divider, var(--ui-border));
  color: var(--ui-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

/* 右侧主面板 */
.port-main {
  min-width: 0;
  padding: 20px 22px;
}

.port-project-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 16px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--ui-divider, var(--ui-border));
}

.port-project-heading > div:first-child {
  flex: 1 1 210px;
  min-width: 0;
}

.port-project-heading h2 {
  margin: 0;
  font-size: 19px;
  line-height: 1.5;
}

.port-project-heading p {
  margin: 5px 0 0;
  color: var(--ui-muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.heading-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.heading-actions :deep(.el-button > span) {
  gap: 5px;
}

.view-mode-switch {
  display: inline-flex;
  padding: 3px;
  border: 1px solid var(--ui-border);
  border-radius: 7px;
  background: var(--ui-raised, var(--ui-bg));
}

.view-mode-switch > button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 9px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--ui-secondary);
  font-size: 12px;
  cursor: pointer;
}

.view-mode-switch > button.active {
  background: var(--ui-surface);
  color: var(--ui-text);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06);
}

.port-toolbar-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px 12px;
  flex-wrap: wrap;
  padding: 8px 0 4px;
}

.port-status-tabs {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 3px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: var(--ui-raised, var(--ui-bg));
}

.port-status-tabs > button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ui-secondary);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.port-status-tabs > button:hover {
  color: var(--ui-text);
}

.port-status-tabs > button.active {
  background: var(--ui-surface);
  color: var(--ui-accent);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06);
  font-weight: 600;
}

.port-status-tabs > button > span {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  opacity: 0.78;
}

.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 0 0 12px;
}

.section-heading h3 {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  font-size: 14px;
  font-weight: 550;
  line-height: 1.6;
}

.section-heading small,
.live-state {
  color: var(--ui-muted);
  font-size: 11px;
  font-weight: 400;
}

.environment-section {
  padding: 14px 0 20px;
}

.environment-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(285px, 100%), 1fr));
  gap: 12px;
}

.environment-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 14px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: var(--ui-surface);
  cursor: pointer;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.environment-card:hover {
  border-color: color-mix(in srgb, var(--ui-accent) 40%, var(--ui-border));
}

.environment-card.selected {
  border-color: var(--ui-accent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ui-accent) 25%, transparent);
}

.service-details-trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 26px;
  padding: 0 3px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--ui-accent);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.service-details-trigger:hover { background: var(--ui-hover); }
.service-details-trigger:focus-visible,
.environment-grid:focus-visible {
  outline: 2px solid var(--ui-accent);
  outline-offset: -2px;
}

.environment-card > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.card-port-headline {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.card-project-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 8px;
  margin: 6px 0 4px;
}

.card-project-line > strong {
  font-size: 14px;
  color: var(--ui-text);
}

.card-project-line > span {
  font-size: 12px;
  color: var(--ui-secondary);
}

.card-badges-row {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-bottom: 6px;
}

.card-workspace-box {
  display: grid;
  gap: 4px;
  padding: 6px 8px;
  margin-bottom: 8px;
  border-radius: 6px;
  background: var(--ui-raised, var(--ui-bg));
  border: 1px solid var(--ui-divider, var(--ui-border));
}

.card-empty-note {
  margin: 8px 0 12px;
  color: var(--ui-muted);
  font-size: 12px;
}

.environment-card > footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 4px 8px;
  margin-top: auto;
  padding-top: 6px;
  border-top: 1px solid var(--ui-divider, var(--ui-border));
}

.port-table-wrap {
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  overflow: hidden;
}

/* 端口与状态通用元素 */
.port-cell {
  display: grid;
  gap: 5px;
}

.port-number-row {
  display: flex;
  align-items: center;
}

.port-number {
  font: 650 15px/1.2 var(--mono);
  font-variant-numeric: tabular-nums;
  color: var(--ui-text);
}

.port-number.is-unassigned {
  font-size: 12px;
  font-weight: 500;
  color: var(--ui-muted);
}

.port-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--ui-text);
  text-decoration: none;
  transition: color 0.15s ease;
}

.port-link > svg {
  color: var(--ui-muted);
  transition: transform 0.15s ease, color 0.15s ease;
}

.port-link:hover {
  color: var(--ui-accent);
}

.port-link:hover > svg {
  color: var(--ui-accent);
  transform: translate(1px, -1px);
}

.port-status-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid transparent;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: currentColor;
}

.port-status-pill.is-listening {
  color: var(--ui-success);
  background: color-mix(in srgb, var(--ui-success) 10%, var(--ui-surface));
  border-color: color-mix(in srgb, var(--ui-success) 24%, transparent);
}

.port-status-pill.is-stopped {
  color: var(--ui-warning);
  background: color-mix(in srgb, var(--ui-warning) 10%, var(--ui-surface));
  border-color: color-mix(in srgb, var(--ui-warning) 24%, transparent);
}

.port-status-pill.is-errored {
  color: var(--ui-danger);
  background: color-mix(in srgb, var(--ui-danger) 10%, var(--ui-surface));
  border-color: color-mix(in srgb, var(--ui-danger) 24%, transparent);
}

.port-status-pill.is-available {
  color: var(--ui-muted);
  background: var(--ui-bg);
  border-color: var(--ui-border);
}

.service-cell {
  display: grid;
  gap: 4px;
}

.project-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.self-badge {
  display: inline-flex;
  align-items: center;
  height: 19px;
  padding: 0 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  color: var(--ui-accent);
  background: var(--ui-accent-soft);
}

.service-meta-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.mode-badge {
  display: inline-flex;
  align-items: center;
  height: 19px;
  padding: 0 6px;
  border-radius: 4px;
  font: 500 11px/1 var(--mono);
  color: var(--ui-secondary);
  background: var(--ui-bg);
  border: 1px solid var(--ui-border);
}

.manager-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.manager-badge {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 7px;
  border-radius: 4px;
  font: 500 11px/1 var(--mono);
  color: var(--ui-muted);
  background: var(--ui-bg);
  border: 1px solid var(--ui-border);
}

.manager-badge.is-pm2 {
  color: var(--ui-secondary);
  background: color-mix(in srgb, var(--ui-accent) 6%, var(--ui-surface));
  border-color: color-mix(in srgb, var(--ui-accent) 20%, var(--ui-border));
}

.workspace-cell {
  display: grid;
  gap: 5px;
}

.branch-row {
  display: flex;
  align-items: center;
}

.branch-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  padding: 2px 7px;
  border-radius: 5px;
  background: var(--ui-surface);
  border: 1px solid var(--ui-border);
  color: var(--ui-text);
  font: 500 11px/1.35 var(--mono);
}

.branch-pill > svg {
  flex: none;
  color: var(--ui-secondary);
}

.branch-pill > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cwd-line {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  min-width: 0;
}

.cwd-line code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ui-secondary);
  font: 11px/1.45 var(--mono);
}

.cwd-line button {
  flex: none;
  width: 22px;
  height: 22px;
  border: 1px solid transparent;
  border-radius: 5px;
  display: inline-grid;
  place-items: center;
  background: transparent;
  color: var(--ui-muted);
  cursor: pointer;
  transition: all 0.15s ease;
}

.cwd-line button:hover {
  border-color: var(--ui-border);
  color: var(--ui-text);
  background: var(--ui-surface);
}

.listener-line {
  display: flex;
  align-items: center;
  gap: 6px;
  line-height: 1.45;
}

.listener-line + .listener-line {
  margin-top: 2px;
}

.listener-line code {
  color: var(--ui-text);
  font: 500 11px/1.4 var(--mono);
}

.listener-line small {
  color: var(--ui-muted);
  font-size: 11px;
}

.row-title.is-muted {
  color: var(--ui-muted);
}

/* 操作按钮组 */
.port-actions {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 5px;
  flex-wrap: nowrap;
}

.port-op-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 7px;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  background: var(--ui-surface);
  color: var(--ui-text);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;
}

.port-op-btn:disabled {
  opacity: 0.36;
  cursor: not-allowed;
}

.port-op-btn.is-start:not(:disabled) {
  color: var(--ui-success);
  border-color: color-mix(in srgb, var(--ui-success) 32%, var(--ui-border));
  background: color-mix(in srgb, var(--ui-success) 6%, var(--ui-surface));
}

.port-op-btn.is-start:not(:disabled):hover {
  border-color: var(--ui-success);
  background: color-mix(in srgb, var(--ui-success) 14%, var(--ui-surface));
}

.port-op-btn.is-restart:not(:disabled) {
  color: var(--ui-text);
}

.port-op-btn.is-restart:not(:disabled):hover {
  color: var(--ui-accent);
  border-color: color-mix(in srgb, var(--ui-accent) 45%, var(--ui-border));
  background: var(--ui-accent-soft);
}

.port-op-btn.is-stop:not(:disabled) {
  color: var(--ui-warning);
  border-color: color-mix(in srgb, var(--ui-warning) 34%, var(--ui-border));
  background: color-mix(in srgb, var(--ui-warning) 6%, var(--ui-surface));
}

.port-op-btn.is-stop:not(:disabled):hover {
  border-color: var(--ui-warning);
  background: color-mix(in srgb, var(--ui-warning) 14%, var(--ui-surface));
}

.port-op-btn.is-delete:not(:disabled) {
  color: var(--ui-danger);
  border-color: color-mix(in srgb, var(--ui-danger) 30%, var(--ui-border));
  background: color-mix(in srgb, var(--ui-danger) 5%, var(--ui-surface));
}

.port-op-btn.is-delete:not(:disabled):hover {
  border-color: var(--ui-danger);
  background: color-mix(in srgb, var(--ui-danger) 14%, var(--ui-surface));
}

/* 固定抽屉中的服务导航与 Markdown 详情，各自滚动。 */
:global(.port-details-drawer .el-drawer__body){display:flex;min-height:0;padding:0 18px 18px}
.deployment-execution {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  overflow: hidden;
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.run-history {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 15px 10px;
  background: var(--ui-raised, var(--ui-bg));
  border-right: 1px solid var(--ui-border);
}

.run-history > .section-heading {
  padding: 0 4px;
}

.run-history-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 0;
  flex: 1;
  overflow: auto;
}

.run-history-list > button {
  display: block;
  width: 100%;
  padding: 9px 10px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--ui-text);
  text-align: left;
  cursor: pointer;
}

.run-history-list > button > span {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.run-history-list > button > span > strong {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.run-history-list > button > small {
  display: block;
  color: var(--ui-muted);
  font-size: 10px;
  line-height: 1.5;
  margin-top: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.run-history-list > button.selected {
  border-color: var(--ui-border);
  background: var(--ui-surface);
}

.run-history-list > button:hover {
  background: var(--ui-accent-soft);
}

.mini-status-tag {
  flex: none;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 10px;
  color: var(--ui-muted);
  background: var(--ui-bg);
}

.mini-status-tag.is-listening {
  color: var(--ui-success);
  background: color-mix(in srgb, var(--ui-success) 12%, transparent);
}

.mini-status-tag.is-stopped {
  color: var(--ui-warning);
  background: color-mix(in srgb, var(--ui-warning) 12%, transparent);
}

.mini-status-tag.is-errored {
  color: var(--ui-danger);
  background: color-mix(in srgb, var(--ui-danger) 12%, transparent);
}

.run-console {
  min-width: 0;
  min-height: 0;
  padding: 16px;
  display: flex;
  flex-direction: column;
}

.log-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.log-heading > div:first-child {
  min-width: 0;
}

.log-heading strong {
  font-size: 14px;
}

.log-heading p {
  margin: 4px 0 0;
  color: var(--ui-muted);
  font: 11px/1.6 var(--mono);
  overflow-wrap: anywhere;
}

.console-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  flex-shrink: 0;
}

.console-header-right :deep(.el-button) {
  margin: 0;
}

.open-browser-link {
  color: var(--ui-accent);
  font-size: 12px;
  text-decoration: none;
}

.open-browser-link:hover {
  text-decoration: underline;
}

.service-markdown {
  flex: 1;
  min-height: 0;
  overflow: auto;
  box-sizing: border-box;
  margin: 0;
  padding: 14px;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  background: var(--ui-raised, var(--ui-bg));
  color: var(--ui-text);
}

.service-markdown :deep(.markdown-heading){color:var(--ui-text)}.service-markdown :deep(.markdown-code){color:var(--ui-text);background:var(--ui-surface);border-color:var(--ui-border);white-space:pre-wrap;overflow-wrap:anywhere}.service-markdown :deep(.markdown-code code){color:inherit;background:transparent}.service-markdown :deep(.code-language){color:var(--ui-muted)}

.is-spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.create-service-form :deep(.el-form-item) {
  margin-bottom: 14px;
}

.form-row-2col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

@media (max-height: 680px) {
  .port-sidebar {
    position: static;
  }
}

@media (max-width: 900px) {
  .port-layout,
  .deployment-execution {
    grid-template-columns: minmax(0, 1fr);
    min-height: 0;
  }

  .port-sidebar {
    position: static;
    border-right: 0;
    border-bottom: 1px solid var(--ui-border);
  }

  .port-projects {
    flex-direction: row;
    max-height: none;
  }

  .port-projects > button {
    flex: 0 0 min(176px, 72%);
    width: auto;
  }

  .run-history {
    border-right: 0;
    border-bottom: 1px solid var(--ui-border);
  }

  .deployment-execution{grid-template-rows:auto minmax(0,1fr)}
  .run-history-list{flex:none;flex-direction:row;max-height:100px}
  .run-history-list>button{flex:0 0 160px;width:160px;min-width:0}
  .run-console{padding:12px}
  .log-heading{flex-wrap:wrap}

  .form-row-2col {
    grid-template-columns: 1fr;
  }
}
</style>
