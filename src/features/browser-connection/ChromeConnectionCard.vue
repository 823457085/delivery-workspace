<script setup lang="ts">
import { computed } from 'vue';
import { ElMessage } from 'element-plus';
import { useBrowserConnection } from './useBrowserConnection';
import type { BrowserConnectionAction } from './api';

const props = withDefaults(defineProps<{ compact?: boolean; active?: boolean }>(), { compact: false, active: true });
const { status, busy, error, refresh, act } = useBrowserConnection(() => props.active);
const verified = computed(() => status.value?.phase === 'connected' && status.value.connectionVerified && !error.value);
const label = computed(() => {
  if (error.value) return '连接状态待确认';
  if (!status.value) return '读取连接状态';
  if (verified.value) return '已连接日常 Chrome';
  return { unavailable: 'Chrome 连接不可用', setup_required: '等待开启远程调试', ready: '可以连接',
    connecting: '正在连接，等待 Chrome 授权', connected: '连接尚未验证', reconnecting: '等待连接恢复', error: '连接未成功' }[status.value.phase];
});
const labelType = computed(() => verified.value ? 'success' : error.value || status.value?.phase === 'error' ? 'warning' : 'info');
const canConnect = computed(() => !busy.value && status.value?.phase !== 'connecting'
  && (status.value?.phase !== 'reconnecting' || status.value.debuggingEnabled)
  && !!status.value && status.value.phase !== 'unavailable' && status.value.chromeAvailable);
const canDisconnect = computed(() => verified.value || status.value?.phase === 'connecting' || status.value?.phase === 'reconnecting');
const connectLabel = computed(() => status.value?.phase === 'connecting' ? '等待 Chrome 允许'
  : verified.value ? '重新检测' : status.value?.phase === 'reconnecting' ? '立即重连' : '连接 Chrome');
const checkedAt = computed(() => {
  const value = status.value?.checkedAt;
  const date = value ? new Date(value) : undefined;
  return date && Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date) : '';
});
async function perform(action: BrowserConnectionAction) {
  try { await act(action); }
  catch (cause) { ElMessage.error(cause instanceof Error ? cause.message : '浏览器连接操作失败'); }
}
</script>

<template>
  <section class="chrome-connection" :class="{ surface: !compact, compact }" aria-label="日常 Chrome 连接" :aria-busy="!!busy">
    <header class="chrome-heading">
      <div class="chrome-title"><component :is="compact ? 'h3' : 'h2'">日常 Chrome <small>可选能力</small></component><el-tag :type="labelType" size="small" role="status">{{ label }}</el-tag></div>
      <el-button link size="small" :disabled="!!busy" aria-label="刷新浏览器连接状态" @click="refresh">刷新状态</el-button>
    </header>
    <p class="chrome-message">{{ error || status?.message || '正在读取本机浏览器连接状态。' }}</p>
    <p v-if="status?.toolAvailable === false" class="chrome-help">未安装 agent-browser，仅影响依赖它的网页自动操作；不影响 AI 会话、代码任务及 Jira 等接口功能，也不影响连接 Chrome。需要网页自动操作时再安装即可。</p>
    <div class="chrome-actions">
      <el-button size="small" :disabled="!!busy || status?.chromeAvailable === false" :loading="busy === 'open-settings'" @click="perform('open-settings')">打开 Chrome 设置</el-button>
      <el-button size="small" type="primary" :disabled="!canConnect" :loading="busy === 'connect'" @click="perform('connect')">{{ connectLabel }}</el-button>
      <el-button v-if="canDisconnect" size="small" :disabled="!!busy" :loading="busy === 'disconnect'" @click="perform('disconnect')">断开 Chrome</el-button>
    </div>
    <p v-if="status?.phase === 'setup_required'" class="chrome-help">在 Chrome 设置中开启远程调试，再点击“连接 Chrome”；授权弹窗出现时请选择允许。</p>
    <p v-else-if="status?.phase === 'connecting'" class="chrome-help">请在日常 Chrome 中允许连接，工作台会自动更新检测结果。</p>
    <p v-if="verified" class="chrome-help">刷新页面或重启工作台会保留此连接。连接中断后会自动尝试恢复。如 Chrome 弹出授权，请点允许。</p>
    <p class="chrome-footnote">浏览器连接、目标站点登录和业务验证分别记录。<span v-if="checkedAt"> 检测于 {{ checkedAt }}</span><span v-if="status?.browserVersion"> · {{ status.browserVersion }}</span></p>
  </section>
</template>

<style scoped>
.chrome-connection { margin-bottom: 18px; padding: 16px; color: var(--ui-text); }
.chrome-heading,.chrome-title,.chrome-actions { display: flex; align-items: center; gap: 10px; }
.chrome-heading { justify-content: space-between; }
.chrome-title { flex-wrap: wrap; min-width: 0; }
.chrome-title h2,.chrome-title h3 { margin: 0; font-size: 14px; font-weight: 650; }
.chrome-title small { margin-left: 6px; font-size: 11px; font-weight: 400; color: var(--ui-muted); }
.chrome-message { margin: 10px 0; color: var(--ui-secondary); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.chrome-actions { flex-wrap: wrap; gap: 8px; }
.chrome-actions :deep(.el-button + .el-button) { margin-left: 0; }
.chrome-help,.chrome-footnote { margin: 9px 0 0; color: var(--ui-muted); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.chrome-footnote { font-size: 11px; }
.chrome-connection.compact { margin: 0; padding: 12px 16px; border-bottom: 1px solid var(--ui-divider); }
@media (max-width: 450px) { .chrome-heading { align-items: flex-start; } .chrome-title { gap: 6px; } }
</style>
