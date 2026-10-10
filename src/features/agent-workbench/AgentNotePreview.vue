<script setup lang="ts">
/** 预览仅展示显式选择的笔记，确认引用才更新消息；复用安全 Markdown 渲染，不执行笔记 HTML。 */
import { shallowRef, watch } from 'vue';
import { ElMessage } from 'element-plus';
import type { AgentNoteContent } from '../../../shared/agent-notes';
import AgentMarkdown from './AgentMarkdown.vue';
import { noteRequest } from './useAgentNotes';

const reference = defineModel<string>({ default: '' });
const emit = defineEmits<{ cite: [reference: string] }>();
const note = shallowRef<AgentNoteContent>();
const loading = shallowRef(false);
watch(reference, async (value, _old, onCleanup) => {
  note.value = undefined;
  loading.value = false;
  if (!value) return;
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  loading.value = true;
  try { note.value = await noteRequest<AgentNoteContent>(`note?reference=${encodeURIComponent(value)}`, undefined, controller.signal); }
  catch (error) { if (!controller.signal.aborted) ElMessage.error(error instanceof Error ? error.message : String(error)); }
  finally { if (!controller.signal.aborted) loading.value = false; }
}, { immediate: true });
</script>

<template>
  <el-dialog :model-value="!!reference" title="笔记预览" width="min(760px, 92vw)" append-to-body @update:model-value="!$event && (reference = '')">
    <el-skeleton v-if="loading" :rows="6" animated />
    <template v-else-if="note">
      <p>{{ note.path }}</p>
      <div class="note-preview"><AgentMarkdown :source="note.content" /></div>
    </template>
    <template #footer><el-button @click="reference = ''">关闭</el-button><el-button type="primary" :disabled="!note" @click="emit('cite', reference); reference = ''">引用到输入框</el-button></template>
  </el-dialog>
</template>

<style scoped>
.note-preview{max-height:55vh;overflow:auto;padding:16px;border-radius:8px;background:var(--agent-bg,#171b24);color:var(--agent-text,#eef0f7)}
</style>
