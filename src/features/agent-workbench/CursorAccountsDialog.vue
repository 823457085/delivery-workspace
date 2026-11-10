<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { RefreshCw, Users } from '@lucide/vue';
import { accountProviderLabels, accountProviders, desktopAccountProviders, trustedAccountLoginUrl } from '../../../shared/cursor-accounts';
import type { AccountProvider, CursorAccountAction, CursorAccountSummary, CursorAccountsDashboard, DesktopAccountSnapshot } from '../../../shared/cursor-accounts';
import type { AgentApiProvider, AgentProvider, AgentRuntimeHealth, AgentUsageLimits, AntigravityUsageLimits } from '../../../shared/agent-runtime';
import AgentAvatar from './AgentAvatar.vue';
import AgentUsageQuota from './AgentUsageQuota.vue';
import AgentAntigravityQuota from './AgentAntigravityQuota.vue';

const props = defineProps<{ runtimes?: AgentRuntimeHealth[]; usageCards?: { key: string; label: string; usage?: AgentUsageLimits }[]; antigravityUsage?: AntigravityUsageLimits; refreshing?: boolean }>();
const emit = defineEmits<{ changed: []; opened: []; closed: []; refresh: []; configureModels: [provider: AgentApiProvider] }>();
const open = shallowRef(false);
const mainPanel = shallowRef<HTMLElement>();
const provider = shallowRef<AgentProvider>('cursor');
const dashboard = shallowRef<CursorAccountsDashboard>();
const desktop = shallowRef<DesktopAccountSnapshot>();
const desktopLoading = shallowRef(false);
const openingDesktop = shallowRef(false);
const loading = shallowRef(false);
const syncing = shallowRef(false);
const sendingFor = shallowRef<Partial<Record<AccountProvider, boolean>>>({});
const confirming = shallowRef(false);
let modelProviderOnClose: AgentApiProvider | undefined;
const endpoint = (target: AccountProvider) => `/api/agent-runtimes/accounts/${target}`;
let poll: ReturnType<typeof setTimeout> | undefined;
let readController: AbortController | undefined;
let desktopController: AbortController | undefined;
let disposed = false;
let viewRevision = 0;
interface PendingLoginWindow { target: AccountProvider; revision: number; tab: Window; operationId?: string }
let pendingLoginWindow: PendingLoginWindow | undefined;

function isManagedProvider(value: string): value is AccountProvider { return (accountProviders as readonly string[]).includes(value); }
function isApiProvider(value: AgentProvider): value is AgentApiProvider { return value === 'api' || value === 'deepseek' || value === 'grok'; }
const managed = computed(() => isManagedProvider(provider.value));
const hasDesktop = computed(() => (desktopAccountProviders as readonly string[]).includes(provider.value));
const selectedRuntime = computed(() => props.runtimes?.find(item => item.provider === provider.value));
const apiProvider = computed(() => isApiProvider(provider.value) ? provider.value : undefined);
const apiModels = computed(() => apiProvider.value ? selectedRuntime.value?.models.filter(model => model.customId) ?? [] : []);
const providerChoices = computed(() => [
  ...accountProviders.map(id => ({ id, label: accountProviderLabels[id], managed: true })),
  ...(props.runtimes || []).filter(item => !isManagedProvider(item.provider)).map(item => ({ id: item.provider, label: item.label, managed: false })),
]);
const providerLabel = computed(() => isManagedProvider(provider.value) ? accountProviderLabels[provider.value] : selectedRuntime.value?.label || provider.value);
const usageCard = computed(() => props.usageCards?.find(item => item.key === (provider.value === 'codex' ? 'codex-plan' : provider.value)));
const accountStatus = computed(() => !managed.value ? selectedRuntime.value?.authenticated ? '登录已核验' : '登录待核验'
  : loading.value && !dashboard.value ? '读取中' : !dashboard.value ? '尚未读取'
  : dashboard.value.pendingRecovery ? '需要恢复' : !dashboard.value.available ? '暂不可读取' : dashboard.value.current?.verified ? provider.value === 'codex' ? '当前 CLI 登录已核验' : '登录已核验'
  : dashboard.value.current ? '本机记录待核验' : selectedRuntime.value?.authenticated ? '账号资料未返回' : '未登录');
const accountTitle = computed(() => {
  const current = dashboard.value?.current;
  const saved = current && dashboard.value?.accounts.find(isCurrent);
  return current?.displayName || current?.email || (saved ? saved.displayName || saved.email || saved.name : '')
    || (current?.verified ? '已核验登录，未返回账号名称或邮箱'
      : current ? '已读取本机账号记录' : accountStatus.value === '未登录' ? '尚未登录账号' : '账号资料尚未读取');
});
const checkedAt = computed(() => {
  const value = managed.value ? dashboard.value?.checkedAt : selectedRuntime.value?.checkedAt;
  const date = value ? new Date(value) : undefined;
  return date && Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '';
});
const sending = computed(() => isManagedProvider(provider.value) && !!sendingFor.value[provider.value]);
const operation = computed(() => dashboard.value?.operation);
const running = computed(() => operation.value?.status === 'running');
const busy = computed(() => loading.value || syncing.value || sending.value || confirming.value || running.value || openingDesktop.value);
const canManage = computed(() => managed.value && !!dashboard.value?.available && !busy.value && !dashboard.value.pendingRecovery);
// Codex / Claude Code 的进程检测仅作提示，切换后已打开的会话重启生效；Cursor 仍需空闲。
const processBlocked = computed(() => provider.value === 'cursor' && !!dashboard.value?.activePids.length);
const canChange = computed(() => canManage.value && !processBlocked.value);
const canRestore = computed(() => managed.value && !!dashboard.value?.available && !busy.value && !processBlocked.value);
const loginUrl = computed(() => running.value && isManagedProvider(provider.value) ? trustedAccountLoginUrl(provider.value, operation.value?.loginUrl) : '');
const operationTitle = computed(() => !running.value ? operation.value?.activation?.status === 'succeeded'
  ? operation.value.desktop ? operation.value.desktop.status === 'opened' ? 'CLI 已登录，桌面端待确认' : 'CLI 已登录，桌面端未完成' : 'CLI 登录已完成' : '最近一次账号操作'
  : operation.value?.action === 'login' ? loginUrl.value ? provider.value === 'codex' ? '等待 Codex CLI 授权回传' : '等待官方登录完成' : '正在处理登录' : '正在更新账号');
const loginHelp = computed(() => provider.value === 'codex'
  ? '由 Codex CLI 发起浏览器授权，回传并通过 CLI 核验后自动保存并启用账号。'
  : '先完成本次 CLI 官方授权，工作台会保存并使用该账号，再打开已安装的桌面端完成登录。');
const accountAddHelp = computed(() => provider.value === 'codex' ? loginHelp.value
  : '完成 CLI 授权后自动保存并使用，再打开已安装的桌面端。两端需要选择同一账号。');
const desktopStatus = computed(() => desktopLoading.value && !desktop.value ? '读取中' : !desktop.value ? '尚未读取'
  : desktop.value.status === 'recorded' ? '本机记录待确认' : desktop.value.status === 'not_installed' ? '未安装'
  : desktop.value.status === 'unsupported' ? '暂不支持' : '待在桌面确认');
const canOpenDesktop = computed(() => !!desktop.value?.canOpen && !desktopLoading.value && !busy.value);
const disabledReason = computed(() => loading.value ? '正在读取账号状态' : busy.value ? '请先完成当前账号操作'
  : dashboard.value?.pendingRecovery ? '上次操作尚未完成，请先恢复上次账号'
  : dashboard.value?.blockedReason || '账号状态尚未读取成功，请刷新状态');
const emptyDescription = computed(() => !dashboard.value?.available ? '账号资料尚未读取成功，暂不能确认已保存的账号。'
  : dashboard.value.current ? '当前本机账号尚未保存，可点击“保存本机账号”加入列表。' : '还没有保存账号，可点击“添加并登录”完成官方登录。');
function refreshState() { emit('refresh'); if (managed.value) void load(true); if (hasDesktop.value) void loadDesktop(); }
function configureModels() {
  if (!apiProvider.value) return;
  modelProviderOnClose = apiProvider.value;
  open.value = false;
}
function afterClose() {
  const target = modelProviderOnClose;
  modelProviderOnClose = undefined;
  emit('closed');
  if (target) emit('configureModels', target);
}

function refreshOnReturn() {
  if (!open.value || disposed || document.visibilityState === 'hidden' || sending.value || syncing.value || confirming.value) return;
  if (managed.value && !readController) void load(true);
  if (hasDesktop.value && !desktopController && !openingDesktop.value) void loadDesktop();
}

async function loadDesktop() {
  if (!hasDesktop.value) return;
  desktopController?.abort();
  const controller = new AbortController();
  desktopController = controller;
  const target = provider.value, revision = viewRevision;
  desktopLoading.value = true;
  try {
    const response = await fetch(`/api/agent-runtimes/desktop-accounts/${target}`, { cache: 'no-store', signal: controller.signal });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || '桌面端状态读取失败');
    if (!controller.signal.aborted && !disposed && open.value && revision === viewRevision && target === provider.value) desktop.value = result;
  } catch (error) {
    if (!controller.signal.aborted && !disposed && open.value && revision === viewRevision) ElMessage.error(error instanceof Error ? error.message : String(error));
  } finally {
    if (desktopController === controller) { desktopController = undefined; desktopLoading.value = false; }
  }
}

async function openDesktop() {
  if (!canOpenDesktop.value) return;
  const target = provider.value, revision = viewRevision;
  openingDesktop.value = true;
  try {
    const response = await fetch(`/api/agent-runtimes/desktop-accounts/${target}/open`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: '{}',
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || '桌面端未能打开');
    if (!disposed && open.value && revision === viewRevision && target === provider.value) {
      desktop.value = result;
      if (result.message) ElMessage.info(result.message);
    }
  } catch (error) {
    if (!disposed) ElMessage.error(error instanceof Error ? error.message : String(error));
  } finally { openingDesktop.value = false; }
}

function listenForReturn(enabled: boolean) {
  if (enabled) {
    window.addEventListener('focus', refreshOnReturn);
    document.addEventListener('visibilitychange', refreshOnReturn);
  } else {
    window.removeEventListener('focus', refreshOnReturn);
    document.removeEventListener('visibilitychange', refreshOnReturn);
  }
}

function isCurrent(account: CursorAccountSummary) {
  const current = dashboard.value?.current;
  if (current?.identity && account.identity) return current.identity === account.identity;
  return !!current?.email && account.email.toLowerCase() === current.email.toLowerCase() && account.team === current.team;
}

function defaultAccountName(action: 'save' | 'login') {
  const accounts = dashboard.value?.accounts || [];
  const saved = action === 'save' ? accounts.find(isCurrent) : undefined;
  const base = (action === 'save' ? dashboard.value?.current?.email.split('@')[0] : provider.value)
    ?.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 32) || provider.value;
  let suggested = base;
  for (let index = 2; accounts.some(account => account.name === suggested); index += 1) suggested = `${base}-${index}`;
  return saved?.name || suggested;
}

function closeLoginWindow(expected = pendingLoginWindow) {
  if (!expected || pendingLoginWindow !== expected) return;
  pendingLoginWindow = undefined;
  try { if (!expected.tab.closed) expected.tab.close(); } catch { /* 仅清理本次未跳转的占位窗口。 */ }
}

function prepareLoginWindow(target: AccountProvider): PendingLoginWindow | undefined {
  closeLoginWindow();
  try {
    const tab = window.open('about:blank', '_blank');
    if (!tab) return;
    const pending = { target, revision: viewRevision, tab };
    pendingLoginWindow = pending;
    tab.opener = null;
    tab.document.title = `正在打开 ${accountProviderLabels[target]} 官方登录`;
    tab.document.body.textContent = '正在准备官方登录页面，请稍候…';
    return pending;
  } catch { closeLoginWindow(); return; }
}

function openOfficialLogin(next: CursorAccountsDashboard) {
  const pending = pendingLoginWindow;
  if (!pending || !open.value || pending.target !== next.provider || pending.revision !== viewRevision
    || !pending.operationId || pending.operationId !== next.operation?.id) return;
  if (next.operation.status !== 'running') { closeLoginWindow(pending); return; }
  const url = trustedAccountLoginUrl(next.provider, next.operation.loginUrl);
  if (!url) return;
  try { if (!pending.tab.closed) pending.tab.location.replace(url); }
  catch { closeLoginWindow(pending); }
  finally { if (pendingLoginWindow === pending) pendingLoginWindow = undefined; }
}

async function syncCurrent() {
  if (!canManage.value) return;
  const target = provider.value;
  if (!isManagedProvider(target)) return;
  const revision = viewRevision;
  syncing.value = true;
  try {
    const next = await load(true);
    if (!next || disposed || !open.value || target !== provider.value || revision !== viewRevision
      || !next.available || !next.current || next.pendingRecovery || next.operation?.status === 'running') return;
    await post(target, 'save', { name: defaultAccountName('save') });
  } finally { syncing.value = false; }
}

function stopPolling() {
  if (poll) clearTimeout(poll);
  poll = undefined;
}

function schedulePoll() {
  stopPolling();
  if (open.value && running.value && !disposed) poll = setTimeout(() => { void load(); }, 2_000);
}

function receive(next: CursorAccountsDashboard, announce = false) {
  if (next.provider !== provider.value) return;
  const previous = operation.value;
  const previousCurrent = dashboard.value?.current;
  const currentChanged = !!dashboard.value && (previousCurrent?.identity !== next.current?.identity
    || previousCurrent?.email !== next.current?.email || previousCurrent?.team !== next.current?.team);
  dashboard.value = next;
  openOfficialLogin(next);
  const completed = next.operation;
  const completedNow = completed && completed.status !== 'running' && (announce || (previous?.id === completed.id && previous.status === 'running'));
  if (completedNow) {
    const message = completed.message;
    if (message) {
      if (completed.status === 'failed') ElMessage.error(message);
      else if (completed.status === 'partial') ElMessage.warning(message);
      else if (completed.status === 'cancelled') ElMessage.info(message);
      else ElMessage.success(message);
    }
  }
  if (completedNow || currentChanged) emit('changed');
  if (completedNow && hasDesktop.value) void loadDesktop();
  schedulePoll();
}

async function load(refresh = false) {
  stopPolling();
  readController?.abort();
  const controller = new AbortController();
  const target = provider.value;
  if (!isManagedProvider(target)) return;
  const revision = viewRevision;
  readController = controller;
  loading.value = refresh || !dashboard.value;
  try {
    const response = await fetch(`${endpoint(target)}${refresh ? '?refresh=1' : ''}`, { cache: 'no-store', signal: controller.signal });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || `${accountProviderLabels[target]} 账号读取失败`);
    if (!controller.signal.aborted && !disposed && revision === viewRevision && target === provider.value) {
      receive(result);
      return result as CursorAccountsDashboard;
    }
  } catch (error) {
    if (!controller.signal.aborted && !disposed && revision === viewRevision) ElMessage.error(error instanceof Error ? error.message : String(error));
  } finally {
    if (readController === controller) {
      readController = undefined;
      loading.value = false;
      schedulePoll();
    }
  }
}

async function post(target: AccountProvider, action: CursorAccountAction | 'cancel', body: { name?: string; operationId?: string }, pending?: PendingLoginWindow) {
  stopPolling();
  readController?.abort();
  readController = undefined;
  loading.value = false;
  const revision = viewRevision;
  sendingFor.value = { ...sendingFor.value, [target]: true };
  try {
    const response = await fetch(`${endpoint(target)}/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || `${accountProviderLabels[target]} 账号操作失败`);
    if (pending && pendingLoginWindow === pending) {
      if (result.provider === target && result.operation?.action === 'login') pending.operationId = result.operation.id;
      else closeLoginWindow(pending);
    }
    if (!disposed && revision === viewRevision && target === provider.value) receive(result, true);
    else if (!disposed) {
      if (result.operation && result.operation.status !== 'running') emit('changed');
      if (open.value && target === provider.value) await load();
    }
  } catch (error) {
    if (pending) closeLoginWindow(pending);
    if (!disposed) {
      ElMessage.error(error instanceof Error ? error.message : String(error));
      if (open.value && target === provider.value) await load();
    }
  } finally { sendingFor.value = { ...sendingFor.value, [target]: false }; }
}

async function act(action: CursorAccountAction, accountName = '') {
  if (action === 'restore' ? !canRestore.value : action === 'use' ? !canChange.value : !canManage.value) return;
  if ((action === 'save' || action === 'login') && !accountName) accountName = defaultAccountName(action);
  if (action !== 'restore' && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(accountName)) return;
  const target = provider.value;
  if (!isManagedProvider(target)) return;
  const revision = viewRevision;
  const label = accountProviderLabels[target];
  const account = dashboard.value?.accounts.find(item => item.name === accountName);
  const accountLabel = account?.displayName || account?.email || accountName;
  if (action === 'use' || action === 'restore' || action === 'delete') {
    if (action === 'delete' && !account) return;
    const confirmation = action === 'use'
        ? [`切换 ${label} 账号`, `将本机 ${label} CLI 切换到“${accountLabel}”。${target === 'codex' ? '' : '随后打开已安装的桌面端，请在应用内确认使用同一账号。'}`]
        : action === 'delete'
          ? [`删除 ${label} 已保存账号`, `将删除“${accountLabel}”在工作台中的记录及其钥匙串备份。当前 CLI 和桌面端会保留登录状态。`]
          : [`恢复 ${label} 上次账号`, `将恢复上次账号操作前的本机 ${label} CLI 登录状态。`];
    confirming.value = true;
    try {
      await ElMessageBox.confirm(confirmation[1], confirmation[0], {
        type: 'warning', confirmButtonText: action === 'delete' ? '删除已保存账号' : '确认继续', cancelButtonText: '取消', closeOnClickModal: false,
      });
    } catch { return; }
    finally { confirming.value = false; }
  }
  if (revision === viewRevision && target === provider.value && open.value) {
    // 在用户点击调用栈中创建窗口，异步取得官方链接后再跳转，避免被弹窗拦截。
    const pending = action === 'login' ? prepareLoginWindow(target) : undefined;
    await post(target, action, action === 'restore' ? {} : { name: accountName }, pending);
  }
}

async function cancel() {
  if (!running.value || !operation.value || sending.value || operation.value.action !== 'login') return;
  if (!isManagedProvider(provider.value)) return;
  closeLoginWindow();
  await post(provider.value, 'cancel', { operationId: operation.value.id });
}

watch([open, provider], ([value], [wasOpen]) => {
  if (value !== wasOpen) listenForReturn(value);
  viewRevision += 1;
  if (mainPanel.value) mainPanel.value.scrollTop = 0;
  closeLoginWindow();
  stopPolling();
  readController?.abort();
  readController = undefined;
  desktopController?.abort();
  desktopController = undefined;
  desktopLoading.value = false;
  desktop.value = undefined;
  loading.value = false;
  dashboard.value = undefined;
  if (value) { emit('opened'); if (!wasOpen) emit('refresh'); void load(true); void loadDesktop(); }
}, { flush: 'sync' });
onBeforeUnmount(() => { disposed = true; listenForReturn(false); stopPolling(); readController?.abort(); desktopController?.abort(); closeLoginWindow(); });
</script>

<template>
  <slot name="trigger" :open="() => open = true"><el-button class="cursor-accounts-trigger" text @click="open = true"><Users :size="14" /> 多账号管理</el-button></slot>
  <el-dialog v-model="open" title="多账号管理" width="min(960px, 94vw)" top="5vh" class="accounts-dialog" append-to-body @closed="afterClose">
    <p class="accounts-intro">查看本机账号和执行器状态，也可进入 API 模型配置。</p>
    <div class="accounts-layout">
      <nav class="accounts-providers" aria-label="账号平台">
        <button v-for="item in providerChoices" :key="item.id" type="button" :aria-pressed="provider === item.id" :class="{ selected: provider === item.id }" :disabled="confirming" @click="provider = item.id">
          <AgentAvatar :provider="item.id" :size="26" /><span><strong>{{ item.label }}</strong><small>{{ item.managed ? '本机账号管理' : isApiProvider(item.id) ? '连接与模型配置' : '连接状态' }}</small></span>
        </button>
      </nav>
      <section class="accounts-main" :aria-label="`${providerLabel} 账号详情`">
        <header class="accounts-heading"><div><h3>{{ providerLabel }}</h3><p>{{ managed ? '本机账号与登录状态' : apiProvider ? '执行器连接与模型配置' : '执行器连接状态' }}</p></div><el-button :loading="managed ? loading : refreshing" :disabled="sending || confirming" @click="refreshState"><RefreshCw :size="14" />刷新状态</el-button></header>
        <div ref="mainPanel" class="accounts-content">
        <section v-if="managed && operation" class="accounts-operation" role="status" aria-live="polite">
          <strong>{{ operationTitle }}</strong>
          <p>{{ operation.message || (running ? '正在处理账号操作…' : '') }}</p>
          <p v-if="operation.activation?.message">{{ operation.activation.message }}</p>
          <p v-if="operation.desktop?.message">{{ operation.desktop.message }}</p>
          <el-button v-if="operation.status === 'partial' && operation.savedAccountName && operation.activation?.status === 'failed'" :disabled="!canChange" @click="act('use', operation.savedAccountName)">继续使用已保存账号</el-button>
          <template v-if="running && operation.action === 'login'">
            <p>{{ loginHelp }}</p>
            <p v-if="loginUrl && operation.loginCode">设备授权码：<code class="accounts-login-code">{{ operation.loginCode }}</code></p>
            <div class="accounts-login-actions">
              <el-button v-if="loginUrl" tag="a" :href="loginUrl" target="_blank" rel="noopener noreferrer" type="primary">{{ provider === 'codex' ? '继续 Codex CLI 授权' : '继续官方登录' }}</el-button>
              <el-button :loading="loading" :disabled="sending" @click="load(true)">检查登录结果</el-button>
              <el-button :loading="sending" @click="cancel">取消登录</el-button>
            </div>
          </template>
        </section>
        <div class="account-clients" :class="{ 'has-desktop': hasDesktop }">
        <section v-if="hasDesktop" class="current-account desktop-account" v-loading="desktopLoading" aria-label="桌面端登录状态">
          <div class="current-account-title"><span>桌面端</span><el-tag size="small" type="info">{{ desktopStatus }}</el-tag></div>
          <strong>{{ desktop?.email || (desktop?.status === 'recorded' ? '已读取桌面账号记录' : desktop?.installed ? '请在桌面端确认账号' : desktop?.status === 'not_installed' ? '尚未安装桌面端' : '桌面端状态待确认') }}</strong>
          <p v-if="desktop?.message">{{ desktop.message }}</p>
          <span :title="running ? '请先完成当前 CLI 授权，避免同时发起两次登录' : ''"><el-button v-if="desktop?.canOpen" size="small" :loading="openingDesktop" :disabled="!canOpenDesktop" @click="openDesktop">打开桌面端登录</el-button></span>
        </section>
        <section class="current-account" v-loading="managed && loading" :aria-label="apiProvider ? '模型连接状态' : 'CLI 登录状态'">
          <div class="current-account-title">
            <span>{{ managed ? dashboard?.current && !dashboard.current.verified ? 'CLI 本机记录' : 'CLI 当前账号' : apiProvider ? '模型 / 执行器' : 'CLI / 执行器' }}</span>
            <el-tag v-if="apiProvider" size="small" :type="selectedRuntime?.ready ? 'success' : 'info'">{{ selectedRuntime?.ready ? '可用' : '待就绪' }}</el-tag>
            <el-tag v-else size="small" :type="managed ? dashboard?.current?.verified && dashboard.available ? 'success' : 'info' : selectedRuntime?.authenticated ? 'success' : 'info'">{{ accountStatus }}</el-tag>
          </div>
          <template v-if="managed"><strong>{{ accountTitle }}</strong><p v-if="dashboard?.current?.displayName && dashboard.current.email">{{ dashboard.current.email }}</p><p v-if="dashboard?.current?.team">{{ dashboard.current.team }}</p></template>
          <strong v-else-if="apiProvider">{{ apiModels.length ? `已保存 ${apiModels.length} 个 API 模型` : '尚未保存 API 模型' }}</strong>
          <strong v-else>{{ selectedRuntime?.authenticated ? '已核验登录，未返回账号名称或邮箱' : '尚未核验登录状态' }}</strong>
          <dl class="account-facts"><div><dt>执行器</dt><dd>{{ selectedRuntime ? selectedRuntime.ready ? '可用' : '尚未就绪' : '尚未读取连接状态' }}</dd></div><div v-if="checkedAt"><dt>最近检查</dt><dd>{{ checkedAt }}</dd></div></dl>
        </section>
        </div>
        <p v-if="managed && dashboard?.blockedReason" class="accounts-description" role="status">{{ dashboard.blockedReason }}</p>
        <p v-else-if="managed && dashboard?.pendingRecovery" class="accounts-description">上次账号操作未完成，请先恢复上次账号。</p>
        <template v-if="managed">
          <div class="accounts-toolbar"><div><strong>已保存账号</strong><small v-if="dashboard && (dashboard.available || dashboard.accounts.length)">{{ dashboard.accounts.length }} 个</small></div><div class="accounts-buttons"><span :title="!canManage ? disabledReason : !dashboard?.current ? '请先在本机完成登录并刷新状态' : '将当前本机登录保存到账号列表' "><el-button :loading="syncing" :disabled="!canManage || !dashboard?.current" @click="syncCurrent">保存本机账号</el-button></span><span :title="canManage ? accountAddHelp : disabledReason"><el-button type="primary" :disabled="!canManage" @click="act('login')">{{ provider === 'codex' ? '添加并登录 CLI' : '添加并登录' }}</el-button></span></div></div>
          <p class="accounts-description account-add-help">{{ accountAddHelp }}</p>
          <el-table v-loading="loading" :data="dashboard?.accounts || []" row-key="name" class="accounts-table">
            <template #empty><el-empty :description="emptyDescription" :image-size="56" /></template>
            <el-table-column label="账号" min-width="150"><template #default="{ row }"><div class="accounts-name"><strong>{{ row.displayName || row.email || row.name }}</strong><el-tag v-if="isCurrent(row)" size="small" :type="dashboard?.current?.verified ? 'success' : 'info'">{{ dashboard?.current?.verified ? '当前账号' : '本机记录' }}</el-tag></div><div v-if="row.displayName && row.email" class="accounts-secondary">{{ row.email }}</div><div v-if="row.team" class="accounts-secondary">{{ row.team }}</div></template></el-table-column>
            <el-table-column label="操作" min-width="132" align="right">
              <template #default="{ row }">
                <div class="accounts-row-actions">
                  <span v-if="!isCurrent(row)" :title="canChange ? '' : processBlocked ? '当前 Cursor 会话运行中，结束后可切换' : disabledReason"><el-button link type="primary" :disabled="!canChange" @click="act('use', row.name)">切换使用</el-button></span>
                  <span :title="canManage ? '通过官方登录更新此账号' : disabledReason"><el-button link :disabled="!canManage" @click="act('login', row.name)">{{ provider === 'codex' ? '重新登录 CLI' : '重新登录' }}</el-button></span>
                  <span :title="canManage ? '删除工作台保存的账号及凭据备份' : disabledReason"><el-button link type="danger" :disabled="!canManage" @click="act('delete', row.name)">删除</el-button></span>
                </div>
              </template>
            </el-table-column>
          </el-table>
        </template>
        <section v-else-if="apiProvider" class="accounts-api-models" aria-label="已配置的 API 模型">
          <div class="accounts-toolbar"><div><strong>API 模型配置</strong></div><el-button type="primary" @click="configureModels">{{ apiModels.length ? '管理 API 模型' : '添加 API 模型' }}</el-button></div>
          <p v-if="provider === 'grok'" class="accounts-description">此处配置 xAI API。Grok Build CLI 的登录与免费额度由该执行器管理。</p>
          <p v-if="selectedRuntime?.message" class="accounts-description">{{ selectedRuntime.message }}</p>
          <ul v-if="apiModels.length" class="accounts-model-list">
            <li v-for="model in apiModels" :key="model.customId"><strong>{{ model.label }}</strong><span class="accounts-secondary">{{ model.id }}</span></li>
          </ul>
        </section>
        <template v-else><p class="accounts-description">{{ hasDesktop ? '此平台的账号在桌面端或 CLI 中管理。' : '此执行器的账号在本机管理。' }}</p><p v-if="selectedRuntime?.message" class="accounts-description">{{ selectedRuntime.message }}</p></template>

        <AgentAntigravityQuota v-if="provider === 'antigravity'" :usage="antigravityUsage" />
        <AgentUsageQuota v-else-if="usageCard" :usage="usageCard.usage" :label="usageCard.label" />
        <p v-else class="accounts-secondary account-usage-empty">当前尚无可显示的额度数据。</p>
        </div>
      </section>
    </div>
    <template #footer><div class="accounts-footer"><span v-if="managed" :title="canRestore ? '恢复上次账号操作前的本机登录状态' : processBlocked ? '当前 Cursor 会话运行中，结束后可恢复' : disabledReason"><el-button link :disabled="!canRestore" @click="act('restore')">恢复上次登录状态</el-button></span><el-button @click="open = false">关闭</el-button></div></template>
  </el-dialog>
</template>

<style scoped>
.cursor-accounts-trigger{flex-shrink:0;min-height:32px;margin:0 10px;gap:6px}.accounts-intro{margin:0 0 20px;font-size:13px;line-height:1.7;color:var(--el-text-color-secondary)}.accounts-layout{display:grid;grid-template-columns:168px minmax(0,1fr);gap:20px;max-height:calc(90dvh - 180px);grid-template-rows:minmax(0,1fr);overflow:hidden}.accounts-providers{min-height:0;overflow:auto;display:flex;flex-direction:column;gap:5px;padding-right:14px;border-right:1px solid var(--el-border-color-lighter)}.accounts-providers button{display:flex;align-items:center;gap:9px;min-width:0;width:100%;padding:10px 8px;border:0;border-radius:8px;background:transparent;color:var(--el-text-color-regular);text-align:left;cursor:pointer}.accounts-providers button:hover{background:var(--el-fill-color-light)}.accounts-providers button.selected{background:var(--el-color-primary-light-9);color:var(--el-color-primary)}.accounts-providers button:focus-visible{outline:2px solid var(--el-color-primary);outline-offset:2px}.accounts-providers button:disabled{opacity:.5;cursor:default}.accounts-providers button>span{min-width:0}.accounts-providers strong{display:block;font-size:12px;font-weight:600;overflow-wrap:anywhere}.accounts-providers small{display:block;margin-top:3px;font-size:11px;color:var(--el-text-color-secondary)}.accounts-main{min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden;--agent-border:var(--el-border-color-lighter);--agent-secondary:var(--el-text-color-regular);--agent-muted:var(--el-text-color-secondary);--agent-text:var(--el-text-color-primary);--agent-raised:var(--el-fill-color-light);--agent-cyan:var(--el-color-primary);--agent-accent:var(--el-color-primary)}.accounts-content{min-height:0;overflow:auto;padding-right:4px;scrollbar-gutter:stable}.accounts-heading{flex-shrink:0;display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}.accounts-heading h3{margin:0;font-size:17px;font-weight:600}.accounts-heading p{margin:5px 0 0;color:var(--el-text-color-secondary);font-size:12px}.accounts-heading>.el-button{flex-shrink:0;gap:5px}.account-clients{display:grid;gap:12px}.account-clients.has-desktop{grid-template-columns:repeat(2,minmax(0,1fr))}.desktop-account>.el-button,.desktop-account>span>.el-button{margin-top:12px}.current-account{min-width:0;padding:14px;border:1px solid var(--el-border-color-lighter);border-radius:10px;background:var(--el-fill-color-blank)}.current-account-title{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;font-size:12px;color:var(--el-text-color-secondary)}.current-account>strong{display:block;font-size:16px;line-height:1.6;overflow-wrap:anywhere}.current-account>p{margin:4px 0;color:var(--el-text-color-secondary);font-size:12px;overflow-wrap:anywhere}.account-facts{display:flex;flex-wrap:wrap;gap:5px 20px;margin:12px 0 0}.account-facts>div{display:flex;gap:12px;font-size:12px;line-height:1.6}.account-facts dt{min-width:52px;color:var(--el-text-color-secondary)}.account-facts dd{margin:0;overflow-wrap:anywhere;color:var(--el-text-color-regular)}.accounts-description{margin:12px 0;color:var(--el-text-color-secondary);font-size:12px;line-height:1.8;overflow-wrap:anywhere}.accounts-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:22px}.accounts-toolbar>div:first-child{display:flex;align-items:baseline;gap:8px;flex-shrink:0}.accounts-toolbar strong{font-size:13px;font-weight:600}.accounts-toolbar small,.accounts-secondary{font-size:12px;color:var(--el-text-color-secondary);line-height:1.7}.accounts-buttons{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.account-add-help{margin:8px 0 10px}.accounts-table :deep(.el-empty){padding:18px 0}.accounts-table :deep(.el-empty__description p){font-size:12px;line-height:1.7}.accounts-table :deep(.el-table__empty-text){width:100%}.accounts-name{display:flex;flex-wrap:wrap;align-items:center;gap:7px}.accounts-name strong{font-size:13px;font-weight:500;overflow-wrap:anywhere}.accounts-operation{margin:0 0 18px;padding:0 0 16px;border-bottom:1px solid var(--el-border-color-lighter)}.accounts-operation>strong{font-size:13px}.accounts-operation>p{margin:8px 0;font-size:12px;line-height:1.8;overflow-wrap:anywhere;color:var(--el-text-color-regular)}.accounts-login-code{font-size:15px;letter-spacing:1px;user-select:all}.accounts-login-actions{display:flex;gap:8px;flex-wrap:wrap}.accounts-login-actions>.el-button+.el-button{margin-left:0}.accounts-row-actions{display:flex;align-items:center;justify-content:flex-end;gap:12px;flex-wrap:wrap}.accounts-table :deep(.cell){padding:10px 12px}.accounts-row-actions .el-button{margin:0;padding:2px 0}.accounts-footer>.el-button{margin-left:auto}.accounts-footer{display:flex;align-items:center;justify-content:space-between;gap:12px}.account-usage-empty{margin:18px 0 0;padding-top:14px;border-top:1px solid var(--el-border-color-lighter)}
.accounts-model-list { margin: 12px 0 0; padding: 0; list-style: none; }
.accounts-model-list li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; padding: 10px 0; border-top: 1px solid var(--el-border-color-lighter); overflow-wrap: anywhere; }
.accounts-model-list strong { font-size: 13px; font-weight: 600; }
@media(max-width:800px){.account-clients.has-desktop{grid-template-columns:minmax(0,1fr)}}
@media(max-width:640px){.accounts-layout{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr);gap:12px;max-height:calc(90dvh - 180px)}.accounts-providers{flex-direction:row;overflow:auto;border-right:0;border-bottom:1px solid var(--el-border-color-lighter);padding:0 0 8px;gap:6px}.accounts-providers button{flex:0 0 auto;width:auto;padding:8px}.accounts-providers small{display:none}.accounts-providers :deep(.agent-avatar){display:none}.accounts-toolbar{align-items:flex-start;flex-wrap:wrap}.accounts-heading h3{font-size:16px}.accounts-buttons{justify-content:flex-start}.accounts-intro{margin-bottom:12px}.current-account{padding:12px}.accounts-name strong{font-size:12px}.accounts-table :deep(.cell){padding:8px 4px}.accounts-row-actions{gap:8px}.accounts-content{scrollbar-gutter:auto}.account-facts{display:grid}}
</style>
