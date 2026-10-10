<script setup lang="ts">
/**
 * 设计说明：配置和反馈只在联调页的一个对话框承接，保持表格、人员分工和审核结论独立。
 * 预览及发送都由服务端校验，客户端不持有已保存的 Webhook；不使用聊天式机器人或自动重试。
 */
import { computed, reactive, shallowRef, watch } from 'vue';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { feedbackStatusLabels, type BackendFeedbackInput, type BackendFeedbackPreview, type BackendFeedbackRecord, type WecomPublicConfig } from '../../../shared/wecom-integration';
import type { ReviewCatalogItem } from './review-catalog';

const open = defineModel<boolean>({ required: true });
const props = defineProps<{ item?: ReviewCatalogItem }>();
const client = useQueryClient();
async function request<T>(suffix: string, input?: unknown): Promise<T> {
  const response = await fetch(`/api/integration-wecom/${suffix}`, input === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: JSON.stringify(input),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || '企业微信操作失败');
  return data;
}
const configKey = ['integration-wecom-config'];
const configuration = useQuery({ queryKey: configKey, queryFn: () => request<WecomPublicConfig>('config'), enabled: computed(() => open.value), retry: false });
const history = useQuery({
  queryKey: computed(() => ['integration-wecom-reports', props.item?.id]),
  queryFn: () => request<BackendFeedbackRecord[]>(`reports?interfaceId=${encodeURIComponent(props.item?.id || '')}`),
  enabled: computed(() => open.value && !!props.item), retry: false,
});
const configForm = reactive({ groupName: '', webhook: '' });
const form = reactive({ summary: '', environment: '', parameters: '', actual: '', expected: '', contractReference: '', traceId: '' });
const preview = shallowRef<BackendFeedbackPreview>();
watch(configuration.error, error => { if (open.value && error) ElMessage.error(error.message); });
watch(history.error, error => { if (open.value && error) ElMessage.error(error.message); });
function resetConfig() {
  const data = configuration.data.value;
  configForm.groupName = data?.groupName || '';
  configForm.webhook = '';
}
watch(configuration.data, () => { if (open.value && !props.item) resetConfig(); });
watch([open, () => props.item?.id], () => {
  if (!open.value) { configForm.webhook = ''; return; }
  preview.value = undefined;
  resetConfig();
  Object.assign(form, { summary: '', environment: '', parameters: '', actual: '', expected: '', contractReference: '', traceId: '' });
});
watch(form, () => { preview.value = undefined; }, { deep: true });
const latest = computed(() => history.data.value?.[0]);
const validFeedback = computed(() => !!props.item?.method && [form.summary, form.environment, form.parameters, form.actual, form.expected, form.contractReference].every(value => !!value.trim()));
const previewMutation = useMutation({ mutationFn: (input: BackendFeedbackInput) => request<BackendFeedbackPreview>('preview', input) });
const sendMutation = useMutation({ mutationFn: (data: BackendFeedbackPreview) => request<{ record: BackendFeedbackRecord; message: string }>('send', { input: data.input, hash: data.hash }) });
const configMutation = useMutation({ mutationFn: (data: unknown) => request<WecomPublicConfig & { message: string }>('config', data) });
const busy = computed(() => previewMutation.isPending.value || sendMutation.isPending.value || configMutation.isPending.value);
async function saveConfig() {
  try {
    const data = await configMutation.mutateAsync({
      groupName: configForm.groupName,
      ...(configForm.webhook.trim() ? { webhook: configForm.webhook.trim() } : {}),
    });
    await client.cancelQueries({ queryKey: configKey });
    client.setQueryData(configKey, data);
    configForm.webhook = '';
    ElMessage.success(data.message);
    open.value = false;
  } catch (error) { ElMessage.error((error as Error).message); }
}
async function prepare() {
  if (!props.item || !validFeedback.value) return;
  try {
    preview.value = await previewMutation.mutateAsync({ interfaceId: props.item.id, ...form });
  } catch (error) { ElMessage.error((error as Error).message); }
}
async function send() {
  if (!preview.value?.canSend || busy.value) return;
  try {
    const data = await sendMutation.mutateAsync(preview.value);
    if (data.record.status === 'sent') ElMessage.success(data.message);
    else ElMessage.warning(data.message);
    await history.refetch();
  } catch (error) { ElMessage.error((error as Error).message); }
}
</script>

<template>
  <el-dialog v-model="open" :title="item ? `后端反馈 · ${item.name}` : '企业微信机器人配置'" width="min(760px, 96vw)"
    :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy" destroy-on-close>
    <div v-loading="configuration.isPending.value">
      <template v-if="!item">
        <el-form label-position="top" :disabled="busy" @submit.prevent="saveConfig">
          <el-form-item label="接收反馈的企业微信群" required><el-input v-model="configForm.groupName" maxlength="80" placeholder="填写目标群名称" /></el-form-item>
          <el-form-item label="群机器人 Webhook" :required="!configuration.data.value?.hasWebhook">
            <el-input v-model="configForm.webhook" type="password" autocomplete="off" show-password :placeholder="configuration.data.value?.hasWebhook ? '已保存；留空保留原 Webhook' : '粘贴群内消息推送机器人的 Webhook'" />
          </el-form-item>
          <p class="wecom-note">Webhook 只保存在本机服务端，页面不回显。保存配置不会发送消息。</p>
        </el-form>
      </template>
      <template v-else>
        <p class="wecom-context"><code>{{ item.method || '方法待确认' }} {{ item.path }}</code><br>{{ item.ui.module }} / {{ item.ui.page }}</p>
        <el-form label-position="top" :disabled="busy" @submit.prevent="prepare">
          <el-form-item label="问题摘要" required><el-input v-model="form.summary" maxlength="160" placeholder="描述已复现的接口问题" /></el-form-item>
          <el-form-item label="请求环境" required><el-input v-model="form.environment" maxlength="200" placeholder="如 DEV · BFF 域名或服务版本" /></el-form-item>
          <el-form-item label="请求参数 / 关键请求头" required><el-input v-model="form.parameters" type="textarea" :rows="3" maxlength="12000" placeholder="保留字段、类型、关键值；无参数请写“无”；不粘贴鉴权密钥" /></el-form-item>
          <el-form-item label="实际返回" required><el-input v-model="form.actual" type="textarea" :rows="3" maxlength="12000" placeholder="HTTP 状态、业务 code/message、关键响应字段或错误" /></el-form-item>
          <el-form-item label="预期结果" required><el-input v-model="form.expected" type="textarea" :rows="3" maxlength="12000" placeholder="具体预期字段、类型、状态及与实际结果的差异" /></el-form-item>
          <el-form-item label="契约依据" required><el-input v-model="form.contractReference" maxlength="2000" placeholder="BFF 契约文件 / 文档链接及版本；先确认预期有依据" /></el-form-item>
          <el-form-item label="traceId / requestId"><el-input v-model="form.traceId" maxlength="200" /></el-form-item>
        </el-form>
        <p class="wecom-note">{{ configuration.data.value?.hasWebhook ? `目标群：${configuration.data.value.groupName}` : '群机器人尚未配置，请在联调页顶部“企业微信机器人”中配置。' }}</p>
        <template v-if="preview">
          <p class="wecom-note">发送预览 · {{ preview.bytes }} 字节</p>
          <pre class="wecom-preview">{{ preview.content }}</pre>
          <p class="wecom-note">{{ preview.truncated ? '群消息已截取摘要，完整脱敏反馈保留在本机。' : '完整脱敏反馈与发送结果保留在本机。' }}发送前请核对脱敏结果。</p>
        </template>
        <el-collapse v-if="latest">
          <el-collapse-item :title="`最近反馈：${feedbackStatusLabels[latest.status]} · ${latest.attemptedAt}`" name="latest">
            <p class="wecom-note">{{ latest.message }}</p>
            <p class="wecom-note">{{ latest.preview.input.summary }} · {{ latest.preview.input.environment }}</p>
            <pre class="wecom-preview">请求参数：{{ latest.preview.input.parameters }}
实际返回：{{ latest.preview.input.actual }}
预期结果：{{ latest.preview.input.expected }}
契约依据：{{ latest.preview.input.contractReference }}</pre>
          </el-collapse-item>
        </el-collapse>
      </template>
    </div>
    <template #footer>
      <el-button :disabled="busy" @click="open = false">关闭</el-button>
      <el-button v-if="!item" type="primary" :loading="configMutation.isPending.value" :disabled="busy || configuration.isError.value || !configForm.groupName.trim()" @click="saveConfig">保存配置</el-button>
      <template v-else>
        <el-button :disabled="busy || !validFeedback" :loading="previewMutation.isPending.value" @click="prepare">预览脱敏反馈</el-button>
        <el-button type="primary" :loading="sendMutation.isPending.value" :disabled="busy || !preview?.canSend" @click="send">发送到群</el-button>
      </template>
    </template>
  </el-dialog>
</template>

<style scoped>
.wecom-note{color:var(--ui-muted);font-size:12px;line-height:1.7}.wecom-context{line-height:1.8;font-size:12px;overflow-wrap:anywhere}
.wecom-preview{margin:8px 0 16px;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.7 var(--mono);color:var(--ui-text)}
</style>
