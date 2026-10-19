<script setup lang="ts">
/** 消息工作区只组合编辑、服务端预览和本机记录；机器人配置沿用联调功能，避免重复连接。 */
import { computed } from 'vue';
import { MessageSquareText, Settings2 } from '@lucide/vue';
import MessageEditor from './MessageEditor.vue';
import MessagePreview from './MessagePreview.vue';
import MessageRecords from './MessageRecords.vue';
import { useWecomMessages } from './useWecomMessages';
const manager = useWecomMessages();
const { form, dirty, bytes, limit, valid, preview, configuration, library, history, activeSaved, configOpen, configForm, busy, canSend } = manager;
const configValid = computed(() => !!configForm.groupName.trim() && (!!configuration.data.value?.hasWebhook || !!configForm.webhook.trim()));
</script>

<template>
  <div class="wecom-workspace">
    <div class="messages-heading"><div><span class="messages-eyebrow"><MessageSquareText :size="14" /> WECOM / MESSAGE CENTER</span><h1>企业微信消息</h1><p>编辑一条消息，核对发送预览，再推送到已连接的群机器人。</p></div><el-button :disabled="busy" @click="configOpen = true"><Settings2 :size="14" /> 机器人配置</el-button></div>
    <div class="messages-status"><span class="run-badge" :class="{ success: configuration.data.value?.hasWebhook }"><i v-if="configuration.data.value?.hasWebhook" class="live-dot"></i>{{ configuration.isPending.value ? '正在读取连接' : configuration.isError.value ? '连接配置读取失败' : configuration.data.value?.hasWebhook ? '机器人已配置' : '机器人未配置' }}</span><span>{{ configuration.data.value?.groupName || '配置目标群后即可推送' }}</span><span class="messages-status-note">手动推送 · 草稿 / 模板 · 本机历史</span></div>
    <div class="messages-compose">
      <MessageEditor :model-value="form" :busy="busy" :bytes="bytes" :limit="limit" :valid="valid" :dirty="dirty" :editing="activeSaved" @update:model-value="Object.assign(form, $event)" @preview="manager.prepare" @save="manager.save" @clear="manager.clear" />
      <MessagePreview :preview="preview" :loading="manager.previewMutation.isPending.value" :sending="manager.sendMutation.isPending.value" :can-send="canSend" :configured="!!configuration.data.value?.hasWebhook" :group-name="configuration.data.value?.groupName || ''" @send="manager.send" @configure="configOpen = true" />
    </div>
    <MessageRecords :saved="library.data.value || []" :history="history.data.value || []" :loading="library.isPending.value || history.isPending.value" :busy="busy" @use-saved="manager.replace($event, $event)" @copy="manager.replace($event)" @remove="manager.remove" @retry="manager.retry" @refresh="manager.refresh" />
    <el-dialog v-model="configOpen" title="企业微信机器人配置" width="min(620px, 95vw)" :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy" destroy-on-close>
      <el-form v-loading="configuration.isPending.value" label-position="top" :disabled="busy" @submit.prevent="manager.saveConfig">
        <el-form-item label="接收消息的企业微信群" required><el-input v-model="configForm.groupName" maxlength="80" placeholder="填写目标群名称" /></el-form-item>
        <el-form-item label="群机器人 Webhook" :required="!configuration.data.value?.hasWebhook"><el-input v-model="configForm.webhook" type="password" autocomplete="off" :placeholder="configuration.data.value?.hasWebhook ? '已保存；留空保留原 Webhook' : '粘贴群机器人的 Webhook'" /></el-form-item>
        <p class="messages-config-note">复用接口联调中已连接的机器人。Webhook 只保存在本机服务端，页面不回显；保存配置不会发送消息。</p>
      </el-form>
      <template #footer><el-button :disabled="busy" @click="configOpen = false">取消</el-button><el-button type="primary" :disabled="busy || !configValid || configuration.isError.value" :loading="manager.configMutation.isPending.value" @click="manager.saveConfig">保存配置</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.wecom-workspace{display:flex;flex-direction:column;gap:21px}.messages-heading{display:flex;align-items:center;justify-content:space-between;gap:20px}.messages-heading h1{font-size:25px;font-weight:600;letter-spacing:-.5px;margin:9px 0 8px}.messages-heading p{font-size:13px;color:var(--ui-muted);margin:0;line-height:1.7}.messages-eyebrow{display:flex;align-items:center;gap:7px;font:10px var(--mono);letter-spacing:1px;color:var(--ui-muted)}.messages-heading>.el-button{gap:7px}.messages-status{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--ui-secondary)}.messages-status-note{margin-left:auto;color:var(--ui-muted);font-size:11px}.messages-compose{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(320px,.85fr);gap:21px;align-items:stretch}.messages-config-note{font-size:12px;color:var(--ui-muted);line-height:1.8}@media(max-width:1050px){.messages-compose{grid-template-columns:minmax(0,1fr)}}@media(max-width:650px){.messages-heading{align-items:flex-start;flex-direction:column;gap:14px}.messages-status-note{margin-left:0;width:100%}}
</style>
