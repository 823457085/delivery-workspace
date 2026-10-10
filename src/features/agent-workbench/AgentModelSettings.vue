<script setup lang="ts">
/**
 * 设计说明：该对话框只管理传给 Codex/Cursor CLI 的本地自定义模型 ID。
 * 边界不包含 API Key、认证或任意 CLI 参数，这些仍由对应 CLI 自身管理。
 */
import { computed, reactive } from 'vue';
import { Plus, Trash2 } from '@lucide/vue';
import type { AgentCustomModelInput, AgentProvider, AgentRuntimeHealth } from '../../../shared/agent-runtime';

const props = defineProps<{ runtimes: AgentRuntimeHealth[]; changing: string }>();
const visible = defineModel<boolean>({ default: false });
const emit = defineEmits<{ add: [input: AgentCustomModelInput]; remove: [id: string] }>();
const form = reactive<AgentCustomModelInput>({ provider: 'codex', modelId: '', label: '' });
const customModels = computed(() => props.runtimes.flatMap((runtime) => runtime.models.filter((model) => model.customId)
  .map((model) => ({ ...model, provider: runtime.provider }))));
const canAdd = computed(() => /^[A-Za-z0-9][A-Za-z0-9._:/\[\]=,-]{0,99}$/.test(form.modelId.trim()) && !!form.label.trim() && !props.changing);
const providerLabel = (provider: AgentProvider) => provider === 'codex' ? 'Codex CLI' : 'Cursor CLI';

function add() {
  if (!canAdd.value) return;
  emit('add', { provider: form.provider, modelId: form.modelId.trim(), label: form.label.trim() });
}
</script>

<template>
  <el-dialog v-model="visible" class="agent-dialog" title="自定义模型" width="min(620px, 92vw)" append-to-body>
    <p class="model-boundary">模型 ID 会传给对应的本机 CLI；登录、账号权限与认证仍由 Codex / Cursor CLI 管理。</p>
    <div class="model-form"><el-select v-model="form.provider" popper-class="agent-model-popper" aria-label="执行器"><el-option label="Codex CLI" value="codex" /><el-option label="Cursor CLI" value="cursor" /></el-select><el-input v-model="form.modelId" maxlength="100" placeholder="模型 ID，例如 my-model-v1" /><el-input v-model="form.label" maxlength="80" placeholder="显示名称" /><el-button type="primary" :disabled="!canAdd" :loading="changing === 'model:add'" @click="add"><Plus :size="14" /> 添加</el-button></div>
    <div v-if="customModels.length" class="custom-model-list"><div v-for="model in customModels" :key="model.customId" class="custom-model-item"><span><strong>{{ model.label }}</strong><small>{{ providerLabel(model.provider) }} · {{ model.id }}</small></span><el-button link type="danger" :loading="changing === `model:${model.customId}`" @click="model.customId && emit('remove', model.customId)"><Trash2 :size="14" /> 删除</el-button></div></div>
    <el-empty v-else description="还没有自定义模型" :image-size="48" />
    <template #footer><el-button @click="visible = false">关闭</el-button></template>
  </el-dialog>
</template>

<style scoped>
.model-boundary{margin:-4px 0 16px;color:#a7a9b7;font-size:11px;line-height:1.7}.model-form{display:grid;grid-template-columns:120px 1fr 1fr auto;gap:8px}.custom-model-list{margin-top:18px;border-top:1px solid #414250}.custom-model-item{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 2px;border-bottom:1px solid #414250}.custom-model-item span{min-width:0}.custom-model-item strong,.custom-model-item small{display:block}.custom-model-item strong{font-size:12px}.custom-model-item small{margin-top:4px;color:#8e909e;font:10px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}@media(max-width:720px){.model-form{grid-template-columns:1fr}}
</style>
