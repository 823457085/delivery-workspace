<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { queryOptions, useQueries } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { RefreshCw } from '@lucide/vue';
import type { ProjectGitSnapshot } from '../../../server/project-git';
import AgentCodeArtifact from './AgentCodeArtifact.vue';
import { useAgentDeliveryWorkspaces, validateAgentDeliveryWorkspaces, type AgentDeliveryWorkspace } from './useAgentDeliveryWorkspaces';
import { workspacePathLabel } from './workspace-catalog';

const props = defineProps<{ paths: string[]; conversationId?: string; bound?: boolean; active?: boolean; runKey?: string; runState?: string }>();
const selection = useAgentDeliveryWorkspaces(() => props.conversationId, () => props.paths, () => props.bound);
const canManage = computed(() => Boolean(props.conversationId) && !props.bound);
const managing = shallowRef(false);
const saving = shallowRef(false);
let nextRowKey = 0;
const draft = ref<(AgentDeliveryWorkspace & { key: number })[]>([]);
async function readSnapshot(path: string, signal?: AbortSignal): Promise<ProjectGitSnapshot> {
  const response = await fetch(`/api/projects/git/snapshot?path=${encodeURIComponent(path)}`, { signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || '读取工作区 Git 状态失败');
  return data;
}
const queries = useQueries({ queries: computed(() => selection.workspaces.value.map(({ path }) => queryOptions({
  queryKey: ['agent-workspace-code', path], enabled: props.active !== false, staleTime: 15_000, retry: false,
  queryFn: ({ signal }) => readSnapshot(path, signal),
}))) });
const repositories = computed(() => [...new Map(queries.value.flatMap(({ data }) => data?.isGit
  ? [[data.directory, data] as const] : [])).values()]);
const loading = computed(() => queries.value.some(query => query.isFetching));
const failed = computed(() => queries.value.some(query => query.isError));
watch([() => props.conversationId, () => props.bound], () => { managing.value = false; });
watch([() => props.runKey, () => props.runState], ([, state]) => {
  if (state && state !== 'running' && state !== 'queued' && props.active !== false) {
    for (const query of queries.value) void query.refetch({ cancelRefetch: false });
  }
});

function repositoryUrl(project: ProjectGitSnapshot) {
  const upstream = project.remotes.filter(remote => project.upstream.startsWith(`${remote.name}/`))
    .sort((left, right) => right.name.length - left.name.length)[0];
  return (upstream || project.remotes.find(remote => remote.name === 'origin')
    || (project.remotes.length === 1 ? project.remotes[0] : undefined))?.webUrl;
}

function repositoryTitle(project: ProjectGitSnapshot) {
  return selection.workspaces.value.find(item => item.path === project.directory)?.label
    || (props.bound && props.paths.length > 1 ? workspacePathLabel(project.directory) : '代码');
}
function openManager() {
  draft.value = selection.workspaces.value.map(item => ({ ...item, key: nextRowKey++ }));
  if (!draft.value.length) addProject();
  managing.value = true;
}
function addProject() { draft.value.push({ path: '', label: '', key: nextRowKey++ }); }
async function saveProjects() {
  const id = props.conversationId;
  if (!id || saving.value) return;
  saving.value = true;
  try {
    const rows = await validateAgentDeliveryWorkspaces(draft.value, readSnapshot);
    if (props.conversationId !== id || props.bound) return;
    selection.save(id, rows);
    managing.value = false;
    ElMessage.success('交付项目已保存');
  } catch (cause) { ElMessage.error(cause instanceof Error ? cause.message : '保存交付项目失败'); }
  finally { saving.value = false; }
}
function resetProjects() {
  if (!props.conversationId) return;
  try {
    selection.reset(props.conversationId);
    managing.value = false;
    ElMessage.success('已恢复会话默认项目');
  } catch (cause) { ElMessage.error(cause instanceof Error ? cause.message : '恢复默认项目失败'); }
}
async function refresh() {
  const results = await Promise.all(queries.value.map(query => query.refetch()));
  const failure = results.find(result => result.error)?.error;
  if (failure) ElMessage.error(failure.message);
}
</script>

<template>
  <section v-if="active !== false && (conversationId || repositories.length || loading || failed)" class="workspace-code-artifacts" aria-label="工作区代码产物">
    <header><strong>交付产物</strong><div class="workspace-code-actions"><el-button v-if="canManage" link @click="openManager">管理项目</el-button><el-button link :loading="loading" aria-label="刷新代码产物" @click="refresh"><RefreshCw :size="13" /></el-button></div></header>
    <el-skeleton v-if="loading && !repositories.length" :rows="2" animated />
    <AgentCodeArtifact v-for="item in repositories" :key="item.directory" :path="item.directory" :file-count="item.counts.total"
      :title="repositoryTitle(item)" :branch="item.branch" :head="item.head" :ahead="item.ahead" :url="repositoryUrl(item)" />
    <el-dialog v-model="managing" title="管理交付项目" width="min(720px, 94vw)" append-to-body :close-on-click-modal="false" :close-on-press-escape="!saving" :show-close="!saving">
      <p class="workspace-code-help">关联本会话的代码交付工作区，保存在当前浏览器中。</p>
      <el-form label-position="top" :disabled="saving">
        <div v-for="(row, index) in draft" :key="row.key" class="workspace-code-row">
          <el-form-item label="项目名称"><el-input v-model="row.label" :aria-label="`交付项目 ${index + 1} 名称`" placeholder="例如 App / PC" maxlength="80" /></el-form-item>
          <el-form-item label="工作区路径"><el-input v-model="row.path" :aria-label="`交付项目 ${index + 1} 工作区路径`" placeholder="项目完整工作区路径" /></el-form-item>
          <el-button text type="danger" :aria-label="`移除交付项目 ${index + 1}`" @click="draft.splice(index, 1)">移除</el-button>
        </div>
        <el-button :disabled="draft.length >= 10" @click="addProject">添加项目</el-button>
      </el-form>
      <template #footer><el-button :disabled="saving" @click="resetProjects">恢复默认项目</el-button><el-button :disabled="saving" @click="managing = false">取消</el-button><el-button type="primary" :loading="saving" @click="saveProjects">保存交付项目</el-button></template>
    </el-dialog>
  </section>
</template>

<style scoped>
.workspace-code-artifacts{display:grid;gap:10px;padding:14px 0;min-width:0}
.workspace-code-artifacts>header{display:flex;align-items:center;justify-content:space-between;color:var(--agent-text);font-size:13px}
.workspace-code-actions{display:flex;align-items:center;gap:8px}.workspace-code-help{margin:0 0 18px;color:var(--el-text-color-secondary);font-size:13px}
.workspace-code-row{display:grid;grid-template-columns:140px minmax(0,1fr) auto;gap:12px;align-items:center}.workspace-code-row :deep(.el-form-item){min-width:0}
@media(max-width:600px){.workspace-code-row{grid-template-columns:minmax(0,1fr) auto}.workspace-code-row>.el-form-item:first-child{grid-column:1/-1}}
</style>
