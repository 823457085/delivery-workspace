<script setup lang="ts">
/**
 * 设计说明：会话输入区独立管理本轮模型、推理强度、速度、访问权限与消息草稿。
 * 发送进入队列，插入通过当前轮的实时连接补充要求；不修改该轮执行配置。
 */
import { computed, shallowRef, useTemplateRef, watch } from 'vue';
import { CircleStop, Send, Settings2 } from '@lucide/vue';
import type { AgentAccessMode, AgentAttachment, AgentProvider, AgentQueuePlacement, AgentReasoningEffort, AgentRun, AgentRunMode, AgentRuntimeHealth, AgentServiceTier } from '../../../shared/agent-runtime';
import { codexWorkbenchDefaults } from '../../../shared/agent-runtime';
import { agentModelDefaults } from '../../shared/agent-model-defaults';
import { agentConversationContinuation, agentConversationInsertRun, type AgentConversation } from './conversation';
import AgentPromptEditor from './AgentPromptEditor.vue';
import AgentAccessSelector from './AgentAccessSelector.vue';
import AgentModelSpeed from './AgentModelSpeed.vue';
import type { AgentTeamRequest } from './AgentTeamDialog.vue';
import type { AgentBusinessMention } from './agent-business-context';
import { codexServiceTier } from './model-speed';
import { useAgentModelSelection } from './model-selection';
import type { AgentAttachmentDraft } from './useAgentAttachments';

const props = defineProps<{ conversation: AgentConversation; runtimes: AgentRuntimeHealth[]; changing: string; running: boolean;
  canInsert: boolean; businessOptions: AgentBusinessMention[]; attachmentDraft?: AgentAttachmentDraft; automaticAccessMode?: AgentAccessMode; stopping?: boolean;
  questionReply?: { text: string; state: 'pending' | 'answered' | 'expired' } }>();
const automatic = defineModel<boolean>('automatic', { default: false });
const draft = defineModel<string>({ default: '' });
const attachments = defineModel<AgentAttachment[]>('attachments', { default: () => [] });
const promptEditor = useTemplateRef<InstanceType<typeof AgentPromptEditor>>('promptEditor');
const emit = defineEmits<{ send: [selection: { provider: AgentProvider; mode?: AgentRunMode; model: string; reasoningEffort: AgentReasoningEffort | ''; accessMode: AgentAccessMode;
  queuePlacement: AgentQueuePlacement; serviceTier?: AgentServiceTier; workflow?: boolean; team?: AgentTeamRequest }]; accessChange: [accessMode: AgentAccessMode]; stop: []; cancelReply: []; configureModels: []; providerChange: [provider: AgentProvider] }>();
const selectedModel = shallowRef('');
const selectedServiceTier = shallowRef<AgentServiceTier>();
const optionsExpanded = shallowRef(false);
const continuation = computed(() => agentConversationContinuation(props.conversation));
const canInsertCurrent = computed(() => {
  const current = agentConversationInsertRun(props.conversation);
  return props.canInsert && !!current && current.mode === composerMode.value;
});
const selectedProvider = shallowRef<AgentProvider>(continuation.value.provider);
const runtime = computed(() => props.runtimes.find((item) => item.provider === selectedProvider.value));
const switchingProvider = computed(() => selectedProvider.value !== continuation.value.provider);
const usesModelDefaults = computed(() => selectedProvider.value === (agentModelDefaults.value.provider || 'codex'));
const modelDefaultsRevision = computed(() => usesModelDefaults.value ? agentModelDefaults.value.revision : '');
const selectedEffort = shallowRef<AgentReasoningEffort | ''>('');
const selectedAccessMode = shallowRef<AgentAccessMode>('workspace');
const modelOptions = computed(() => runtime.value?.models || []);
const selectedOption = computed(() => modelOptions.value.find((model) => model.id === selectedModel.value));
const effortOptions = computed(() => selectedOption.value?.efforts || []);
const modelPicker = useAgentModelSelection(() => runtime.value, selectedModel, selectedEffort);
const inheritedMode = computed(() => props.conversation.source === 'codex' ? 'agent' : continuation.value.mode);
const modeChangeAllowed = computed(() => !automatic.value && props.conversation.source !== 'codex'
  && !continuation.value.team && (!continuation.value.task || continuation.value.task.role === 'main'));
const selectedMode = shallowRef<AgentRunMode>(inheritedMode.value);
const retrySelectionChanged = shallowRef(false);
const composerMode = computed(() => modeChangeAllowed.value ? selectedMode.value : inheritedMode.value);
watch([() => props.conversation.id, () => continuation.value.id, inheritedMode], () => {
  selectedMode.value = inheritedMode.value;
  retrySelectionChanged.value = false;
});
watch([selectedProvider, automatic], () => { retrySelectionChanged.value = false; });
watch([selectedProvider, () => runtime.value?.modes], () => {
  if (modeChangeAllowed.value && runtime.value && !runtime.value.modes.includes(selectedMode.value)) {
    selectedMode.value = runtime.value.modes.includes('ask') ? 'ask' : runtime.value.modes[0] || 'ask';
  }
});
function setMode(mode: AgentRunMode) {
  if (!modeChangeAllowed.value || !runtime.value?.modes.includes(mode)) return;
  retrySelectionChanged.value = true;
  selectedMode.value = mode;
  if (mode !== 'agent') selectedAccessMode.value = 'workspace';
}
const writable = computed(() => composerMode.value === 'agent');
const modeLabel = computed(() => writable.value ? 'Agent 模式' : composerMode.value === 'plan' ? 'Plan 模式' : 'Ask 模式');
const canResume = computed(() => !!continuation.value.sessionId || ['queued', 'running'].includes(continuation.value.status));
const hasContent = computed(() => !!draft.value.trim() || !!attachments.value.length);
const stoppableRunId = computed(() => props.conversation.runs.find((run) => run.status === 'running')?.id
  || [...props.conversation.runs].reverse().find((run) => run.status === 'queued')?.id);
const canSend = computed(() => props.questionReply
  ? props.questionReply.state === 'pending' && !!draft.value.trim() && !props.changing && !props.attachmentDraft?.pending
  : automatic.value
  ? hasContent.value && !props.changing && !props.attachmentDraft?.pending
  : (switchingProvider.value || canResume.value) && hasContent.value && !props.changing
  && !props.attachmentDraft?.pending
  && !!runtime.value?.ready && runtime.value.modes.includes(composerMode.value)
  && (!runtime.value.accessModes || runtime.value.accessModes.includes(selectedAccessMode.value))
  && !!selectedOption.value && (!effortOptions.value.length || (selectedProvider.value === 'claude' && !selectedEffort.value)
    || effortOptions.value.includes(selectedEffort.value as AgentReasoningEffort)));
const effortLabels: Record<AgentReasoningEffort, string> = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '极高', ultra: '最高' };

watch([() => props.conversation.id, () => continuation.value.provider], () => {
  selectedProvider.value = continuation.value.provider;
});
watch(selectedProvider, (value) => emit('providerChange', value), { immediate: true });
// 统一应用只覆盖同一执行器的单会话选择，不切换已有会话的执行器。
function modelSelectionKey() {
  return `agent-model-selection${selectedProvider.value === 'codex' ? ':v3' : ''}:${props.conversation.id}:${selectedProvider.value}`;
}

function readModelSelection(): { model: string; reasoningEffort: string } | undefined {
  try {
    const value = JSON.parse(window.localStorage.getItem(modelSelectionKey()) || 'null');
    if (value && typeof value.model === 'string' && typeof value.reasoningEffort === 'string'
      && (value.revision || '') === modelDefaultsRevision.value) return value;
  } catch { /* 存储不可用时仍可在当前会话选择模型 */ }
}

function saveModelSelection() {
  try {
    window.localStorage.setItem(modelSelectionKey(),
      JSON.stringify({ model: selectedModel.value, reasoningEffort: selectedEffort.value,
        revision: modelDefaultsRevision.value }));
  } catch { /* 当前页面仍使用选中的模型与档位 */ }
}

function setModel(value: string) {
  modelPicker.model.value = value;
  saveModelSelection();
}

watch([() => props.conversation.id, selectedProvider, () => runtime.value?.defaultModel, () => modelDefaultsRevision.value], () => {
  // 旧轮模型保留在历史；应用偏好后，该执行器未手动改选的会话采用新默认值。
  const previous = !usesModelDefaults.value && !switchingProvider.value ? continuation.value.model : undefined;
  const preferred = readModelSelection()?.model ?? previous ?? runtime.value?.defaultModel ?? '';
  selectedModel.value = modelOptions.value.some(model => model.id === preferred)
    ? preferred : runtime.value?.defaultModel || modelOptions.value[0]?.id || '';
}, { immediate: true });

watch([selectedModel, selectedProvider, () => props.conversation.id, () => modelDefaultsRevision.value,
  () => selectedOption.value?.efforts?.join(','), () => selectedOption.value?.defaultEffort], (selection, previousSelection) => {
  if (selection.every((value, index) => value === previousSelection[index])) return;
  const saved = readModelSelection();
  const previous = saved?.model === selectedModel.value ? saved.reasoningEffort
    : selectedProvider.value === 'claude' && !switchingProvider.value && continuation.value.model === selectedModel.value
      ? continuation.value.reasoningEffort : '';
  selectedEffort.value = effortOptions.value.includes(previous as AgentReasoningEffort)
    ? previous as AgentReasoningEffort : selectedOption.value?.defaultEffort || (selectedProvider.value === 'codex' ? effortOptions.value[0] || '' : '');
}, { immediate: true });

watch([() => props.conversation.id, () => continuation.value.accessMode, selectedProvider, () => runtime.value?.accessModes?.join(','),
  automatic, () => props.automaticAccessMode], (values, previous) => {
  const supported = (value: AgentAccessMode) => !runtime.value?.accessModes || runtime.value.accessModes.includes(value);
  const contextChanged = values[0] !== previous?.[0] || values[2] !== previous?.[2] || values[4] !== previous?.[4];
  const providerChanged = previous?.[2] !== undefined && values[2] !== previous[2];
  if (providerChanged) {
    if (composerMode.value !== 'agent' || !supported(selectedAccessMode.value)) selectedAccessMode.value = 'workspace';
  }
  else if (automatic.value) selectedAccessMode.value = supported(props.automaticAccessMode || 'full') ? props.automaticAccessMode || 'full' : 'workspace';
  else if (contextChanged) selectedAccessMode.value = composerMode.value === 'agent' && supported('full') ? 'full' : 'workspace';
  else if (composerMode.value !== 'agent' || !supported(selectedAccessMode.value)) selectedAccessMode.value = 'workspace';
}, { immediate: true });
watch([selectedAccessMode, automatic], ([accessMode, isAutomatic]) => {
  if (isAutomatic) emit('accessChange', accessMode);
}, { immediate: true });

watch(() => props.conversation.id, (id) => {
  let saved: string | null = null;
  try { saved = window.localStorage.getItem(`agent-service-tier:v2:${id}`); } catch { /* 本地存储不可用时仍可在当前页面切换 */ }
  selectedServiceTier.value = saved === 'default' || saved === 'priority' ? saved : codexWorkbenchDefaults.serviceTier;
}, { immediate: true });

function setServiceTier(value: AgentServiceTier) {
  selectedServiceTier.value = value;
  try { window.localStorage.setItem(`agent-service-tier:v2:${props.conversation.id}`, value); }
  catch { /* 当前页面仍使用选中的档位 */ }
}

function submit(queuePlacement: AgentQueuePlacement = 'append', workflow = false) {
  if (canSend.value) emit('send', { provider: selectedProvider.value, model: selectedModel.value, reasoningEffort: selectedEffort.value,
    accessMode: selectedAccessMode.value, queuePlacement, ...(modeChangeAllowed.value ? { mode: composerMode.value } : {}),
    ...(selectedProvider.value === 'codex' ? { serviceTier: codexServiceTier(runtime.value, selectedModel.value, selectedServiceTier.value) } : {}), workflow });
}

function focusPrompt() { void promptEditor.value?.focusInput(); }

function retrySelection(run: AgentRun): Pick<AgentRun, 'mode' | 'accessMode'> | undefined {
  if (!retrySelectionChanged.value || !modeChangeAllowed.value || switchingProvider.value || run.provider !== selectedProvider.value
    || run.team || run.task && run.task.role !== 'main') return;
  return { mode: composerMode.value, accessMode: selectedAccessMode.value };
}

defineExpose({ focusPrompt, retrySelection });
</script>

<template>
  <footer class="composer">
    <div class="composer-inner" :class="{ 'options-expanded': optionsExpanded }">
      <button v-if="!automatic" type="button" class="mobile-composer-options" :aria-expanded="optionsExpanded" @click="optionsExpanded = !optionsExpanded">{{ optionsExpanded ? '收起模型设置' : '模型设置' }}</button>
      <div class="composer-mode collaboration-controls">
        <div class="mode-toolbar">
          <AgentAccessSelector v-model="selectedAccessMode" :mode="automatic ? 'agent' : composerMode" :provider="selectedProvider" :allow-mode-change="modeChangeAllowed" :modes="runtime?.modes" @mode-change="setMode" @selection-change="retrySelectionChanged = true" :access-modes="runtime?.accessModes" :disabled="!!changing" />
        </div>
        <div class="manual-options" :class="{ expanded: !automatic }" :inert="automatic" :aria-hidden="automatic">
        <div class="manual-options-inner">
        <el-select v-model="selectedProvider" class="composer-provider" :class="{ switching: switchingProvider }" popper-class="agent-model-popper" size="small" :disabled="!!changing" aria-label="选择执行器">
          <el-option v-for="item in runtimes" :key="item.provider" :value="item.provider" :label="item.label" :disabled="!item.ready || (!modeChangeAllowed && !item.modes.includes(composerMode))" />
        </el-select>
        <span>{{ modeLabel }}</span>
        <el-select :model-value="modelPicker.model.value" class="composer-model" popper-class="agent-model-popper" size="small" filterable :disabled="!!changing" :empty-values="[null, undefined]" aria-label="选择模型" @update:model-value="setModel"><el-option v-for="model in modelPicker.models.value" :key="model.id || 'default'" :label="model.label" :value="model.id"><span>{{ model.label }}</span><small v-if="model.customId">自定义</small></el-option></el-select>
        <el-select v-if="modelPicker.efforts.value.length" v-model="modelPicker.effort.value" class="composer-effort" popper-class="agent-model-popper" size="small" :disabled="!!changing" :empty-values="[null, undefined]" :aria-label="`${runtime?.label || '模型'} 推理强度`" @change="saveModelSelection"><el-option v-if="modelPicker.allowDefaultEffort.value" label="Thinking 默认" value="" /><el-option v-for="effort in modelPicker.efforts.value" :key="effort" :label="`Thinking ${effortLabels[effort]}`" :value="effort" /></el-select>
        <AgentModelSpeed :runtime="runtime" :model="selectedModel" :service-tier="selectedServiceTier" @update:service-tier="setServiceTier" />
        <el-button text size="small" aria-label="管理自定义模型" @click="emit('configureModels')"><Settings2 :size="13" /></el-button>
        </div>
        </div>
      </div>
      <div v-if="questionReply" class="composer-reply" aria-label="当前回复的问题"><span>{{ questionReply.state === 'pending' ? '回复：' : questionReply.state === 'answered' ? '此问题已回答：' : '此问题已过期：' }}{{ questionReply.text }}</span><el-button link size="small" :disabled="!!changing" @click="emit('cancelReply')">取消回复</el-button></div>
      <AgentPromptEditor ref="promptEditor" v-model="draft" v-model:attachments="attachments" class="composer-prompt" :workspace-path="conversation.latest.workspacePath"
        :attachment-draft="attachmentDraft"
        :provider="selectedProvider" :modes="automatic ? [] : runtime?.modes || []" :selected-mode="composerMode" mode-locked
        :business-options="businessOptions" :min-rows="3" :max-rows="6" input-label="会话消息"
        :placeholder="questionReply ? '回复上面的问题（Enter 发送）' : automatic ? '交代目标、补充要求或询问进展…（Enter 发送）' : switchingProvider ? '输入要求，发送后在当前对话切换执行器继续…' : running ? '当前轮执行中；发送后将进入队列' : '继续询问当前会话…（输入 @ 选择业务上下文、模式、Skill 或文件，Enter 发送）'" submit-on-enter @submit="submit()" />
      <div class="composer-footer">
        <span>{{ questionReply ? questionReply.state === 'pending' ? '发送将回复所选问题' : '取消回复后可继续交代任务' : automatic ? '负责人协调分工，并反馈要求何时生效' : switchingProvider ? running ? '发送后排队，在当前轮结束后切换执行器继续当前对话' : '发送后切换执行器继续当前对话' : running ? hasContent ? canInsertCurrent ? '发送将排队 · 插入补充到当前轮（沿用当前模型与权限）' : '发送后将等待上一轮完成' : '当前轮执行中 · 输入消息后可排队' : writable ? selectedAccessMode === 'full' ? 'Agent 会话 · 可访问本机文件与网络' : 'Agent 会话 · 可修改所选工作区' : '只读会话 · 不修改工作区或外部系统' }}</span>
        <div class="composer-actions">
          <el-button v-if="running && (automatic || !hasContent)" type="danger" :disabled="!!changing || stopping" :loading="changing === stoppableRunId || stopping" @click="emit('stop')"><CircleStop :size="14" /> {{ automatic ? stopping ? '正在暂停' : '暂停' : '中断' }}</el-button>
          <template v-if="!running || hasContent"><el-button v-if="!automatic && !switchingProvider && running && canInsertCurrent" :disabled="!canSend" :loading="!!changing" @click="submit('next')">插入</el-button><el-button type="primary" :disabled="!canSend" :loading="!!changing" @click="submit()"><Send :size="14" /> 发送</el-button></template>
        </div>
      </div>
    </div>
  </footer>
</template>

<style scoped>
.composer-reply{grid-column:1/-1;display:flex;align-items:center;gap:12px;margin-bottom:8px;color:var(--agent-muted);font-size:12px}.composer-reply span{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.composer-inner:has(.composer-reply){grid-template-areas:"mode tools" "reply reply" "editor editor" "footer footer"}.composer-reply{grid-area:reply}
.composer-mode.collaboration-controls { display: grid; gap: 0; }
.mode-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.manual-options { display: grid; grid-template-rows: 0fr; min-width: 0; opacity: 0; visibility: hidden; transition: grid-template-rows 180ms ease, opacity 140ms ease, visibility 180ms; }
.manual-options.expanded { grid-template-rows: 1fr; opacity: 1; visibility: visible; }
.manual-options-inner { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-height: 0; overflow: hidden; }
.manual-options.expanded .manual-options-inner { padding-top: 8px; }
@media (max-width: 760px) {
  .composer .composer-inner .composer-mode.collaboration-controls { display: grid; max-height: none; overflow: visible; }
  .composer .composer-inner:not(.options-expanded) .manual-options { display: none; }
}
@media (prefers-reduced-motion: reduce) { .manual-options { transition: none; } }
.mobile-composer-options{display:none}
.composer-provider{width:112px;flex-shrink:0}
.composer{position:relative;padding:12px clamp(26px,4.2vw,64px) 18px;border-top:1px solid #252d3b;background:linear-gradient(180deg,#11151de8,#10131a)}.composer::before{position:absolute;content:"";left:12%;right:12%;top:-28px;height:28px;background:linear-gradient(transparent,#10141ce8);pointer-events:none}.composer-inner{display:grid;grid-template-areas:"mode tools" "editor editor" "footer footer";grid-template-columns:minmax(0,1fr) auto;column-gap:12px;width:min(100%,980px);margin:0 auto;padding:11px 13px 12px;border:1px solid #3a4457;border-radius:14px;background:#181d27;box-shadow:0 16px 44px #0005,0 0 0 1px #ffffff05 inset}.composer-mode{grid-area:mode;display:flex;align-items:center;gap:6px;min-width:0;margin:0 0 9px}.composer-mode>span,.composer-mode>strong{display:inline-flex;align-items:center;height:30px;padding:0 9px;border:1px solid #343d4e;border-radius:7px;background:#202633;font-size:10px;font-weight:560;color:#929caf;white-space:nowrap}.composer-mode>strong{border-color:#5c56a4;background:#2b2945;color:#cdc9ff}.composer-model{width:176px}.composer-effort{width:120px}.composer-mode:deep(.el-select__wrapper){min-height:30px;padding:2px 9px;border:1px solid #514d8b;border-radius:7px;background:#24243a;box-shadow:none}.composer-mode:deep(.el-select__wrapper:hover){border-color:#746bd0}.composer-mode:deep(.el-select__selected-item){font-size:10px;color:#d0cdff}.composer-mode:deep(.el-button){width:30px;height:30px;padding:0;border:1px solid #343d4e;border-radius:7px;color:#b2adff}.composer-mode:deep(.el-button:hover){border-color:#57538a;background:#2c2947}.composer-prompt{display:contents}.composer-prompt:deep(.prompt-tools){grid-area:tools;justify-content:flex-end;align-self:start;gap:4px;margin:0 0 9px}.composer-prompt:deep(.prompt-tools .el-button){height:30px;padding:4px 9px;border:1px solid transparent;border-radius:7px;font-size:10px}.composer-prompt:deep(.prompt-tools .el-button:hover){border-color:#3d4658}.composer-prompt:deep(.prompt-tools .el-button.active){border-color:#5c56a4}.composer-prompt:deep(.tool-divider){height:18px;margin:0 2px}.composer-prompt:deep(.editor-body){grid-area:editor;min-width:0}.composer-footer{grid-area:footer;display:flex;align-items:center;justify-content:space-between;gap:12px;margin:9px 0 0}.composer-footer span{font-size:9px;color:var(--agent-muted)}.composer-actions{display:flex;align-items:center;gap:8px}.composer-footer:deep(.el-button--primary){min-width:88px;height:34px;border:1px solid #9689ff33;border-radius:8px;background:linear-gradient(115deg,#5c62eb,#7b45e9);box-shadow:0 8px 20px #654fe63b}.composer-footer:deep(.el-button--primary:not(.is-disabled):hover){filter:brightness(1.1)}
@media(max-width:1240px){.composer-inner{grid-template-areas:"mode" "tools" "editor" "footer";grid-template-columns:minmax(0,1fr)}.composer-mode{flex-wrap:wrap}.composer-prompt:deep(.prompt-tools){justify-content:flex-start}}
@media(max-width:1600px){.composer{padding:12px 18px 16px}.composer-inner{grid-template-areas:"mode" "tools" "editor" "footer";grid-template-columns:minmax(0,1fr)}.composer-mode{flex-wrap:wrap}.composer-model{flex:1 0 150px}.composer-effort{flex:0 0 120px}.composer-prompt:deep(.prompt-tools){justify-content:flex-start}.composer-footer{flex-wrap:wrap}.composer-actions{margin-left:auto;flex-wrap:wrap}}
</style>
