<script setup lang="ts">
import AgentMarkdown from '../agent-workbench/AgentMarkdown.vue';
/** 项目按真实 repository 分组，采用左项目分类 + 右工作区卡片与操作控制台的双栏布局，支持添加本机目录、克隆仓库和交互式 Git 管理。 */
import { computed, inject, onMounted, onUnmounted, shallowRef, watch } from 'vue';
import { useWorkspacePanelState } from '../../shared/useWorkspacePanelState';
import { agentWorkspaceContext } from '../../shared/agent-workspace-context';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Copy, FolderGit2, GitBranch, Terminal } from '@lucide/vue';
import { useRoute, useRouter } from 'vue-router';
import type { LocalProject, ProjectsData } from '../../../shared/hub';
import { useSource, useSourceActions } from '../../shared/api';
import { dateTime, safeUrl, searchMatches } from '../../shared/format';
import PageHeading from '../../shared/ui/PageHeading.vue';
import MetricStrip from '../../shared/ui/MetricStrip.vue';
import QueryState from '../../shared/ui/QueryState.vue';
import { projectWorkspaceReviewDraft } from '../agent-workbench/agent-quick-actions';
import ProjectGitDrawer from './ProjectGitDrawer.vue';
import ProjectWorkspaceActions from './ProjectWorkspaceActions.vue';

type ProjectGroup = {
  project: LocalProject;
  workspaces: LocalProject[];
};

const route = useRoute();
const router = useRouter();
const query = useSource<ProjectsData>('projects', computed((): Record<string, string> => typeof route.query.workspace === 'string' && route.query.workspace
  ? { refresh: 'true' } : {}));
const agentWorkspace = inject(agentWorkspaceContext, undefined);
const { data, isPending, isFetching, error } = query;
const actions = useSourceActions();
const { search, root, status, sort } = useWorkspacePanelState('projects', () => ({
  search: '',
  root: 'all',
  status: 'all',
  sort: 'workspaces',
}));

watch(
  () => route.query.q,
  value => {
    if (typeof value === 'string' && value !== search.value) {
      search.value = value;
      root.value = 'all';
      status.value = 'all';
    }
  },
  { immediate: true },
);
watch(search, value => {
  if (typeof route.query.q === 'string' && route.query.q !== value) {
    void router.replace({ query: { ...route.query, q: value || undefined } });
  }
});

const selectedProjectId = shallowRef('');
const workspaceKeyword = shallowRef('');
const gitProject = shallowRef<LocalProject>();
const gitDrawer = shallowRef(false);
const workspacePaths = new Map<string, string>();
const activityClock = shallowRef(Date.now());
let activityTimer: ReturnType<typeof setInterval>;
onMounted(() => { activityTimer = setInterval(() => { activityClock.value = Date.now(); }, 60_000); });
onUnmounted(() => clearInterval(activityTimer));
const gitWorkspaces = computed(() =>
  (data.value?.projects || []).filter(item => item.projectId === gitProject.value?.projectId),
);

// Folder picker & Clone dialog state
const pickingFolder = shallowRef(false);
const cloneDialogVisible = shallowRef(false);
const cloning = shallowRef(false);
const cloneParent = shallowRef('');
const cloneUrl = shallowRef('');
const cloneFolder = shallowRef('');

const filtered = computed(() =>
  (data.value?.projects || []).filter(
    item =>
      (root.value === 'all' || item.rootPath === root.value)
      && (status.value === 'all'
        || (status.value === 'dirty' && !item.clean)
        || (status.value === 'clean' && item.clean)
        || (status.value === 'detached' && item.detached))
      && searchMatches([item.displayName, item.path, item.projectName, item.repository, item.branch], search.value),
  ),
);

const groups = computed<ProjectGroup[]>(() => {
  const map = new Map<string, ProjectGroup>();
  for (const item of filtered.value) {
    if (!map.has(item.projectId)) map.set(item.projectId, { project: item, workspaces: [] });
    map.get(item.projectId)!.workspaces.push(item);
  }
  return [...map.values()].sort((a, b) =>
    sort.value === 'project'
      ? a.project.displayName.localeCompare(b.project.displayName, 'zh-CN')
      : sort.value === 'changes'
        ? b.workspaces.reduce((sum, item) => sum + item.changed, 0)
          - a.workspaces.reduce((sum, item) => sum + item.changed, 0)
        : sort.value === 'branch'
          ? a.project.branch.localeCompare(b.project.branch)
          : b.workspaces.length - a.workspaces.length,
  );
});

watch(
  groups,
  list => {
    if (!list.some(g => g.project.projectId === selectedProjectId.value)) {
      selectedProjectId.value = list[0]?.project.projectId || '';
    }
  },
  { immediate: true },
);

const selectedGroup = computed(() =>
  groups.value.find(g => g.project.projectId === selectedProjectId.value) || groups.value[0],
);

watch(selectedProjectId, () => {
  workspaceKeyword.value = '';
});

const visibleWorkspaces = computed(() => {
  const list = selectedGroup.value?.workspaces || [];
  const term = workspaceKeyword.value.trim();
  if (!term) return list;
  return list.filter(ws => searchMatches([ws.folderName, ws.relativePath, ws.displayPath, ws.branch, ws.upstream], term));
});

const activeWorkspacePath = shallowRef('');

const activeWorkspace = computed<LocalProject | undefined>(() => {
  const list = selectedGroup.value?.workspaces || [];
  return list.find(w => w.path === activeWorkspacePath.value) || list[0];
});

watch(
  selectedGroup,
  group => {
    if (!group) {
      activeWorkspacePath.value = '';
      return;
    }
    const remembered = workspacePaths.get(group.project.projectId);
    if (remembered && group.workspaces.some(w => w.path === remembered)) {
      activeWorkspacePath.value = remembered;
    } else if (!group.workspaces.some(w => w.path === activeWorkspacePath.value)) {
      activeWorkspacePath.value = group.workspaces[0]?.path || '';
    }
  },
  { immediate: true },
);

function selectProjectGroup(group: ProjectGroup) {
  selectedProjectId.value = group.project.projectId;
}

function selectActiveWorkspace(ws: LocalProject) {
  activeWorkspacePath.value = ws.path;
  workspacePaths.set(ws.projectId, ws.path);
}

function dirtyWorkspacesCount(group: ProjectGroup) {
  return group.workspaces.filter(item => !item.clean).length;
}

const metrics = computed(() => [
  { label: '扫描工作区', value: data.value?.projects.length, note: '逐个读取 Git 状态' },
  { label: '当前筛选项目', value: data.value ? groups.value.length : undefined, note: '同仓库多个工作区合并展示' },
  {
    label: '有本地改动',
    value: data.value?.projects.filter(item => !item.clean).length,
    note: '未清理或修改工作树',
    tone: 'warning',
  },
  {
    label: '扫描目录',
    value: data.value?.directoryCount,
    note: data.value
      ? `${(data.value.durationMs / 1000).toFixed(1)} 秒 · ${data.value.unreadableCount} 个不可读`
      : '首次扫描可能需要约一分钟',
  },
]);

async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    ElMessage.success('路径已复制');
  } catch {
    ElMessage.error('浏览器未允许复制');
  }
}

async function rename(item: LocalProject) {
  try {
    const result = await ElMessageBox.prompt('只修改看板中的展示名称，不重命名目录或 Git 仓库。', '设置项目中文名称', {
      inputValue: item.displayName,
      confirmButtonText: '下一步',
      cancelButtonText: '取消',
    });
    await actions.execute(
      'project-label',
      { projectId: item.projectId, displayName: result.value },
      '确认保存展示名称',
      `将项目显示名称改为“${result.value}”。`,
    );
  } catch {
    /* 用户取消 */
  }
}

function openGitManager(item: LocalProject) {
  selectActiveWorkspace(item);
  gitProject.value = item;
  gitDrawer.value = true;
}

let locatedWorkspace = '', refreshedWorkspace = '', missingWorkspace = '';
function locateRequestedWorkspace() {
  const path = typeof route.query.workspace === 'string' ? route.query.workspace : '';
  if (!path) { locatedWorkspace = ''; refreshedWorkspace = ''; missingWorkspace = ''; return; }
  const request = JSON.stringify([path, route.query.git === '1']);
  if (locatedWorkspace !== request && (gitProject.value?.path !== path || route.query.git !== '1')) gitDrawer.value = false;
  if (locatedWorkspace === request || !data.value || isFetching.value) return;
  const item = data.value.projects.find(item => item.path === path);
  if (!item) {
    if (refreshedWorkspace !== request) { refreshedWorkspace = request; void query.refetch(); return; }
    if (missingWorkspace !== request) { missingWorkspace = request; ElMessage.warning(`项目列表中未找到工作区：${path}`); }
    return;
  }
  locatedWorkspace = request;
  search.value = path;
  root.value = 'all';
  status.value = 'all';
  selectedProjectId.value = item.projectId;
  if (route.query.git === '1') openGitManager(item);
  else selectActiveWorkspace(item);
}
watch([() => route.query.workspace, () => route.query.git, data, isFetching], locateRequestedWorkspace, { immediate: true });

function selectWorkspace(item: LocalProject) {
  gitProject.value = item;
  activeWorkspacePath.value = item.path;
  workspacePaths.set(item.projectId, item.path);
}

function selectAfterRemoval(path: string, projects: LocalProject[]) {
  const current = gitProject.value;
  if (current && current.path === path) {
    const next = projects.find(item => item.projectId === current.projectId && item.path !== path);
    if (next) selectWorkspace(next);
    else {
      workspacePaths.delete(current.projectId);
      gitProject.value = undefined;
      gitDrawer.value = false;
    }
  }
  if (activeWorkspacePath.value === path) {
    const nextInGroup = selectedGroup.value?.workspaces.find(w => w.path !== path);
    activeWorkspacePath.value = nextInGroup?.path || '';
  }
}

async function workspaceRemoved(path: string) {
  selectAfterRemoval(path, data.value?.projects || []);
  try {
    await query.refetch({ throwOnError: true });
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '工作区已删除，项目列表刷新失败');
  }
}

function composeProject(item: LocalProject) {
  gitDrawer.value = false;
  if (agentWorkspace) {
    agentWorkspace.compose(projectWorkspaceReviewDraft(item.path), item.path);
  } else {
    void router.push({ path: '/agent', query: { workspace: item.path } });
  }
}

async function openExternal(workspacePath: string, endpoint: '/api/workspace/cursor' | '/api/workspace/terminal') {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspacePath }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.message || '打开失败');
    ElMessage.success(body.message || '已打开');
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '打开失败');
  }
}

const workspaceDate = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
const workspaceDateTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short', hour12: false });

function workspaceIdle(ws: LocalProject) {
  if (!ws.lastActivityAt) return '暂无活动记录';
  const minutes = Math.floor((activityClock.value - Date.parse(ws.lastActivityAt)) / 60_000);
  if (minutes < 1) return '闲置不到 1 分钟';
  if (minutes < 60) return `闲置 ${minutes} 分钟`;
  if (minutes < 1440) return `闲置 ${Math.floor(minutes / 60)} 小时`;
  return `闲置 ${Math.floor(minutes / 1440)} 天`;
}

function buildWorkspaceSummary(ws: LocalProject): string {
  const lines = [
    `# 工作区概览`,
    `所属项目: ${ws.displayName || ws.projectName}`,
    `工作区目录: ${ws.path}`,
    `创建时间: ${ws.createdAt ? workspaceDateTime.format(new Date(ws.createdAt)) : '未知'}`,
    `最近活动: ${ws.lastActivityAt ? `${workspaceDateTime.format(new Date(ws.lastActivityAt))} · ${workspaceIdle(ws)}` : '暂无活动记录'}（根据本地 Git 操作与未提交文件的修改时间估算）`,
    `Git 仓库: ${ws.repository || '未配置远程地址'}`,
    `当前分支: ${ws.branch || '游离 HEAD'}${ws.detached ? ' (游离 HEAD)' : ''}`,
    `远端跟踪: ${ws.upstream || '未关联 upstream'} (领先 ${ws.ahead} · 落后 ${ws.behind})`,
    `工作树状态: ${ws.clean ? '干净（无未提交改动）' : `共 ${ws.changed} 项改动（暂存 ${ws.staged} · 修改 ${ws.modified} · 未跟踪 ${ws.untracked}）`}`,
    '',
    `# 操作提示`,
    `点击上方「打开完整 Git 面板」或工作区卡片中的「Git 管理」，可直接查看文件 Diff、暂存提交、切换/合并分支及在线编辑代码。`,
  ];
  return lines.join('\n');
}

async function pickAndAddFolder() {
  if (pickingFolder.value) return;
  pickingFolder.value = true;
  try {
    const pickRes = await fetch('/api/workspace/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const picked = await pickRes.json();
    if (!pickRes.ok) throw new Error(picked.message || '选择文件夹失败');
    if (picked.cancelled || !picked.workspacePath) return;

    const saveRes = await fetch('/api/share/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add-root', path: picked.workspacePath }),
    });
    const saved = await saveRes.json();
    if (!saveRes.ok) throw new Error(saved.message || '添加扫描目录失败');
    ElMessage.success(saved.message || '已添加本地项目目录');
    await query.refetch();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '添加目录失败');
  } finally {
    pickingFolder.value = false;
  }
}

function openCloneDialog() {
  if (!cloneParent.value && data.value?.roots?.length) {
    cloneParent.value = data.value.roots[0].path;
  }
  cloneDialogVisible.value = true;
}

async function pickCloneParent() {
  try {
    const res = await fetch('/api/workspace/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const picked = await res.json();
    if (res.ok && !picked.cancelled && picked.workspacePath) {
      cloneParent.value = picked.workspacePath;
    }
  } catch {
    /* ignore */
  }
}

function autoFillCloneFolder() {
  if (cloneFolder.value.trim()) return;
  const match = cloneUrl.value.trim().match(/\/([^/]+?)(?:\.git)?$/);
  if (match?.[1]) cloneFolder.value = match[1];
}

async function submitClone() {
  if (!cloneParent.value.trim() || !cloneUrl.value.trim() || !cloneFolder.value.trim()) {
    ElMessage.warning('请填写完整的目标父目录、仓库地址和新建文件夹名');
    return;
  }
  cloning.value = true;
  try {
    const res = await fetch('/api/projects/git/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'clone',
        parent: cloneParent.value.trim(),
        url: cloneUrl.value.trim(),
        folder: cloneFolder.value.trim(),
      }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.message || '克隆仓库失败');
    ElMessage.success(`仓库已克隆到 ${result.destination}`);
    cloneDialogVisible.value = false;
    cloneUrl.value = '';
    cloneFolder.value = '';
    await query.refetch();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '克隆仓库失败');
  } finally {
    cloning.value = false;
  }
}
</script>

<template>
  <section class="project-inventory">
    <PageHeading
      title="本地项目与 Git 管理"
      description="自动识别本机 Git 仓库与多工作区；支持直接浏览代码、查看 Diff、暂存提交、切换/合并分支与推送远端。"
      :loading="isFetching"
      @refresh="query.refetch()"
    >
      <el-button :loading="pickingFolder" @click="pickAndAddFolder">添加本地目录</el-button>
      <el-button type="primary" plain @click="openCloneDialog">克隆远程仓库</el-button>
    </PageHeading>

    <MetricStrip :items="metrics" />

    <el-alert
      v-if="data?.limited || data?.unreadableCount"
      class="section-alert"
      type="warning"
      title="本次扫描存在数量上限或不可读目录。"
      :closable="false"
      show-icon
    />

    <QueryState :loading="isPending" :error="error" :has-data="!!data" @retry="query.refetch()">
      <div class="project-layout">
        <!-- 左侧：项目分类导航（对齐项目部署布局） -->
        <aside class="project-sidebar" aria-label="本地项目分类">
          <div class="sidebar-heading">
            <strong>项目分类</strong>
            <span>{{ groups.length }}</span>
          </div>

          <el-input
            v-model="search"
            placeholder="搜索项目、路径或分支"
            clearable
            aria-label="搜索项目、路径或分支"
          />

          <div class="sidebar-filters">
            <el-select v-model="status" size="small" aria-label="工作区状态">
              <el-option label="全部状态" value="all" />
              <el-option label="有本地改动" value="dirty" />
              <el-option label="干净" value="clean" />
              <el-option label="游离 HEAD" value="detached" />
            </el-select>
            <el-select v-model="sort" size="small" aria-label="排序">
              <el-option label="按工作区数" value="workspaces" />
              <el-option label="按项目名称" value="project" />
              <el-option label="按本地改动" value="changes" />
              <el-option label="按分支" value="branch" />
            </el-select>
          </div>

          <el-select v-if="(data?.roots?.length || 0) > 1" v-model="root" size="small" aria-label="扫描目录">
            <el-option label="全部扫描目录" value="all" />
            <el-option v-for="item in data?.roots" :key="item.path" :label="item.label" :value="item.path" />
          </el-select>

          <nav class="deployment-projects" aria-label="项目列表">
            <button
              v-for="group in groups"
              :key="group.project.projectId"
              type="button"
              :class="{ selected: selectedGroup?.project.projectId === group.project.projectId }"
              :aria-current="selectedGroup?.project.projectId === group.project.projectId ? 'page' : undefined"
              @click="selectProjectGroup(group)"
            >
              <FolderGit2 :size="16" />
              <span>
                <strong>{{ group.project.displayName || group.project.projectName }}</strong>
                <small>
                  {{ group.workspaces.length }} 个工作区 ·
                  <em :class="{ dirty: dirtyWorkspacesCount(group) > 0 }">
                    {{ dirtyWorkspacesCount(group) > 0 ? `${dirtyWorkspacesCount(group)} 个有改动` : '工作区干净' }}
                  </em>
                </small>
              </span>
            </button>
            <p v-if="!groups.length" class="sidebar-empty">没有匹配的项目</p>
          </nav>

          <div class="sidebar-footer">
            <span>{{ groups.length }} 个项目 · {{ filtered.length }} 个工作区</span>
          </div>
        </aside>

        <!-- 右侧：主工作区（项目头部 + 本地工作区卡片网格 + 底部工作区详情与操作控制台） -->
        <main class="project-main">
          <template v-if="selectedGroup">
            <header class="deployment-project-heading">
              <div>
                <h2>{{ selectedGroup.project.displayName || selectedGroup.project.projectName }}</h2>
                <p>
                  <a
                    v-if="safeUrl(selectedGroup.project.webUrl)"
                    :href="safeUrl(selectedGroup.project.webUrl)"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {{ selectedGroup.project.repository }} ↗
                  </a>
                  <span v-else>{{ selectedGroup.project.repository || selectedGroup.project.displayPath }}</span>
                  · 共 {{ selectedGroup.workspaces.length }} 个本地工作区
                </p>
              </div>
              <div class="heading-actions">
                <el-button @click="rename(selectedGroup.project)">编辑名称</el-button>
                <el-button
                  type="primary"
                  @click="openGitManager(activeWorkspace || selectedGroup.project)"
                >
                  打开完整 Git 面板
                </el-button>
              </div>
            </header>

            <!-- 顶部区域：该项目下的本地工作区卡片网格（参考项目部署的部署环境卡片） -->
            <section class="environment-section" aria-label="项目本地工作区">
              <div class="section-heading">
                <h3>
                  工作区环境
                  <small>{{ visibleWorkspaces.length }}</small>
                </h3>
                <el-input
                  v-if="selectedGroup.workspaces.length > 3"
                  v-model="workspaceKeyword"
                  clearable
                  size="small"
                  placeholder="筛选当前项目的工作区或分支"
                  aria-label="筛选当前项目的工作区或分支"
                  style="width: 220px"
                />
              </div>

              <div v-if="visibleWorkspaces.length" class="environment-grid">
                <article
                  v-for="ws in visibleWorkspaces"
                  :key="ws.path"
                  class="environment-card workspace-card"
                  :class="{ selected: activeWorkspace?.path === ws.path }"
                  @click="selectActiveWorkspace(ws)"
                >
                  <header>
                    <strong :title="ws.relativePath || ws.folderName">
                      {{ ws.relativePath || ws.folderName }}
                    </strong>
                    <el-tag size="small" :type="ws.clean ? 'success' : 'warning'" effect="plain">
                      {{ ws.clean ? '干净' : `${ws.changed} 项改动` }}
                    </el-tag>
                  </header>

                  <div class="branch-row">
                    <span class="branch-pill" :title="ws.branch">
                      <GitBranch :size="12" />
                      <span>{{ ws.branch || '游离 HEAD' }}</span>
                    </span>
                    <span v-if="ws.detached" class="detached-badge">游离 HEAD</span>
                  </div>

                  <div class="cwd-line">
                    <code :title="ws.path">{{ ws.displayPath }}</code>
                    <button
                      type="button"
                      title="复制工作区路径"
                      aria-label="复制工作区路径"
                      @click.stop="copy(ws.path)"
                    >
                      <Copy :size="12" />
                    </button>
                  </div>

                  <div class="environment-status">
                    <span>{{ ws.upstream || '无 upstream' }}</span>
                    <span>领先 {{ ws.ahead }} · 落后 {{ ws.behind }}</span>
                    <span v-if="!ws.clean" class="dirty-breakdown">
                      暂存 {{ ws.staged }} · 修改 {{ ws.modified }} · 未跟踪 {{ ws.untracked }}
                    </span>
                  </div>

                  <footer @click.stop>
                    <el-button type="primary" plain size="small" @click="openGitManager(ws)">
                      Git 管理
                    </el-button>
                    <el-button
                      link
                      size="small"
                      @click="
                        actions.execute(
                          'project-open',
                          { path: ws.path },
                          '打开本地目录',
                          `在 Finder 中打开 ${ws.path}，不会修改文件。`,
                        )
                      "
                    >
                      Finder 打开
                    </el-button>
                    <el-button link size="small" @click="copy(ws.path)">复制路径</el-button>
                    <span class="environment-spacer"></span>
                    <el-button link type="primary" size="small" @click="composeProject(ws)">
                      带入会话
                    </el-button>
                  </footer>
                </article>
              </div>
              <el-empty v-else description="没有匹配的工作区" :image-size="60" />
            </section>

            <!-- 底部区域：工作区列表 + 选中工作区状态与快捷操作控制台（参考项目部署的运行控制台） -->
            <section class="deployment-execution" aria-label="工作区详情与操作">
              <aside class="run-history" aria-label="工作区快速切换">
                <div class="section-heading">
                  <h3>工作区记录</h3>
                  <small>{{ selectedGroup.workspaces.length }} 个</small>
                </div>
                <div class="run-history-list">
                  <button
                    v-for="ws in selectedGroup.workspaces"
                    :key="ws.path"
                    type="button"
                    :class="{ selected: activeWorkspace?.path === ws.path }"
                    :aria-pressed="activeWorkspace?.path === ws.path"
                    @click="selectActiveWorkspace(ws)"
                  >
                    <span>
                      <strong>{{ ws.folderName }}</strong>
                      <span class="mini-status-tag" :class="{ 'is-dirty': !ws.clean, 'is-clean': ws.clean }">
                        {{ ws.clean ? '干净' : `${ws.changed} 改动` }}
                      </span>
                    </span>
                    <small>{{ ws.branch || '游离 HEAD' }}</small>
                    <small>{{ ws.displayPath }}</small>
                    <small class="workspace-activity">
                      <time v-if="ws.createdAt" :datetime="ws.createdAt">创建 {{ workspaceDate.format(new Date(ws.createdAt)) }}</time>
                      <span v-else>创建日期未知</span>
                      <span :title="ws.lastActivityAt ? workspaceDateTime.format(new Date(ws.lastActivityAt)) : undefined">{{ workspaceIdle(ws) }}</span>
                    </small>
                  </button>
                </div>
              </aside>

              <div class="run-console">
                <div class="section-heading">
                  <h3>
                    <Terminal :size="16" />
                    <span>工作区状态与快捷操作</span>
                  </h3>
                  <span class="live-state">扫描于 {{ dateTime(data?.scannedAt) }}</span>
                </div>

                <template v-if="activeWorkspace">
                  <div class="log-heading">
                    <div>
                      <strong>
                        {{ activeWorkspace.relativePath || activeWorkspace.folderName }}
                        · {{ activeWorkspace.branch || '游离 HEAD' }}
                      </strong>
                      <p>{{ activeWorkspace.path }}</p>
                    </div>
                    <div class="console-header-actions">
                      <el-button
                        size="small"
                        @click="openExternal(activeWorkspace.path, '/api/workspace/cursor')"
                      >
                        Cursor 打开
                      </el-button>
                      <el-button
                        size="small"
                        @click="openExternal(activeWorkspace.path, '/api/workspace/terminal')"
                      >
                        终端打开
                      </el-button>
                      <el-button
                        size="small"
                        type="primary"
                        plain
                        @click="openGitManager(activeWorkspace)"
                      >
                        Git 与代码管理
                      </el-button>
                      <ProjectWorkspaceActions
                        :path="activeWorkspace.path"
                        @removed="workspaceRemoved"
                      />
                    </div>
                  </div>

                  <AgentMarkdown class="workspace-summary" aria-label="工作区状态摘要" :source="buildWorkspaceSummary(activeWorkspace)" />
                </template>
              </div>
            </section>
          </template>

          <el-empty
            v-else
            description="当前筛选没有匹配工作区，可点击右上角“添加本地目录”或“克隆远程仓库”"
            :image-size="80"
          />
        </main>
      </div>
    </QueryState>

    <ProjectGitDrawer
      v-model="gitDrawer"
      :project="gitProject"
      :workspaces="gitWorkspaces"
      @select="selectWorkspace"
      @copy="copy"
      @open-folder="
        item =>
          actions.execute(
            'project-open',
            { path: item.path },
            '打开本地目录',
            `在 Finder 中打开 ${item.path}，不会修改文件。`,
          )
      "
      @refreshed="query.refetch()"
      @workspace-removed="workspaceRemoved"
      @compose="composeProject"
    />

    <el-dialog v-model="cloneDialogVisible" title="克隆远程 Git 仓库" width="520px">
      <el-form label-position="top">
        <el-form-item label="仓库地址 (SSH 或 HTTPS)">
          <el-input
            v-model="cloneUrl"
            placeholder="例如 git@gitlab.example.com:team/project.git"
            @blur="autoFillCloneFolder"
          />
        </el-form-item>
        <el-form-item label="存放父目录">
          <div style="display: flex; gap: 8px; width: 100%">
            <el-input v-model="cloneParent" placeholder="/Users/yourname/Desktop" />
            <el-button @click="pickCloneParent">选择文件夹</el-button>
          </div>
        </el-form-item>
        <el-form-item label="新建文件夹名称">
          <el-input v-model="cloneFolder" placeholder="例如 my-project" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="cloneDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="cloning" @click="submitClone">开始克隆</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.project-inventory {
  min-width: 0;
}

.project-inventory :deep(.hub-metrics.hub-metrics > .metric-card) {
  min-height: 82px;
  padding: 12px 18px;
}

.project-inventory :deep(.hub-metrics.hub-metrics > .metric-card strong) {
  font: 600 26px/1.3 var(--sans, sans-serif);
  margin: 4px 0;
}

.project-inventory :deep(.hub-metrics.hub-metrics > .metric-card small) {
  font-size: 11px;
}

/* 左右分栏主布局（与项目部署 DeploymentWorkspace 对齐） */
.project-layout {
  display: grid;
  grid-template-columns: 248px minmax(0, 1fr);
  align-items: start;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  background: var(--ui-surface);
  overflow: clip;
}

.project-sidebar {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  position: sticky;
  top: 0;
  align-self: start;
  box-sizing: border-box;
  padding: 18px 12px;
  border-right: 1px solid var(--ui-border);
  background: var(--ui-raised, var(--ui-bg));
}

.sidebar-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 6px;
  font-size: 14px;
}

.sidebar-heading > span {
  font-size: 12px;
  color: var(--ui-muted);
}

.sidebar-filters {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

.deployment-projects {
  min-width: 0;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-height: 0;
  max-height: min(48dvh, 26rem);
  overflow: auto;
  flex: 1;
}

.deployment-projects > button {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  width: 100%;
  padding: 11px 10px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--ui-text);
  text-align: left;
  cursor: pointer;
  font: inherit;
}

.deployment-projects > button > svg {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--ui-muted);
}

.deployment-projects > button > span {
  min-width: 0;
}

.deployment-projects strong,
.deployment-projects small {
  display: block;
  overflow-wrap: anywhere;
}

.deployment-projects strong {
  font-size: 13px;
  font-weight: 550;
  line-height: 1.5;
}

.deployment-projects small {
  margin-top: 4px;
  font-size: 11px;
  color: var(--ui-muted);
}

.deployment-projects small em {
  font-style: normal;
}

.deployment-projects small em.dirty {
  color: var(--el-color-warning-dark-2);
}

.deployment-projects > button:hover {
  background: var(--ui-accent-soft);
}

.deployment-projects > button.selected {
  border-color: color-mix(in srgb, var(--ui-accent) 35%, transparent);
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
}

.deployment-projects > button.selected > svg {
  color: var(--ui-accent);
}

.sidebar-empty {
  padding: 12px;
  color: var(--ui-muted);
  font-size: 12px;
}

.sidebar-footer {
  padding: 6px 6px 0;
  border-top: 1px solid var(--ui-divider, var(--ui-border));
  color: var(--ui-muted);
  font-size: 11px;
}

/* 右侧主区域 */
.project-main {
  min-width: 0;
  padding: 20px 22px;
}

.deployment-project-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--ui-divider, var(--ui-border));
}

.deployment-project-heading > div:first-child {
  min-width: 0;
}

.deployment-project-heading h2 {
  margin: 0;
  font-size: 19px;
  line-height: 1.5;
}

.deployment-project-heading p {
  margin: 6px 0 0;
  color: var(--ui-muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.deployment-project-heading p a {
  color: var(--ui-accent);
  text-decoration: none;
}

.deployment-project-heading p a:hover {
  text-decoration: underline;
}

.heading-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.heading-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}

.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 0 0 14px;
}

.section-heading h3 {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  font-size: 14px;
  font-weight: 550;
  line-height: 1.6;
}

.section-heading small,
.live-state {
  color: var(--ui-muted);
  font-size: 11px;
  font-weight: 400;
}

.environment-section {
  padding: 18px 0 22px;
}

.environment-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(275px, 100%), 1fr));
  gap: 12px;
}

.environment-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 14px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: var(--ui-surface);
  cursor: pointer;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.environment-card:hover {
  border-color: color-mix(in srgb, var(--ui-accent) 40%, var(--ui-border));
}

.environment-card.selected {
  border-color: var(--ui-accent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ui-accent) 25%, transparent);
}

.environment-card > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 9px;
}

.environment-card > header > strong {
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.branch-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 10px 0 6px;
}

.branch-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  padding: 2px 7px;
  border-radius: 5px;
  background: var(--ui-raised, var(--ui-bg));
  border: 1px solid var(--ui-border);
  color: var(--ui-text);
  font: 500 11px/1.35 var(--mono);
}

.branch-pill > svg {
  flex: none;
  color: var(--ui-secondary);
}

.branch-pill > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detached-badge {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 4px;
  color: var(--ui-warning);
  background: color-mix(in srgb, var(--ui-warning) 12%, transparent);
}

.cwd-line {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  min-width: 0;
}

.cwd-line code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ui-muted);
  font: 11px/1.5 var(--mono);
}

.cwd-line button {
  flex: none;
  width: 22px;
  height: 22px;
  border: 1px solid transparent;
  border-radius: 5px;
  display: inline-grid;
  place-items: center;
  background: transparent;
  color: var(--ui-muted);
  cursor: pointer;
}

.cwd-line button:hover {
  border-color: var(--ui-border);
  color: var(--ui-text);
  background: var(--ui-raised, var(--ui-bg));
}

.environment-status {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px 10px;
  margin: 10px 0 12px;
  color: var(--ui-muted);
  font-size: 11px;
}

.dirty-breakdown {
  color: var(--el-color-warning-dark-2);
}

.environment-card > footer {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: auto;
  padding-top: 10px;
  border-top: 1px solid var(--ui-divider, var(--ui-border));
}

.environment-card > footer .el-button + .el-button {
  margin-left: 0;
}

.environment-spacer {
  flex: 1;
}

/* 底部工作区记录与详情控制台（对齐项目部署的 .deployment-execution） */
.deployment-execution {
  display: grid;
  grid-template-columns: 215px minmax(0, 1fr);
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  overflow: hidden;
}

.run-history {
  min-width: 0;
  padding: 15px 10px;
  background: var(--ui-raised, var(--ui-bg));
  border-right: 1px solid var(--ui-border);
}

.run-history > .section-heading {
  padding: 0 4px;
}

.run-history-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: min(42dvh, 340px);
  overflow: auto;
}

.run-history-list > button {
  display: block;
  width: 100%;
  padding: 9px 10px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--ui-text);
  text-align: left;
  cursor: pointer;
}

.run-history-list > button > span {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.run-history-list > button > span > strong {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.run-history-list > button > small {
  display: block;
  color: var(--ui-muted);
  font-size: 10px;
  line-height: 1.5;
  margin-top: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.run-history-list > button.selected {
  border-color: var(--ui-border);
  background: var(--ui-surface);
}

.run-history-list > button > .workspace-activity {
  display: flex;
  flex-wrap: wrap;
  column-gap: 8px;
  font-variant-numeric: tabular-nums;
}

.run-history-list > button:hover {
  background: var(--ui-accent-soft);
}

.mini-status-tag {
  flex: none;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 10px;
}

.mini-status-tag.is-clean {
  color: var(--ui-success);
  background: color-mix(in srgb, var(--ui-success) 12%, transparent);
}

.mini-status-tag.is-dirty {
  color: var(--ui-warning);
  background: color-mix(in srgb, var(--ui-warning) 12%, transparent);
}

.run-console {
  min-width: 0;
  padding: 16px;
  display: flex;
  flex-direction: column;
}

.log-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.log-heading > div:first-child {
  min-width: 0;
  flex: 1 1 320px;
}

.log-heading strong {
  font-size: 14px;
}

.log-heading p {
  margin: 4px 0 0;
  color: var(--ui-muted);
  font: 11px/1.6 var(--mono);
  overflow-wrap: anywhere;
}

.console-header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.console-header-actions :deep(.el-button) {
  margin: 0;
}

.workspace-summary {
  flex: 1;
  max-height: 280px;
  overflow: auto;
  box-sizing: border-box;
  margin: 0;
  padding: 14px;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  background: var(--ui-raised, var(--ui-bg));
  color: var(--ui-text);
  font: 12px/1.75 var(--sans);
  white-space: normal;
  overflow-wrap: anywhere;
}

@media (max-height: 680px) {
  .project-sidebar {
    position: static;
  }
}

@media (max-width: 900px) {
  .project-layout,
  .deployment-execution {
    grid-template-columns: minmax(0, 1fr);
    min-height: 0;
  }

  .project-sidebar {
    position: static;
    border-right: 0;
    border-bottom: 1px solid var(--ui-border);
  }

  .deployment-projects {
    max-height: min(48dvh, 220px);
  }

  .run-history {
    border-right: 0;
    border-bottom: 1px solid var(--ui-border);
  }
}
</style>
