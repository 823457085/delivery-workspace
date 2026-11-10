<script setup lang="ts">
import { shallowRef } from 'vue';
import { CodeXml } from '@lucide/vue';
import { ElMessage } from 'element-plus';

const props = defineProps<{ workspacePath: string }>();
const opening = shallowRef(false);
async function open() {
  if (opening.value || !props.workspacePath) return;
  const workspacePath = props.workspacePath;
  opening.value = true;
  try {
    const response = await fetch('/api/workspace/cursor', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspacePath }),
    });
    if (response.status === 404) throw new Error('Cursor 接口尚未加载，请在当前任务结束后重启 Delivery 服务');
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || '打开 Cursor 失败');
    ElMessage.success(result.message);
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '打开 Cursor 失败'); }
  finally { opening.value = false; }
}
</script>

<template><el-button class="cursor-button" :loading="opening" :disabled="!workspacePath" :title="`在 Cursor 中打开：${workspacePath}`" @click="open"><CodeXml :size="14" />打开 Cursor</el-button></template>

<style scoped>.cursor-button{flex-shrink:0;gap:5px;margin-left:0}</style>
