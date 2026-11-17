<script setup lang="ts">
/**
 * 从原工作区启动独立会话时，收集首条消息、附件和执行模式。
 * 附件上传复用统一消息编辑器，会话分叉与附件清理仍由上层容器负责。
 */
import { computed, nextTick, shallowRef, useTemplateRef } from 'vue';
import type { AgentAttachment, AgentRun, AgentRunMode } from '../../../shared/agent-runtime';
import AgentPromptEditor from './AgentPromptEditor.vue';
import type { AgentAttachmentDraft } from './useAgentAttachments';

const props = defineProps<{ open: boolean; source?: AgentRun; submitting: boolean; inSide?: boolean; attachmentDraft?: AgentAttachmentDraft }>();
const objective = defineModel<string>('objective', { required: true });
const attachments = defineModel<AgentAttachment[]>('attachments', { required: true });
const emit = defineEmits<{ submit: [mode?: AgentRunMode]; cancel: [] }>();
const mode = shallowRef<AgentRunMode | ''>('');
const editorMode = computed(() => mode.value || props.source?.mode || 'agent');
const promptEditor = useTemplateRef<InstanceType<typeof AgentPromptEditor>>('promptEditor');
const canSubmit = computed(() => (!!objective.value.trim() || !!attachments.value.length) && !props.attachmentDraft?.pending);

async function focusPrompt() {
  await nextTick();
  promptEditor.value?.focusInput();
}

function submit() {
  if (canSubmit.value && !props.submitting) emit('submit', mode.value || undefined);
}
</script>

<template>
  <el-dialog :model-value="open" :title="inSide ? '在侧边新建继承会话' : '基于此会话新建'" width="min(600px, 92vw)" class="agent-fork-dialog"
    :close-on-click-modal="false" :close-on-press-escape="!submitting" :show-close="!submitting"
    @opened="focusPrompt" @update:model-value="!$event && emit('cancel')">
    <p class="fork-description">新会话与原会话共用工作区，有已完成的轮次时会继承其上下文。</p>
    <label class="fork-mode">
      <span>执行模式</span>
      <el-select v-model="mode" size="small" aria-label="新会话执行模式" :empty-values="[null, undefined]" :disabled="submitting">
        <el-option value="" label="自动（同目录写入中时只读）" />
        <el-option value="ask" label="只读分析" />
        <el-option value="plan" label="先出方案" />
        <el-option value="agent" label="Agent（同目录写入中时排队）" />
      </el-select>
    </label>
    <AgentPromptEditor v-if="source" ref="promptEditor" v-model="objective" v-model:attachments="attachments"
      :attachment-draft="attachmentDraft"
      :workspace-path="source.workspacePath" provider="codex" :modes="[editorMode]" :selected-mode="editorMode" mode-locked
      :disabled="submitting" placeholder="输入新会话的第一条消息，或直接粘贴图片" :min-rows="3" :max-rows="8" submit-on-enter @submit="submit" />
    <template #footer>
      <el-button :disabled="submitting" @click="emit('cancel')">取消</el-button>
      <el-button type="primary" :disabled="!canSubmit" :loading="submitting" @click="submit">创建并发送</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.fork-description{margin:0 0 14px;color:var(--el-text-color-secondary);font-size:12px;line-height:1.6}
.fork-mode{display:flex;align-items:center;gap:8px;margin-bottom:12px;color:var(--el-text-color-secondary);font-size:12px}
.fork-mode :deep(.el-select){width:230px}
</style>
