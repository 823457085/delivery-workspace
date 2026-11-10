<script setup lang="ts">
import { computed, watch } from 'vue';
import { queryOptions, useQueries } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { RefreshCw } from '@lucide/vue';
import type { ProjectGitSnapshot } from '../../../server/project-git';
import AgentCodeArtifact from './AgentCodeArtifact.vue';

const props = defineProps<{ paths: string[]; active?: boolean; runState?: string }>();
const queries = useQueries({ queries: computed(() => [...new Set(props.paths.filter(Boolean))].map(path => queryOptions({
  queryKey: ['agent-workspace-code', path], enabled: props.active !== false, staleTime: 15_000, retry: false,
  queryFn: async ({ signal }): Promise<ProjectGitSnapshot> => {
    const response = await fetch(`/api/projects/git/snapshot?path=${encodeURIComponent(path)}`, { signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '读取工作区 Git 状态失败');
    return data;
  },
}))) });
const repositories = computed(() => [...new Map(queries.value.flatMap(({ data }) => data?.isGit
  ? [[data.directory, data] as const] : [])).values()]);
const loading = computed(() => queries.value.some(query => query.isFetching));
const failed = computed(() => queries.value.some(query => query.isError));
watch(() => props.runState, state => {
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

async function refresh() {
  const results = await Promise.all(queries.value.map(query => query.refetch()));
  const failure = results.find(result => result.error)?.error;
  if (failure) ElMessage.error(failure.message);
}
</script>

<template>
  <section v-if="active !== false && (repositories.length || loading || failed)" class="workspace-code-artifacts" aria-label="工作区代码产物">
    <header><strong>交付产物</strong><el-button link :loading="loading" aria-label="刷新代码产物" @click="refresh"><RefreshCw :size="13" /></el-button></header>
    <el-skeleton v-if="loading && !repositories.length" :rows="2" animated />
    <AgentCodeArtifact v-for="item in repositories" :key="item.directory" :path="item.directory" :file-count="item.counts.total"
      :branch="item.branch" :head="item.head" :ahead="item.ahead" :url="repositoryUrl(item)" />
  </section>
</template>

<style scoped>
.workspace-code-artifacts{display:grid;gap:10px;padding:14px 0;min-width:0}
.workspace-code-artifacts>header{display:flex;align-items:center;justify-content:space-between;color:var(--agent-text);font-size:13px}
</style>
