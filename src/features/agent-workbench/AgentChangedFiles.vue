<script setup lang="ts">
/**
 * 设计说明：该组件只呈现单轮 Agent 的结构化文件变更与本地产物。
 * 打开操作通过受限后端接口交给 Cursor 或浏览器，组件不直接读取文件内容。
 */
import { FileDiff, FolderOpen, Globe2, SquareArrowOutUpRight } from '@lucide/vue';
import { ElMessage } from 'element-plus';
import type { AgentChangedFile } from '../../../shared/agent-runtime';

const props = defineProps<{ files: AgentChangedFile[]; runId: string }>();

const labels: Record<AgentChangedFile['status'], string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
  renamed: '重命名',
  generated: '生成',
};

const canOpenInBrowser = (file: AgentChangedFile) => file.status !== 'deleted' && /\.(?:html?|svg)$/i.test(file.path);

async function requestFileAction(file: AgentChangedFile, action: 'open-file' | 'reveal-file' | 'open-browser') {
  if (file.status === 'deleted') return;
  try {
    const response = await fetch(`/api/agent-runtimes/runs/${props.runId}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' },
      body: JSON.stringify({ path: file.path }),
    });
    const result = await response.json() as { message?: string };
    if (action === 'open-browser' && response.status === 404 && result.message === 'Agent 执行接口不存在') {
      throw new Error('浏览器预览接口尚未生效，请在 Agent 任务结束后重启 Delivery Workspace');
    }
    if (!response.ok) throw new Error(result.message || '打开文件失败');
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '打开文件失败'); }
}

const openInCursor = (file: AgentChangedFile) => requestFileAction(file, 'open-file');
const revealInFolder = (file: AgentChangedFile) => requestFileAction(file, 'reveal-file');
const openInBrowser = (file: AgentChangedFile) => requestFileAction(file, 'open-browser');
</script>

<template>
  <section class="changed-files" aria-label="本轮改动文件">
    <header><FileDiff :size="13" /><strong>本轮改动 / 生成文件</strong><span>{{ files.length }}</span></header>
    <div v-if="files.length" class="changed-file-list">
      <div v-for="file in files" :key="`${file.status}:${file.path}`" class="changed-file-row">
        <button type="button" class="changed-file-open" :disabled="file.status === 'deleted'"
          :title="file.status === 'deleted' ? '文件已删除' : `在 Cursor 中打开 ${file.path}`" @click="openInCursor(file)">
          <span :class="file.status">{{ labels[file.status] }}</span><code>{{ file.path }}</code><SquareArrowOutUpRight v-if="file.status !== 'deleted'" :size="11" />
        </button>
        <div class="changed-file-actions">
          <button v-if="canOpenInBrowser(file)" type="button" class="changed-file-action" :title="`在浏览器中打开 ${file.path}`"
            :aria-label="`在浏览器中打开 ${file.path}`" @click="openInBrowser(file)"><Globe2 :size="12" /></button>
          <button type="button" class="changed-file-action" :disabled="file.status === 'deleted'" :title="`在文件夹中显示 ${file.path}`"
            :aria-label="`在文件夹中显示 ${file.path}`" @click="revealInFolder(file)"><FolderOpen :size="12" /></button>
        </div>
      </div>
    </div>
    <small v-else>未检测到工作区改动或本地文件产物</small>
  </section>
</template>

<style scoped>
.changed-files{margin-top:13px;padding:10px 11px;border:1px solid color-mix(in srgb,var(--agent-border) 78%,transparent);border-radius:8px;background:color-mix(in srgb,var(--agent-bg) 38%,transparent)}
.changed-files header{display:flex;align-items:center;gap:6px;color:var(--agent-secondary)}.changed-files header strong{font-size:9px;font-weight:650}.changed-files header span{margin-left:auto;color:var(--agent-muted);font:8px var(--mono)}
.changed-file-list{display:grid;gap:5px;max-height:180px;margin-top:8px;overflow:auto}.changed-file-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:2px;border-radius:5px}.changed-file-row:hover{background:color-mix(in srgb,var(--agent-accent) 10%,transparent)}.changed-file-open{display:grid;grid-template-columns:38px minmax(0,1fr) 14px;align-items:center;gap:8px;min-height:24px;padding:2px 4px;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer}.changed-file-open:disabled,.changed-file-action:disabled{cursor:default;opacity:.7}.changed-file-open>span{font-size:8px}.changed-file-open>span.added{color:#69ddb2}.changed-file-open>span.modified,.changed-file-open>span.renamed{color:#e9bd72}.changed-file-open>span.deleted{color:#ff9aac}.changed-file-open>span.generated{color:#83c7ff}
.changed-file-open code{overflow:hidden;color:var(--agent-text);font:9px/1.5 var(--mono);text-overflow:ellipsis;white-space:nowrap}.changed-file-open svg,.changed-file-action{color:var(--agent-muted)}.changed-file-actions{display:flex;align-items:center;gap:2px}.changed-file-action{display:grid;width:24px;height:24px;padding:0;border:0;border-radius:4px;background:transparent;cursor:pointer;place-items:center}.changed-file-action:hover{color:var(--agent-text);background:color-mix(in srgb,var(--agent-accent) 14%,transparent)}.changed-files>small{display:block;margin-top:7px;color:var(--agent-muted);font-size:8px}
</style>
