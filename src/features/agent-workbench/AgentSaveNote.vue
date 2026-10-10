<script setup lang="ts">
/** 保存从选定的已完成回复生成草稿，先编辑、预览新增差异再新建文件；不保存整段运行日志，不覆盖笔记。 */
import { computed, shallowRef } from 'vue';
import { ElMessage } from 'element-plus';
import type { AgentConversation } from './conversation';
import AgentMarkdown from './AgentMarkdown.vue';
import { noteRequest } from './useAgentNotes';

const props = defineProps<{ conversation?: AgentConversation; vaultPath: string; vaultId: string }>();
const emit = defineEmits<{ saved: [] }>();
const open = shallowRef(false);
const filename = shallowRef('');
const content = shallowRef('');
const selectedRun = shallowRef('');
const preview = shallowRef(false);
const saving = shallowRef(false);
const loadingFolders = shallowRef(false);
const foldersReady = shallowRef(false);
const folders = shallowRef<string[]>([]);
const folder = shallowRef('');
const results = computed(() => props.conversation?.runs.filter(run => run.status === 'completed' && run.result.trim()) || []);
const snapshot = shallowRef(results.value);
const sourceTitle = shallowRef('');
const sourceId = shallowRef('');
const destination = shallowRef({ path: '', id: '' });

function selectResult(id: string) {
  const run = snapshot.value.find(item => item.id === id);
  if (!run) return;
  content.value = `# ${sourceTitle.value}\n\n${run.result}\n\n---\n来源会话：${sourceId.value}\n工作区：${run.workspacePath}\n分支：${run.branch || '无'}\n记录时间：${run.updatedAt}\n`;
  preview.value = false;
}
async function start() {
  if (loadingFolders.value) return;
  snapshot.value = [...results.value];
  const run = snapshot.value.at(-1);
  if (!run || !props.conversation) return;
  sourceTitle.value = props.conversation.title.replace(/\s+/g, ' ').slice(0, 80);
  sourceId.value = props.conversation.id;
  destination.value = { path: props.vaultPath, id: props.vaultId };
  filename.value = `${sourceTitle.value.replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/^\.+/, '').slice(0, 60) || '会话结论'}.md`;
  selectedRun.value = run.id;
  selectResult(run.id);
  open.value = true;
  foldersReady.value = false;
  loadingFolders.value = true;
  folders.value = [];
  folder.value = '';
  try {
    const value = await noteRequest<{ vaultId: string; folders: string[] }>('folders');
    if (value.vaultId !== destination.value.id) throw new Error('笔记库已切换，请重新打开保存窗口');
    folders.value = value.folders;
    folder.value = value.folders.includes('收件箱') ? '收件箱' : '';
    foldersReady.value = value.folders.includes(folder.value);
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); }
  finally { loadingFolders.value = false; }
}
async function save() {
  if (!foldersReady.value || saving.value) return;
  saving.value = true;
  try {
    await noteRequest('notes', { filename: filename.value, content: content.value, vaultId: destination.value.id, folder: folder.value });
    open.value = false;
    emit('saved');
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); }
  finally { saving.value = false; }
}
</script>

<template>
  <el-button size="small" :disabled="!vaultPath || !results.length || loadingFolders" @click="start">保存会话结果</el-button>
  <el-dialog v-model="open" title="保存到知识库" width="min(800px, 92vw)" append-to-body :close-on-click-modal="!saving" :show-close="!saving">
    <el-form label-position="top" :disabled="saving">
      <el-form-item label="回复"><el-select v-model="selectedRun" @change="selectResult"><el-option v-for="(run, index) in snapshot" :key="run.id" :label="`${index + 1}. ${run.objective.slice(0, 80)}`" :value="run.id" /></el-select></el-form-item>
      <el-form-item label="保存目录"><el-select v-model="folder" filterable :loading="loadingFolders" :disabled="!foldersReady" @change="preview = false"><el-option v-for="item in folders" :key="item" :label="item || '笔记库根目录'" :value="item" /></el-select></el-form-item>
      <el-form-item label="新笔记文件名"><el-input v-model="filename" @input="preview = false" /></el-form-item>
      <p class="destination">{{ destination.path }}/{{ folder ? `${folder}/` : '' }}{{ filename }}</p>
      <el-input v-if="!preview" v-model="content" type="textarea" :rows="12" placeholder="整理已验证的结论、依据和待办" />
      <div v-else class="save-preview">
        <AgentMarkdown :source="content" />
        <details><summary>新增内容（+{{ content.split('\n').length }} 行，不覆盖已有文件）</summary><pre>{{ content.split('\n').map(line => `+ ${line}`).join('\n') }}</pre></details>
      </div>
    </el-form>
    <template #footer>
      <el-button :disabled="saving" @click="open = false">取消</el-button>
      <el-button v-if="preview" :disabled="saving" @click="preview = false">返回编辑</el-button>
      <el-button v-if="!preview" type="primary" :disabled="!foldersReady || !filename.trim() || !content.trim()" @click="preview = true">预览新增内容</el-button>
      <el-button v-else type="primary" :loading="saving" @click="save">确认新建笔记</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.destination{overflow-wrap:anywhere;font-size:12px}.save-preview{max-height:55vh;overflow:auto;padding:16px;border-radius:8px;background:var(--agent-bg,#171b24);color:var(--agent-text,#eef0f7)}.save-preview details{margin-top:18px}.save-preview pre{white-space:pre-wrap;color:#86d9af}
</style>
