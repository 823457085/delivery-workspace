<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { LocalProject } from '../../../shared/hub';
import { dateTime, safeUrl } from '../../shared/format';
import { presentGitDiff, splitGitDiff } from './git-diff';
import ProjectCodeEditor from './ProjectCodeEditor.vue';
import ProjectWorkspaceActions from './ProjectWorkspaceActions.vue';
import ProjectGitMergePanel from './ProjectGitMergePanel.vue';
import type { GitBranchItem, GitFileItem, GitSnapshot } from './project-git-types';

interface TreeEntry {
  name: string;
  path: string;
  directory: boolean;
  symlink: boolean;
}

const props = defineProps<{
  modelValue: boolean;
  project?: LocalProject;
  workspaces?: LocalProject[];
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  'refreshed': [];
  'compose': [project: LocalProject];
  'select': [project: LocalProject];
  'copy': [path: string];
  'open-folder': [project: LocalProject];
  'workspace-removed': [path: string];
}>();

const visible = computed({
  get: () => props.modelValue,
  set: (val: boolean) => emit('update:modelValue', val),
});

const workspaceSearch = shallowRef('');
const visibleWorkspaces = computed(() => (props.workspaces || (props.project ? [props.project] : [])).filter(item =>
  `${item.folderName} ${item.displayPath} ${item.branch}`.toLocaleLowerCase().includes(workspaceSearch.value.trim().toLocaleLowerCase())));
const activeTab = shallowRef<'changes' | 'branches' | 'merge' | 'remotes' | 'code'>('changes');
const loading = shallowRef(false);
const acting = shallowRef(false);
const confirmingDiscard = shallowRef(false);
const workspaceActing = shallowRef(false);
const mergeActing = shallowRef(false);
const snapshot = ref<GitSnapshot>();
const lastOutput = shallowRef<{ title: string; type: 'info' | 'success'; details?: string }>();
const showGitOutput = shallowRef(false);
const gitBusy = computed(() => acting.value || confirmingDiscard.value || workspaceActing.value || mergeActing.value || loading.value || !snapshot.value?.isGit);
let snapshotRequest = 0, treeRequest = 0, codeRequest = 0, diffRequest = 0;
let selectionVersion = 0;

// Diff state
const selectedDiffFile = shallowRef('');
const selectedDiffStaged = shallowRef(false);
const diffContent = shallowRef('');
const diffLoading = shallowRef(false);
const diffLayout = shallowRef<'unified' | 'split'>('unified');
const diffPresentation = computed(() => presentGitDiff(diffContent.value));
const showSplitDiff = computed(() => diffLayout.value === 'split'
  && diffPresentation.value.lines.some(line => line.oldLine !== null || line.newLine !== null));
const splitDiffRows = computed(() => splitGitDiff(diffPresentation.value.lines));

// Commit state
const commitMessage = shallowRef('');

// Branch state
const newBranchName = shallowRef('feature/');
const newBranchStartRef = shallowRef('');

// Remote state
const remoteFormName = shallowRef('origin');
const remoteFormUrl = shallowRef('');
const selectedRemote = shallowRef('origin');
const canPushCurrentBranch = computed(() => !gitBusy.value && !!selectedRemote.value
  && !!snapshot.value?.branch && !!snapshot.value.head && !snapshot.value.mergeInProgress && !snapshot.value.counts.conflicts);

// Code browser state
const currentDir = shallowRef('');
const parentDir = shallowRef('');
const treeEntries = ref<TreeEntry[]>([]);
const treeLoading = shallowRef(false);
const codeFile = shallowRef('');
const codeContent = shallowRef('');
const codeLoading = shallowRef(false);
const editorTarget = shallowRef<{ directory: string; file: string; initialLine?: number }>();

function editFile(file: string, directory = props.project?.path) {
  if (file && directory && !gitBusy.value) editorTarget.value = {
    directory, file,
    initialLine: file === selectedDiffFile.value ? diffPresentation.value.firstChangedLine : undefined,
  };
}

async function afterFileSaved() {
  emit('refreshed');
  await loadSnapshot();
  if (selectedDiffFile.value) {
    const file = snapshot.value?.files.find(item => item.path === selectedDiffFile.value);
    void viewDiff(selectedDiffFile.value, !!file?.staged && !file.unstaged);
  }
  if (codeFile.value) void loadCode(codeFile.value);
}

const conflictCount = computed(() => snapshot.value?.counts.conflicts ?? 0);
const conflictFiles = computed(() => (snapshot.value?.files || []).filter((f) => f.conflict));
const stagedFiles = computed(() => (snapshot.value?.files || []).filter((f) => !f.conflict && f.staged));
const unstagedFiles = computed(() => (snapshot.value?.files || []).filter((f) => !f.conflict && (f.unstaged || f.untracked)));
const localBranches = computed(() => (snapshot.value?.branches || []).filter(branch => !branch.remote)
  .sort((left, right) => Number(right.current) - Number(left.current)));
const remoteBranches = computed(() => (snapshot.value?.branches || []).filter((b) => b.remote));

function applySnapshot(data: GitSnapshot) {
  snapshot.value = data;
  if (!data.remotes.some(remote => remote.name === selectedRemote.value)) selectedRemote.value = data.remotes[0]?.name || '';
  if (data.remotes.length && !remoteFormUrl.value) {
    const origin = data.remotes.find(remote => remote.name === 'origin') || data.remotes[0];
    remoteFormName.value = origin.name;
    remoteFormUrl.value = origin.url;
  }
}

function isCurrentBranch(branch: GitBranchItem) {
  return branch.current || (branch.remote && !!branch.localBranch && branch.localBranch === snapshot.value?.branch);
}

function switchLabel(branch: GitBranchItem) {
  if (isCurrentBranch(branch)) return '当前分支';
  if (branch.worktreePaths?.some(directory => directory !== snapshot.value?.directory)) return '已在其他工作区';
  if (branch.switchBlockedReason) return '需选择本地分支';
  return branch.remote ? '检出 / 切换' : '切换至此分支';
}

async function loadSnapshot() {
  if (!props.project?.path) return;
  const requestedPath = props.project.path;
  const request = ++snapshotRequest;
  loading.value = true;
  try {
    const res = await fetch(`/api/projects/git/snapshot?path=${encodeURIComponent(props.project.path)}`);
    const data = await res.json();
    if (request !== snapshotRequest || props.project?.path !== requestedPath) return;
    if (!res.ok) throw new Error(data.message || '读取 Git 状态失败');
    applySnapshot(data);
  } catch (err) {
    if (request !== snapshotRequest || props.project?.path !== requestedPath) return;
    ElMessage.error(err instanceof Error ? err.message : '读取 Git 状态失败');
  } finally {
    if (request === snapshotRequest && props.project?.path === requestedPath) loading.value = false;
  }
}

async function loadTree(dir = '') {
  if (!props.project?.path) return;
  const requestedPath = props.project.path;
  const request = ++treeRequest;
  treeLoading.value = true;
  try {
    const res = await fetch(`/api/projects/git/tree?path=${encodeURIComponent(props.project.path)}&dir=${encodeURIComponent(dir)}`);
    const data = await res.json();
    if (request !== treeRequest || props.project?.path !== requestedPath) return;
    if (!res.ok) throw new Error(data.message || '读取目录失败');
    currentDir.value = data.path;
    parentDir.value = data.parent;
    treeEntries.value = data.entries || [];
  } catch (err) {
    if (request !== treeRequest || props.project?.path !== requestedPath) return;
    ElMessage.error(err instanceof Error ? err.message : '读取目录失败');
  } finally {
    if (request === treeRequest && props.project?.path === requestedPath) treeLoading.value = false;
  }
}

async function loadCode(file: string) {
  if (!props.project?.path) return;
  const requestedPath = props.project.path;
  const request = ++codeRequest;
  codeLoading.value = true;
  codeFile.value = file;
  codeContent.value = '';
  try {
    const res = await fetch(`/api/projects/git/code?path=${encodeURIComponent(props.project.path)}&file=${encodeURIComponent(file)}`);
    const data = await res.json();
    if (request !== codeRequest || props.project?.path !== requestedPath) return;
    if (!res.ok) throw new Error(data.message || '读取文件失败');
    codeContent.value = data.content || '';
  } catch (err) {
    if (request !== codeRequest || props.project?.path !== requestedPath) return;
    codeContent.value = '';
    ElMessage.error(err instanceof Error ? err.message : '读取文件失败');
  } finally {
    if (request === codeRequest && props.project?.path === requestedPath) codeLoading.value = false;
  }
}

async function viewDiff(file: string, staged: boolean) {
  if (!props.project?.path) return;
  const requestedPath = props.project.path;
  const request = ++diffRequest;
  selectedDiffFile.value = file;
  selectedDiffStaged.value = staged;
  diffLoading.value = true;
  diffContent.value = '';
  try {
    const res = await fetch(
      `/api/projects/git/diff?path=${encodeURIComponent(props.project.path)}&file=${encodeURIComponent(file)}&staged=${staged ? 'true' : 'false'}`,
    );
    const data = await res.json();
    if (request !== diffRequest || props.project?.path !== requestedPath) return;
    if (!res.ok) throw new Error(data.message || '读取差异失败');
    diffContent.value = data.patch || '（无文本差异）';
  } catch (err) {
    if (request !== diffRequest || props.project?.path !== requestedPath) return;
    diffContent.value = '';
    ElMessage.error(err instanceof Error ? err.message : '读取差异失败');
  } finally {
    if (request === diffRequest && props.project?.path === requestedPath) diffLoading.value = false;
  }
}

function pushResultTitle(remote: string, output: string) {
  // git push --porcelain returns the status flag and destination ref as tab-separated fields.
  const result = /^([* =+])\t[^:\t\r\n]+:refs\/heads\/([^\t\r\n]+)\t/m.exec(output);
  if (!result) return `推送成功，目标远端为「${remote}」。`;
  const [, status, branch] = result;
  const target = `${remote}/${branch}`;
  if (status === '*') return `推送成功，已创建远端分支「${target}」。`;
  if (status === '=') return `远端分支「${target}」已是最新。`;
  return `推送成功，已更新远端分支「${target}」。`;
}

async function runAction(payload: Record<string, unknown>, successMsg?: string) {
  if (!props.project?.path || gitBusy.value) return false;
  const requestedPath = props.project.path;
  const selectedVersion = selectionVersion;
  ++snapshotRequest;
  lastOutput.value = undefined;
  showGitOutput.value = false;
  acting.value = true;
  try {
    const res = await fetch('/api/projects/git/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: props.project.path,
        revision: snapshot.value?.revision,
        ...payload,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Git 操作未完成');
    const sameSelection = selectedVersion === selectionVersion && props.project?.path === requestedPath;
    if (sameSelection) {
      if (data.snapshot) applySnapshot(data.snapshot);
      const output = typeof data.output === 'string' ? data.output : '';
      if (payload.action === 'push' && typeof payload.remote === 'string') {
        lastOutput.value = { title: pushResultTitle(payload.remote, output), type: 'success', details: output };
      } else if (output) {
        lastOutput.value = { title: output, type: 'info' };
      }
      if (['stage', 'stage-all', 'unstage', 'unstage-all', 'commit', 'create-branch', 'switch', 'merge', 'abort-merge', 'pull'].includes(String(payload.action))) {
        ++diffRequest;
        selectedDiffFile.value = ''; diffContent.value = ''; diffLoading.value = false;
      }
      if (payload.action === 'discard') {
        if (selectedDiffFile.value === payload.file && !selectedDiffStaged.value) {
          ++diffRequest;
          selectedDiffFile.value = ''; diffContent.value = ''; diffLoading.value = false;
        }
        if (codeFile.value === payload.file) {
          ++codeRequest;
          codeFile.value = ''; codeContent.value = ''; codeLoading.value = false;
        }
        void loadTree(currentDir.value);
      }
      if (['create-branch', 'switch', 'merge', 'abort-merge', 'pull'].includes(String(payload.action))) {
        ++codeRequest;
        codeFile.value = ''; codeContent.value = ''; codeLoading.value = false;
        void loadTree('');
      }
    }
    if (data.outcome === 'merge-conflicts') {
      if (sameSelection) {
        activeTab.value = 'changes';
        ElMessage.warning(`有 ${data.snapshot.counts.conflicts} 个文件需要处理冲突，解决后即可继续合并。`);
      }
      emit('refreshed');
      return false;
    }
    if (successMsg) ElMessage.success(successMsg);
    emit('refreshed');
    return sameSelection;
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : 'Git 操作失败');
    if (selectedVersion === selectionVersion && props.project?.path === requestedPath) await loadSnapshot();
    return false;
  } finally {
    acting.value = false;
  }
}

async function discardFile(file: GitFileItem) {
  const current = snapshot.value;
  if (gitBusy.value || !current?.revision) return;
  const selectedVersion = selectionVersion;
  const consequence = file.untracked ? '将从磁盘删除这个未跟踪文件。'
    : file.staged ? '将恢复到已暂存的版本，保留暂存内容。' : '将恢复文件的 Git 版本。';
  confirmingDiscard.value = true;
  try {
    await ElMessageBox.confirm(`「${file.path}」\n${consequence}丢弃的内容无法通过 Git 恢复。`, '丢弃文件改动', {
      type: 'warning', confirmButtonText: file.untracked ? '删除文件' : '丢弃改动', cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger', closeOnClickModal: false, autofocus: false,
    });
  } catch { return; }
  finally { confirmingDiscard.value = false; }
  if (!props.modelValue || selectionVersion !== selectedVersion) return;
  await runAction({ action: 'discard', file: file.path, revision: current.revision, confirmed: true },
    file.untracked ? '已删除未跟踪文件' : '已丢弃未暂存改动');
}

async function commitChanges() {
  if (!commitMessage.value.trim()) {
    ElMessage.warning('请填写提交说明');
    return;
  }
  const ok = await runAction({ action: 'commit', message: commitMessage.value.trim() }, '已提交到本地仓库');
  if (ok) {
    commitMessage.value = '';
    selectedDiffFile.value = '';
    diffContent.value = '';
  }
}

async function createBranch() {
  const name = newBranchName.value.trim();
  if (!name) {
    ElMessage.warning('请输入新分支名称');
    return;
  }
  const ok = await runAction({ action: 'create-branch', branch: name, startRef: newBranchStartRef.value || undefined }, `已创建并切换到分支 ${name}`);
  if (ok) { newBranchName.value = 'feature/'; newBranchStartRef.value = ''; }
}

async function switchBranch(refName: string) {
  const ok = await runAction({ action: 'switch', ref: refName });
  if (ok) ElMessage.success(`已切换到分支 ${snapshot.value?.branch}`);
}

function pushCurrentBranch() {
  if (!canPushCurrentBranch.value) return;
  void runAction({ action: 'push', remote: selectedRemote.value });
}

async function saveRemote() {
  const name = remoteFormName.value.trim();
  const url = remoteFormUrl.value.trim();
  if (!name || !url) {
    ElMessage.warning('请填写远程名称和仓库地址');
    return;
  }
  const exists = snapshot.value?.remotes.some((r) => r.name === name);
  await runAction(
    { action: exists ? 'update-remote' : 'connect', name, url },
    exists ? `已更新远程仓库 ${name}` : `已连接远程仓库 ${name}`,
  );
}

async function openExternal(endpoint: '/api/workspace/cursor' | '/api/workspace/terminal') {
  if (!props.project?.path) return;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspacePath: props.project.path }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || '打开失败');
    ElMessage.success(data.message || '已打开');
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '打开失败');
  }
}

watch(() => props.project?.projectId, () => { workspaceSearch.value = ''; });

watch(
  () => [props.modelValue, props.project?.path] as const,
  ([open, projectPath]) => {
    ++selectionVersion; ++snapshotRequest; ++treeRequest; ++codeRequest; ++diffRequest;
    loading.value = false; treeLoading.value = false; codeLoading.value = false; diffLoading.value = false;
    if (open && projectPath) {
      snapshot.value = undefined;
      codeLoading.value = false;
      diffLoading.value = false;
      remoteFormName.value = 'origin';
      remoteFormUrl.value = '';
      selectedRemote.value = 'origin';
      currentDir.value = '';
      treeEntries.value = [];
      commitMessage.value = '';
      newBranchStartRef.value = '';
      mergeActing.value = false;
      selectedDiffFile.value = '';
      diffContent.value = '';
      codeFile.value = '';
      codeContent.value = '';
      lastOutput.value = undefined;
      void loadSnapshot();
      void loadTree('');
    }
  },
  { immediate: true },
);
</script>

<template>
  <el-drawer
    v-model="visible"
    :title="project?.displayName || project?.projectName || '本地项目与 Git 管理'"
    size="min(1640px, 96vw)"
    class="project-git-drawer"
    destroy-on-close
  >
    <template #header="{ titleId, titleClass }">
      <div class="git-drawer-title">
        <h2 :id="titleId" :class="titleClass">{{ project?.displayName || project?.projectName || '本地项目与 Git 管理' }}</h2>
        <div v-if="project" class="workspace-utilities">
          <el-button link @click="emit('open-folder', project)">Finder 打开</el-button>
          <el-button link @click="emit('copy', project.path)">复制路径</el-button>
        </div>
      </div>
    </template>
    <div v-if="project" class="project-workspace-layout">
      <aside class="workspace-picker" aria-label="项目工作区">
        <div class="workspace-picker-heading"><strong>工作区</strong><span>{{ workspaces?.length || 1 }}</span></div>
        <el-input v-model="workspaceSearch" placeholder="搜索路径或分支" aria-label="搜索工作区" clearable />
        <div class="workspace-picker-list">
          <button v-for="item in visibleWorkspaces" :key="item.path" type="button" :class="{ active: item.path === project.path }" :aria-current="item.path === project.path ? 'true' : undefined" :disabled="acting || workspaceActing || mergeActing" @click="emit('select', item)">
            <span class="workspace-item-heading"><strong :title="item.folderName">{{ item.folderName }}</strong><span class="workspace-status" :class="{ dirty: !item.clean }">{{ item.clean ? '干净' : `${item.changed} 项改动` }}</span></span>
            <span class="workspace-item-branch" :title="item.branch">{{ item.branch }}</span>
            <small class="workspace-item-path" :title="item.displayPath">{{ item.displayPath }}</small>
          </button>
          <el-empty v-if="!visibleWorkspaces.length" description="没有匹配的工作区" :image-size="48" />
        </div>
      </aside>
      <div class="git-drawer">
      <div class="git-header surface">
        <div class="git-header-main">
          <div class="git-path-line">
            <span class="row-mono">{{ project.path }}</span>
          </div>
          <div v-if="snapshot" class="git-badges">
            <el-tag type="primary" effect="plain" :title="snapshot.branch">分支：{{ snapshot.branch || '游离 HEAD' }}</el-tag>
            <el-tag v-if="snapshot.upstream" effect="plain" :title="snapshot.upstream">跟踪：{{ snapshot.upstream }}</el-tag>
            <el-tag v-if="snapshot.ahead !== null || snapshot.behind !== null" type="info" effect="plain">
              领先 {{ snapshot.ahead ?? 0 }} · 落后 {{ snapshot.behind ?? 0 }}
            </el-tag>
            <el-tag :type="snapshot.clean ? 'success' : 'warning'" effect="plain">
              {{ snapshot.clean ? '工作树干净' : `${snapshot.counts.total} 项改动` }}
            </el-tag>
            <el-tag v-if="snapshot.mergeInProgress" type="warning" effect="plain">
              {{ conflictCount ? `合并进行中 · ${conflictCount} 个冲突` : '合并进行中' }}
            </el-tag>
          </div>
        </div>
        <div class="git-header-actions">
          <el-button size="small" @click="openExternal('/api/workspace/cursor')">Cursor 打开</el-button>
          <el-button size="small" @click="openExternal('/api/workspace/terminal')">终端打开</el-button>
          <el-button size="small" type="primary" plain @click="emit('compose', project)">带入 AI 会话</el-button>
          <el-button size="small" :loading="loading" :disabled="acting || mergeActing" @click="loadSnapshot">刷新状态</el-button>
          <ProjectWorkspaceActions :path="project.path" :revision="snapshot?.revision" :disabled="acting || loading || mergeActing"
            @busy="workspaceActing = $event" @removed="emit('workspace-removed', $event)" />
        </div>
      </div>

      <el-alert
        v-if="lastOutput"
        :title="lastOutput.title"
        :type="lastOutput.type"
        :description="showGitOutput ? lastOutput.details : undefined"
        show-icon
        closable
        class="git-output-alert"
        @close="lastOutput = undefined"
      >
        <template v-if="lastOutput.details" #title>
          {{ lastOutput.title }}
          <el-button link type="primary" size="small" class="git-output-toggle"
            :aria-expanded="showGitOutput" @click="showGitOutput = !showGitOutput">
            {{ showGitOutput ? '收起 Git 原始输出' : '查看 Git 原始输出' }}
          </el-button>
        </template>
      </el-alert>

      <el-tabs v-model="activeTab" class="git-tabs">
        <!-- Tab 1: Changes & Commit -->
        <el-tab-pane :label="`改动与提交 (${snapshot?.counts.total ?? 0})`" name="changes">
          <div class="git-changes-layout">
            <div class="git-files-col">
              <div v-if="conflictCount" class="surface git-box">
                <div class="git-box-header"><strong>待解决冲突 ({{ conflictCount }})</strong></div>
                <div class="git-file-list">
                  <div v-for="item in conflictFiles" :key="item.path" class="git-file-row">
                    <span class="git-status-badge conflict">{{ item.status }}</span>
                    <span class="git-file-path" :title="item.path">{{ item.path }}</span>
                    <el-button link type="primary" size="small" :disabled="gitBusy" @click="editFile(item.path, snapshot?.directory)">解决冲突</el-button>
                  </div>
                </div>
              </div>
              <div class="surface git-box">
                <div class="git-box-header">
                  <strong>已暂存 ({{ snapshot?.counts.staged ?? 0 }})</strong>
                  <el-button
                    v-if="stagedFiles.length"
                    link
                    type="warning"
                    :disabled="gitBusy || snapshot?.mergeInProgress || !!conflictCount"
                    @click="runAction({ action: 'unstage-all' }, '已全部取消暂存')"
                  >
                    全部取消暂存
                  </el-button>
                </div>
                <div v-if="stagedFiles.length" class="git-file-list">
                  <div
                    v-for="item in stagedFiles"
                    :key="`staged-${item.path}`"
                    class="git-file-row"
                    :class="{ active: selectedDiffFile === item.path && selectedDiffStaged }"
                    @click="viewDiff(item.path, true)"
                  >
                    <span class="git-status-badge staged">{{ item.status }}</span>
                    <span class="git-file-path" :title="item.path">{{ item.path }}</span>
                    <el-button
                      link
                      size="small"
                      :disabled="gitBusy"
                      @click.stop="runAction({ action: 'unstage', files: [item.path] })"
                    >
                      取消暂存
                    </el-button>
                  </div>
                </div>
                <p v-else class="git-empty-hint">暂无已暂存文件</p>
              </div>

              <div class="surface git-box">
                <div class="git-box-header">
                  <strong>未暂存 / 未跟踪 ({{ unstagedFiles.length }})</strong>
                  <el-button
                    v-if="unstagedFiles.length"
                    link
                    type="primary"
                    :disabled="gitBusy || !!conflictCount"
                    @click="runAction({ action: 'stage-all' }, '已全部暂存')"
                  >
                    全部暂存
                  </el-button>
                </div>
                <div v-if="unstagedFiles.length" class="git-file-list">
                  <div
                    v-for="item in unstagedFiles"
                    :key="`unstaged-${item.path}`"
                    class="git-file-row"
                    :class="{ active: selectedDiffFile === item.path && !selectedDiffStaged }"
                    @click="viewDiff(item.path, false)"
                  >
                    <span class="git-status-badge">{{ item.status }}</span>
                    <span class="git-file-path" :title="item.path">{{ item.path }}</span>
                    <el-button
                      link
                      type="primary"
                      size="small"
                      :disabled="gitBusy"
                      @click.stop="runAction({ action: 'stage', files: [item.path] })"
                    >
                      暂存
                    </el-button>
                    <el-button
                      v-if="!item.path.endsWith('/')"
                      link
                      type="danger"
                      size="small"
                      :disabled="gitBusy"
                      :title="item.untracked ? '删除未跟踪文件' : '丢弃未暂存改动'"
                      :aria-label="`丢弃 ${item.path}`"
                      @click.stop="discardFile(item)"
                    >
                      丢弃
                    </el-button>
                  </div>
                </div>
                <p v-else class="git-empty-hint">工作树无未暂存改动</p>
              </div>

              <div class="surface git-box">
                <div class="git-box-header">
                  <strong>{{ snapshot?.mergeInProgress ? '完成合并提交' : '提交改动 (Commit)' }}</strong>
                </div>
                <el-input
                  v-model="commitMessage"
                  :disabled="acting"
                  type="textarea"
                  :rows="3"
                  placeholder="输入本次 Git 提交说明（例如：feat: 完成列表筛选与接口联调）"
                />
                <div class="git-commit-actions">
                  <el-button
                    type="primary"
                    :loading="acting"
                    :disabled="gitBusy || !!conflictCount || (!stagedFiles.length && !snapshot?.mergeInProgress)"
                    @click="commitChanges"
                  >
                    {{ snapshot?.mergeInProgress ? '提交并完成合并' : `提交已暂存改动 (${stagedFiles.length})` }}
                  </el-button>
                  <el-button v-if="snapshot?.mergeInProgress" :disabled="gitBusy" @click="activeTab = 'merge'">查看合并状态 / 中止</el-button>
                  <el-button
                    v-if="snapshot?.remotes.length"
                    :loading="acting"
                    :disabled="!canPushCurrentBranch"
                    @click="pushCurrentBranch"
                  >
                    推送当前分支 (Push)
                  </el-button>
                </div>
              </div>
            </div>

            <div class="surface git-diff-col">
              <div class="git-preview-header">
                <div class="git-preview-title">
                  <span>差异预览</span>
                  <strong>{{ selectedDiffFile || '选择文件查看改动' }}</strong>
                </div>
                <div v-if="selectedDiffFile" class="git-preview-meta">
                  <el-radio-group v-model="diffLayout" size="small" aria-label="差异布局">
                    <el-radio-button value="unified">统一差异</el-radio-button>
                    <el-radio-button value="split">左右对比</el-radio-button>
                  </el-radio-group>
                  <el-button size="small" :disabled="gitBusy || diffLoading" @click="editFile(selectedDiffFile, snapshot?.directory)">{{ snapshot?.files.find(item => item.path === selectedDiffFile)?.conflict ? '解决冲突' : '编辑文件' }}</el-button>
                  <span v-if="!diffLoading && diffPresentation.added" class="git-diff-added">+{{ diffPresentation.added }}</span>
                  <span v-if="!diffLoading && diffPresentation.removed" class="git-diff-removed">-{{ diffPresentation.removed }}</span>
                  <el-tag size="small" effect="plain">{{ selectedDiffStaged ? '已暂存' : '工作区' }}</el-tag>
                </div>
              </div>
              <pre v-if="diffLoading" class="git-code-pre">正在加载差异...</pre>
              <div v-else-if="showSplitDiff" class="git-diff-view" tabindex="0" :aria-label="`左右对比：${selectedDiffFile}`">
                <div class="git-diff-pair git-diff-headings"><span>旧内容</span><span>新内容</span></div>
                <template v-for="(row, index) in splitDiffRows" :key="index">
                  <div v-if="'info' in row" class="git-diff-line" :class="`is-${row.info.kind}`"><code>{{ row.info.content }}</code></div>
                  <div v-else class="git-diff-pair">
                    <div v-for="(cell, side) in [row.old, row.next]" :key="side" class="git-diff-line git-diff-cell" :class="cell ? `is-${cell.line.kind}` : 'is-blank'">
                      <template v-if="cell">
                        <span class="git-line-number" aria-hidden="true">{{ side === 0 ? cell.line.oldLine : cell.line.newLine }}</span>
                        <span class="git-line-marker" aria-hidden="true">{{ cell.line.marker }}</span>
                        <code>{{ cell.line.content || ' ' }}<small v-if="cell.note" class="git-diff-note">{{ cell.note }}</small></code>
                      </template>
                    </div>
                  </div>
                </template>
              </div>
              <div v-else-if="selectedDiffFile" class="git-diff-view" tabindex="0" :aria-label="`差异预览：${selectedDiffFile}`">
                <div v-for="(line, index) in diffPresentation.lines" :key="index" class="git-diff-line" :class="`is-${line.kind}`">
                  <span class="git-line-number" aria-hidden="true">{{ line.oldLine }}</span>
                  <span class="git-line-number" aria-hidden="true">{{ line.newLine }}</span>
                  <span class="git-line-marker" aria-hidden="true">{{ line.marker }}</span>
                  <code>{{ line.content || ' ' }}</code>
                </div>
              </div>
              <div v-else class="git-diff-empty">选择左侧任意改动文件即可实时查看代码 Diff</div>
            </div>
          </div>
        </el-tab-pane>

        <!-- Tab 2: Branches -->
        <el-tab-pane :label="`分支管理 (${localBranches.length})`" name="branches">
          <div class="git-section-grid">
            <div class="surface git-box">
              <div class="git-box-header"><strong>新建分支</strong></div>
              <p class="row-secondary">选择新分支的起点；创建后自动切换，要求工作树干净。</p>
              <el-select v-model="newBranchStartRef" :disabled="gitBusy" aria-label="新分支起点" filterable>
                <el-option :value="''" :label="`当前 HEAD (${snapshot?.branch || '游离 HEAD'})`" />
                <el-option v-for="item in snapshot?.branches" :key="item.ref" :value="item.ref" :label="`${item.name}${item.remote ? ' (远端)' : ' (本地)'}`" />
              </el-select>
              <div class="git-inline-form">
                <el-input v-model="newBranchName" :disabled="acting" placeholder="例如 feature/PROJ-101" @keyup.enter="createBranch" />
                <el-button type="primary" :loading="acting" :disabled="gitBusy || !snapshot?.clean || snapshot?.mergeInProgress" @click="createBranch">创建并切换</el-button>
              </div>
            </div>

            <div class="surface git-box">
              <div class="git-box-header"><strong>合并代码与合并请求</strong></div>
              <p class="row-secondary">选择来源分支、预览改动后合入当前分支，或向远端目标分支创建合并请求。</p>
              <el-button type="primary" plain @click="activeTab = 'merge'">打开合并与请求</el-button>
            </div>
          </div>

          <div class="surface git-box">
            <div class="git-box-header">
              <strong>本地分支 ({{ localBranches.length }})</strong>
              <el-select v-if="snapshot && snapshot.remotes.length > 1" v-model="selectedRemote" size="small"
                :disabled="gitBusy" aria-label="推送远端" placeholder="选择推送远端" style="width: 148px">
                <el-option v-for="remote in snapshot.remotes" :key="remote.name" :value="remote.name" :label="remote.name" />
              </el-select>
              <span v-else-if="snapshot?.remotes.length" class="row-secondary">推送远端 {{ selectedRemote }}</span>
            </div>
            <el-table :data="localBranches" size="small" :max-height="260">
              <el-table-column label="分支名" min-width="180">
                <template #default="{ row }">
                  <strong>{{ row.name }}</strong>
                  <el-tag v-if="row.current" size="small" type="success" effect="plain" style="margin-left: 8px">当前分支</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="跟踪远端" min-width="160">
                <template #default="{ row }">
                  <span v-if="row.upstream">{{ row.upstream }}</span>
                  <span v-else class="row-secondary">未跟踪远端</span>
                </template>
              </el-table-column>
              <el-table-column label="HEAD" width="110">
                <template #default="{ row }"><span class="row-mono">{{ row.sha.slice(0, 8) }}</span></template>
              </el-table-column>
              <el-table-column label="操作" width="120">
                <template #default="{ row }">
                  <el-button
                    v-if="!row.current"
                    link
                    type="primary"
                    :disabled="gitBusy || !!row.switchBlockedReason || !snapshot?.clean || snapshot?.mergeInProgress"
                    :title="row.switchBlockedReason"
                    @click="switchBranch(row.ref)"
                  >
                    {{ switchLabel(row) }}
                  </el-button>
                  <el-button v-else-if="selectedRemote" link type="primary" :loading="acting" :disabled="!canPushCurrentBranch"
                    :title="'推送到 ' + selectedRemote" @click="pushCurrentBranch">
                    {{ row.upstream ? '推送' : '首次推送' }}
                  </el-button>
                  <el-button v-else link type="primary" @click="activeTab = 'remotes'">配置远端</el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>

          <div class="surface git-box">
            <div class="git-box-header"><strong>远端分支 ({{ remoteBranches.length }})</strong></div>
            <el-table :data="remoteBranches" size="small" :max-height="260">
              <el-table-column prop="name" label="远端分支" min-width="220" />
              <el-table-column prop="localBranch" label="对应本地分支" min-width="150" />
              <el-table-column label="HEAD" width="110">
                <template #default="{ row }"><span class="row-mono">{{ row.sha.slice(0, 8) }}</span></template>
              </el-table-column>
              <el-table-column label="操作" width="130">
                <template #default="{ row }">
                  <el-button link type="primary" :disabled="gitBusy || !!row.switchBlockedReason || isCurrentBranch(row) || !snapshot?.clean || snapshot?.mergeInProgress" :title="row.switchBlockedReason" @click="switchBranch(row.ref)">
                    {{ switchLabel(row) }}
                  </el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </el-tab-pane>

        <el-tab-pane label="合并与请求" name="merge" lazy>
          <ProjectGitMergePanel
            v-if="snapshot"
            :key="project.path"
            :path="project.path"
            :snapshot="snapshot"
            :busy="acting || workspaceActing || loading"
            :execute="runAction"
            @busy="mergeActing = $event"
            @snapshot="applySnapshot"
            @changes="activeTab = 'changes'"
          />
        </el-tab-pane>

        <!-- Tab 3: Remotes & Sync -->
        <el-tab-pane :label="`远端与同步 (${snapshot?.remotes.length ?? 0})`" name="remotes">
          <div class="surface git-box">
            <div class="git-box-header"><strong>远端同步操作</strong></div>
            <div class="git-sync-bar">
              <el-select v-model="selectedRemote" :disabled="acting" placeholder="选择远端" style="width: 160px">
                <el-option v-for="r in snapshot?.remotes" :key="r.name" :label="r.name" :value="r.name" />
              </el-select>
              <el-button
                :loading="acting"
                :disabled="gitBusy || !selectedRemote"
                @click="runAction({ action: 'test-remote', remote: selectedRemote }, '远端连接验证成功')"
              >
                测试连接
              </el-button>
              <el-button
                :loading="acting"
                :disabled="gitBusy || !selectedRemote"
                @click="runAction({ action: 'fetch', remote: selectedRemote }, '已获取远端最新分支信息')"
              >
                获取远端 (Fetch)
              </el-button>
              <el-button
                :loading="acting"
                :disabled="gitBusy || !snapshot?.upstream || !snapshot?.clean || snapshot?.mergeInProgress"
                @click="runAction({ action: 'pull' }, '已完成快进拉取 (Pull)')"
              >
                快进拉取 (Pull)
              </el-button>
              <el-button
                type="primary"
                :loading="acting"
                :disabled="!canPushCurrentBranch"
                @click="pushCurrentBranch"
              >
                推送当前分支 (Push)
              </el-button>
            </div>
          </div>

          <div class="surface git-box">
            <div class="git-box-header"><strong>配置 / 修改远程仓库连接</strong></div>
            <div class="git-remote-form">
              <el-input v-model="remoteFormName" :disabled="acting" placeholder="远程名称 (如 origin)" style="width: 160px" />
              <el-input v-model="remoteFormUrl" :disabled="acting" placeholder="SSH 或 HTTPS 仓库地址 (如 git@gitlab.example.com:team/repo.git)" />
              <el-button type="primary" :loading="acting" :disabled="gitBusy" @click="saveRemote">保存并验证远程</el-button>
            </div>
          </div>

          <div class="surface git-box">
            <div class="git-box-header"><strong>已连接的远程仓库</strong></div>
            <el-table :data="snapshot?.remotes || []" size="small">
              <el-table-column prop="name" label="名称" width="100" />
              <el-table-column prop="provider" label="平台" width="100" />
              <el-table-column prop="url" label="仓库地址" min-width="260">
                <template #default="{ row }">
                  <a v-if="row.webUrl" :href="safeUrl(row.webUrl)" target="_blank" class="row-mono">{{ row.url }}</a>
                  <span v-else class="row-mono">{{ row.url }}</span>
                </template>
              </el-table-column>
            </el-table>
          </div>
        </el-tab-pane>

        <!-- Tab 4: Code Browser & Commit Log -->
        <el-tab-pane label="代码浏览与提交历史" name="code">
          <div class="git-changes-layout git-code-layout">
            <div class="surface git-box git-files-col">
              <div class="git-box-header">
                <strong>目录：/{{ currentDir }}</strong>
                <el-button v-if="currentDir" link type="primary" @click="loadTree(parentDir)">返回上级</el-button>
              </div>
              <div v-if="treeLoading" class="git-empty-hint">正在读取目录...</div>
              <div v-else class="git-file-list">
                <div
                  v-for="entry in treeEntries"
                  :key="entry.path"
                  class="git-file-row"
                  :class="{ active: codeFile === entry.path }"
                  @click="entry.directory ? loadTree(entry.path) : loadCode(entry.path)"
                >
                  <span class="git-status-badge">{{ entry.directory ? 'DIR' : 'FILE' }}</span>
                  <span class="git-file-path">{{ entry.name }}</span>
                </div>
              </div>
            </div>

            <div class="surface git-diff-col">
              <div class="git-preview-header">
                <div class="git-preview-title"><span>文件预览</span><strong>{{ codeFile || '选择文件查看源码' }}</strong></div>
                <el-button v-if="codeFile" size="small" :disabled="gitBusy || codeLoading" @click="editFile(codeFile)">编辑文件</el-button>
              </div>
              <pre v-if="codeLoading" class="git-code-pre">正在读取文件...</pre>
              <pre v-else-if="codeFile" class="git-code-pre">{{ codeContent }}</pre>
              <div v-else class="git-diff-empty">选择左侧目录或代码文件即可直接浏览</div>
            </div>
          </div>

          <div class="surface git-box git-history">
            <div class="git-box-header"><strong>最近提交记录 ({{ snapshot?.log.length ?? 0 }})</strong></div>
            <el-table :data="snapshot?.log || []" size="small" :max-height="240">
              <el-table-column label="Commit" width="105">
                <template #default="{ row }"><span class="row-mono">{{ row.sha.slice(0, 8) }}</span></template>
              </el-table-column>
              <el-table-column prop="subject" label="提交说明" min-width="260" />
              <el-table-column prop="author" label="作者" width="130" />
              <el-table-column label="提交时间" width="165">
                <template #default="{ row }">{{ dateTime(row.date) }}</template>
              </el-table-column>
            </el-table>
          </div>
        </el-tab-pane>
      </el-tabs>
      </div>
    </div>
  </el-drawer>
  <ProjectCodeEditor v-if="editorTarget" :directory="editorTarget.directory" :file="editorTarget.file" :initial-line="editorTarget.initialLine" @close="editorTarget = undefined" @saved="afterFileSaved" />
</template>

<style scoped>
:global(.project-git-drawer .el-drawer__header) {
  margin: 0;
  padding: 14px 18px;
  border-bottom: 1px solid var(--ui-border, #e3e5eb);
}
:global(.project-git-drawer .el-drawer__body) {
  padding: 0;
  min-height: 0;
  overflow: hidden;
  display: flex;
}
.git-drawer-title { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex: 1; min-width: 0; }
.git-drawer-title h2 { margin: 0; font-size: 16px; line-height: 1.4; font-weight: 600; color: var(--ui-text); }
.workspace-utilities { display: flex; gap: 12px; flex-wrap: wrap; }
.workspace-utilities :deep(.el-button) { margin: 0; font-size: 12px; }
.project-workspace-layout { display: grid; grid-template-columns: 216px minmax(0, 1fr); width: 100%; min-width: 0; min-height: 0; }
.workspace-picker { display: flex; flex-direction: column; gap: 10px; padding: 16px 12px; min-height: 0; min-width: 0; border-right: 1px solid var(--ui-border, #e3e5eb); background: var(--ui-raised, #f8f9fc); }
.workspace-picker-heading { display: flex; align-items: center; justify-content: space-between; font-size: 13px; }
.workspace-picker-heading > span { color: var(--ui-muted); font-variant-numeric: tabular-nums; }
.workspace-picker-list { display: flex; flex-direction: column; gap: 6px; flex: 1; min-height: 0; overflow: auto; scrollbar-gutter: stable; }
.workspace-picker-list > button { display: flex; flex-direction: column; gap: 5px; width: 100%; min-width: 0; padding: 10px; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--ui-text); text-align: left; cursor: pointer; }
.workspace-picker-list > button:hover { background: var(--ui-accent-soft); }
.workspace-picker-list > button.active { background: var(--ui-surface); border-color: var(--ui-accent); }
.workspace-picker-list > button:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: -2px; }
.workspace-item-heading { display: flex; align-items: baseline; gap: 6px; width: 100%; min-width: 0; }
.workspace-item-heading strong { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 13px; line-height: 1.5; }
.workspace-item-heading .workspace-status { flex-shrink: 0; color: var(--el-color-success-dark-2); font-size: 11px; }
.workspace-item-heading .workspace-status.dirty { color: var(--el-color-warning-dark-2); }
.workspace-item-branch { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; line-height: 1.5; color: var(--ui-secondary); }
.workspace-item-path { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; color: var(--ui-muted); font-size: 11px; line-height: 1.5; }
.git-drawer { display: flex; flex-direction: column; gap: 12px; min-width: 0; min-height: 0; overflow: hidden; padding: 14px 18px 18px; }
.project-workspace-layout :is(.git-header, .git-box, .git-diff-col) { margin: 0; min-width: 0; box-shadow: none; border-radius: 9px; }
.git-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; flex: none; padding: 12px 14px; }
.git-header-main { min-width: 0; flex: 1 1 480px; }
.git-path-line { margin-bottom: 9px; min-width: 0; }
.git-path-line .row-mono { font-size: 12px; line-height: 1.5; color: var(--ui-secondary); overflow-wrap: anywhere; }
.git-badges { display: flex; flex-wrap: wrap; gap: 6px; }
.git-badges :deep(.el-tag) { max-width: 100%; font-size: 11px; }
.git-badges :deep(.el-tag__content) { overflow: hidden; text-overflow: ellipsis; }
.git-header-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.git-header-actions :deep(.el-button), .git-commit-actions :deep(.el-button) { margin: 0; }
.git-output-alert { flex: none; max-height: 110px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.git-output-toggle { margin-inline-start: 8px; }
.git-tabs { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; }
.git-tabs :deep(.el-tabs__header) { margin: 0 0 12px; flex: none; }
.git-tabs :deep(.el-tabs__item) { height: 40px; font-size: 13px; }
.git-tabs :deep(.el-tabs__content) { flex: 1; min-height: 0; overflow: auto; }
.git-tabs :deep(#pane-changes) { height: 100%; }
.git-changes-layout { display: grid; grid-template-columns: 272px minmax(0, 1fr); gap: 12px; height: 100%; min-height: 0; align-items: stretch; }
.git-files-col { display: flex; flex-direction: column; gap: 12px; min-width: 0; min-height: 0; overflow: auto; }
.git-files-col > .git-box { flex: none; }
.git-box { padding: 12px; }
.git-box-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; font-size: 13px; }
.git-box-header strong { min-width: 0; overflow-wrap: anywhere; font-weight: 600; }
.git-box-header :deep(.el-button) { margin: 0; font-size: 12px; flex-shrink: 0; }
.git-file-list { display: flex; flex-direction: column; gap: 3px; max-height: min(26dvh, 220px); overflow: auto; }
.git-file-row { display: flex; align-items: center; gap: 7px; padding: 9px 6px; border-radius: 5px; cursor: pointer; font-size: 12px; }
.git-file-row:hover, .git-file-row.active { background: var(--ui-accent-soft); }
.git-file-row :deep(.el-button) { margin: 0; flex-shrink: 0; font-size: 12px; }
.git-status-badge { font-family: var(--mono, monospace); font-size: 11px; padding: 2px 5px; border-radius: 4px; background: var(--ui-raised); color: var(--ui-secondary); flex-shrink: 0; }
.git-status-badge.staged { color: var(--el-color-success); }
.git-status-badge.conflict { color: var(--el-color-danger); font-weight: 600; }
.git-file-path { flex: 1; min-width: 0; overflow-wrap: anywhere; line-height: 1.6; }
.git-empty-hint { font-size: 12px; color: var(--ui-muted); margin: 4px 0; line-height: 1.6; }
.git-commit-actions { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.git-commit-actions :deep(.el-button) { width: 100%; }
.git-diff-col { display: flex; flex-direction: column; min-height: 0; padding: 0; overflow: hidden; }
.git-preview-header { display: flex; align-items: center; justify-content: space-between; flex: none; flex-wrap: wrap; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--ui-border, #e3e5eb); }
.git-preview-title { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.git-preview-title > span { color: var(--ui-muted); font-size: 11px; }
.git-preview-title strong { font: 600 13px/1.5 var(--mono, monospace); color: var(--ui-text); overflow-wrap: anywhere; }
.git-preview-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; font-size: 12px; font-variant-numeric: tabular-nums; }
.git-diff-added { color: var(--el-color-success-dark-2); }
.git-diff-removed { color: var(--el-color-danger); }
.git-diff-view { flex: 1; min-height: 0; min-width: 0; overflow: auto; padding: 4px 0; background: var(--ui-surface); scrollbar-gutter: stable; }
.git-diff-view:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: -2px; }
.git-diff-line { display: grid; grid-template-columns: 50px 50px 24px minmax(0, 1fr); padding-right: 14px; min-height: 26px; color: var(--ui-text); font: 14px/1.85 var(--mono, ui-monospace, monospace); }
.git-diff-line code { min-width: 0; font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 2; }
.git-line-number { color: var(--ui-muted); font-size: 11px; text-align: right; padding-right: 8px; border-right: 1px solid color-mix(in srgb, var(--ui-border) 50%, transparent); font-variant-numeric: tabular-nums; user-select: none; }
.git-line-marker { text-align: center; user-select: none; }
.git-diff-line.is-add { background: color-mix(in srgb, var(--el-color-success) 9%, var(--ui-surface)); }
.git-diff-line.is-remove { background: color-mix(in srgb, var(--el-color-danger) 9%, var(--ui-surface)); }
.is-add .git-line-marker { color: var(--el-color-success-dark-2); }
.is-remove .git-line-marker { color: var(--el-color-danger); }
.git-diff-line.is-meta { color: var(--ui-muted); font-size: 11px; }
.git-diff-line.is-hunk { color: var(--ui-accent); background: var(--ui-raised); margin-block: 5px; font-size: 12px; }
.git-diff-line:is(.is-meta, .is-hunk) { grid-template-columns: minmax(0, 1fr); padding-inline: 14px; }
.git-diff-line:is(.is-meta, .is-hunk) :is(.git-line-number, .git-line-marker) { display: none; }
.git-diff-pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.git-diff-pair > :first-child { border-right: 1px solid var(--ui-border); }
.git-diff-headings { position: sticky; top: 0; z-index: 1; background: var(--ui-raised); color: var(--ui-secondary); font-size: 12px; border-bottom: 1px solid var(--ui-border); }
.git-diff-headings span { padding: 6px 12px; }
.git-diff-line.git-diff-cell { grid-template-columns: 42px 18px minmax(0, 1fr); font-size: 13px; padding-right: 8px; }
.git-diff-cell.is-blank { background: var(--ui-raised); }
.git-diff-note { display: block; color: var(--ui-muted); font-size: 11px; }
.git-code-pre { flex: 1; min-height: 0; min-width: 0; max-width: 100%; margin: 0; padding: 14px; background: var(--ui-raised, #f8f9fc); color: var(--ui-text); font: 13px/1.8 var(--mono, ui-monospace, monospace); overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 2; }
.git-diff-empty { display: grid; place-items: center; flex: 1; min-height: 240px; padding: 24px; color: var(--ui-muted); text-align: center; font-size: 13px; }
.git-section-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-bottom: 12px; }
.git-tabs :deep(#pane-branches) > .git-box, .git-tabs :deep(#pane-remotes) > .git-box { margin-bottom: 12px; }
.git-inline-form, .git-remote-form, .git-sync-bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 10px; }
.git-inline-form :deep(.el-select), .git-remote-form :deep(.el-input:nth-child(2)) { flex: 1; min-width: 140px; }
.git-inline-form :deep(.el-input) { flex: 1; min-width: 140px; }
.git-sync-bar :deep(.el-button), .git-remote-form :deep(.el-button) { margin: 0; }
.git-code-layout { height: min(56dvh, 600px); min-height: 320px; }
.git-code-layout .git-files-col { overflow: hidden; }
.git-code-layout .git-file-list { flex: 1; min-height: 0; max-height: none; }
.git-history { margin-top: 12px; }
@media (max-width: 1150px) {
  .project-workspace-layout { grid-template-columns: 188px minmax(0, 1fr); }
  .git-drawer { padding: 12px; }
  .git-changes-layout { grid-template-columns: 230px minmax(0, 1fr); }
  .git-header-main { flex-basis: 100%; }
  .git-preview-header { flex-wrap: wrap; gap: 8px; }
  .git-diff-line { grid-template-columns: 44px 44px 20px minmax(0, 1fr); font-size: 13px; padding-right: 10px; }
  .git-line-number { padding-right: 5px; font-size: 10px; }
}
@media (max-width: 760px) {
  :global(.project-git-drawer.el-drawer) { width: 100vw !important; }
  :global(.project-git-drawer .el-drawer__header) { padding: 12px; }
  .git-drawer-title { flex-wrap: wrap; gap: 6px; }
  .git-drawer-title h2 { font-size: 15px; }
  .workspace-utilities { gap: 10px; }
  .workspace-utilities :deep(.el-button) { font-size: 11px; }
  .project-workspace-layout { display: flex; flex-direction: column; }
  .workspace-picker { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px 14px; flex: none; padding: 10px 12px; border-right: 0; border-bottom: 1px solid var(--ui-border); }
  .workspace-picker-heading { gap: 8px; }
  .workspace-picker-list { grid-column: 1 / -1; flex-direction: row; overflow-x: auto; overflow-y: hidden; max-height: 104px; }
  .workspace-picker-list > button { flex: 0 0 218px; padding: 8px; }
  .workspace-item-path { -webkit-line-clamp: 1; }
  .git-drawer { flex: 1; padding: 10px; gap: 10px; }
  .git-header { padding: 10px; gap: 10px; }
  .git-tabs :deep(.el-tabs__item) { padding-inline: 12px; font-size: 12px; }
  .git-tabs :deep(#pane-changes) { height: auto; }
  .git-changes-layout, .git-section-grid { display: flex; flex-direction: column; height: auto; }
  .git-files-col { overflow: visible; }
  .git-file-list { max-height: 170px; }
  .git-diff-col { min-height: 360px; }
  .git-diff-view, .git-code-pre { max-height: 65dvh; }
  .git-code-layout .git-files-col { max-height: 220px; }
  .git-code-layout .git-diff-col { min-height: 320px; }
  .git-preview-header { padding: 10px; }
  .git-preview-title strong { font-size: 12px; }
}
</style>
