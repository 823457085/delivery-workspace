<script setup lang="ts">
/** 设置卡片只编辑模型偏好；模型目录复用运行时查询，应用逻辑由共享偏好维护，避免复制会话状态。 */
import { computed, reactive, toRef, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { agentProviderLabels, type AgentModelDefaults, type AgentReasoningEffort } from '../../../shared/agent-runtime';
import { agentModelDefaults, applyAgentModelDefaults } from '../../shared/agent-model-defaults';
import { useAgentRuntimeSnapshot } from '../../shared/useAgentRuntimeSnapshot';
import QueryState from '../../shared/ui/QueryState.vue';
import { useAgentModelSelection } from '../agent-workbench/model-selection';

const query = useAgentRuntimeSnapshot();
const runtimes = computed(() => query.data.value?.runtimes || []);
const runtime = computed(() => runtimes.value.find(item => item.provider === form.provider));
const models = computed(() => runtime.value?.models || []);
const form = reactive<AgentModelDefaults>({ ...agentModelDefaults.value, provider: agentModelDefaults.value.provider || 'codex' });
const option = computed(() => models.value.find(item => item.id === form.model));
const efforts = computed(() => option.value?.efforts || []);
const modelPicker = useAgentModelSelection(() => runtime.value, toRef(form, 'model'), toRef(form, 'reasoningEffort'), { allowDefaultEffort: false });
const labels: Record<AgentReasoningEffort, string> = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '极高', ultra: '最高' };
const activeRuntime = computed(() => runtimes.value.find(item => item.provider === (agentModelDefaults.value.provider || 'codex')));
const activeLabel = computed(() => activeRuntime.value?.models.find(item => item.id === agentModelDefaults.value.model)?.label || agentModelDefaults.value.model || 'CLI 默认');
const valid = computed(() => !!option.value && (efforts.value.length ? efforts.value.includes(form.reasoningEffort as AgentReasoningEffort) : !form.reasoningEffort));
watch(agentModelDefaults, value => { form.provider = value.provider || 'codex'; form.model = value.model; form.reasoningEffort = value.reasoningEffort; });
function changeProvider() {
  form.model = form.provider === (agentModelDefaults.value.provider || 'codex')
    ? agentModelDefaults.value.model : runtime.value?.defaultModel || runtime.value?.models[0]?.id || '';
  changeModel();
}
function changeModel() { form.reasoningEffort = option.value?.defaultEffort || efforts.value[0] || ''; }
function apply() {
  try { applyAgentModelDefaults(form, runtime.value); ElMessage.success('默认模型已保存，新会话将使用该执行器'); }
  catch (error) { ElMessage.error((error as Error).message); }
}
</script>

<template>
  <section class="surface model-defaults" aria-label="会话默认模型">
    <div class="surface-header"><div><h2>会话默认模型</h2><p>选择新会话的默认执行器与模型，并应用到该执行器已有会话的后续消息。</p></div></div>
    <div class="surface-body">
      <p class="model-current">当前默认：{{ agentProviderLabels[agentModelDefaults.provider || 'codex'] }} · <strong>{{ activeLabel }}</strong><span v-if="agentModelDefaults.reasoningEffort"> · Thinking {{ labels[agentModelDefaults.reasoningEffort] }}</span></p>
      <QueryState :loading="query.isPending.value" :error="query.error.value" :has-data="!!runtime" @retry="query.refetch()">
        <el-form class="settings-form" label-position="top" @submit.prevent="apply">
          <div class="settings-fields">
            <el-form-item label="默认执行器"><el-select v-model="form.provider" aria-label="默认执行器" @change="changeProvider"><el-option v-for="item in runtimes" :key="item.provider" :value="item.provider" :label="item.label" /></el-select></el-form-item>
            <el-form-item label="默认模型"><el-select v-model="modelPicker.model.value" filterable :empty-values="[null, undefined]" aria-label="默认模型" @change="changeModel"><el-option v-for="model in modelPicker.models.value" :key="model.id" :label="model.label" :value="model.id" /></el-select></el-form-item>
            <el-form-item v-if="modelPicker.efforts.value.length" label="默认推理强度"><el-select v-model="modelPicker.effort.value" :empty-values="[null, undefined]" aria-label="默认推理强度" :disabled="!modelPicker.efforts.value.length"><el-option v-for="effort in modelPicker.efforts.value" :key="effort" :value="effort" :label="`Thinking ${labels[effort]}`" /><el-option v-if="modelPicker.allowDefaultEffort.value || !modelPicker.efforts.value.length" value="" label="模型默认" /></el-select></el-form-item>
          </div>
          <div class="model-actions"><el-button type="primary" :disabled="!valid" @click="apply">应用默认模型</el-button><small>覆盖该执行器各会话已保存的模型选择；之后仍可在会话中单独改选。</small></div>
        </el-form>
      </QueryState>
      <p class="model-scope">仅保存在当前浏览器，并同步同一工作台地址的其他标签页。正在执行和已排队的任务保持原配置；Jira 修复、需求开发的首次启动沿用各自设置。</p>
    </div>
  </section>
</template>

<style scoped>
.model-defaults{margin-bottom:22px}.model-current{margin:0 0 20px;color:var(--ui-secondary);font-size:13px;line-height:1.7}.model-current strong{color:var(--ui-text)}.settings-fields :deep(.el-select){width:100%}.model-actions{display:flex;align-items:center;flex-wrap:wrap;gap:12px}.model-actions small,.model-scope{color:var(--ui-muted);font-size:12px;line-height:1.7}.model-scope{margin:18px 0 0}
.model-current,.model-scope,.model-actions small{overflow-wrap:anywhere}
.model-actions>.el-button{flex-shrink:0}
</style>
