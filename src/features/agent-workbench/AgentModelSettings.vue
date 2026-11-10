<script setup lang="ts">
/** CLI 继续使用自身认证；兼容 API 的地址和密钥通过服务端配置，不在模型列表回传密钥。 */
import { computed, reactive, ref, watch } from 'vue';
import { Plus, Trash2 } from '@lucide/vue';
import { agentProviderLabels, type AgentApiProvider, type AgentCustomModelInput, type AgentProvider, type AgentRuntimeHealth } from '../../../shared/agent-runtime';

const props = defineProps<{ runtimes: AgentRuntimeHealth[]; changing: string; initialProvider?: AgentApiProvider }>();
const visible = defineModel<boolean>({ default: false });
const emit = defineEmits<{ add: [input: AgentCustomModelInput]; remove: [id: string] }>();
const connection = ref<'cli' | 'api' | 'grok' | 'deepseek' | 'deepseek-nvidia'>('cli');
const form = reactive({ provider: 'codex' as AgentProvider, modelId: '', label: '', baseUrl: '', apiKey: '' });
const cliRuntimes = computed(() => props.runtimes.filter(runtime => !['api', 'grok', 'deepseek'].includes(runtime.provider)));
const customModels = computed(() => props.runtimes.flatMap((runtime) => runtime.models.filter((model) => model.customId)
  .map((model) => ({ ...model, provider: runtime.provider }))));
const validBaseUrl = computed(() => {
  try {
    const url = new URL(form.baseUrl.trim());
    return (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
});
const officialApi = computed(() => ['grok', 'deepseek', 'deepseek-nvidia'].includes(connection.value));
const officialBaseUrl = computed(() => connection.value === 'deepseek-nvidia' ? 'https://integrate.api.nvidia.com/v1'
  : connection.value === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.x.ai/v1');
const officialKeyLabel = computed(() => connection.value === 'deepseek-nvidia' ? 'NVIDIA API Key'
  : connection.value === 'deepseek' ? 'DeepSeek API Key' : 'xAI API Key');
const canAdd = computed(() => /^[A-Za-z0-9][A-Za-z0-9._:/\[\]=,-]{0,99}$/.test(form.modelId.trim()) && !!form.label.trim()
  && !props.changing && (officialApi.value ? !!form.apiKey.trim()
    : connection.value === 'api' ? validBaseUrl.value : cliRuntimes.value.some(runtime => runtime.provider === form.provider)));
watch(visible, value => {
  if (value && props.initialProvider) connection.value = props.initialProvider;
  if (!value) form.apiKey = '';
});
watch(connection, (value, previous) => {
  form.apiKey = '';
  if (value === 'deepseek-nvidia') form.modelId = 'deepseek-ai/deepseek-v4.1-flash';
  else if (previous === 'deepseek-nvidia') form.modelId = '';
}, { flush: 'sync' });

function add() {
  if (!canAdd.value) return;
  emit('add', { provider: connection.value === 'cli' ? form.provider : connection.value === 'deepseek-nvidia' ? 'deepseek' : connection.value, modelId: form.modelId.trim(), label: form.label.trim(),
    ...(connection.value !== 'cli' ? { api: { baseUrl: officialApi.value ? officialBaseUrl.value : form.baseUrl.trim(),
      ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}) } } : {}) });
  form.apiKey = '';
}
</script>

<template>
  <el-dialog v-model="visible" class="agent-dialog" title="自定义模型" width="min(680px, 92vw)" append-to-body>
    <p class="model-boundary">兼容 API 用于对话与规划；DeepSeek、Grok（xAI）可使用工作区文件和受控命令。NVIDIA 提供线上 DeepSeek 免费开发端点，需要独立账号密钥，资格和限额以服务商为准；失败停止，不切换付费通道。WorkBuddy 的可用性以执行器状态为准。<router-link to="/settings" @click="visible = false">配置会话默认模型</router-link></p>
    <el-form label-position="top" class="model-form" @submit.prevent="add">
      <el-form-item label="接入方式"><el-select v-model="connection" aria-label="接入方式"><el-option label="本机 CLI" value="cli" /><el-option label="模型 API（OpenAI 兼容）" value="api" /><el-option label="Grok（xAI 本机执行）" value="grok" /><el-option label="DeepSeek（NVIDIA 免费开发端点）" value="deepseek-nvidia" /><el-option label="DeepSeek（官方 API 本机执行）" value="deepseek" /></el-select></el-form-item>
      <el-form-item v-if="connection === 'cli'" label="执行器"><el-select v-model="form.provider" popper-class="agent-model-popper" aria-label="执行器"><el-option v-for="runtime in cliRuntimes" :key="runtime.provider" :label="runtime.label" :value="runtime.provider" /></el-select></el-form-item>
      <template v-else>
        <el-form-item class="model-wide" label="API Base URL"><div class="api-address"><el-input v-if="officialApi" :model-value="officialBaseUrl" aria-label="API Base URL" readonly /><template v-else><el-input v-model="form.baseUrl" aria-label="API Base URL" placeholder="https://api.deepseek.com" maxlength="1000" /><el-button @click="form.baseUrl = 'https://api.deepseek.com'">DeepSeek</el-button></template></div></el-form-item>
        <el-form-item class="model-wide" :label="officialApi ? officialKeyLabel : 'API Key（可选）'"><el-input v-model="form.apiKey" aria-label="API Key" type="password" autocomplete="new-password" :placeholder="officialApi ? `填写自己的 ${officialKeyLabel}，仅保存在本机` : '仅保存在本机；无需认证的接口可留空'" maxlength="4096" /></el-form-item>
      </template>
      <el-form-item label="模型 ID"><el-input v-model="form.modelId" aria-label="模型 ID" :readonly="connection === 'deepseek-nvidia'" maxlength="100" placeholder="填写服务商提供的模型 ID" /></el-form-item>
      <el-form-item label="显示名称"><el-input v-model="form.label" aria-label="显示名称" maxlength="80" placeholder="显示名称" /></el-form-item>
      <div class="model-wide model-actions"><el-button type="primary" :disabled="!canAdd" :loading="changing === 'model:add'" @click="add"><Plus :size="14" /> 添加</el-button></div>
    </el-form>
    <div v-if="customModels.length" class="custom-model-list"><div v-for="model in customModels" :key="model.customId" class="custom-model-item"><span><strong>{{ model.label }}</strong><small>{{ agentProviderLabels[model.provider] }} · {{ model.id }}</small><small v-if="model.api">{{ model.api.baseUrl }}</small></span><el-button link type="danger" :loading="changing === `model:${model.customId}`" @click="model.customId && emit('remove', model.customId)"><Trash2 :size="14" /> 删除</el-button></div></div>
    <el-empty v-else description="还没有自定义模型" :image-size="48" />
    <template #footer><el-button @click="visible = false">关闭</el-button></template>
  </el-dialog>
</template>

<style scoped>
.model-boundary{margin:-4px 0 16px;color:var(--ui-muted);font-size:12px;line-height:1.7}.model-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:14px}.model-form :deep(.el-form-item){min-width:0;margin-bottom:14px}.model-form :deep(.el-select){width:100%;min-width:0}.model-wide{grid-column:1/-1}.api-address{display:flex;gap:8px;width:100%;min-width:0}.api-address :deep(.el-input){min-width:0}.model-actions{display:flex;justify-content:flex-end}.custom-model-list{margin-top:18px;border-top:1px solid var(--ui-border)}.custom-model-item{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 2px;border-bottom:1px solid var(--ui-border)}.custom-model-item span{min-width:0}.custom-model-item strong,.custom-model-item small{display:block}.custom-model-item strong{font-size:12px}.custom-model-item small{margin-top:4px;color:var(--ui-muted);font:10px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.custom-model-item :deep(.el-button){flex-shrink:0}@media(max-width:600px){.model-form{grid-template-columns:minmax(0,1fr)}}
</style>
