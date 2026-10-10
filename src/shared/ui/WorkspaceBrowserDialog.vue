<script setup lang="ts">
/** 共享远端目录选择 UI：服务端负责目录边界与分支，选中后只向调用表单回填，不执行任务。 */
import { computed, shallowRef, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { ArrowUp, File, Folder } from '@lucide/vue';
import type { WorkspaceDirectoryListing, WorkspaceSelection } from '../../../shared/workspace-selection';

const props = defineProps<{ open: boolean; initialPath?: string }>();
const emit = defineEmits<{ select: [selection: WorkspaceSelection]; cancel: [] }>();
const location = shallowRef('');
const pathInput = shallowRef('');
const selecting = shallowRef(false);
watch(() => props.open, open => { if (open) { location.value = props.initialPath || ''; pathInput.value = location.value; } }, { immediate: true });
const query = useQuery({ queryKey: computed(() => ['workspace-directories', location.value]), enabled: () => props.open,
  retry: false, staleTime: 0, queryFn: async ({ signal }): Promise<WorkspaceDirectoryListing> => {
    const response = await fetch('/api/workspace/browse', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: location.value }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '读取目录失败');
    return data;
  } });
const directory = query.data;
watch(directory, value => { if (value) pathInput.value = value.path; });
watch(query.error, error => { if (error) ElMessage.error(error.message); });
function browse(value: string) { location.value = value; pathInput.value = value; }
async function select() {
  if (!directory.value || query.isFetching.value || query.isError.value || selecting.value || pathInput.value !== directory.value.path) return;
  selecting.value = true;
  try {
    const response = await fetch('/api/workspace/select-directory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: directory.value.path }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '选择目录失败');
    emit('select', data as WorkspaceSelection);
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '选择目录失败'); }
  finally { selecting.value = false; }
}
</script>

<template>
  <el-dialog :model-value="open" title="选择运行 Delivery 的电脑上的文件夹" width="min(680px, 94vw)" append-to-body destroy-on-close
    :close-on-click-modal="false" :show-close="!selecting" :close-on-press-escape="!selecting" @close="emit('cancel')">
    <div class="directory-toolbar">
      <el-button :disabled="!directory?.parent || query.isFetching.value || selecting" aria-label="上一级目录" @click="browse(directory!.parent!)"><ArrowUp :size="16" /></el-button>
      <el-input v-model="pathInput" aria-label="电脑上的目录路径" placeholder="输入这台电脑的目录路径" :disabled="selecting" @keyup.enter="browse(pathInput.trim())" />
      <el-button :disabled="selecting" @click="browse(pathInput.trim())">打开</el-button>
    </div>
    <div v-loading="query.isFetching.value" class="directory-list">
      <template v-if="!query.isError.value">
        <button v-for="entry in directory?.entries || []" :key="entry.path" type="button" class="directory-entry" :disabled="entry.kind !== 'directory' || selecting"
          @click="browse(entry.path)"><Folder v-if="entry.kind === 'directory'" :size="17" /><File v-else :size="17" /><span>{{ entry.name }}</span></button>
        <el-empty v-if="directory && !directory.entries.length && !query.isFetching.value" description="此文件夹为空" :image-size="56" />
      </template>
    </div>
    <p class="directory-hint">{{ directory?.truncated ? '当前显示前 500 项，可输入完整目录路径打开。' : '仅选择当前用户目录内的文件夹；不会上传文件或启动任务。' }}</p>
    <template #footer><el-button :disabled="selecting" @click="emit('cancel')">取消</el-button><el-button type="primary" :loading="selecting"
      :disabled="!directory || query.isFetching.value || query.isError.value || pathInput !== directory.path" @click="select">选择此文件夹</el-button></template>
  </el-dialog>
</template>

<style scoped>
.directory-toolbar{display:flex;gap:8px;align-items:center;margin-bottom:12px}.directory-list{min-height:160px;max-height:45vh;overflow:auto}.directory-entry{display:flex;align-items:center;gap:10px;width:100%;padding:10px;border:0;border-radius:5px;background:transparent;color:var(--el-text-color-primary);text-align:left;cursor:pointer}.directory-entry:not(:disabled):hover{background:var(--el-fill-color-light)}.directory-entry:disabled{color:var(--el-text-color-secondary);cursor:default}.directory-entry span{min-width:0;overflow-wrap:anywhere}.directory-entry svg{flex-shrink:0}.directory-hint{margin:10px 0 0;color:var(--el-text-color-secondary);font-size:12px;line-height:1.6}
</style>
