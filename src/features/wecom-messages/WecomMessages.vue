<script setup lang="ts">
/** 消息工作区只组合编辑、服务端预览和本机记录；机器人配置沿用联调功能，避免重复连接。 */
import { computed, defineAsyncComponent, shallowRef } from 'vue';
import { MessageSquareText, Settings2 } from '@lucide/vue';
import type { WecomMessageInput, WecomMessageRecord, WecomMessageSaved } from '../../../shared/wecom-messages';
import MessageEditor from './MessageEditor.vue';
import MessagePreview from './MessagePreview.vue';
const MessageRecords = defineAsyncComponent(() => import('./MessageRecords.vue'));
import { useWecomMessages } from './useWecomMessages';
const manager = useWecomMessages();
const activeTab = shallowRef('compose');
const { form, dirty, bytes, limit, valid, preview, configuration, library, history, activeSaved, configOpen, configForm, busy, canSend } = manager;
const configValid = computed(() => !!configForm.groupName.trim() && (!!configuration.data.value?.hasWebhook || !!configForm.webhook.trim()));
async function editMessage(input: WecomMessageInput, saved?: WecomMessageSaved) {
  if (await manager.replace(input, saved)) activeTab.value = 'compose';
}
async function retryMessage(record: WecomMessageRecord) {
  if (await manager.retry(record)) activeTab.value = 'compose';
}
</script>

<template>
  <div class="wecom-workspace">
    <div class="messages-heading"><div><span class="messages-eyebrow"><MessageSquareText :size="14" /> 企微群消息推送</span><h1>手动群消息</h1><p>编写正文并预览后点击发送。定时日报请在<router-link to="/agent?view=settings&amp;settingsTab=reports">自动汇报</router-link>中设置。</p></div><el-button :disabled="busy" @click="configOpen = true"><Settings2 :size="14" /> 更换手动消息群</el-button></div>
    <div class="messages-status"><span class="run-badge" :class="{ success: configuration.data.value?.hasWebhook }"><i v-if="configuration.data.value?.hasWebhook" class="live-dot"></i>{{ configuration.isPending.value ? '正在读取连接' : configuration.isError.value ? '连接配置读取失败' : configuration.data.value?.hasWebhook ? '机器人已配置' : '机器人未配置' }}</span><span>{{ configuration.data.value?.groupName || '配置目标群后即可推送' }}</span><span class="messages-status-note">手动推送 · 草稿 / 模板 · 本机历史</span></div>
    <el-tabs v-model="activeTab" class="workspace-section-tabs">
      <el-tab-pane label="编辑与预览" name="compose">
        <div class="messages-compose">
          <MessageEditor :model-value="form" :busy="busy" :bytes="bytes" :limit="limit" :valid="valid" :dirty="dirty" :editing="activeSaved" @update:model-value="Object.assign(form, $event)" @preview="manager.prepare" @save="manager.save" @clear="manager.clear" />
          <MessagePreview :preview="preview" :loading="manager.previewMutation.isPending.value" :sending="manager.sendMutation.isPending.value" :can-send="canSend" :configured="!!configuration.data.value?.hasWebhook" :group-name="configuration.data.value?.groupName || ''" @send="manager.send" @configure="configOpen = true" />
        </div>
      </el-tab-pane>
      <el-tab-pane label="消息管理" name="records" lazy>
        <MessageRecords :saved="library.data.value || []" :history="history.data.value || []" :loading="library.isPending.value || history.isPending.value" :busy="busy" @use-saved="editMessage($event, $event)" @copy="editMessage" @remove="manager.remove" @retry="retryMessage" @refresh="manager.refresh" />
      </el-tab-pane>
    </el-tabs>
    <el-dialog v-if="configOpen" v-model="configOpen" title="企业微信机器人配置" width="min(620px, 95vw)" :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy" destroy-on-close>
      <el-form v-loading="configuration.isPending.value" label-position="top" :disabled="busy" @submit.prevent="manager.saveConfig">
        <el-form-item label="接收消息的企业微信群" required><el-input v-model="configForm.groupName" maxlength="80" placeholder="填写目标群名称" /></el-form-item>
        <el-form-item label="群机器人 Webhook" :required="!configuration.data.value?.hasWebhook"><el-input v-model="configForm.webhook" type="password" autocomplete="off" :placeholder="configuration.data.value?.hasWebhook ? '已保存；留空保留原 Webhook' : '粘贴群机器人的 Webhook'" /></el-form-item>
        <p class="messages-config-note">这里与接口联调共用接收群。自动汇报选择“单独设置汇报群”时不受这里影响；选择“共用手动消息群”时使用这里的群。Webhook 仅保存在本机，页面不回显。</p>
      </el-form>
      <template #footer><el-button :disabled="busy" @click="configOpen = false">取消</el-button><el-button type="primary" :disabled="busy || !configValid || configuration.isError.value" :loading="manager.configMutation.isPending.value" @click="manager.saveConfig">保存配置</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.wecom-workspace{display:flex;flex-direction:column;gap:12px}.messages-heading{display:flex;align-items:center;justify-content:space-between;gap:14px}.messages-heading h1{font-size:18px;font-weight:600;letter-spacing:-.02em;margin:4px 0 4px}.messages-heading p{font-size:12.5px;color:var(--ui-muted);margin:0;line-height:1.55}.messages-eyebrow{display:flex;align-items:center;gap:6px;font:500 11px var(--sans);color:var(--ui-muted)}.messages-heading p a{color:var(--ui-secondary);margin:0 4px;text-decoration:underline;text-underline-offset:3px;transition:color 140ms ease}.messages-heading p a:hover{color:var(--ui-accent)}.messages-heading>.el-button{gap:6px}.messages-status{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 12px;border:1px solid var(--ui-border);border-radius:var(--ds-radius,8px);background:var(--ui-surface);font-size:12px;color:var(--ui-secondary)}.messages-status-note{margin-left:auto;color:var(--ui-muted);font-size:11.5px}.messages-compose{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(320px,.85fr);gap:14px;align-items:stretch}.messages-config-note{font-size:12px;color:var(--ui-muted);line-height:1.65}@media(max-width:1050px){.messages-compose{grid-template-columns:minmax(0,1fr)}}@media(max-width:650px){.messages-heading{align-items:flex-start;flex-direction:column;gap:10px}.messages-status-note{margin-left:0;width:100%}}
</style>
