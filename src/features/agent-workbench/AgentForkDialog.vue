<script setup lang="ts">
/**
 * 设计说明：该弹窗只收集“基于已有会话新建”的首条消息与图片。
 * 附件上传复用统一消息编辑器，会话分叉与附件清理仍由上层容器负责。
 */
import { computed, nextTick, useTemplateRef } from 'vue';
import type { AgentAttachment, AgentRun } from '../../../shared/agent-runtime';
import AgentPromptEditor from './AgentPromptEditor.vue';
import type { AgentAttachmentDraft } from './useAgentAttachments';

const props = defineProps<{ open: boolean; source?: AgentRun; submitting: boolean; inSide?: boolean; attachmentDraft?: AgentAttachmentDraft }>();
const objective = defineModel<string>('objective', { required: true });
const attachments = defineModel<AgentAttachment[]>('attachments', { required: true });
const emit = defineEmits<{ submit: []; cancel: [] }>();
const promptEditor = useTemplateRef<InstanceType<typeof AgentPromptEditor>>('promptEditor');
const canSubmit = computed(() => (!!objective.value.trim() || !!attachments.value.length) && !props.attachmentDraft?.pending);

async function focusPrompt() {
  await nextTick();
  promptEditor.value?.focusInput();
}

function submit() {
  if (canSubmit.value && !props.submitting) emit('submit');
}
</script>

<template>
  <el-dialog :model-value="open" :title="inSide ? '在侧边新建继承会话' : '基于此会话新建'" width="min(600px, 92vw)" class="agent-fork-dialog"
    :close-on-click-modal="false" :close-on-press-escape="!submitting" :show-close="!submitting"
    @opened="focusPrompt" @update:model-value="!$event && emit('cancel')">
    <p class="fork-description">新会话会继承当前会话截至已完成轮次的上下文。分叉后，两边可以各自继续。</p>
    <AgentPromptEditor v-if="source" ref="promptEditor" v-model="objective" v-model:attachments="attachments"
      :attachment-draft="attachmentDraft"
      :workspace-path="source.workspacePath" provider="codex" :modes="[source.mode]" :selected-mode="source.mode" mode-locked
      :disabled="submitting" placeholder="输入新会话的第一条消息，或直接粘贴图片" :min-rows="3" :max-rows="8" submit-on-enter @submit="submit" />
    <template #footer>
      <el-button :disabled="submitting" @click="emit('cancel')">取消</el-button>
      <el-button type="primary" :disabled="!canSubmit" :loading="submitting" @click="submit">创建并发送</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.fork-description{margin:0 0 14px;color:var(--el-text-color-secondary);font-size:12px;line-height:1.6}
</style>
