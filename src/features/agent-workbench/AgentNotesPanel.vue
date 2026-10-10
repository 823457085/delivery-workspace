<script setup lang="ts">
/** 笔记库面板仅负责绑定、搜索和选择；预览与保存独立组件，保留原代码知识检索入口。 */
import { shallowRef, watch } from 'vue';
import { ElMessage } from 'element-plus';
import type { AgentConversation } from './conversation';
import AgentNotePreview from './AgentNotePreview.vue';
import AgentSaveNote from './AgentSaveNote.vue';
import { useAgentNotes } from './useAgentNotes';

defineProps<{ conversation?: AgentConversation }>();
const emit = defineEmits<{ compose: [prompt: string] }>();
const notes = useAgentNotes();
const path = shallowRef('');
const configuring = shallowRef(false);
const reference = shallowRef('');
watch(() => notes.config.data.value?.path, value => { path.value = value || ''; }, { immediate: true });
watch(() => notes.notes.error.value || notes.config.error.value, error => { if (error) ElMessage.error(error.message); });

async function configure(value: string) {
  configuring.value = true;
  try { await notes.configure(value); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); }
  finally { configuring.value = false; }
}
async function chooseFolder() {
  configuring.value = true;
  try {
    const response = await fetch('/api/workspace/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '选择目录失败');
    if (!data.cancelled) path.value = data.workspacePath;
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); }
  finally { configuring.value = false; }
}
</script>

<template>
  <section class="notes-panel" aria-label="Obsidian 笔记库">
    <h3>Obsidian 笔记</h3>
    <details :open="!notes.config.data.value?.path">
      <summary>{{ notes.config.data.value?.path || '绑定笔记目录' }}</summary>
      <el-select v-model="path" filterable allow-create default-first-option placeholder="选择已有库或输入目录" :disabled="configuring">
        <el-option v-for="candidate in notes.config.data.value?.candidates || []" :key="candidate" :label="candidate" :value="candidate" />
      </el-select>
      <div class="note-actions"><el-button size="small" :disabled="configuring" @click="chooseFolder">选择文件夹</el-button><el-button size="small" :loading="configuring" :disabled="!path" @click="configure(path)">绑定</el-button><el-button v-if="notes.config.data.value?.path" text size="small" :disabled="configuring" @click="configure('')">解除绑定</el-button></div>
      <p class="scope">仅检索选定目录的 Markdown；引用内容随消息交给所选模型。</p>
    </details>
    <template v-if="notes.config.data.value?.path">
      <el-input v-model="notes.search.value" clearable placeholder="搜索笔记标题、路径或正文" maxlength="200" />
      <div class="note-actions"><AgentSaveNote :conversation="conversation" :vault-path="notes.config.data.value.path" :vault-id="notes.config.data.value.id" @saved="notes.saved" /></div>
      <el-skeleton v-if="notes.notes.isFetching.value" :rows="3" animated />
      <div v-else class="note-results">
        <button v-for="note in notes.notes.data.value?.notes || []" :key="note.reference" class="note-result" type="button" @click="reference = note.reference">
          <strong>{{ note.title }}</strong><small>{{ note.path }}</small><span>{{ note.excerpt }}</span>
        </button>
        <el-empty v-if="!notes.notes.data.value?.notes.length" description="没有匹配笔记" :image-size="48" />
        <small v-if="notes.notes.data.value?.truncated">结果已截断，可增加关键词缩小范围。</small>
      </div>
    </template>
    <AgentNotePreview v-model="reference" @cite="emit('compose', `@${$event} `)" />
  </section>
</template>

<style scoped>
.notes-panel{--el-fill-color-blank:var(--agent-bg);--el-text-color-regular:var(--agent-text);--el-text-color-placeholder:var(--agent-muted);--el-border-color:var(--agent-border);--el-color-primary:var(--agent-accent)}
.notes-panel{padding-bottom:18px;margin-bottom:16px;border-bottom:1px solid var(--agent-border)}.notes-panel h3{margin:0 0 10px;font-size:14px}.notes-panel details{margin-bottom:12px}.notes-panel summary{cursor:pointer;font-size:12px;overflow-wrap:anywhere;margin-bottom:8px;color:var(--agent-secondary)}.notes-panel :deep(.el-select){width:100%}.note-actions{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}.note-actions :deep(.el-button+.el-button){margin-left:0}.scope{font-size:12px;line-height:1.6;color:var(--agent-muted)}.note-results{max-height:420px;overflow-y:auto}.note-result{display:grid;gap:4px;width:100%;padding:10px;margin:6px 0;text-align:left;border:1px solid var(--agent-border);border-radius:8px;background:var(--agent-panel-strong);color:var(--agent-text);cursor:pointer}.note-result:hover{border-color:var(--agent-accent)}.note-result strong{font-size:13px}.note-result small{color:var(--agent-muted);overflow-wrap:anywhere}.note-result span{font-size:12px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
</style>
