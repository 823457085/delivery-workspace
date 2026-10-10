<script setup lang="ts">
/**
 * 设计说明：会话输入区独立管理本轮模型、推理强度、速度、访问权限与消息草稿。
 * 发送进入队列，插入通过当前轮的实时连接补充要求；不修改该轮执行配置。
 */
import { computed, shallowRef, useTemplateRef, watch } from 'vue';
import { CircleStop, Send, Settings2 } from '@lucide/vue';
import type { AgentAccessMode, AgentAttachment, AgentProvider, AgentQueuePlacement, AgentReasoningEffort, AgentRuntimeHealth, AgentServiceTier } from '../../../shared/agent-runtime';
import type { AgentConversation } from './conversation';
import AgentPromptEditor from './AgentPromptEditor.vue';
import AgentAccessSelector from './AgentAccessSelector.vue';
import AgentModelSpeed from './AgentModelSpeed.vue';
import type { AgentBusinessMention } from './agent-business-context';
import { codexServiceTier } from './model-speed';

const props = defineProps<{ conversation: AgentConversation; runtimes: AgentRuntimeHealth[]; changing: string; running: boolean;
  canInsert: boolean; businessOptions: AgentBusinessMention[] }>();
const draft = defineModel<string>({ default: '' });
const attachments = defineModel<AgentAttachment[]>('attachments', { default: () => [] });
const promptEditor = useTemplateRef<InstanceType<typeof AgentPromptEditor>>('promptEditor');
const emit = defineEmits<{ send: [selection: { provider: AgentProvider; model: string; reasoningEffort: AgentReasoningEffort | ''; accessMode: AgentAccessMode;
  queuePlacement: AgentQueuePlacement; serviceTier?: AgentServiceTier; workflow?: boolean }]; stop: []; configureModels: [] }>();
const selectedModel = shallowRef('');
const selectedServiceTier = shallowRef<AgentServiceTier>();
const optionsExpanded = shallowRef(false);
const selectedProvider = shallowRef<AgentProvider>(props.conversation.latest.provider);
const runtime = computed(() => props.runtimes.find((item) => item.provider === selectedProvider.value));
const switchingProvider = computed(() => selectedProvider.value !== props.conversation.latest.provider);
const selectedEffort = shallowRef<AgentReasoningEffort | ''>('');
const selectedAccessMode = shallowRef<AgentAccessMode>('workspace');
const modelOptions = computed(() => runtime.value?.models || []);
const selectedOption = computed(() => modelOptions.value.find((model) => model.id === selectedModel.value));
const effortOptions = computed(() => selectedOption.value?.efforts || []);
const composerMode = computed(() => props.conversation.source === 'codex' ? 'agent' : props.conversation.latest.mode);
const writable = computed(() => composerMode.value === 'agent');
const modeLabel = computed(() => writable.value ? 'Agent 模式' : composerMode.value === 'plan' ? 'Plan 模式' : 'Ask 模式');
const canResume = computed(() => !!props.conversation.latest.sessionId || ['queued', 'running'].includes(props.conversation.latest.status));
const hasContent = computed(() => !!draft.value.trim() || !!attachments.value.length);
const stoppableRunId = computed(() => props.conversation.runs.find((run) => run.status === 'running')?.id
  || [...props.conversation.runs].reverse().find((run) => run.status === 'queued')?.id);
const canSend = computed(() => (switchingProvider.value || canResume.value) && hasContent.value && !props.changing
  && !!runtime.value?.ready && runtime.value.modes.includes(composerMode.value)
  && !!selectedOption.value && (!effortOptions.value.length || effortOptions.value.includes(selectedEffort.value as AgentReasoningEffort)));
const effortLabels: Record<AgentReasoningEffort, string> = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '极高', ultra: '最高' };

watch([() => props.conversation.id, () => props.conversation.latest.provider], () => {
  selectedProvider.value = props.conversation.latest.provider;
});
watch([() => props.conversation.id, () => props.conversation.latest.model, selectedProvider, () => runtime.value?.defaultModel], () => {
  const previous = switchingProvider.value ? '' : props.conversation.latest.model || '';
  selectedModel.value = previous && modelOptions.value.some((model) => model.id === previous)
    ? previous : runtime.value?.defaultModel || modelOptions.value[0]?.id || '';
}, { immediate: true });

watch([selectedModel, selectedProvider, () => props.conversation.id], () => {
  const previous = props.conversation.latest.reasoningEffort || '';
  selectedEffort.value = effortOptions.value.includes(previous as AgentReasoningEffort)
    ? previous as AgentReasoningEffort : selectedOption.value?.defaultEffort || effortOptions.value[0] || '';
}, { immediate: true });

watch([() => props.conversation.id, () => props.conversation.latest.accessMode], () => {
  selectedAccessMode.value = composerMode.value === 'agent' && props.conversation.latest.accessMode === 'full' ? 'full' : 'workspace';
}, { immediate: true });

watch(() => props.conversation.id, (id) => {
  let saved: string | null = null;
  try { saved = window.localStorage.getItem(`agent-service-tier:${id}`); } catch { /* 本地存储不可用时仍可在当前页面切换 */ }
  selectedServiceTier.value = saved === 'default' || saved === 'priority' ? saved : props.conversation.latest.serviceTier;
}, { immediate: true });

function setServiceTier(value: AgentServiceTier) {
  selectedServiceTier.value = value;
  try { window.localStorage.setItem(`agent-service-tier:${props.conversation.id}`, value); }
  catch { /* 当前页面仍使用选中的档位 */ }
}

function submit(queuePlacement: AgentQueuePlacement = 'append', workflow = false) {
  if (canSend.value) emit('send', { provider: selectedProvider.value, model: selectedModel.value, reasoningEffort: selectedEffort.value,
    accessMode: selectedAccessMode.value, queuePlacement,
    ...(selectedProvider.value === 'codex' ? { serviceTier: codexServiceTier(runtime.value, selectedModel.value, selectedServiceTier.value) } : {}), workflow });
}

function focusPrompt() { void promptEditor.value?.focusInput(); }

defineExpose({ focusPrompt });
</script>

<template>
  <footer class="composer">
    <div class="composer-inner" :class="{ 'options-expanded': optionsExpanded }">
      <button type="button" class="mobile-composer-options" :aria-expanded="optionsExpanded" @click="optionsExpanded = !optionsExpanded">模型与权限 {{ optionsExpanded ? '收起' : '设置' }}</button>
      <div class="composer-mode">
        <AgentAccessSelector v-model="selectedAccessMode" :mode="composerMode" :disabled="!!changing" />
        <el-select v-model="selectedProvider" class="composer-provider" popper-class="agent-model-popper" size="small" :disabled="!!changing" aria-label="选择执行器">
          <el-option v-for="item in runtimes" :key="item.provider" :value="item.provider" :label="item.label" :disabled="!item.ready || !item.modes.includes(composerMode)" />
        </el-select>
        <span>{{ modeLabel }}</span>
        <el-select v-model="selectedModel" class="composer-model" popper-class="agent-model-popper" size="small" filterable :disabled="!!changing" aria-label="选择模型"><el-option v-for="model in modelOptions" :key="model.id || 'default'" :label="model.label" :value="model.id"><span>{{ model.label }}</span><small v-if="model.customId">自定义</small></el-option></el-select>
        <el-select v-if="effortOptions.length" v-model="selectedEffort" class="composer-effort" popper-class="agent-model-popper" size="small" :disabled="!!changing" aria-label="Codex 推理强度"><el-option v-for="effort in effortOptions" :key="effort" :label="`Thinking ${effortLabels[effort]}`" :value="effort" /></el-select>
        <AgentModelSpeed :runtime="runtime" :model="selectedModel" :service-tier="selectedServiceTier" @update:service-tier="setServiceTier" />
        <el-button text size="small" aria-label="管理自定义模型" @click="emit('configureModels')"><Settings2 :size="13" /></el-button>
      </div>
      <AgentPromptEditor ref="promptEditor" v-model="draft" v-model:attachments="attachments" class="composer-prompt" :workspace-path="conversation.latest.workspacePath"
        :provider="selectedProvider" :modes="runtime?.modes || []" :selected-mode="composerMode" mode-locked
        :business-options="businessOptions"
        :placeholder="switchingProvider ? '输入要求，发送后带入近期对话文本并创建独立会话…' : running ? '当前轮执行中；发送后将进入队列' : '继续询问当前会话…（输入 @ 选择业务上下文、模式、Skill 或文件，Enter 发送）'" submit-on-enter @submit="submit()" />
      <div class="composer-footer">
        <span>{{ switchingProvider ? '发送后新建独立会话 · 携带最近 6 轮文本，不含历史图片和附件 · 原会话保留' : running ? hasContent ? canInsert ? '发送将排队 · 插入补充到当前轮（沿用当前模型与权限）' : '发送后将等待上一轮完成' : '当前轮执行中 · 输入消息后可排队' : writable ? selectedAccessMode === 'full' ? 'Agent 会话 · 可访问本机文件与网络' : 'Agent 会话 · 可修改所选工作区' : '只读会话 · 不修改工作区或外部系统' }}</span>
        <div class="composer-actions">
          <el-button v-if="running && !hasContent" type="danger" :loading="changing === stoppableRunId" @click="emit('stop')"><CircleStop :size="14" /> 中断</el-button>
          <template v-else><el-button v-if="!switchingProvider && !running && writable && conversation.source !== 'codex'" :disabled="!canSend || !draft.trim()" title="在独立工作区实现，完成后自动只读复核" @click="submit('append', true)">实现并复核</el-button><el-button v-if="!switchingProvider && running && canInsert" :disabled="!canSend" :loading="!!changing" @click="submit('next')">插入</el-button><el-button type="primary" :disabled="!canSend" :loading="!!changing" @click="submit()"><Send :size="14" /> 发送</el-button></template>
        </div>
      </div>
    </div>
  </footer>
</template>

<style scoped>
.mobile-composer-options{display:none}
.composer-provider{width:112px;flex-shrink:0}
.composer{position:relative;padding:12px clamp(26px,4.2vw,64px) 18px;border-top:1px solid #252d3b;background:linear-gradient(180deg,#11151de8,#10131a)}.composer::before{position:absolute;content:"";left:12%;right:12%;top:-28px;height:28px;background:linear-gradient(transparent,#10141ce8);pointer-events:none}.composer-inner{display:grid;grid-template-areas:"mode tools" "editor editor" "footer footer";grid-template-columns:minmax(0,1fr) auto;column-gap:12px;width:min(100%,980px);margin:0 auto;padding:11px 13px 12px;border:1px solid #3a4457;border-radius:14px;background:#181d27;box-shadow:0 16px 44px #0005,0 0 0 1px #ffffff05 inset}.composer-mode{grid-area:mode;display:flex;align-items:center;gap:6px;min-width:0;margin:0 0 9px}.composer-mode>span,.composer-mode>strong{display:inline-flex;align-items:center;height:30px;padding:0 9px;border:1px solid #343d4e;border-radius:7px;background:#202633;font-size:10px;font-weight:560;color:#929caf;white-space:nowrap}.composer-mode>strong{border-color:#5c56a4;background:#2b2945;color:#cdc9ff}.composer-model{width:176px}.composer-effort{width:120px}.composer-mode:deep(.el-select__wrapper){min-height:30px;padding:2px 9px;border:1px solid #514d8b;border-radius:7px;background:#24243a;box-shadow:none}.composer-mode:deep(.el-select__wrapper:hover){border-color:#746bd0}.composer-mode:deep(.el-select__selected-item){font-size:10px;color:#d0cdff}.composer-mode:deep(.el-button){width:30px;height:30px;padding:0;border:1px solid #343d4e;border-radius:7px;color:#b2adff}.composer-mode:deep(.el-button:hover){border-color:#57538a;background:#2c2947}.composer-prompt{display:contents}.composer-prompt:deep(.prompt-tools){grid-area:tools;justify-content:flex-end;align-self:start;gap:4px;margin:0 0 9px}.composer-prompt:deep(.prompt-tools .el-button){height:30px;padding:4px 9px;border:1px solid transparent;border-radius:7px;font-size:10px}.composer-prompt:deep(.prompt-tools .el-button:hover){border-color:#3d4658}.composer-prompt:deep(.prompt-tools .el-button.active){border-color:#5c56a4}.composer-prompt:deep(.tool-divider){height:18px;margin:0 2px}.composer-prompt:deep(.editor-body){grid-area:editor;min-width:0}.composer-footer{grid-area:footer;display:flex;align-items:center;justify-content:space-between;gap:12px;margin:9px 0 0}.composer-footer span{font-size:9px;color:var(--agent-muted)}.composer-actions{display:flex;align-items:center;gap:8px}.composer-footer:deep(.el-button--primary){min-width:88px;height:34px;border:1px solid #9689ff33;border-radius:8px;background:linear-gradient(115deg,#5c62eb,#7b45e9);box-shadow:0 8px 20px #654fe63b}.composer-footer:deep(.el-button--primary:not(.is-disabled):hover){filter:brightness(1.1)}
@media(max-width:1240px){.composer-inner{grid-template-areas:"mode" "tools" "editor" "footer";grid-template-columns:minmax(0,1fr)}.composer-mode{flex-wrap:wrap}.composer-prompt:deep(.prompt-tools){justify-content:flex-start}}
@media(max-width:1600px){.composer{padding:12px 18px 16px}.composer-inner{grid-template-areas:"mode" "tools" "editor" "footer";grid-template-columns:minmax(0,1fr)}.composer-mode{flex-wrap:wrap}.composer-model{flex:1 0 150px}.composer-effort{flex:0 0 120px}.composer-prompt:deep(.prompt-tools){justify-content:flex-start}.composer-footer{flex-wrap:wrap}.composer-actions{margin-left:auto;flex-wrap:wrap}}
</style>
