<script setup lang="ts">
/** 项目按真实 repository 分组，保留每个 worktree 的路径和独立 Git 状态。 */
import { computed, inject, shallowRef, watch } from 'vue';
import { useWorkspacePanelState } from '../../shared/useWorkspacePanelState';
import { agentWorkspaceContext } from '../../shared/agent-workspace-context';
import { ElMessage, ElMessageBox } from 'element-plus';
import { FolderGit2 } from '@lucide/vue';
import { useRoute, useRouter } from 'vue-router';
import type { LocalProject, ProjectsData } from '../../../shared/hub';
import { useSource, useSourceActions } from '../../shared/api';
import { safeUrl, searchMatches, dateTime } from '../../shared/format';
import PageHeading from '../../shared/ui/PageHeading.vue';
import MetricStrip from '../../shared/ui/MetricStrip.vue';
import QueryState from '../../shared/ui/QueryState.vue';
import RecordDrawer from '../../shared/ui/RecordDrawer.vue';
const query = useSource<ProjectsData>('projects');
const route = useRoute();
const router = useRouter();
const agentWorkspace = inject(agentWorkspaceContext, undefined);
const { data, isPending, isFetching, error } = query;
const actions = useSourceActions();
const { search, root, status, sort, page } = useWorkspacePanelState('projects', () => ({ search: '', root: 'all', status: 'all', sort: 'workspaces', page: 1 }));
watch(() => route.query.q, value => { if (typeof value === 'string' && value !== search.value) { search.value = value; root.value = 'all'; status.value = 'all'; page.value = 1; } }, { immediate: true });
watch(search, value => { if (typeof route.query.q === 'string' && route.query.q !== value) void router.replace({ query: { ...route.query, q: value || undefined } }); });
const selected = shallowRef<LocalProject>(), drawer = shallowRef(false);
const filtered = computed(() => (data.value?.projects || []).filter((item) => (root.value === 'all' || item.rootPath === root.value) && (status.value === 'all' || status.value === 'dirty' && !item.clean || status.value === 'clean' && item.clean || status.value === 'detached' && item.detached) && searchMatches([item.displayName, item.path, item.projectName, item.repository, item.branch], search.value)));
const groups = computed(() => {
  const map = new Map<string, { project: LocalProject; workspaces: LocalProject[] }>();
  for (const item of filtered.value) { if (!map.has(item.projectId)) map.set(item.projectId, { project: item, workspaces: [] }); map.get(item.projectId)!.workspaces.push(item); }
  return [...map.values()].sort((a, b) => sort.value === 'project' ? a.project.displayName.localeCompare(b.project.displayName, 'zh-CN') : sort.value === 'changes' ? b.workspaces.reduce((sum, item) => sum + item.changed, 0) - a.workspaces.reduce((sum, item) => sum + item.changed, 0) : sort.value === 'branch' ? a.project.branch.localeCompare(b.project.branch) : b.workspaces.length - a.workspaces.length);
});
const visible = computed(() => groups.value.slice((Math.min(page.value, Math.max(1, Math.ceil(groups.value.length / 8))) - 1) * 8, Math.min(page.value, Math.max(1, Math.ceil(groups.value.length / 8))) * 8));
const metrics = computed(() => [{ label: '扫描工作区', value: data.value?.projects.length, note: '逐个读取 Git 状态' }, { label: '当前筛选项目', value: data.value ? groups.value.length : undefined, note: '同仓库多个工作区合并展示' }, { label: '有本地改动', value: data.value?.projects.filter((item) => !item.clean).length, note: '未清理或修改工作树', tone: 'warning' }, { label: '扫描目录', value: data.value?.directoryCount, note: data.value ? `${(data.value.durationMs / 1000).toFixed(1)} 秒 · ${data.value.unreadableCount} 个不可读` : '首次扫描可能需要约一分钟' }]);
async function copy(value: string) { try { await navigator.clipboard.writeText(value); ElMessage.success('路径已复制'); } catch { ElMessage.error('浏览器未允许复制'); } }
async function rename(item: LocalProject) {
  try { const result = await ElMessageBox.prompt('只修改原看板中的展示名称，不重命名目录或 Git 仓库。', '设置项目中文名称', { inputValue: item.displayName, confirmButtonText: '下一步', cancelButtonText: '取消' }); await actions.execute('project-label', { projectId: item.projectId, displayName: result.value }, '确认保存展示名称', `将项目显示名称改为“${result.value}”。`); } catch { /* 用户取消 */ }
}
function inspect(item: LocalProject) { selected.value = item; drawer.value = true; }
</script>
<template>
  <PageHeading title="本地项目与工作区" description="同一个仓库、多个独立工作区；真实分支和未提交改动逐项可见。" :loading="isFetching" @refresh="query.refetch()" />
  <MetricStrip :items="metrics" />
  <el-alert v-if="data?.limited || data?.unreadableCount" class="section-alert" type="warning" title="本次扫描存在数量上限或不可读目录，请核对完整原始记录。" :closable="false" show-icon />
  <QueryState :loading="isPending" :error="error" :has-data="!!data" @retry="query.refetch()"><div class="surface"><div class="filter-bar"><el-input v-model="search" placeholder="搜索项目、路径或分支" clearable @input="page = 1" /><el-select v-model="root" aria-label="扫描目录" @change="page = 1"><el-option label="全部目录" value="all" /><el-option v-for="item in data?.roots" :key="item.path" :label="item.label" :value="item.path" /></el-select><el-select v-model="status" aria-label="工作区状态" @change="page = 1"><el-option label="全部状态" value="all" /><el-option label="有本地改动" value="dirty" /><el-option label="干净" value="clean" /><el-option label="游离 HEAD" value="detached" /></el-select><el-select v-model="sort" aria-label="排序"><el-option label="按工作区数量" value="workspaces" /><el-option label="按项目名称" value="project" /><el-option label="按本地改动" value="changes" /><el-option label="按分支" value="branch" /></el-select><span class="filter-count">{{ filtered.length }} 个工作区</span></div></div>
    <section v-for="group in visible" :key="group.project.projectId" class="surface"><div class="surface-header"><div class="project-group-title"><span><FolderGit2 :size="20" /></span><div><h2>{{ group.project.displayName || group.project.projectName }} <small>{{ group.workspaces.length }} 个工作区</small></h2><a :href="safeUrl(group.project.webUrl)" target="_blank" class="row-secondary">{{ group.project.repository }}</a></div></div><el-button link type="primary" @click="rename(group.project)">编辑名称</el-button></div><el-table :data="group.workspaces" :max-height="480"><el-table-column label="工作区路径" min-width="340"><template #default="{ row }"><span class="row-title">{{ row.relativePath || row.folderName }}</span><span class="row-mono">{{ row.displayPath }}</span><div class="inline-links"><el-button link type="primary" @click="copy(row.path)">复制路径</el-button><el-button link @click="actions.execute('project-open', { path: row.path }, '打开本地目录', `在 Finder 中打开 ${row.path}，不会修改文件。`)">Finder 打开</el-button></div></template></el-table-column><el-table-column label="分支 / 远端跟踪" min-width="210"><template #default="{ row }"><span class="row-title">{{ row.branch }}</span><span class="row-secondary">{{ row.upstream || '无 upstream' }}</span><span class="row-secondary">领先 {{ row.ahead }} · 落后 {{ row.behind }}{{ row.detached ? ' · 游离 HEAD' : '' }}</span></template></el-table-column><el-table-column label="工作树状态" width="185"><template #default="{ row }"><el-tag :type="row.clean ? 'success' : 'warning'" effect="plain">{{ row.clean ? '干净' : `${row.changed} 项改动` }}</el-tag><span class="row-secondary">暂存 {{ row.staged }} · 修改 {{ row.modified }} · 未跟踪 {{ row.untracked }}</span></template></el-table-column><el-table-column label="详情" width="70"><template #default="{ row }"><el-button link type="primary" @click="inspect(row)">查看</el-button></template></el-table-column></el-table></section>
    <el-empty v-if="!groups.length" description="当前筛选没有匹配工作区" /><div class="table-footer"><span>扫描于 {{ dateTime(data?.scannedAt) }}</span><el-pagination v-model:current-page="page" :total="groups.length" :page-size="8" layout="prev, pager, next" /></div>
  </QueryState>
  <RecordDrawer v-model="drawer" :title="selected?.displayName || '工作区详情'" :subtitle="selected?.path" :record="selected"><template #footer><el-button v-if="agentWorkspace && selected" type="primary" @click="agentWorkspace.compose(`@项目:${selected.projectId} 请检查当前分支、工作区变更和远端差异，给出下一步，先只读分析。`)">带入会话</el-button></template></RecordDrawer>
</template>
<style scoped>.project-group-title{display:flex;align-items:center;gap:11px}.project-group-title>span{width:36px;height:36px;background:var(--ui-accent-soft);color:var(--ui-accent);border-radius:7px;display:grid;place-items:center}.project-group-title h2 small{font-size:11px;font-weight:400;color:var(--ui-muted);margin-left:12px}.project-group-title a{font-size:11px}.inline-links{margin-top:5px;gap:10px}</style>
