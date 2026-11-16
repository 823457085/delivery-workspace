<script setup lang="ts">
import { computed, ref, shallowRef, useTemplateRef, watch } from 'vue';
import { Archive, Check, ChevronLeft, ChevronRight, Copy, Layers, Search } from '@lucide/vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { LocalProject } from '../../../shared/hub';
import { dateTime, safeUrl } from '../../shared/format';
import { presentGitDiff, splitGitDiff } from './git-diff';
import {
  CONVENTIONAL_COMMIT_TYPES,
  analyzeCommitMessage,
  applyConventionalPrefix,
  detectConventionalType,
  extractDiffHunkIndices,
  splitGitFilePath,
} from './git-commit-studio';
import ProjectCodeEditor from './ProjectCodeEditor.vue';
import ProjectWorkspaceActions from './ProjectWorkspaceActions.vue';
import ProjectGitMergePanel from './ProjectGitMergePanel.vue';
import { isSensitiveCommitPath } from '../../../shared/diff-review-hygiene';
import { parseUnifiedDiffHunks } from '../../../shared/git-hunk-patch';
import { planAtomicCommitLanes, type AtomicCommitLane } from '../../../shared/git-commit-lanes';
import type {
  GitBranchItem,
  GitCommitAssist,
  GitCommitDetail,
  GitCommitItem,
  GitFileItem,
  GitSnapshot,
  GitStashItem,
  WorktreeConflictRadarReport,
  WorktreeSiblingRadarItem,
} from './project-git-types';

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
const selectedStashRef = shallowRef('');
const diffContent = shallowRef('');
const diffLoading = shallowRef(false);
const diffLayout = shallowRef<'unified' | 'split'>('unified');
const changedFileFilter = shallowRef('');
const diffCopied = shallowRef(false);
const hunkCursor = shallowRef(0);
const diffViewport = useTemplateRef<HTMLElement>('diffViewport');
const diffPresentation = computed(() => presentGitDiff(diffContent.value));
const parsedDiffPatch = computed(() => parseUnifiedDiffHunks(diffContent.value));
const hunkAnchors = computed(() => extractDiffHunkIndices(diffPresentation.value.lines));
const showSplitDiff = computed(() => diffLayout.value === 'split'
  && diffPresentation.value.lines.some(line => line.oldLine !== null || line.newLine !== null));
const splitDiffRows = computed(() => splitGitDiff(diffPresentation.value.lines));
const hunkIndexByLine = computed(() => {
  const map = new Map<number, number>();
  let hunkIdx = 0;
  diffPresentation.value.lines.forEach((line, lineIdx) => {
    if (line.kind === 'hunk') map.set(lineIdx, hunkIdx++);
  });
  return map;
});
const splitHunkIndexByRow = computed(() => {
  const map = new Map<number, number>();
  let hunkIdx = 0;
  splitDiffRows.value.forEach((row, rowIdx) => {
    if ('info' in row && row.info.kind === 'hunk') map.set(rowIdx, hunkIdx++);
  });
  return map;
});
const canActOnDiffHunks = computed(() =>
  !gitBusy.value
  && !diffLoading.value
  && !selectedStashRef.value
  && !snapshot.value?.mergeInProgress
  && !conflictCount.value
  && parsedDiffPatch.value.canStageIndividualHunks
  && parsedDiffPatch.value.hunks.length > 0,
);

// Stash state
const showStashForm = shallowRef(false);
const stashNote = shallowRef('');
const stashMode = shallowRef<'all' | 'staged' | 'keep-index'>('all');
const stashItems = computed(() => snapshot.value?.stashes || []);
const activeStashItem = computed(() => stashItems.value.find(item => item.ref === selectedStashRef.value));

// Commit state
const commitMessage = shallowRef('');
const commitAssist = shallowRef<GitCommitAssist>();
const commitAssisting = shallowRef(false);
const showCommitLanes = shallowRef(false);
const commitLanePlan = computed(() => planAtomicCommitLanes(snapshot.value?.files || []));
const activeCommitType = computed(() => detectConventionalType(commitMessage.value));
const commitAnalysis = computed(() => analyzeCommitMessage(commitMessage.value));
let assistRequest = 0;

// Cross-worktree conflict radar state
const worktreeRadar = shallowRef<WorktreeConflictRadarReport>();
const worktreeRadarLoading = shallowRef(false);
const showRadarBanner = shallowRef(false);
let radarRequest = 0;

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
const selectedCommitDetail = shallowRef<GitCommitDetail>();
const commitDetailLoading = shallowRef(false);
const cherryPickSha = ref('');
let commitDetailRequest = 0;

const selectedCommitDiffPresentation = computed(() =>
  presentGitDiff(selectedCommitDetail.value?.patch || ''),
);

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
const normalizedFileFilter = computed(() => changedFileFilter.value.trim().toLocaleLowerCase());
const filteredStagedFiles = computed(() =>
  normalizedFileFilter.value
    ? stagedFiles.value.filter(f => f.path.toLocaleLowerCase().includes(normalizedFileFilter.value))
    : stagedFiles.value,
);
const filteredUnstagedFiles = computed(() =>
  normalizedFileFilter.value
    ? unstagedFiles.value.filter(f => f.path.toLocaleLowerCase().includes(normalizedFileFilter.value))
    : unstagedFiles.value,
);
const navigableDiffEntries = computed(() => [
  ...filteredStagedFiles.value.filter(f => !f.path.endsWith('/')).map(f => ({ path: f.path, staged: true })),
  ...filteredUnstagedFiles.value.filter(f => !f.path.endsWith('/')).map(f => ({ path: f.path, staged: false })),
]);
const activeDiffIndex = computed(() =>
  navigableDiffEntries.value.findIndex(e => e.path === selectedDiffFile.value && e.staged === selectedDiffStaged.value),
);
const localBranches = computed(() => (snapshot.value?.branches || []).filter(branch => !branch.remote)
  .sort((left, right) => Number(right.current) - Number(left.current)));
const remoteBranches = computed(() => (snapshot.value?.branches || []).filter((b) => b.remote));

function stepDiffFile(delta: -1 | 1) {
  const next = navigableDiffEntries.value[activeDiffIndex.value + delta];
  if (next) void viewDiff(next.path, next.staged);
}

function jumpNextHunk() {
  const anchors = hunkAnchors.value;
  if (!anchors.length || !diffViewport.value) return;
  const idx = hunkCursor.value % anchors.length;
  hunkCursor.value = (idx + 1) % anchors.length;
  const target = diffViewport.value.querySelector<HTMLElement>(`[data-diff-line-idx="${anchors[idx]!.lineIndex}"]`);
  target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function copyActiveDiff() {
  if (!diffContent.value.trim()) return;
  try {
    await navigator.clipboard.writeText(diffContent.value);
    diffCopied.value = true;
    setTimeout(() => { diffCopied.value = false; }, 1600);
  } catch {
    ElMessage.error('复制失败，请检查剪贴板权限');
  }
}

function toggleCommitPrefix(type: string) {
  if (acting.value) return;
  commitMessage.value = applyConventionalPrefix(commitMessage.value, type);
}

function onCommitKeydown(event: KeyboardEvent) {
  if (!(event.metaKey || event.ctrlKey) || event.key !== 'Enter') return;
  if (gitBusy.value || !!conflictCount.value || (!stagedFiles.value.length && !snapshot.value?.mergeInProgress)) return;
  event.preventDefault();
  void commitChanges();
}

function applySnapshot(data: GitSnapshot) {
  snapshot.value = data;
  commitAssist.value = undefined;
  if (!data.remotes.some(remote => remote.name === selectedRemote.value)) selectedRemote.value = data.remotes[0]?.name || '';
  if (data.remotes.length && !remoteFormUrl.value) {
    const origin = data.remotes.find(remote => remote.name === 'origin') || data.remotes[0];
    remoteFormName.value = origin.name;
    remoteFormUrl.value = origin.url;
  }
  if (activeTab.value === 'changes' && !selectedDiffFile.value) {
    const firstStaged = (data.files || []).find(f => !f.conflict && f.staged && !f.path.endsWith('/'));
    const firstUnstaged = (data.files || []).find(f => !f.conflict && (f.unstaged || f.untracked) && !f.path.endsWith('/'));
    if (firstStaged) void viewDiff(firstStaged.path, true);
    else if (firstUnstaged) void viewDiff(firstUnstaged.path, false);
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
  selectedStashRef.value = '';
  selectedDiffFile.value = file;
  selectedDiffStaged.value = staged;
  diffCopied.value = false;
  hunkCursor.value = 0;
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

async function viewStashDiff(stash: GitStashItem) {
  if (!props.project?.path) return;
  const requestedPath = props.project.path;
  const request = ++diffRequest;
  selectedDiffFile.value = '';
  selectedStashRef.value = stash.ref;
  diffCopied.value = false;
  hunkCursor.value = 0;
  diffLoading.value = true;
  diffContent.value = '';
  try {
    const res = await fetch(
      `/api/projects/git/stash-diff?path=${encodeURIComponent(props.project.path)}&stash=${encodeURIComponent(stash.ref)}`,
    );
    const data = await res.json();
    if (request !== diffRequest || props.project?.path !== requestedPath) return;
    if (!res.ok) throw new Error(data.message || '读取贮藏差异失败');
    diffContent.value = data.patch || '（无文本差异）';
  } catch (err) {
    if (request !== diffRequest || props.project?.path !== requestedPath) return;
    diffContent.value = '';
    ElMessage.error(err instanceof Error ? err.message : '读取贮藏差异失败');
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
        const fetchOutput = payload.action === 'fetch';
        lastOutput.value = fetchOutput || output.includes('\n')
          ? { title: successMsg || (fetchOutput ? '已获取远端分支' : 'Git 操作已完成'), type: 'info', details: output }
          : { title: output, type: 'info' };
      }
      const hunkAction = ['stage-hunk', 'unstage-hunk', 'discard-hunk'].includes(String(payload.action));
      const indexAction = ['stage', 'stage-all', 'unstage', 'unstage-all'].includes(String(payload.action));
      if (hunkAction && selectedDiffFile.value && data.snapshot) {
        const viewing = selectedDiffFile.value;
        const item = (data.snapshot.files as GitFileItem[]).find(file => file.path === viewing);
        if (!item) {
          ++diffRequest;
          selectedDiffFile.value = ''; diffContent.value = ''; diffLoading.value = false;
        } else {
          const keepCurrentSide = selectedDiffStaged.value ? item.staged : (item.unstaged || item.untracked);
          const nextStaged = keepCurrentSide ? selectedDiffStaged.value : item.staged;
          void viewDiff(viewing, nextStaged);
        }
        if (payload.action === 'discard-hunk' && codeFile.value === payload.file) {
          void loadCode(String(payload.file));
        }
      } else if (indexAction && selectedDiffFile.value && data.snapshot) {
        // 暂存/取消暂存后保留正在查看的文件：自动切换到该文件仍有差异的一侧，避免反复重新点选。
        const viewing = selectedDiffFile.value;
        const affected = payload.action === 'stage-all' || payload.action === 'unstage-all'
          || (Array.isArray(payload.files) && payload.files.includes(viewing));
        const item = (data.snapshot.files as GitFileItem[]).find(file => file.path === viewing);
        if (!item) { ++diffRequest; selectedDiffFile.value = ''; diffContent.value = ''; diffLoading.value = false; }
        else if (affected) {
          const preferStaged = String(payload.action).startsWith('stage');
          const staged = preferStaged ? item.staged || !(item.unstaged || item.untracked) : !(item.unstaged || item.untracked);
          void viewDiff(viewing, staged);
        }
      } else if (['stage', 'stage-all', 'unstage', 'unstage-all', 'commit', 'create-branch', 'switch', 'merge', 'abort-merge', 'pull', 'stash-push', 'stash-apply', 'stash-pop', 'stash-drop'].includes(String(payload.action))) {
        ++diffRequest;
        selectedDiffFile.value = ''; selectedStashRef.value = ''; diffContent.value = ''; diffLoading.value = false;
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
      if (['create-branch', 'switch', 'merge', 'abort-merge', 'pull', 'stash-push', 'stash-apply', 'stash-pop'].includes(String(payload.action))) {
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

async function stageDiffHunk(hunkIndex: number) {
  const hunk = parsedDiffPatch.value.hunks[hunkIndex];
  if (!selectedDiffFile.value || !hunk || gitBusy.value) return;
  await runAction(
    {
      action: 'stage-hunk',
      file: selectedDiffFile.value,
      hunkIndex,
      hunkHeader: hunk.header,
    },
    `已暂存第 ${hunkIndex + 1} 处变更块`,
  );
}

async function unstageDiffHunk(hunkIndex: number) {
  const hunk = parsedDiffPatch.value.hunks[hunkIndex];
  if (!selectedDiffFile.value || !hunk || gitBusy.value) return;
  await runAction(
    {
      action: 'unstage-hunk',
      file: selectedDiffFile.value,
      hunkIndex,
      hunkHeader: hunk.header,
    },
    `已取消暂存第 ${hunkIndex + 1} 处变更块`,
  );
}

async function discardDiffHunk(hunkIndex: number) {
  const current = snapshot.value;
  const hunk = parsedDiffPatch.value.hunks[hunkIndex];
  const file = selectedDiffFile.value;
  if (!file || !hunk || gitBusy.value || !current?.revision) return;
  const selectedVersion = selectionVersion;
  confirmingDiscard.value = true;
  try {
    await ElMessageBox.confirm(
      `「${file}」第 ${hunkIndex + 1} 处变更块（@@ ${hunk.rangeLabel} @@，+${hunk.added} / -${hunk.removed}）\n将从工作区丢弃此块修改并保留其余变更块，丢弃后无法通过 Git 恢复。`,
      '丢弃单个变更块',
      {
        type: 'warning',
        confirmButtonText: '丢弃此块',
        cancelButtonText: '取消',
        confirmButtonClass: 'el-button--danger',
        closeOnClickModal: false,
        autofocus: false,
      },
    );
  } catch {
    return;
  } finally {
    confirmingDiscard.value = false;
  }
  if (!props.modelValue || selectionVersion !== selectedVersion) return;
  await runAction(
    {
      action: 'discard-hunk',
      file,
      hunkIndex,
      hunkHeader: hunk.header,
      revision: current.revision,
      confirmed: true,
    },
    `已丢弃第 ${hunkIndex + 1} 处变更块`,
  );
}

async function applyCommitLane(lane: AtomicCommitLane) {
  if (gitBusy.value || !snapshot.value) return;
  const toUnstage = stagedFiles.value
    .filter(item => !lane.files.includes(item.path))
    .map(item => item.path);
  if (toUnstage.length) {
    const ok = await runAction({ action: 'unstage', files: toUnstage });
    if (!ok) return;
  }
  const latestFiles = snapshot.value?.files || [];
  const toStage = lane.files.filter((filePath) => {
    const found = latestFiles.find(item => item.path === filePath);
    return found && (!found.staged || found.unstaged || found.untracked);
  });
  if (toStage.length) {
    const ok = await runAction({ action: 'stage', files: toStage });
    if (!ok) return;
  }
  commitMessage.value = lane.suggestedSubject;
  ElMessage.success(`已按「${lane.label}」独立暂存 ${lane.files.length} 个文件并填入提交标题`);
}

async function pushStash(customMode?: 'all' | 'staged' | 'keep-index', customMessage?: string) {
  if (gitBusy.value || !snapshot.value?.head) return;
  const mode = customMode || stashMode.value;
  const message = (customMessage !== undefined ? customMessage : stashNote.value).trim();
  const ok = await runAction(
    { action: 'stash-push', mode, ...(message ? { message } : {}) },
    '已将改动推入 Git 贮藏栈',
  );
  if (ok) {
    stashNote.value = '';
    showStashForm.value = false;
  }
}

async function applyStash(stash: GitStashItem) {
  if (gitBusy.value) return;
  await runAction(
    { action: 'stash-apply', stash: stash.ref, stashSha: stash.sha },
    `已应用 ${stash.ref}（保留贮藏条目）`,
  );
}

async function popStash(stash: GitStashItem) {
  if (gitBusy.value) return;
  await runAction(
    { action: 'stash-pop', stash: stash.ref, stashSha: stash.sha },
    `已弹出并恢复 ${stash.ref}`,
  );
}

async function dropStash(stash: GitStashItem) {
  if (gitBusy.value) return;
  const selectedVersion = selectionVersion;
  confirmingDiscard.value = true;
  try {
    await ElMessageBox.confirm(
      `「${stash.ref} · ${stash.subject}」\n删除后将从贮藏栈永久移除且无法通过界面恢复。`,
      '删除贮藏条目',
      {
        type: 'warning',
        confirmButtonText: '确认删除',
        cancelButtonText: '取消',
        confirmButtonClass: 'el-button--danger',
        closeOnClickModal: false,
        autofocus: false,
      },
    );
  } catch {
    return;
  } finally {
    confirmingDiscard.value = false;
  }
  if (!props.modelValue || selectionVersion !== selectedVersion) return;
  await runAction(
    { action: 'stash-drop', stash: stash.ref, stashSha: stash.sha, confirmed: true },
    `已删除 ${stash.ref}`,
  );
}

async function inspectCommit(sha: string) {
  if (!props.project?.path || !sha) return;
  if (selectedCommitDetail.value?.sha === sha || selectedCommitDetail.value?.sha.startsWith(sha)) {
    selectedCommitDetail.value = undefined;
    return;
  }
  const requestedPath = props.project.path;
  const req = ++commitDetailRequest;
  commitDetailLoading.value = true;
  try {
    const res = await fetch(
      `/api/projects/git/commit-detail?path=${encodeURIComponent(props.project.path)}&sha=${encodeURIComponent(sha)}`,
    );
    const data = await res.json();
    if (req !== commitDetailRequest || props.project?.path !== requestedPath) return;
    if (!res.ok) throw new Error(data.message || '读取提交详情失败');
    selectedCommitDetail.value = data as GitCommitDetail;
  } catch (err) {
    if (req !== commitDetailRequest || props.project?.path !== requestedPath) return;
    ElMessage.error(err instanceof Error ? err.message : '读取提交详情失败');
  } finally {
    if (req === commitDetailRequest && props.project?.path === requestedPath) {
      commitDetailLoading.value = false;
    }
  }
}

function prepareFixupForCommit(commit: GitCommitItem) {
  const cleanSubject = commit.subject.replace(/^(?:fixup!|squash!)\s+/i, '').trim();
  commitMessage.value = `fixup! ${cleanSubject}`;
  activeTab.value = 'changes';
  ElMessage.success(`已填入 fixup! 标题（指向 ${commit.sha.slice(0, 8)}），请暂存修正块后提交`);
}

async function resolveConflictBySide(filePath: string, strategy: 'ours' | 'theirs') {
  if (gitBusy.value || !snapshot.value) return;
  const selectedVersion = selectionVersion;
  const sideLabel = strategy === 'ours' ? '当前分支 (Ours)' : '传入分支 (Theirs)';
  confirmingDiscard.value = true;
  try {
    await ElMessageBox.confirm(
      `冲突文件：${filePath}\n将整文件采用「${sideLabel}」侧结果并标记为已解决（适用于二进制冲突、超大文件或删改冲突）。`,
      `确认整文件冲突解决 · ${sideLabel}`,
      {
        type: 'warning',
        confirmButtonText: `采用${strategy === 'ours' ? '当前' : '对方'}`,
        cancelButtonText: '取消',
        closeOnClickModal: false,
        autofocus: false,
      },
    );
  } catch {
    return;
  } finally {
    confirmingDiscard.value = false;
  }
  if (!props.modelValue || selectionVersion !== selectedVersion) return;
  await runAction(
    { action: 'resolve-conflict', file: filePath, strategy, confirmed: true, revision: snapshot.value.revision },
    `已采用${strategy === 'ours' ? '当前分支' : '传入分支'}解决冲突：${filePath}`,
  );
}

async function abortActiveSequencer() {
  if (gitBusy.value || !snapshot.value?.sequencerState) return;
  const seqLabel = snapshot.value.sequencerState === 'rebase'
    ? '变基 (Rebase)'
    : snapshot.value.sequencerState === 'cherry-pick'
      ? '摘取 (Cherry-Pick)'
      : snapshot.value.sequencerState === 'revert'
        ? '回滚 (Revert)'
        : '合并 (Merge)';
  await runAction({ action: 'abort-sequencer' }, `已中止进行中的${seqLabel}`);
}

async function revertCommit(commit: GitCommitItem) {
  if (gitBusy.value || !snapshot.value?.clean || snapshot.value.mergeInProgress) return;
  const selectedVersion = selectionVersion;
  confirmingDiscard.value = true;
  try {
    await ElMessageBox.confirm(
      `目标提交：${commit.sha.slice(0, 8)} · ${commit.subject}\n将基于当前干净工作区创建一个反向抵消提交（git revert --no-edit），不改写已有历史。`,
      '安全回滚提交 (Revert)',
      {
        type: 'warning',
        confirmButtonText: '生成回滚提交',
        cancelButtonText: '取消',
        closeOnClickModal: false,
        autofocus: false,
      },
    );
  } catch {
    return;
  } finally {
    confirmingDiscard.value = false;
  }
  if (!props.modelValue || selectionVersion !== selectedVersion) return;
  const ok = await runAction(
    { action: 'revert-commit', sha: commit.sha, confirmed: true },
    `已回滚提交 ${commit.sha.slice(0, 8)}`,
  );
  if (ok) selectedCommitDetail.value = undefined;
}

async function submitCherryPick() {
  const sha = cherryPickSha.value.trim();
  if (!sha || gitBusy.value) return;
  const ok = await runAction(
    { action: 'cherry-pick', sha },
    `已将提交 ${sha.slice(0, 8)} 摘取到当前分支`,
  );
  if (ok) cherryPickSha.value = '';
}

async function requestCommitAssist(fillMode: 'auto' | 'subject' | 'full' | 'none' = 'auto') {
  if (!props.project?.path || commitAssisting.value) return undefined;
  const requestedPath = props.project.path;
  const selectedVersion = selectionVersion;
  const request = ++assistRequest;
  commitAssisting.value = true;
  try {
    const res = await fetch('/api/projects/git/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: props.project.path, action: 'commit-assist' }),
    });
    const data = await res.json();
    if (request !== assistRequest || selectionVersion !== selectedVersion || props.project?.path !== requestedPath) return undefined;
    if (!res.ok) throw new Error(data.message || '提交前体检失败');
    const assist = data.assist as GitCommitAssist | undefined;
    commitAssist.value = assist;
    if (assist && assist.scope !== 'clean') {
      if (fillMode === 'full') {
        commitMessage.value = assist.suggestedMessage;
      } else if (fillMode === 'subject' || (fillMode === 'auto' && !commitMessage.value.trim())) {
        commitMessage.value = assist.suggestedSubject;
      }
    }
    return assist;
  } catch (err) {
    if (request === assistRequest && fillMode !== 'none') {
      ElMessage.error(err instanceof Error ? err.message : '提交前体检失败');
    }
    return undefined;
  } finally {
    if (request === assistRequest) commitAssisting.value = false;
  }
}

async function commitChanges() {
  if (!commitMessage.value.trim()) {
    ElMessage.warning('请填写提交说明');
    return;
  }
  const selectedVersion = selectionVersion;
  let assist = commitAssist.value?.scope === 'staged' ? commitAssist.value : undefined;
  if (!assist && stagedFiles.value.length > 0) {
    assist = await requestCommitAssist('none');
    if (selectionVersion !== selectedVersion) return;
  }
  const blockers = (assist?.scope === 'staged' ? assist.hygieneWarnings : []).filter(item => item.severity === 'blocker');
  if (blockers.length > 0) {
    const summary = blockers.slice(0, 4).map(item => `• [${item.label}] ${item.file}${item.line ? `:${item.line}` : ''} — ${item.reason}`).join('\n');
    try {
      await ElMessageBox.confirm(
        `已暂存改动命中 ${blockers.length} 项提交前高危体检告警：\n\n${summary}\n\n确认并非真实凭据或未解冲突后，再继续提交到本地仓库？`,
        '提交前安全与冲突告警',
        {
          type: 'warning',
          confirmButtonText: '确认无误并提交',
          cancelButtonText: '返回核查',
          confirmButtonClass: 'el-button--danger',
          closeOnClickModal: false,
          autofocus: false,
        },
      );
    } catch {
      return;
    }
    if (!props.modelValue || selectionVersion !== selectedVersion) return;
  }
  const ok = await runAction({ action: 'commit', message: commitMessage.value.trim() }, '已提交到本地仓库');
  if (ok) {
    commitMessage.value = '';
    commitAssist.value = undefined;
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

function siblingRadarFor(item: LocalProject): WorktreeSiblingRadarItem | undefined {
  const radar = worktreeRadar.value;
  if (!radar || item.path === props.project?.path) return undefined;
  return radar.siblings.find(sib => sib.path === item.path || sib.folderName === item.folderName);
}

function openRadarFile(file: string) {
  const dirtyItem = snapshot.value?.files.find(item => item.path === file);
  if (dirtyItem) {
    activeTab.value = 'changes';
    void viewDiff(file, dirtyItem.staged && !(dirtyItem.unstaged || dirtyItem.untracked));
    return;
  }
  activeTab.value = 'code';
  void loadCode(file);
}

async function requestWorktreeRadar(silent = false) {
  if (!props.project?.path || worktreeRadarLoading.value) return undefined;
  const requestedPath = props.project.path;
  const selectedVersion = selectionVersion;
  const request = ++radarRequest;
  worktreeRadarLoading.value = true;
  try {
    const res = await fetch('/api/projects/git/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: props.project.path, action: 'worktree-radar' }),
    });
    const data = await res.json();
    if (request !== radarRequest || selectionVersion !== selectedVersion || props.project?.path !== requestedPath) return undefined;
    if (!res.ok) throw new Error(data.message || '跨工作区冲突检测失败');
    const radar = data.radar as WorktreeConflictRadarReport | undefined;
    worktreeRadar.value = radar;
    if (radar && (radar.conflictCount > 0 || radar.overlapCount > 0)) {
      showRadarBanner.value = true;
    } else if (!silent && radar) {
      showRadarBanner.value = true;
    }
    return radar;
  } catch (err) {
    if (request === radarRequest && !silent) {
      ElMessage.error(err instanceof Error ? err.message : '跨工作区冲突检测失败');
    }
    return undefined;
  } finally {
    if (request === radarRequest) worktreeRadarLoading.value = false;
  }
}

watch(
  () => [props.modelValue, props.project?.path] as const,
  ([open, projectPath]) => {
    ++selectionVersion; ++snapshotRequest; ++treeRequest; ++codeRequest; ++diffRequest; ++assistRequest; ++radarRequest; ++commitDetailRequest;
    loading.value = false; treeLoading.value = false; codeLoading.value = false; diffLoading.value = false; commitAssisting.value = false; worktreeRadarLoading.value = false; commitDetailLoading.value = false;
    if (open && projectPath) {
      snapshot.value = undefined;
      selectedCommitDetail.value = undefined;
      cherryPickSha.value = '';
      codeLoading.value = false;
      diffLoading.value = false;
      remoteFormName.value = 'origin';
      remoteFormUrl.value = '';
      selectedRemote.value = 'origin';
      currentDir.value = '';
      treeEntries.value = [];
      commitMessage.value = '';
      commitAssist.value = undefined;
      worktreeRadar.value = undefined;
      showRadarBanner.value = false;
      newBranchStartRef.value = '';
      mergeActing.value = false;
      changedFileFilter.value = '';
      selectedDiffFile.value = '';
      diffContent.value = '';
      codeFile.value = '';
      codeContent.value = '';
      lastOutput.value = undefined;
      void loadSnapshot();
      void loadTree('');
      if ((props.workspaces?.length || 0) > 1) {
        void requestWorktreeRadar(true);
      }
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
    append-to-body
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
        <div class="workspace-picker-heading">
          <strong>工作区 ({{ workspaces?.length || 1 }})</strong>
          <el-button
            link
            size="small"
            type="primary"
            :loading="worktreeRadarLoading"
            title="跨 Git Worktree 无损检测未提交改动与分支的三方冲突及同文件重叠"
            @click="requestWorktreeRadar(false)"
          >
            冲突雷达
          </el-button>
        </div>
        <el-input v-model="workspaceSearch" placeholder="搜索路径或分支" aria-label="搜索工作区" clearable />
        <div class="workspace-picker-list">
          <button v-for="item in visibleWorkspaces" :key="item.path" type="button" :class="{ active: item.path === project.path }" :aria-current="item.path === project.path ? 'true' : undefined" :disabled="acting || workspaceActing || mergeActing" @click="emit('select', item)">
            <span class="workspace-item-heading"><strong :title="item.folderName">{{ item.folderName }}</strong><span class="workspace-status" :class="{ dirty: !item.clean }">{{ item.clean ? '干净' : `${item.changed} 项改动` }}</span></span>
            <span class="workspace-item-meta">
              <span class="workspace-item-branch" :title="item.branch">{{ item.branch }}</span>
              <span
                v-if="siblingRadarFor(item)?.status === 'conflict'"
                class="workspace-radar-pill is-conflict"
                :title="`与当前工作区存在 ${siblingRadarFor(item)?.conflictingFiles.length} 个行级冲突文件`"
              >
                行冲突 {{ siblingRadarFor(item)?.conflictingFiles.length }}
              </span>
              <span
                v-else-if="siblingRadarFor(item)?.status === 'overlap'"
                class="workspace-radar-pill is-overlap"
                :title="`与当前工作区同时修改了 ${siblingRadarFor(item)?.overlappingFiles.length} 个相同文件`"
              >
                同文件 {{ siblingRadarFor(item)?.overlappingFiles.length }}
              </span>
            </span>
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
            <el-tag type="info" effect="plain" :title="snapshot.branch">分支：{{ snapshot.branch || '游离 HEAD' }}</el-tag>
            <el-tag v-if="snapshot.upstream" type="info" effect="plain" :title="snapshot.upstream">跟踪：{{ snapshot.upstream }}</el-tag>
            <el-tag v-if="snapshot.ahead !== null || snapshot.behind !== null" type="info" effect="plain">
              领先 {{ snapshot.ahead ?? 0 }} · 落后 {{ snapshot.behind ?? 0 }}
            </el-tag>
            <el-tag :type="snapshot.clean ? 'success' : 'warning'" effect="plain">
              {{ snapshot.clean ? '工作树干净' : `${snapshot.counts.total} 项改动` }}
            </el-tag>
            <el-tag v-if="snapshot.mergeInProgress" type="warning" effect="plain">
              {{ conflictCount ? `合并进行中 · ${conflictCount} 个冲突` : '合并进行中' }}
            </el-tag>
            <el-tag v-else-if="snapshot.sequencerState" type="warning" effect="plain">
              {{ snapshot.sequencerState === 'rebase' ? '变基进行中' : snapshot.sequencerState === 'cherry-pick' ? 'Cherry-Pick 进行中' : 'Revert 进行中' }}
              <el-button link type="danger" size="small" :disabled="gitBusy" @click="abortActiveSequencer">中止</el-button>
            </el-tag>
            <el-tag v-if="snapshot.truncated" type="danger" effect="plain">
              改动超过 200 项（已截断展示）
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

      <div
        v-if="showRadarBanner && worktreeRadar"
        class="git-worktree-radar"
        :class="{
          'is-conflict': worktreeRadar.conflictCount > 0,
          'is-overlap': worktreeRadar.conflictCount === 0 && worktreeRadar.overlapCount > 0,
        }"
      >
        <div class="git-worktree-radar-head">
          <strong>
            跨工作区冲突雷达
            <template v-if="worktreeRadar.siblingCount === 0"> · 当前无其他并行 Git Worktree</template>
            <template v-else-if="worktreeRadar.conflictCount === 0 && worktreeRadar.overlapCount === 0">
              · 已扫描 {{ worktreeRadar.siblingCount }} 个并行工作区，未见同文件碰撞
            </template>
            <template v-else>
              · 扫描 {{ worktreeRadar.siblingCount }} 个并行工作区：行级冲突 {{ worktreeRadar.conflictCount }} 处，同文件重叠 {{ worktreeRadar.overlapCount }} 处
            </template>
          </strong>
          <div class="git-worktree-radar-actions">
            <el-button link size="small" type="primary" :loading="worktreeRadarLoading" @click="requestWorktreeRadar(false)">重新扫描</el-button>
            <el-button link size="small" @click="showRadarBanner = false">收起</el-button>
          </div>
        </div>
        <ul v-if="worktreeRadar.conflictCount > 0 || worktreeRadar.overlapCount > 0" class="git-worktree-radar-list">
          <li
            v-for="sib in worktreeRadar.siblings.filter(item => item.status !== 'clean')"
            :key="sib.path"
          >
            <el-tag size="small" :type="sib.status === 'conflict' ? 'danger' : 'warning'" effect="plain">
              {{ sib.status === 'conflict' ? '行级冲突' : '同文件改动' }}
            </el-tag>
            <strong>{{ sib.folderName }}</strong>
            <span class="row-mono">({{ sib.branch }})</span>
            <span>涉及：</span>
            <button
              v-for="file in (sib.status === 'conflict' ? sib.conflictingFiles : sib.overlappingFiles).slice(0, 6)"
              :key="`${sib.path}-${file}`"
              type="button"
              class="git-hygiene-jump"
              @click="openRadarFile(file)"
            >
              {{ file }}
            </button>
          </li>
        </ul>
      </div>

      <el-alert
        v-if="lastOutput"
        :title="lastOutput.title"
        :type="lastOutput.type"
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
        <template #default>
          <span v-if="showGitOutput && lastOutput.details" class="git-output-details" role="region"
            aria-label="Git 原始输出" tabindex="0">{{ lastOutput.details }}</span>
        </template>
      </el-alert>

      <el-tabs v-model="activeTab" class="git-tabs">
        <!-- Tab 1: Changes & Commit -->
        <el-tab-pane :label="`改动与提交 (${snapshot?.counts.total ?? 0})`" name="changes">
          <div class="git-changes-layout">
            <div class="git-files-col">
              <div v-if="(snapshot?.files.length || 0) > 2" class="git-file-filter-bar">
                <el-input v-model="changedFileFilter" size="small" clearable placeholder="筛选改动文件名或目录…" aria-label="筛选改动文件" @keydown.esc="changedFileFilter = ''">
                  <template #prefix><Search :size="13" /></template>
                </el-input>
              </div>
              <div v-if="conflictCount" class="surface git-box">
                <div class="git-box-header"><strong>待解决冲突 ({{ conflictCount }})</strong></div>
                <div class="git-file-list">
                  <div v-for="item in conflictFiles" :key="item.path" class="git-file-row">
                    <span class="git-status-badge conflict">{{ item.status }}</span>
                    <span class="git-file-path" :title="item.path">
                      <strong class="git-file-base">{{ splitGitFilePath(item.path).base }}</strong>
                      <small v-if="splitGitFilePath(item.path).dir" class="git-file-dir">{{ splitGitFilePath(item.path).dir }}</small>
                    </span>
                    <el-button link size="small" :disabled="gitBusy" title="整文件保留当前分支版本（支持二进制与删改冲突）" @click="resolveConflictBySide(item.path, 'ours')">采用当前</el-button>
                    <el-button link size="small" :disabled="gitBusy" title="整文件采用合入分支版本（支持二进制与删改冲突）" @click="resolveConflictBySide(item.path, 'theirs')">采用对方</el-button>
                    <el-button link type="primary" size="small" :disabled="gitBusy" @click="editFile(item.path, snapshot?.directory)">打开编辑</el-button>
                  </div>
                </div>
              </div>
              <div class="surface git-box">
                <div class="git-box-header">
                  <strong>已暂存 ({{ normalizedFileFilter ? `${filteredStagedFiles.length}/${stagedFiles.length}` : (snapshot?.counts.staged ?? 0) }})</strong>
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
                <div v-if="filteredStagedFiles.length" class="git-file-list">
                  <div
                    v-for="item in filteredStagedFiles"
                    :key="`staged-${item.path}`"
                    class="git-file-row"
                    :class="{ active: selectedDiffFile === item.path && selectedDiffStaged }"
                    @click="viewDiff(item.path, true)"
                  >
                    <span class="git-status-badge staged">{{ item.status }}</span>
                    <span class="git-file-path" :title="item.path">
                      <strong class="git-file-base">{{ splitGitFilePath(item.path).base }}</strong>
                      <small v-if="splitGitFilePath(item.path).dir" class="git-file-dir">{{ splitGitFilePath(item.path).dir }}</small>
                    </span>
                    <el-tag v-if="isSensitiveCommitPath(item.path)" size="small" type="danger" effect="plain">敏感</el-tag>
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
                <p v-else class="git-empty-hint">{{ normalizedFileFilter && stagedFiles.length ? '无匹配的已暂存文件' : '暂无已暂存文件' }}</p>
              </div>

              <div class="surface git-box">
                <div class="git-box-header">
                  <strong>未暂存 / 未跟踪 ({{ normalizedFileFilter ? `${filteredUnstagedFiles.length}/${unstagedFiles.length}` : unstagedFiles.length }})</strong>
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
                <div v-if="filteredUnstagedFiles.length" class="git-file-list">
                  <div
                    v-for="item in filteredUnstagedFiles"
                    :key="`unstaged-${item.path}`"
                    class="git-file-row"
                    :class="{ active: selectedDiffFile === item.path && !selectedDiffStaged }"
                    @click="viewDiff(item.path, false)"
                  >
                    <span class="git-status-badge">{{ item.status }}</span>
                    <span class="git-file-path" :title="item.path">
                      <strong class="git-file-base">{{ splitGitFilePath(item.path).base }}</strong>
                      <small v-if="splitGitFilePath(item.path).dir" class="git-file-dir">{{ splitGitFilePath(item.path).dir }}</small>
                    </span>
                    <el-tag v-if="isSensitiveCommitPath(item.path)" size="small" type="danger" effect="plain">敏感</el-tag>
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
                <p v-else class="git-empty-hint">{{ normalizedFileFilter && unstagedFiles.length ? '无匹配的未暂存文件' : '工作树无未暂存改动' }}</p>
              </div>

              <div class="surface git-box">
                <div class="git-box-header">
                  <strong>{{ snapshot?.mergeInProgress ? '完成合并提交' : '提交改动 (Commit)' }}</strong>
                  <el-button
                    v-if="stagedFiles.length || unstagedFiles.length"
                    link
                    type="primary"
                    size="small"
                    :loading="commitAssisting"
                    :disabled="gitBusy"
                    title="扫描已暂存/工作区改动中的密钥、冲突、.only、debugger 并自动生成中文提交说明"
                    @click="requestCommitAssist('auto')"
                  >
                    智能生成 & 体检
                  </el-button>
                </div>
                <div
                  v-if="commitAssist && commitAssist.scope !== 'clean'"
                  class="git-commit-assist"
                  :class="{
                    'is-danger': commitAssist.hygieneWarnings.some(item => item.severity === 'blocker'),
                    'is-warn': !commitAssist.hygieneWarnings.some(item => item.severity === 'blocker') && (commitAssist.hygieneWarnings.length > 0 || commitAssist.triage?.missingTestsWarning),
                  }"
                >
                  <div class="git-commit-assist-head">
                    <span>
                      {{ commitAssist.scope === 'staged' ? '已暂存体检' : '未暂存预检' }}（{{ commitAssist.fileCount }} 文件）
                      <template v-if="!commitAssist.hygieneWarnings.length && !commitAssist.triage?.missingTestsWarning"> · 未见高危风险</template>
                    </span>
                    <div class="git-commit-assist-links">
                      <el-button link size="small" type="primary" @click="commitMessage = commitAssist.suggestedSubject">用简明标题</el-button>
                      <el-button v-if="commitAssist.suggestedBody" link size="small" type="primary" @click="commitMessage = commitAssist.suggestedMessage">含文件明细</el-button>
                    </div>
                  </div>
                  <ul v-if="commitAssist.hygieneWarnings.length || commitAssist.triage?.missingTestsWarning" class="git-hygiene-list">
                    <li v-for="(warn, idx) in commitAssist.hygieneWarnings" :key="`${warn.category}-${warn.file}-${idx}`">
                      <el-tag size="small" :type="warn.severity === 'blocker' ? 'danger' : 'warning'" effect="plain">
                        {{ warn.severity === 'blocker' ? '阻断提示' : '注意' }}
                      </el-tag>
                      <button type="button" class="git-hygiene-jump" @click="viewDiff(warn.file, commitAssist.scope === 'staged')">
                        {{ warn.file }}<template v-if="warn.line">:{{ warn.line }}</template>
                      </button>
                      <span>{{ warn.label }}（{{ warn.reason }}）</span>
                    </li>
                    <li v-if="commitAssist.triage?.missingTestsWarning">
                      <el-tag size="small" type="info" effect="plain">建议</el-tag>
                      <span>包含 {{ commitAssist.triage.sourceFiles }} 个源码文件改动但未见测试文件更新</span>
                    </li>
                  </ul>
                </div>
                <div v-if="!snapshot?.mergeInProgress && commitLanePlan.shouldSuggestSplit" class="git-commit-lanes">
                  <div class="git-commit-lanes-head">
                    <span class="git-commit-lanes-title">
                      <Layers :size="13" />
                      <strong>原子提交泳道</strong>
                      <small>{{ commitLanePlan.lanes.length }} 组 · {{ commitLanePlan.totalEligibleFiles }} 文件</small>
                    </span>
                    <el-button link size="small" type="primary" @click="showCommitLanes = !showCommitLanes">
                      {{ showCommitLanes ? '收起' : '拆分暂存' }}
                    </el-button>
                  </div>
                  <div v-if="showCommitLanes" class="git-commit-lanes-body">
                    <p v-if="commitLanePlan.excludedSensitiveFiles.length" class="git-lanes-sensitive-note">
                      已自动排除 {{ commitLanePlan.excludedSensitiveFiles.length }} 个敏感路径（{{ commitLanePlan.excludedSensitiveFiles.join('、') }}），防止误暂存凭据。
                    </p>
                    <div
                      v-for="lane in commitLanePlan.lanes"
                      :key="lane.id"
                      class="git-lane-card"
                      :class="{ 'is-matched': lane.isExactStagedMatch }"
                    >
                      <div class="git-lane-main">
                        <div class="git-lane-top">
                          <strong>{{ lane.label }}</strong>
                          <span class="git-lane-count">{{ lane.files.length }} 文件</span>
                          <span v-if="lane.isExactStagedMatch" class="git-lane-ready">已独立暂存</span>
                        </div>
                        <code class="git-lane-subject" :title="lane.rationale">{{ lane.suggestedSubject }}</code>
                      </div>
                      <el-button
                        size="small"
                        :type="lane.isExactStagedMatch ? 'default' : 'primary'"
                        plain
                        :disabled="gitBusy"
                        @click="applyCommitLane(lane)"
                      >
                        {{ lane.isExactStagedMatch ? '填入标题' : '仅暂存此组' }}
                      </el-button>
                    </div>
                  </div>
                </div>
                <div v-if="!snapshot?.mergeInProgress" class="git-conventional-strip" role="group" aria-label="Conventional Commits 快捷前缀">
                  <button
                    v-for="item in CONVENTIONAL_COMMIT_TYPES"
                    :key="item.type"
                    type="button"
                    class="git-conv-chip"
                    :class="{ active: activeCommitType === item.type }"
                    :disabled="acting"
                    :title="`${item.label}: ${item.hint}（再次点击可移除前缀）`"
                    @click="toggleCommitPrefix(item.type)"
                  >
                    {{ item.label }}
                  </button>
                </div>
                <el-input
                  v-model="commitMessage"
                  :disabled="acting"
                  type="textarea"
                  :rows="3"
                  placeholder="输入提交说明（点选上方 feat/fix 前缀，或按 ⌘↵ 快速提交）"
                  @keydown="onCommitKeydown"
                />
                <div class="git-commit-ruler">
                  <span class="git-ruler-count" :class="`is-${commitAnalysis.tone}`" title="建议首行标题不超过 50 字符（上限 72 字符）">
                    标题 {{ commitAnalysis.subjectLength }}/50
                  </span>
                  <span class="git-ruler-kbd"><kbd>⌘↵</kbd> 提交已暂存</span>
                </div>
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

                <div
                  v-if="!snapshot?.mergeInProgress && (stashItems.length > 0 || (!!snapshot?.head && !snapshot?.clean && !conflictCount))"
                  class="surface git-box git-stash-box"
                >
                  <div class="git-box-header">
                    <span class="git-stash-heading"><Archive :size="13" /><strong>贮藏架 ({{ stashItems.length }})</strong></span>
                    <div v-if="snapshot?.head && !snapshot?.clean && !conflictCount" class="git-stash-head-actions">
                      <el-button v-if="!showStashForm" link type="primary" size="small" :disabled="gitBusy" @click="pushStash('all', '')">
                        快速贮藏
                      </el-button>
                      <el-button link size="small" :disabled="gitBusy" @click="showStashForm = !showStashForm">
                        {{ showStashForm ? '收起' : '高级贮藏' }}
                      </el-button>
                    </div>
                  </div>
                  <div v-if="showStashForm && snapshot?.head && !snapshot?.clean && !conflictCount" class="git-stash-form">
                    <el-select v-model="stashMode" size="small" :disabled="gitBusy" aria-label="贮藏范围">
                      <el-option value="all" label="全部改动（含未跟踪文件）" />
                      <el-option value="staged" label="仅贮藏已暂存改动" :disabled="!stagedFiles.length" />
                      <el-option value="keep-index" label="贮藏工作区但保留已暂存状态" />
                    </el-select>
                    <div class="git-stash-input-row">
                      <el-input
                        v-model="stashNote"
                        size="small"
                        :disabled="gitBusy"
                        placeholder="备注说明（可选，例如：切分支前保存实验方案）"
                        @keyup.enter="pushStash()"
                      />
                      <el-button size="small" type="primary" :disabled="gitBusy" @click="pushStash()">存入</el-button>
                    </div>
                  </div>
                  <div v-if="stashItems.length" class="git-file-list git-stash-list">
                    <div
                      v-for="stash in stashItems"
                      :key="stash.sha"
                      class="git-file-row git-stash-row"
                      :class="{ active: selectedStashRef === stash.ref }"
                      @click="viewStashDiff(stash)"
                    >
                      <span class="git-status-badge is-stash">{{ stash.ref }}</span>
                      <span class="git-file-path" :title="`${stash.subject} (${stash.branch || '未知分支'})`">
                        <strong class="git-file-base">{{ stash.subject }}</strong>
                        <small class="git-file-dir">{{ stash.branch ? `分支 ${stash.branch} · ` : '' }}{{ dateTime(stash.date) }}</small>
                      </span>
                      <el-button link type="primary" size="small" :disabled="gitBusy || !!conflictCount" title="应用并从贮藏栈移除 (git stash pop)" @click.stop="popStash(stash)">弹出</el-button>
                      <el-button link size="small" :disabled="gitBusy || !!conflictCount" title="应用但保留贮藏条目 (git stash apply)" @click.stop="applyStash(stash)">应用</el-button>
                      <el-button link type="danger" size="small" :disabled="gitBusy" title="永久删除此贮藏" @click.stop="dropStash(stash)">删除</el-button>
                    </div>
                  </div>
                  <p v-else-if="!showStashForm" class="git-empty-hint">暂无贮藏快照；可一键贮藏当前改动以临时腾空干净工作区。</p>
                </div>
              </div>

              <div class="surface git-diff-col">
                <div class="git-preview-header">
                  <div class="git-preview-title">
                    <span>{{ selectedStashRef ? '贮藏快照差异预览' : '差异预览' }}</span>
                    <strong>{{ selectedStashRef ? `${selectedStashRef} · ${activeStashItem?.subject || ''}` : (selectedDiffFile || '选择文件查看改动') }}</strong>
                  </div>
                  <div v-if="selectedDiffFile || selectedStashRef" class="git-preview-meta">
                    <div v-if="!selectedStashRef && navigableDiffEntries.length > 1 && activeDiffIndex >= 0" class="git-diff-stepper" aria-label="切换改动文件">
                      <el-button size="small" :disabled="activeDiffIndex <= 0" title="上一个改动文件" @click="stepDiffFile(-1)"><ChevronLeft :size="13" /></el-button>
                      <span>{{ activeDiffIndex + 1 }}/{{ navigableDiffEntries.length }}</span>
                      <el-button size="small" :disabled="activeDiffIndex >= navigableDiffEntries.length - 1" title="下一个改动文件" @click="stepDiffFile(1)"><ChevronRight :size="13" /></el-button>
                    </div>
                    <button v-if="!diffLoading && hunkAnchors.length > 0 && !showSplitDiff" type="button" class="git-hunk-jump-btn" title="循环跳转到下一处变更块 (Hunk)" @click="jumpNextHunk">
                      {{ hunkAnchors.length }} 处变更 ↧
                    </button>
                    <el-radio-group v-model="diffLayout" size="small" aria-label="差异布局">
                      <el-radio-button value="unified">统一差异</el-radio-button>
                      <el-radio-button value="split">左右对比</el-radio-button>
                    </el-radio-group>
                    <el-button v-if="!diffLoading && diffContent" size="small" @click="copyActiveDiff">
                      <Check v-if="diffCopied" :size="13" /><Copy v-else :size="13" />
                      <span style="margin-left: 4px">{{ diffCopied ? '已复制' : '复制 Diff' }}</span>
                    </el-button>
                    <el-button v-if="selectedDiffFile && !selectedStashRef" size="small" :disabled="gitBusy || diffLoading" @click="editFile(selectedDiffFile, snapshot?.directory)">{{ snapshot?.files.find(item => item.path === selectedDiffFile)?.conflict ? '解决冲突' : '编辑文件' }}</el-button>
                    <span v-if="!diffLoading && diffPresentation.added" class="git-diff-added">+{{ diffPresentation.added }}</span>
                    <span v-if="!diffLoading && diffPresentation.removed" class="git-diff-removed">-{{ diffPresentation.removed }}</span>
                    <el-tag size="small" effect="plain">{{ selectedStashRef ? '贮藏快照' : (selectedDiffStaged ? '已暂存' : '工作区') }}</el-tag>
                  </div>
                </div>
              <pre v-if="diffLoading" class="git-code-pre">正在加载差异...</pre>
              <div v-else-if="showSplitDiff" ref="diffViewport" class="git-diff-view" tabindex="0" :aria-label="`左右对比：${selectedDiffFile}`">
                <div class="git-diff-pair git-diff-headings"><span>旧内容</span><span>新内容</span></div>
                <template v-for="(row, index) in splitDiffRows" :key="index">
                  <div v-if="'info' in row" class="git-diff-line" :class="`is-${row.info.kind}`">
                    <div v-if="row.info.kind === 'hunk'" class="git-hunk-bar">
                      <code>{{ row.info.content }}</code>
                      <div v-if="canActOnDiffHunks && splitHunkIndexByRow.has(index)" class="git-hunk-actions">
                        <template v-if="!selectedDiffStaged">
                          <button type="button" class="git-hunk-act is-stage" :disabled="gitBusy" @click="stageDiffHunk(splitHunkIndexByRow.get(index)!)">+ 暂存此块</button>
                          <button type="button" class="git-hunk-act is-discard" :disabled="gitBusy" @click="discardDiffHunk(splitHunkIndexByRow.get(index)!)">丢弃此块</button>
                        </template>
                        <button v-else type="button" class="git-hunk-act is-unstage" :disabled="gitBusy" @click="unstageDiffHunk(splitHunkIndexByRow.get(index)!)">- 取消暂存此块</button>
                      </div>
                    </div>
                    <code v-else>{{ row.info.content }}</code>
                  </div>
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
              <div v-else-if="selectedDiffFile || selectedStashRef" ref="diffViewport" class="git-diff-view" tabindex="0" :aria-label="`差异预览：${selectedStashRef || selectedDiffFile}`">
                <div v-for="(line, index) in diffPresentation.lines" :key="index" :data-diff-line-idx="index" class="git-diff-line" :class="`is-${line.kind}`">
                  <template v-if="line.kind === 'hunk'">
                    <div class="git-hunk-bar">
                      <code>{{ line.content }}</code>
                      <div v-if="canActOnDiffHunks && hunkIndexByLine.has(index)" class="git-hunk-actions">
                        <template v-if="!selectedDiffStaged">
                          <button type="button" class="git-hunk-act is-stage" :disabled="gitBusy" @click="stageDiffHunk(hunkIndexByLine.get(index)!)">+ 暂存此块</button>
                          <button type="button" class="git-hunk-act is-discard" :disabled="gitBusy" @click="discardDiffHunk(hunkIndexByLine.get(index)!)">丢弃此块</button>
                        </template>
                        <button v-else type="button" class="git-hunk-act is-unstage" :disabled="gitBusy" @click="unstageDiffHunk(hunkIndexByLine.get(index)!)">- 取消暂存此块</button>
                      </div>
                    </div>
                  </template>
                  <template v-else>
                    <span class="git-line-number" aria-hidden="true">{{ line.oldLine }}</span>
                    <span class="git-line-number" aria-hidden="true">{{ line.newLine }}</span>
                    <span class="git-line-marker" aria-hidden="true">{{ line.marker }}</span>
                    <code>{{ line.content || ' ' }}</code>
                  </template>
                </div>
              </div>
              <div v-else class="git-diff-empty">选择左侧任意改动文件即可实时查看代码 Diff</div>
            </div>
          </div>
        </el-tab-pane>

        <!-- Tab 2: Branches -->
        <el-tab-pane :label="`分支管理 (${localBranches.length})`" name="branches">
          <div
            v-if="snapshot && !snapshot.clean && !snapshot.mergeInProgress && !conflictCount && snapshot.head"
            class="git-branch-dirty-banner"
          >
            <span>当前工作区有 <strong>{{ snapshot.counts.total }}</strong> 项未提交改动，切换或新建分支前需保持工作树干净。</span>
            <el-button size="small" type="primary" plain :disabled="gitBusy" @click="pushStash('all', `切分支前自动贮藏 (${snapshot.branch || 'HEAD'})`)">
              <Archive :size="13" /><span style="margin-left: 4px">一键贮藏改动以解锁切分支</span>
            </el-button>
          </div>
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
            <div class="git-box-header git-history-header">
              <strong>最近提交记录 ({{ snapshot?.log.length ?? 0 }})</strong>
              <div class="git-cherry-pick-bar">
                <el-input
                  v-model="cherryPickSha"
                  size="small"
                  :disabled="gitBusy || !snapshot?.clean || snapshot?.mergeInProgress"
                  placeholder="输入其他分支 Commit SHA 执行摘取 (Cherry-Pick)"
                  style="width: 270px"
                  @keyup.enter="submitCherryPick"
                />
                <el-button
                  size="small"
                  type="primary"
                  plain
                  :disabled="gitBusy || !snapshot?.clean || snapshot?.mergeInProgress || !cherryPickSha.trim()"
                  :title="!snapshot?.clean ? '摘取提交前需先提交或贮藏当前工作区改动' : '将指定 Commit 摘取到当前分支'"
                  @click="submitCherryPick"
                >
                  摘取 (Cherry-Pick)
                </el-button>
              </div>
            </div>
            <el-table :data="snapshot?.log || []" size="small" :max-height="240" @row-click="(row: GitCommitItem) => inspectCommit(row.sha)">
              <el-table-column label="Commit" width="105">
                <template #default="{ row }"><span class="row-mono git-commit-sha-link">{{ row.sha.slice(0, 8) }}</span></template>
              </el-table-column>
              <el-table-column prop="subject" label="提交说明" min-width="240" />
              <el-table-column prop="author" label="作者" width="120" />
              <el-table-column label="提交时间" width="155">
                <template #default="{ row }">{{ dateTime(row.date) }}</template>
              </el-table-column>
              <el-table-column label="操作" width="205">
                <template #default="{ row }">
                  <el-button link type="primary" size="small" @click.stop="inspectCommit(row.sha)">
                    {{ selectedCommitDetail?.sha === row.sha ? '收起详情' : '查看 Diff' }}
                  </el-button>
                  <el-button
                    link
                    size="small"
                    :disabled="gitBusy || snapshot?.mergeInProgress"
                    title="填入 fixup! 标题并跳至改动页，方便后续 rebase --autosquash 归并修正"
                    @click.stop="prepareFixupForCommit(row)"
                  >
                    Fixup
                  </el-button>
                  <el-button
                    link
                    type="danger"
                    size="small"
                    :disabled="gitBusy || !snapshot?.clean || snapshot?.mergeInProgress"
                    :title="!snapshot?.clean ? '请先保持工作区干净后再回滚提交' : '创建反向抵消提交 (git revert --no-edit)'"
                    @click.stop="revertCommit(row)"
                  >
                    回滚
                  </el-button>
                </template>
              </el-table-column>
            </el-table>

            <div v-if="commitDetailLoading" class="git-empty-hint">正在读取提交详情与 Diff...</div>
            <div v-else-if="selectedCommitDetail" class="git-commit-inspector">
              <div class="git-commit-inspector-head">
                <div class="git-commit-inspector-meta">
                  <code class="row-mono">{{ selectedCommitDetail.sha.slice(0, 12) }}</code>
                  <strong>{{ selectedCommitDetail.subject }}</strong>
                  <small>{{ selectedCommitDetail.author }} &lt;{{ selectedCommitDetail.email }}&gt; · {{ dateTime(selectedCommitDetail.date) }}</small>
                  <el-tag v-if="selectedCommitDetail.parents.length > 1" size="small" type="warning" effect="plain">合并提交</el-tag>
                </div>
                <el-button link size="small" @click="selectedCommitDetail = undefined">关闭检视</el-button>
              </div>
              <pre v-if="selectedCommitDetail.body" class="git-commit-body-note">{{ selectedCommitDetail.body }}</pre>
              <div v-if="selectedCommitDetail.files.length" class="git-commit-files-strip">
                <span v-for="file in selectedCommitDetail.files" :key="file.path" class="git-commit-file-pill">
                  <b>{{ file.status }}</b>
                  <code>{{ file.path }}</code>
                  <em v-if="!file.binary" class="git-diff-added">+{{ file.additions ?? 0 }}</em>
                  <em v-if="!file.binary" class="git-diff-removed">-{{ file.deletions ?? 0 }}</em>
                </span>
              </div>
              <div class="git-diff-view git-commit-diff-view">
                <div v-for="(line, idx) in selectedCommitDiffPresentation.lines" :key="idx" class="git-diff-line" :class="`is-${line.kind}`">
                  <span class="git-line-number" aria-hidden="true">{{ line.oldLine }}</span>
                  <span class="git-line-number" aria-hidden="true">{{ line.newLine }}</span>
                  <span class="git-line-marker" aria-hidden="true">{{ line.marker }}</span>
                  <code>{{ line.content || ' ' }}</code>
                </div>
              </div>
            </div>
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
  padding: 12px 18px;
  border-bottom: 1px solid var(--ui-border, #e3e5eb);
  background: color-mix(in srgb, var(--ui-raised) 52%, var(--ui-surface));
}
:global(.project-git-drawer .el-drawer__body) {
  padding: 0;
  min-height: 0;
  overflow: hidden;
  display: flex;
}
.git-drawer-title { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex: 1; min-width: 0; }
.git-drawer-title h2 { margin: 0; font-size: 15px; line-height: 1.4; font-weight: 600; letter-spacing: -0.015em; color: var(--ui-text); }
.workspace-utilities { display: flex; gap: 12px; flex-wrap: wrap; }
.workspace-utilities :deep(.el-button) { margin: 0; font-size: 12px; }
.project-workspace-layout { display: grid; grid-template-columns: 224px minmax(0, 1fr); width: 100%; min-width: 0; min-height: 0; color: var(--ui-text); background: var(--ui-bg); }
.workspace-picker { display: flex; flex-direction: column; gap: 10px; padding: 16px 14px; min-height: 0; min-width: 0; border-right: 1px solid var(--ui-border, #e3e5eb); background: var(--ui-raised, #f8f9fc); color: var(--ui-text); }
.workspace-picker-heading { display: flex; align-items: center; justify-content: space-between; font-size: 13px; color: var(--ui-text); }
.workspace-picker-heading > span { color: var(--ui-muted); font-variant-numeric: tabular-nums; }
.workspace-picker-list { display: flex; flex-direction: column; gap: 6px; flex: 1; min-height: 0; overflow: auto; scrollbar-gutter: stable; }
.workspace-picker-list > button { display: flex; flex-direction: column; gap: 5px; width: 100%; min-width: 0; padding: 10px 12px; border: 1px solid transparent; border-radius: var(--ds-radius-xs, 8px); background: transparent; color: var(--ui-text); text-align: left; cursor: pointer; transition: background-color 160ms ease, border-color 160ms ease; }
.workspace-picker-list > button:hover { background: var(--ui-hover); }
.workspace-picker-list > button.active { background: var(--ui-surface); border-color: var(--ui-accent); box-shadow: 0 2px 8px -4px var(--ui-shadow-color); }
.workspace-picker-list > button:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: -2px; }
.workspace-item-heading { display: flex; align-items: baseline; gap: 6px; width: 100%; min-width: 0; }
.workspace-item-heading strong { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 13px; line-height: 1.5; }
.workspace-item-heading .workspace-status { flex-shrink: 0; color: var(--ui-success, var(--el-color-success-dark-2)); font-size: 11px; }
.workspace-item-heading .workspace-status.dirty { color: var(--ui-warning, var(--el-color-warning-dark-2)); }
.workspace-item-meta { display: flex; align-items: center; justify-content: space-between; gap: 6px; min-width: 0; }
.workspace-item-branch { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 11.5px/1.5 var(--mono); color: var(--ui-secondary); }
.workspace-radar-pill { flex-shrink: 0; padding: 1px 5px; border-radius: 4px; font-size: 10.5px; font-weight: 600; line-height: 1.4; }
.workspace-radar-pill.is-conflict { color: var(--el-color-danger); background: color-mix(in srgb, var(--el-color-danger) 12%, var(--ui-surface)); }
.workspace-radar-pill.is-overlap { color: var(--el-color-warning-dark-2); background: color-mix(in srgb, var(--el-color-warning) 14%, var(--ui-surface)); }
.git-worktree-radar { flex: none; padding: 8px 12px; border: 1px solid var(--ui-border); border-radius: var(--ds-radius, 10px); background: var(--ui-raised); color: var(--ui-text); font-size: 12px; line-height: 1.55; }
.git-worktree-radar strong { color: var(--ui-text); }
.git-worktree-radar.is-overlap { border-color: color-mix(in srgb, var(--el-color-warning) 50%, var(--ui-border)); background: color-mix(in srgb, var(--el-color-warning) 7%, var(--ui-surface)); }
.git-worktree-radar.is-conflict { border-color: color-mix(in srgb, var(--el-color-danger) 55%, var(--ui-border)); background: color-mix(in srgb, var(--el-color-danger) 7%, var(--ui-surface)); }
.git-worktree-radar-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
.git-worktree-radar-actions { display: flex; align-items: center; gap: 8px; }
.git-worktree-radar-actions :deep(.el-button) { margin: 0; font-size: 12px; }
.git-worktree-radar-list { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 5px; max-height: 84px; overflow-y: auto; }
.git-worktree-radar-list li { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; overflow-wrap: anywhere; }
.workspace-item-path { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; color: var(--ui-muted); font-size: 11px; line-height: 1.5; }
.git-drawer { display: flex; flex-direction: column; gap: 10px; min-width: 0; min-height: 0; overflow: hidden; padding: 12px 18px 16px; }
.project-workspace-layout :is(.git-header, .git-box, .git-diff-col) { margin: 0; min-width: 0; box-shadow: none; border-radius: var(--ds-radius, 10px); }
.git-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; flex: none; padding: 10px 14px; border: 1px solid var(--ui-border); background: var(--ui-raised); }
.git-header-main { min-width: 0; flex: 1 1 480px; }
.git-path-line { margin-bottom: 6px; min-width: 0; }
.git-path-line .row-mono { font-size: 12px; line-height: 1.5; color: var(--ui-secondary); overflow-wrap: anywhere; }
.git-badges { display: flex; flex-wrap: wrap; gap: 6px; }
.git-badges :deep(.el-tag) { max-width: 100%; font-size: 11px; }
.git-badges :deep(.el-tag__content) { overflow: hidden; text-overflow: ellipsis; }
.git-header-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.git-header-actions :deep(.el-button), .git-commit-actions :deep(.el-button) { margin: 0; }
.git-output-alert { flex: none; align-items: flex-start; overflow-wrap: anywhere; }
.git-output-alert :deep(.el-alert__content) { flex: 1; min-width: 0; padding-inline-end: 16px; }
.git-output-toggle { margin-inline-start: 8px; }
.git-output-details { display: block; max-height: min(20dvh, 150px); overflow: auto; white-space: pre-wrap; font-family: var(--mono, monospace); }
.git-tabs { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; }
.git-tabs :deep(.el-tabs__header) { margin: 0 0 12px; flex: none; }
.git-tabs :deep(.el-tabs__item) { height: 40px; font-size: 13px; }
.git-tabs :deep(.el-tabs__content) { flex: 1; min-height: 0; overflow: auto; }
.git-tabs :deep(#pane-changes) { height: 100%; }
.git-changes-layout { display: grid; grid-template-columns: 316px minmax(0, 1fr); gap: 12px; height: 100%; min-height: 0; align-items: stretch; }
.git-files-col { display: flex; flex-direction: column; gap: 10px; min-width: 0; min-height: 0; overflow: auto; }
.git-file-filter-bar { flex: none; }
.git-files-col > .git-box { flex: none; }
.git-box { padding: 12px 14px; border: 1px solid var(--ui-border); background: var(--ui-surface); color: var(--ui-text); }
.git-box-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; font-size: 13px; color: var(--ui-text); }
.git-box-header strong { min-width: 0; overflow-wrap: anywhere; font-weight: 600; color: var(--ui-text); }
.git-box-header :deep(.el-button) { margin: 0; font-size: 12px; flex-shrink: 0; }
.git-file-list { display: flex; flex-direction: column; gap: 3px; max-height: min(24dvh, 204px); overflow: auto; }
.git-file-row { display: flex; align-items: center; gap: 7px; padding: 6px 8px; border-radius: var(--ds-radius-xs, 7px); cursor: pointer; font-size: 12.5px; transition: background-color 150ms ease; }
.git-file-row:hover { background: var(--ui-hover); }
.git-file-row.active { background: var(--ui-accent-soft); }
.git-file-row :deep(.el-button) { margin: 0; flex-shrink: 0; font-size: 12px; }
.git-status-badge { font-family: var(--mono, monospace); font-size: 10.5px; padding: 1px 5px; border-radius: 4px; background: var(--ui-raised); color: var(--ui-secondary); flex-shrink: 0; }
.git-status-badge.staged { color: var(--ui-success, var(--el-color-success)); }
.git-status-badge.conflict { color: var(--ui-danger, var(--el-color-danger)); font-weight: 600; }
.git-status-badge.is-stash { color: var(--ui-accent, #2563eb); background: var(--ui-accent-soft, rgba(37, 99, 235, 0.1)); font-weight: 600; }
.git-stash-heading { display: inline-flex; align-items: center; gap: 6px; }
.git-stash-heading svg { color: var(--ui-accent); }
.git-stash-head-actions { display: inline-flex; align-items: center; gap: 8px; }
.git-stash-form { display: flex; flex-direction: column; gap: 7px; margin-bottom: 8px; padding: 8px; border: 1px solid var(--ui-border); border-radius: 7px; background: var(--ui-raised); }
.git-stash-input-row { display: flex; align-items: center; gap: 6px; }
.git-stash-input-row :deep(.el-input) { flex: 1; }
.git-stash-input-row :deep(.el-button) { margin: 0; flex-shrink: 0; }
.git-branch-dirty-banner { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; padding: 9px 14px; border: 1px solid color-mix(in srgb, var(--el-color-warning) 48%, var(--ui-border)); border-radius: var(--ds-radius, 10px); background: color-mix(in srgb, var(--el-color-warning) 8%, var(--ui-surface)); font-size: 12.5px; color: var(--ui-text); }
.git-branch-dirty-banner :deep(.el-button) { margin: 0; }
.git-file-path { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; font-family: var(--mono); overflow: hidden; }
.git-file-base { font: 600 12px/1.35 var(--mono); color: var(--ui-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.git-file-dir { font: 400 10.5px/1.3 var(--mono); color: var(--ui-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.git-conventional-strip { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
.git-conv-chip { height: 22px; padding: 0 7px; border: 1px solid var(--ui-border); border-radius: 5px; background: var(--ui-raised); color: var(--ui-secondary); font: 600 10.5px/1 var(--mono); cursor: pointer; transition: border-color 120ms ease, color 120ms ease, background-color 120ms ease; }
.git-conv-chip:hover:not(:disabled) { border-color: color-mix(in srgb, var(--ui-accent) 45%, var(--ui-border)); color: var(--ui-text); }
.git-conv-chip.active { border-color: var(--ui-accent); background: var(--ui-accent-soft); color: var(--ui-accent); }
.git-commit-ruler { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 6px; font-size: 11px; color: var(--ui-muted); font-variant-numeric: tabular-nums; }
.git-ruler-count { font-family: var(--mono); }
.git-ruler-count.is-good { color: var(--ui-success); }
.git-ruler-count.is-warn { color: var(--ui-warning); font-weight: 600; }
.git-ruler-kbd { display: inline-flex; align-items: center; gap: 4px; }
.git-ruler-kbd kbd { padding: 1px 5px; border: 1px solid var(--ui-border); border-radius: 4px; background: var(--ui-raised); font: 600 10px/1.2 var(--mono); color: var(--ui-secondary); }
.git-diff-stepper { display: inline-flex; align-items: center; gap: 4px; font: 500 11.5px/1 var(--mono); color: var(--ui-muted); }
.git-diff-stepper :deep(.el-button) { margin: 0; padding: 4px 6px; }
.git-hunk-jump-btn { height: 24px; padding: 0 8px; border: 1px solid var(--ui-border); border-radius: 5px; background: var(--ui-surface); color: var(--ui-accent); font: 600 11px/1 var(--mono); cursor: pointer; transition: border-color 120ms ease, background-color 120ms ease; }
.git-hunk-jump-btn:hover { border-color: var(--ui-accent); background: var(--ui-accent-soft); }
:global(:root[data-theme='acid'] :is(.git-conv-chip, .git-ruler-kbd kbd, .git-hunk-jump-btn, .git-status-badge)) { border-radius: 0 !important; }
.git-empty-hint { font-size: 12px; color: var(--ui-muted); margin: 4px 0; line-height: 1.6; }
.git-commit-assist { margin-bottom: 10px; padding: 8px 10px; border: 1px solid var(--ui-border); border-radius: var(--ds-radius-xs, 7px); background: var(--ui-raised); font-size: 11.5px; line-height: 1.55; }
.git-commit-assist.is-warn { border-color: color-mix(in srgb, var(--el-color-warning) 50%, var(--ui-border)); background: color-mix(in srgb, var(--el-color-warning) 7%, var(--ui-surface)); }
.git-commit-assist.is-danger { border-color: color-mix(in srgb, var(--el-color-danger) 55%, var(--ui-border)); background: color-mix(in srgb, var(--el-color-danger) 7%, var(--ui-surface)); }
.git-commit-assist-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px; color: var(--ui-secondary); font-weight: 500; }
.git-commit-assist-links { display: flex; align-items: center; gap: 6px; }
.git-commit-assist-links :deep(.el-button) { margin: 0; font-size: 11.5px; }
.git-hygiene-list { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.git-hygiene-list li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 5px; color: var(--ui-text); overflow-wrap: anywhere; }
.git-hygiene-jump { padding: 0; border: 0; background: transparent; color: var(--ui-accent); font: 500 11.5px/1.4 var(--mono, monospace); cursor: pointer; text-decoration: underline; }
.git-commit-actions { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.git-commit-actions :deep(.el-button) { width: 100%; }
.git-diff-col { display: flex; flex-direction: column; min-height: 0; padding: 0; overflow: hidden; border: 1px solid var(--ui-border); background: var(--ui-surface); }
.git-preview-header { display: flex; align-items: center; justify-content: space-between; flex: none; flex-wrap: wrap; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--ui-border, #e3e5eb); background: var(--ui-raised); }
.git-preview-title { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.git-preview-title > span { color: var(--ui-muted); font-size: 11px; }
.git-preview-title strong { font: 600 13px/1.5 var(--mono, monospace); color: var(--ui-text); overflow-wrap: anywhere; }
.git-preview-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; font-size: 12px; font-variant-numeric: tabular-nums; }
.git-diff-added { color: var(--ui-success, var(--el-color-success-dark-2)); }
.git-diff-removed { color: var(--ui-danger, var(--el-color-danger)); }
.git-diff-view { flex: 1; min-height: 0; min-width: 0; overflow: auto; padding: 6px 0; background: var(--ui-surface); scrollbar-gutter: stable; }
.git-diff-view:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: -2px; }
.git-diff-line { display: grid; grid-template-columns: 50px 50px 24px minmax(0, 1fr); padding-right: 14px; min-height: 24px; color: var(--ui-text); font: 13px/1.75 var(--mono, ui-monospace, monospace); }
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
.git-hunk-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; min-height: 28px; padding-block: 2px; }
.git-hunk-actions { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; }
.git-hunk-act { height: 22px; padding: 0 8px; border: 1px solid var(--ui-border); border-radius: 5px; background: var(--ui-surface); font: 600 11px/1 var(--sans, system-ui, sans-serif); cursor: pointer; transition: border-color 120ms ease, background-color 120ms ease, color 120ms ease; }
.git-hunk-act:disabled { opacity: 0.5; cursor: not-allowed; }
.git-hunk-act.is-stage { color: var(--ui-success, #16a34a); border-color: color-mix(in srgb, var(--ui-success, #16a34a) 36%, var(--ui-border)); }
.git-hunk-act.is-stage:hover:not(:disabled) { background: color-mix(in srgb, var(--ui-success, #16a34a) 12%, var(--ui-surface)); border-color: var(--ui-success, #16a34a); }
.git-hunk-act.is-unstage { color: var(--ui-warning, #d97706); border-color: color-mix(in srgb, var(--ui-warning, #d97706) 36%, var(--ui-border)); }
.git-hunk-act.is-unstage:hover:not(:disabled) { background: color-mix(in srgb, var(--ui-warning, #d97706) 12%, var(--ui-surface)); border-color: var(--ui-warning, #d97706); }
.git-hunk-act.is-discard { color: var(--ui-danger, #dc2626); border-color: color-mix(in srgb, var(--ui-danger, #dc2626) 32%, var(--ui-border)); }
.git-hunk-act.is-discard:hover:not(:disabled) { background: color-mix(in srgb, var(--ui-danger, #dc2626) 11%, var(--ui-surface)); border-color: var(--ui-danger, #dc2626); }
.git-commit-lanes { margin-bottom: 9px; padding: 7px 10px; border: 1px solid color-mix(in srgb, var(--ui-accent) 26%, var(--ui-border)); border-radius: var(--ds-radius-xs, 7px); background: color-mix(in srgb, var(--ui-accent-soft, transparent) 42%, var(--ui-raised)); }
.git-commit-lanes-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.git-commit-lanes-head :deep(.el-button) { margin: 0; font-size: 11.5px; }
.git-commit-lanes-title { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--ui-text); }
.git-commit-lanes-title svg { color: var(--ui-accent); flex-shrink: 0; }
.git-commit-lanes-title small { color: var(--ui-muted); font-family: var(--mono); font-size: 11px; }
.git-commit-lanes-body { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.git-lanes-sensitive-note { margin: 0; padding: 4px 8px; border-radius: 5px; background: color-mix(in srgb, var(--el-color-warning) 11%, var(--ui-surface)); color: var(--ui-secondary); font-size: 11px; line-height: 1.45; }
.git-lane-card { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 8px; border: 1px solid var(--ui-border); border-radius: 6px; background: var(--ui-surface); }
.git-lane-card.is-matched { border-color: color-mix(in srgb, var(--ui-success, #16a34a) 48%, var(--ui-border)); background: color-mix(in srgb, var(--ui-success, #16a34a) 6%, var(--ui-surface)); }
.git-lane-card :deep(.el-button) { margin: 0; flex-shrink: 0; font-size: 11.5px; padding: 4px 8px; }
.git-lane-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.git-lane-top { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 11.5px; }
.git-lane-count { font: 500 10.5px/1.3 var(--mono); color: var(--ui-muted); }
.git-lane-ready { padding: 0 5px; border-radius: 4px; background: color-mix(in srgb, var(--ui-success, #16a34a) 14%, var(--ui-surface)); color: var(--ui-success, #16a34a); font-size: 10.5px; font-weight: 600; }
.git-lane-subject { font: 500 11px/1.4 var(--mono); color: var(--ui-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
.git-history-header { flex-wrap: wrap; gap: 8px; }
.git-cherry-pick-bar { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.git-commit-sha-link { color: var(--ui-accent); cursor: pointer; font-weight: 600; }
.git-commit-inspector { margin-top: 12px; padding: 10px 12px; border: 1px solid var(--ui-border); border-radius: 8px; background: var(--ui-raised); display: flex; flex-direction: column; gap: 8px; }
.git-commit-inspector-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.git-commit-inspector-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
.git-commit-inspector-meta small { color: var(--ui-muted); }
.git-commit-body-note { margin: 0; padding: 6px 8px; border-radius: 6px; background: var(--ui-surface); font: 11.5px/1.6 var(--mono); white-space: pre-wrap; color: var(--ui-secondary); }
.git-commit-files-strip { display: flex; flex-wrap: wrap; gap: 6px; }
.git-commit-file-pill { display: inline-flex; align-items: center; gap: 5px; padding: 2px 7px; border-radius: 5px; border: 1px solid var(--ui-border); background: var(--ui-surface); font: 11px/1.4 var(--mono); }
.git-commit-file-pill em { font-style: normal; }
.git-commit-diff-view { max-height: 320px; border: 1px solid var(--ui-border); border-radius: 6px; background: var(--ui-surface); }
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
