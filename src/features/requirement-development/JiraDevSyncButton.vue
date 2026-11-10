<script setup lang="ts">
/** 同步 Jira 研发助手云端版本：先只读检查并展示将改动的内容，确认后才下载、校验和替换。 */
import { computed, onMounted, shallowRef } from 'vue';
import { ElMessage } from 'element-plus';
import { RefreshCw } from '@lucide/vue';
import { dateTime } from '../../shared/format';

type SyncStatus = {
  current: { version: string; syncedAt: string };
  latest: { version: string; publishedAt: string; notes: string[]; sha256: string; size: number };
  updateAvailable: boolean; running: boolean;
  code: { available: true; changed: string[] } | { available: false; reason: string };
};
type SyncResult = { version: string; skillsChanged: string[]; codeChanged: string[]; codeSkipped: string; restartRequired: boolean; backup: string };

const open = shallowRef(false), checking = shallowRef(false), syncing = shallowRef(false);
const status = shallowRef<SyncStatus>(), error = shallowRef(''), result = shallowRef<SyncResult>();
const label = computed(() => status.value?.updateAvailable ? `有新版本 ${status.value.latest.version}` : '同步研发助手');

async function check(silent = false) {
  checking.value = true; error.value = '';
  try {
    const response = await fetch('/api/agent-runtimes/jira-dev/sync');
    const data = await response.json();
    if (!response.ok) throw new Error(response.status === 404 ? '后台尚未加载同步功能，需要在当前任务结束后重启本地服务。' : data.message || '检查更新失败');
    status.value = data;
  } catch (cause) { if (!silent) error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { checking.value = false; }
}
function show() { open.value = true; result.value = undefined; void check(); }
async function sync() {
  if (!status.value) return;
  syncing.value = true; error.value = '';
  try {
    const response = await fetch('/api/agent-runtimes/jira-dev/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' },
      body: JSON.stringify({ expectedVersion: status.value.latest.version, expectedSha256: status.value.latest.sha256 }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '同步失败');
    result.value = data;
    ElMessage.success(`已同步到研发助手 ${data.version}`);
    await check(true);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { syncing.value = false; }
}
onMounted(() => { void check(true); });
</script>

<template>
  <el-button :class="{ 'has-update': status?.updateAvailable }" @click="show"><RefreshCw :size="14" />{{ label }}</el-button>
  <el-dialog v-model="open" title="同步 Jira 研发助手" width="min(640px, 94vw)" append-to-body :close-on-click-modal="!syncing" :show-close="!syncing">
    <el-skeleton v-if="checking && !status" :rows="4" animated />
    <template v-else-if="status">
      <dl class="sync-versions">
        <div><dt>工作台当前</dt><dd>{{ status.current.version }}<small v-if="status.current.syncedAt">同步于 {{ dateTime(status.current.syncedAt) }}</small></dd></div>
        <div><dt>云端最新</dt><dd>{{ status.latest.version }}<small>发布于 {{ dateTime(status.latest.publishedAt) }}</small></dd></div>
      </dl>
      <template v-if="result">
        <el-alert :type="result.restartRequired ? 'warning' : 'success'" :closable="false" :title="result.restartRequired ? '已同步，代码模块需重启服务后生效' : '已同步，下次启动会话即生效'"
          :description="result.restartRequired ? '当前没有执行中的任务时，在终端运行 pm2 restart delivery-workspace。' : ''" />
        <ul class="sync-list">
          <li>研发技能：{{ result.skillsChanged.length ? `更新 ${result.skillsChanged.length} 个文件` : '无变化' }}</li>
          <li>代码模块：{{ result.codeChanged.length ? result.codeChanged.join('、') : result.codeSkipped || '无变化' }}</li>
          <li class="muted">原文件已备份到 {{ result.backup }}</li>
        </ul>
      </template>
      <template v-else-if="status.updateAvailable">
        <h4>更新内容</h4>
        <ul class="sync-list"><li v-for="note in status.latest.notes" :key="note">{{ note }}</li></ul>
        <h4>同步时会</h4>
        <ul class="sync-list">
          <li>校验云端签名、安装包 SHA-256 和逐个文件清单，再替换研发技能（skills）。</li>
          <li v-if="status.code.available">更新代码模块：{{ status.code.changed.length ? status.code.changed.join('、') : '无变化' }}（需重启服务生效）。</li>
          <li v-else>代码模块不更新：{{ status.code.reason }}。</li>
          <li>替换前自动备份；表单、多项目选择等界面功能不会自动改动，需要另行移植。</li>
        </ul>
      </template>
      <el-alert v-else type="success" :closable="false" title="已是最新版本" />
    </template>
    <el-alert v-if="error" type="error" :closable="false" :title="error" class="sync-error" />
    <template #footer>
      <el-button :disabled="syncing" :loading="checking" @click="check()">重新检查</el-button>
      <el-button :disabled="syncing" @click="open = false">{{ result ? '完成' : '取消' }}</el-button>
      <el-button v-if="status?.updateAvailable && !result" type="primary" :loading="syncing" :disabled="checking || status.running" @click="sync">确认同步到 {{ status.latest.version }}</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.el-button svg{margin-right:6px}
.has-update{border-color:var(--ui-accent);color:var(--ui-accent)}
.sync-versions{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:0 0 16px}
.sync-versions div{padding:12px 14px;border:1px solid var(--ui-border);border-radius:10px;background:var(--ui-raised)}
.sync-versions dt{font-size:12px;color:var(--ui-muted)}.sync-versions dd{margin:4px 0 0;font-size:20px;font-weight:600}.sync-versions small{display:block;margin-top:2px;font-size:11px;font-weight:400;color:var(--ui-muted)}
h4{margin:14px 0 6px;font-size:13px}
.sync-list{margin:8px 0 0;padding-left:18px;font-size:13px;line-height:1.75;color:var(--ui-secondary)}.sync-list .muted{color:var(--ui-muted);font-size:12px;overflow-wrap:anywhere}
.sync-error{margin-top:12px}
</style>
