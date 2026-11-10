<script setup lang="ts">
import { shallowRef } from 'vue';
import { Copy, Download } from '@lucide/vue';
import { ElMessage } from 'element-plus';
import AgentMarkdown from './AgentMarkdown.vue';

const props = defineProps<{ title: string; content: string }>();
const open = shallowRef(false);
const draft = shallowRef({ title: '', content: '' });

function show() {
  draft.value = { title: props.title, content: props.content };
  open.value = true;
}

async function copy() {
  try {
    await navigator.clipboard.writeText(draft.value.content);
    ElMessage.success('已复制草稿');
  } catch { ElMessage.error('复制失败'); }
}

function download() {
  const url = URL.createObjectURL(new Blob([draft.value.content], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${draft.value.title.replace(/[<>:"/\\|?*]/g, '-')}.md`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
</script>

<template>
  <el-button link type="primary" @click="show">查看草稿</el-button>
  <el-dialog v-model="open" :title="draft.title" width="min(760px, calc(100vw - 32px))" align-center append-to-body destroy-on-close>
    <AgentMarkdown class="report-draft-content" :source="draft.content" />
    <template #footer>
      <el-button :icon="Copy" @click="copy">复制 Markdown</el-button>
      <el-button :icon="Download" type="primary" @click="download">下载 Markdown</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.report-draft-content{max-height:min(62dvh,600px);overflow:auto;overscroll-behavior:contain;padding-right:8px;color:var(--ui-text);font-size:14px;line-height:1.7;overflow-wrap:anywhere}
</style>
