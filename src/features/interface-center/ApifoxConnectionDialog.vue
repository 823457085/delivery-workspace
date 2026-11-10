<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { ExternalLink, Link2, RefreshCw } from '@lucide/vue';
import type { ApifoxConnection } from '../../../shared/interface-center-apifox';
import { errorMessage, interfaceApi } from './api';

const open = defineModel<boolean>({ default: false });
const connection = shallowRef<ApifoxConnection>({ configured: false, teams: [] });
const token = ref(''), busy = ref(''), verified = ref(false), changingAccount = ref(false);
const showConnectForm = computed(() => !connection.value.configured || changingAccount.value);

function acceptConnection(value: ApifoxConnection) {
  connection.value = value; verified.value = true; changingAccount.value = false;
}
async function load() {
  if (busy.value) return;
  busy.value = 'load'; verified.value = false;
  try {
    connection.value = await interfaceApi<ApifoxConnection>('/apifox');
    if (connection.value.configured) acceptConnection(await interfaceApi<ApifoxConnection>('/apifox/refresh', {}));
  } catch (error) { ElMessage.error(errorMessage(error)); }
  finally { busy.value = ''; }
}
watch(open, value => {
  token.value = ''; changingAccount.value = false;
  if (value) void load();
});
async function connect() {
  if (busy.value || !token.value.trim()) return;
  busy.value = 'connect';
  try {
    const value = await interfaceApi<ApifoxConnection>('/apifox/connect', { token: token.value.trim() });
    token.value = ''; acceptConnection(value); ElMessage.success('Apifox 账号已连接');
  } catch (error) {
    verified.value = false;
    try { connection.value = await interfaceApi<ApifoxConnection>('/apifox'); } catch { /* 保留已知连接，待重新验证。 */ }
    ElMessage.error(errorMessage(error));
  }
  finally { busy.value = ''; }
}
async function disconnect() {
  if (busy.value) return;
  busy.value = 'disconnect';
  try {
    connection.value = await interfaceApi<ApifoxConnection>('/apifox/disconnect', {});
    verified.value = false; token.value = ''; ElMessage.success('Apifox 连接已断开');
  } catch (error) { ElMessage.error(errorMessage(error)); }
  finally { busy.value = ''; }
}
</script>

<template>
  <el-dialog v-model="open" title="Apifox 连接" width="min(520px, calc(100vw - 32px))" class="apifox-connection-dialog"
    :close-on-click-modal="false" :close-on-press-escape="!busy" :show-close="!busy">
    <template #header="{ titleId, titleClass }">
      <div class="connection-heading">
        <span class="connection-icon" aria-hidden="true"><Link2 :size="19" /></span>
        <h2 :id="titleId" :class="titleClass">Apifox 连接</h2>
      </div>
    </template>
    <div class="apifox-content" v-loading="busy === 'load'">
      <div v-if="connection.configured" class="account-row">
        <div><Link2 :size="16" /><strong>{{ connection.account?.name }}</strong><span>{{ verified ? '已连接' : '待验证' }}</span></div>
        <div><el-button text size="small" :disabled="!!busy" @click="load"><RefreshCw :size="13" />验证连接</el-button><el-button text size="small" :disabled="!!busy" @click="changingAccount = !changingAccount; token = ''">更换令牌</el-button><el-button text size="small" :disabled="!!busy" @click="disconnect">断开</el-button></div>
      </div>
      <el-form v-if="showConnectForm" id="apifox-connect-form" label-position="top" :disabled="!!busy" class="connect-form" @submit.prevent="connect">
        <el-form-item label="API 访问令牌"><el-input v-model="token" type="password" show-password autocomplete="off" aria-label="Apifox API 访问令牌" placeholder="粘贴你的 Apifox 个人访问令牌" /></el-form-item>
        <p class="connect-hint">在 Apifox「头像 → 账号设置 → API 访问令牌」中获取。令牌保存在本机钥匙串。</p>
      </el-form>
    </div>
    <template #footer>
      <div class="connection-footer">
        <el-link href="https://docs.apifox.com/" target="_blank" rel="noopener noreferrer" :underline="false" class="connection-help">连接说明<ExternalLink :size="12" /></el-link>
        <div class="connection-buttons">
          <el-button :disabled="!!busy" @click="open = false">关闭</el-button>
          <el-button v-if="showConnectForm" type="primary" native-type="submit" form="apifox-connect-form" :disabled="!!busy || !token.trim()" :loading="busy === 'connect'">连接并验证</el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>

.connection-heading { display: flex; align-items: center; gap: 10px; }
.connection-heading h2 { margin: 0; }
.connection-icon {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
}
.connect-form :deep(.el-form-item) { margin-bottom: 8px; }
.connect-hint { margin: 0; color: var(--ui-muted); font-size: 12px; line-height: 1.7; }
.connection-footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding-top: 14px;
  border-top: 1px solid var(--ui-divider);
}
.connection-help { font-size: 12px; gap: 4px; }
.connection-buttons { display: flex; gap: 8px; margin-inline-start: auto; }
.connection-buttons .el-button { margin: 0; }
.apifox-content{color:var(--ui-text);font-size:13px}.account-row,.account-row>div{display:flex;align-items:center;gap:10px}.account-row{justify-content:space-between;gap:8px;padding-bottom:18px;border-bottom:1px solid var(--ui-border);flex-wrap:wrap}.account-row>div:first-child{min-width:0}.account-row strong{overflow-wrap:anywhere}.account-row span{font-size:12px;color:var(--ui-muted)}.connect-form{margin-top:8px}@media(max-width:600px){.account-row{align-items:flex-start}.account-row>div{flex-wrap:wrap}}
</style>
