<script setup lang="ts">
/**
 * 设计说明：新会话采用与 Codex 一致的“先进入空白会话，再在输入区切换上下文”模式。
 * 项目与分支为可选上下文；未选项目时由服务端创建独立会话目录，不默认绑定最近项目。
 */
import { computed, shallowRef, useTemplateRef, watch } from 'vue';
import { ChevronDown, GitBranch, Send, Settings2, Terminal } from '@lucide/vue';
import { ElMessage } from 'element-plus';
import type { AgentAccessMode, AgentAttachment, AgentProvider, AgentReasoningEffort, AgentRunMode, AgentRuntimeHealth, AgentServiceTier, AgentWorkspaceBranches } from '../../../shared/agent-runtime';
import AgentAccessSelector from './AgentAccessSelector.vue';
import AgentModelSpeed from './AgentModelSpeed.vue';
import AgentPromptEditor from './AgentPromptEditor.vue';
import AgentWorkspaceSelector from './AgentWorkspaceSelector.vue';
import { useAgentModelSelection } from './model-selection';
import { workspacePathLabel, type AgentWorkspaceOption } from './workspace-catalog';
import type { AgentBusinessMention } from './agent-business-context';
import type { AgentAttachmentDraft } from './useAgentAttachments';

export type { AgentWorkspaceOption };

const props = defineProps<{ runtimes: AgentRuntimeHealth[]; workspaces: AgentWorkspaceOption[]; changing: string; canStart: boolean;
  businessOptions: AgentBusinessMention[]; attachmentDraft?: AgentAttachmentDraft }>();
const provider = defineModel<AgentProvider>('provider', { required: true });
const mode = defineModel<AgentRunMode>('mode', { required: true });
const accessMode = defineModel<AgentAccessMode>('accessMode', { required: true });
const model = defineModel<string>('model', { required: true });
const serviceTier = defineModel<AgentServiceTier | undefined>('serviceTier', { required: true });
const reasoningEffort = defineModel<AgentReasoningEffort | ''>('reasoningEffort', { required: true });
const objective = defineModel<string>('objective', { required: true });
const attachments = defineModel<AgentAttachment[]>('attachments', { required: true });
const workspacePath = defineModel<string>('workspacePath', { required: true });
const workspacePaths = defineModel<string[]>('workspacePaths', { default: () => [] });
const branch = defineModel<string>('branch', { required: true });
const emit = defineEmits<{ send: []; chooseWorkspace: []; configureModels: [] }>();
const promptEditor = useTemplateRef<InstanceType<typeof AgentPromptEditor>>('promptEditor');
const branchOptions = shallowRef<string[]>([]);
const branchesLoading = shallowRef(false);
const runtime = computed(() => props.runtimes.find((item) => item.provider === provider.value));
const modelPicker = useAgentModelSelection(() => runtime.value, model, reasoningEffort);
const currentWorkspace = computed(() => props.workspaces.find((item) => item.path === workspacePath.value));
const workspaceLabel = computed(() => currentWorkspace.value?.label || (workspacePath.value ? workspacePathLabel(workspacePath.value) : '不选择项目'));
const effortLabels: Record<AgentReasoningEffort, string> = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '极高', ultra: '最高' };
const modeLabel = computed(() => mode.value === 'agent' ? 'Agent 模式' : mode.value === 'plan' ? 'Plan 模式' : 'Ask 模式');

watch(mode, (value) => { if (value !== 'agent') accessMode.value = 'workspace'; });
// 执行器切换仅收紧权限；完全访问需要用户再次明确选择。
watch(() => runtime.value?.accessModes, modes => {
  if (modes && !modes.includes(accessMode.value)) accessMode.value = 'workspace';
});
watch(() => workspacePath.value, async (nextPath, _previousPath, onCleanup) => {
  branchOptions.value = [];
  branch.value = '';
  if (!nextPath) { branchesLoading.value = false; return; }
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  branchesLoading.value = true;
  try {
    const params = new URLSearchParams({ workspacePath: nextPath });
    const response = await fetch(`/api/agent-runtimes/branches?${params}`, { signal: controller.signal });
    const result = await response.json() as AgentWorkspaceBranches & { message?: string };
    if (controller.signal.aborted || workspacePath.value !== nextPath) return;
    if (!response.ok) throw new Error(result.message || '分支列表读取失败');
    branchOptions.value = result.branches;
    branch.value = result.current || (result.branches.includes(branch.value) ? branch.value : result.branches[0] || '');
  } catch (error) {
    if (!controller.signal.aborted) ElMessage.error(error instanceof Error ? error.message : '分支列表读取失败');
  } finally {
    if (!controller.signal.aborted) branchesLoading.value = false;
  }
}, { immediate: true });

function submit() {
  if (props.canStart && !props.attachmentDraft?.pending && !branchesLoading.value) emit('send');
}

function focusPrompt() { void promptEditor.value?.focusInput(); }

defineExpose({ focusPrompt });
</script>

<template>
  <section class="new-conversation" aria-label="新建 Agent 会话">
    <div class="new-compose-canvas">
      <header class="new-header"><span>Agent Studio</span><strong>新会话</strong><div class="new-header-actions"><slot name="header-actions" /></div></header>
      <div class="new-compose-stage">
        <div class="new-empty">
          <span class="new-mark" aria-hidden="true"><Terminal :size="24" /></span>
          <h1 v-if="workspacePaths.length > 1">想让我在 <em>{{ workspaceLabel }}</em> 等 {{ workspacePaths.length }} 个项目中完成什么？</h1>
          <h1 v-else-if="workspacePath">想让我在 <em>{{ workspaceLabel }}</em> 中完成什么？</h1>
          <h1 v-else>想让我帮你完成什么？</h1>
        </div>
        <section class="new-composer" aria-label="会话编辑区">
          <div class="new-context-panel" role="group" aria-label="项目、分支和访问权限">
            <div class="new-project">
              <AgentWorkspaceSelector
                v-model:workspace-path="workspacePath"
                v-model:workspace-paths="workspacePaths"
                v-model:branch="branch"
                :workspaces="workspaces"
                :disabled="!!changing"
                @choose-workspace="emit('chooseWorkspace')"
              />
              <label v-if="workspacePath && (branchesLoading || branchOptions.length)" class="new-branch">
                <GitBranch :size="13" />
                <select v-model="branch" aria-label="切换分支" :disabled="branchesLoading || !!changing">
                  <option v-if="branchesLoading" value="">读取分支…</option>
                  <option v-for="item in branchOptions" :key="item" :value="item">{{ item }}</option>
                </select>
                <ChevronDown :size="12" />
              </label>
            </div>
            <div class="new-access"><AgentAccessSelector v-model="accessMode" :mode="mode" :provider="provider" :access-modes="runtime?.accessModes" :disabled="!!changing" /></div>
          </div>
          <AgentPromptEditor ref="promptEditor" v-model="objective" v-model:attachments="attachments" class="new-prompt" :workspace-path="workspacePath" :provider="provider" :modes="runtime?.modes || []"
            :attachment-draft="attachmentDraft"
            :selected-mode="mode" :business-options="businessOptions" :disabled="!!changing" :placeholder="'随心输入，输入 @ 可选择 Jira、项目、接口、模式、Skill 或文件…'" submit-on-enter
            @select-mode="mode = $event" @submit="submit" />
          <div class="composer-actions">
            <div class="composer-mode">
              <span class="manual-mode-label">{{ modeLabel }}</span>
              <el-select v-model="provider" class="composer-provider" popper-class="agent-model-popper" size="small" :disabled="changing === 'start'" aria-label="选择执行器">
                <el-option v-for="item in runtimes" :key="item.provider" :value="item.provider" :label="item.label" :disabled="!item.ready || !item.modes.length" />
              </el-select>
              <el-select v-model="modelPicker.model.value" class="composer-model" popper-class="agent-model-popper" size="small" filterable :disabled="changing === 'start'" :empty-values="[null, undefined]" aria-label="选择模型"><el-option v-for="item in modelPicker.models.value" :key="item.id || 'default'" :label="item.label" :value="item.id"><span>{{ item.label }}</span><small v-if="item.customId">自定义</small></el-option></el-select>
              <el-select v-if="modelPicker.efforts.value.length" v-model="modelPicker.effort.value" class="composer-effort" popper-class="agent-model-popper" size="small" :disabled="changing === 'start'" :empty-values="[null, undefined]" :aria-label="`${runtime?.label || '模型'} 推理强度`"><el-option v-if="modelPicker.allowDefaultEffort.value" label="Thinking 默认" value="" /><el-option v-for="effort in modelPicker.efforts.value" :key="effort" :label="`Thinking ${effortLabels[effort]}`" :value="effort" /></el-select>
              <AgentModelSpeed v-model:service-tier="serviceTier" :runtime="runtime" :model="model" />
              <el-button text size="small" aria-label="管理自定义模型" @click="emit('configureModels')"><Settings2 :size="13" /></el-button>
            </div>
            <el-button class="send-button" type="primary" :disabled="!canStart || attachmentDraft?.pending || branchesLoading" :loading="changing === 'start'" aria-label="创建并发送" @click="submit"><template #icon><Send :size="15" /></template>发送</el-button>
          </div>
        </section>
      </div>
    </div>
  </section>
</template>

<style scoped>
.new-conversation { min-width: 0; min-height: 0; height: 100%; color: var(--ui-text); }
.new-branch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: min(100%, 340px);
  height: 32px;
  padding-inline: 9px;
  border: 1px solid var(--chat-rule);
  border-radius: 8px;
  background: var(--chat-panel);
  color: var(--ui-secondary);
  font-size: 12px;
}
.new-branch:hover, .new-branch:focus-within { border-color: var(--ui-accent); }
.new-branch svg { flex-shrink: 0; }
.new-branch select { min-width: 0; max-width: 100%; appearance: none; border: 0; outline: 0; background: transparent; color: inherit; font: inherit; text-overflow: ellipsis; }
.new-branch select:not(:disabled) { cursor: pointer; }
</style>
