<script setup lang="ts">
/** 原生终端入口独立管理请求状态，不干扰会话发送；只传实际工作目录，不传命令。 */
import { shallowRef } from 'vue';
import { Terminal } from '@lucide/vue';
import { ElMessage } from 'element-plus';
const props = defineProps<{ workspacePath: string }>();
const opening = shallowRef(false);
async function open() {
  if (opening.value || !props.workspacePath) return;
  const workspacePath = props.workspacePath;
  opening.value = true;
  try {
    const response = await fetch('/api/workspace/terminal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspacePath }),
    });
    if (response.status === 404) throw new Error('终端接口尚未加载，请在当前任务结束后重启 Delivery 服务');
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || '打开终端失败');
    ElMessage.success(result.message);
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '打开终端失败'); }
  finally { opening.value = false; }
}
</script>

<template><el-button class="terminal-button" :loading="opening" :disabled="!workspacePath" :title="`在系统终端打开：${workspacePath}`" @click="open"><Terminal :size="14" />打开终端</el-button></template>

<style scoped>.terminal-button{flex-shrink:0;gap:5px;margin-left:0}</style>
