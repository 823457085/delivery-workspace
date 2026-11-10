<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { dateTime, safeUrl } from '../../shared/format';
import type { GitCommitItem, GitSnapshot } from './project-git-types';

interface MergePreview {
  sourceRef: string;
  sourceName: string;
  sourceSha: string;
  targetRef: string;
  targetName: string;
  targetSha: string;
  ahead: number;
  behind: number;
  alreadyMerged: boolean;
  canFastForward: boolean;
  commits: GitCommitItem[];
  commitsTruncated: boolean;
  files: { path: string; additions: number | null; deletions: number | null; binary: boolean }[];
  filesTruncated: boolean;
  totals: { files: number; additions: number; deletions: number; binaryFiles: number };
  branchDiff?: { files: { path: string; status: string }[]; total: number };
}

const branchDiffStatus: Record<string, string> = {
  A: '仅来源分支有',
  D: '仅当前分支有',
  M: '内容不同',
  T: '类型不同',
};

const requestStateLabels: Record<string, string> = {
  UNDER_DEV: '开发中',
  UNDER_REVIEW: '评审中',
  TO_BE_MERGED: '待合并',
  MERGED: '已合并',
  CLOSED: '已关闭',
};

interface RemoteRequest {
  mode: 'api' | 'browser' | 'unavailable';
  provider: string;
  remote: string;
  sourceBranch: string;
  targetBranch: string;
  sourceSha: string;
  targetSha: string;
  revision: string;
  repositoryUrl: string;
  url: string;
  title: string;
  description: string;
  canCreate: boolean;
  reason?: string;
  existing?: { id: string | number; url: string; title: string; state: string };
}

type ListedRequest = Omit<NonNullable<RemoteRequest['existing']>, 'id'> & {
  id: number; sourceBranch: string; targetBranch: string; author?: string;
};

const props = defineProps<{
  path: string;
  snapshot: GitSnapshot;
  busy: boolean;
  execute: (payload: Record<string, unknown>, successMessage?: string) => Promise<boolean>;
}>();
const emit = defineEmits<{
  busy: [value: boolean];
  snapshot: [value: GitSnapshot];
  changes: [];
}>();

const sourceRef = shallowRef('');
const strategy = shallowRef<'ff' | 'no-ff' | 'ff-only'>('ff');
const mergeMessage = shallowRef('');
const preview = ref<MergePreview>();
const previewing = shallowRef(false);
const preparing = shallowRef(false);
const creating = shallowRef(false);
const confirming = shallowRef(false);
const preparingLocal = shallowRef(false);
const editingTitle = shallowRef(false);
const localMergeSection = ref<HTMLElement>();
const busy = computed(() => props.busy || previewing.value || preparing.value || creating.value || confirming.value || preparingLocal.value || editingTitle.value);
const candidates = computed(() => props.snapshot.branches.filter(branch => !branch.current));
const strategyLabel = computed(() => ({ ff: '普通合并（可快进时快进）', 'no-ff': '始终创建合并提交', 'ff-only': '仅允许快进' })[strategy.value]);
const canMerge = computed(() => !!preview.value && !preview.value.alreadyMerged && props.snapshot.clean
  && !props.snapshot.mergeInProgress && !!props.snapshot.branch && !busy.value
  && (strategy.value !== 'ff-only' || preview.value.canFastForward));

const remote = shallowRef('');
const sourceBranch = shallowRef('');
const targetBranch = shallowRef('');
const requestTitle = shallowRef('');
const requestDescription = shallowRef('');
const prepared = ref<RemoteRequest>();
const createdRequest = ref<NonNullable<RemoteRequest['existing']>>();
const resultUncertain = shallowRef(false);
const visibleRequest = computed(() => createdRequest.value ?? prepared.value?.existing);
const isCodeup = computed(() => props.snapshot.remotes.find(item => item.name === remote.value)?.provider === 'Codeup');
const requests = shallowRef<ListedRequest[]>([]);
const loadingRequests = shallowRef(false);
const requestListError = shallowRef('');
const queryLabel = computed(() => {
  if (resultUncertain.value) return '重新查询合并请求';
  return isCodeup.value ? '查询合并请求' : '准备合并请求';
});
const remoteBranches = computed(() => {
  const prefix = `refs/remotes/${remote.value}/`;
  return props.snapshot.branches.filter(branch => branch.remote && branch.ref.startsWith(prefix))
    .map(branch => ({ name: branch.ref.slice(prefix.length), sha: branch.sha }));
});
let requestVersion = 0;
let listVersion = 0;
let alive = true;

watch([previewing, preparing, creating, confirming, editingTitle], () =>
  emit('busy', previewing.value || preparing.value || creating.value || confirming.value || editingTitle.value), { flush: 'sync' });
onBeforeUnmount(() => { alive = false; ++requestVersion; emit('busy', false); });
watch(sourceRef, () => { preview.value = undefined; }, { flush: 'sync' });
watch(() => props.snapshot, snapshot => {
  if (preview.value && (snapshot.head !== preview.value.targetSha
    || snapshot.branches.find(branch => branch.ref === preview.value?.sourceRef)?.sha !== preview.value.sourceSha
    || snapshot.branch !== preview.value.targetName)) preview.value = undefined;
  if (!snapshot.remotes.some(item => item.name === remote.value)) remote.value = snapshot.remotes.find(item => item.name === 'origin')?.name || snapshot.remotes[0]?.name || '';
}, { immediate: true, flush: 'sync' });

function resetRequest() {
  ++requestVersion;
  prepared.value = undefined;
  createdRequest.value = undefined;
  resultUncertain.value = false;
}
watch(remote, () => {
  resetRequest();
  const prefix = `${remote.value}/`;
  const proposed = props.snapshot.upstream.startsWith(prefix) ? props.snapshot.upstream.slice(prefix.length) : props.snapshot.branch;
  sourceBranch.value = remoteBranches.value.some(branch => branch.name === proposed) ? proposed : '';
  targetBranch.value = ['master', 'main', 'pre'].find(name => name !== sourceBranch.value && remoteBranches.value.some(branch => branch.name === name)) || '';
  requestTitle.value = '';
  requestDescription.value = '';
}, { immediate: true, flush: 'sync' });
watch([sourceBranch, targetBranch], resetRequest, { flush: 'sync' });
watch(remoteBranches, branches => {
  if (sourceBranch.value && !branches.some(branch => branch.name === sourceBranch.value)) sourceBranch.value = '';
  if (targetBranch.value && !branches.some(branch => branch.name === targetBranch.value)) targetBranch.value = '';
  if (prepared.value && (branches.find(branch => branch.name === sourceBranch.value)?.sha !== prepared.value.sourceSha
    || branches.find(branch => branch.name === targetBranch.value)?.sha !== prepared.value.targetSha)) prepared.value = undefined;
});

async function jsonRequest(url: string, input: Record<string, unknown>, confirmed = false) {
  const response = await fetch(url, { method: 'POST', body: JSON.stringify(input),
    headers: { 'Content-Type': 'application/json', ...(confirmed ? { 'X-Delivery-Confirmed': 'yes' } : {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || '操作未完成');
  return data;
}

async function loadRequestList() {
  const version = ++listVersion;
  requestListError.value = '';
  loadingRequests.value = isCodeup.value;
  if (!isCodeup.value) return;
  try {
    const result = await jsonRequest('/api/projects/git/merge-request/list', { path: props.path, remote: remote.value });
    if (alive && version === listVersion) requests.value = result.requests;
  } catch (error) {
    if (alive && version === listVersion) {
      requests.value = [];
      requestListError.value = error instanceof Error ? error.message : '读取合并请求失败';
    }
  } finally {
    if (alive && version === listVersion) loadingRequests.value = false;
  }
}

watch([() => props.path, remote, isCodeup], () => {
  requests.value = [];
  void loadRequestList();
}, { immediate: true });

async function editRequestTitle(request: ListedRequest) {
  if (busy.value || loadingRequests.value) return;
  const path = props.path, remoteName = remote.value;
  const selectedRepository = () => props.snapshot.remotes.find(item => item.name === remote.value)?.webUrl;
  const repositoryUrl = URL.parse(selectedRepository() || '')?.href;
  if (!repositoryUrl) return;
  const stillSelected = () => alive && props.path === path && remote.value === remoteName
    && URL.parse(selectedRepository() || '')?.href === repositoryUrl;
  editingTitle.value = true;
  try {
    let title: string;
    try {
      const result = await ElMessageBox.prompt(`保存后会更新 Codeup 合并请求 #${request.id} 的标题。`, '编辑合并请求标题', {
        inputValue: request.title, confirmButtonText: '保存标题', cancelButtonText: '取消', closeOnClickModal: false,
        inputValidator: input => !input.trim() ? '请输入标题' : input.trim().length > 256 ? '标题不能超过 256 个字符' : true,
      });
      title = result.value.trim();
    } catch { return; }
    if (!stillSelected() || title === request.title) return;
    const result: { request: ListedRequest } = await jsonRequest('/api/projects/git/merge-request/title', {
      path, remote: remoteName, repositoryUrl, id: request.id, sourceBranch: request.sourceBranch, targetBranch: request.targetBranch,
      expectedTitle: request.title, title,
    }, true);
    if (!stillSelected()) return;
    requests.value = requests.value.map(item => item.id === request.id ? { ...item, ...result.request } : item);
    if (createdRequest.value?.id === request.id) createdRequest.value = result.request;
    if (prepared.value?.existing?.id === request.id) prepared.value = { ...prepared.value, existing: result.request };
    ElMessage.success('合并请求标题已更新');
  } catch (error) {
    if (!stillSelected()) return;
    ElMessage.error(error instanceof Error ? error.message : '保存标题失败');
    void loadRequestList();
  } finally { editingTitle.value = false; }
}

async function prepareLocalRequestMerge(request: ListedRequest) {
  if (busy.value || !props.snapshot.clean || props.snapshot.mergeInProgress) return;
  const remoteName = remote.value;
  const { sourceBranch: source, targetBranch: target } = request;
  const stillSelected = () => alive && remote.value === remoteName;
  confirming.value = true;
  try {
    await ElMessageBox.confirm(
      `获取 ${remoteName}/${source} 和 ${remoteName}/${target}，切换或检出本地「${target}」，快进同步后预览 #${request.id} 的合并改动。`,
      '准备本地合并', { confirmButtonText: '获取并预览', cancelButtonText: '取消', type: 'info' },
    );
  } catch { return; }
  finally { confirming.value = false; }
  if (!stillSelected() || busy.value || !props.snapshot.clean || props.snapshot.mergeInProgress) return;

  preparingLocal.value = true;
  preview.value = undefined;
  try {
    if (!await props.execute({ action: 'fetch', remote: remoteName, branches: [source, target] })) return;
    await nextTick();
    if (!stillSelected()) return;
    const sourceRemote = props.snapshot.branches.find(branch => branch.ref === `refs/remotes/${remoteName}/${source}`);
    const targetRemote = props.snapshot.branches.find(branch => branch.ref === `refs/remotes/${remoteName}/${target}`);
    if (!sourceRemote || !targetRemote) throw new Error('未找到合并请求的远端来源或目标分支。');
    const localTarget = props.snapshot.branches.find(branch => branch.ref === `refs/heads/${target}`);
    if (localTarget?.upstream && localTarget.upstream !== targetRemote.name) {
      throw new Error(`本地「${target}」跟踪的是 ${localTarget.upstream}，请先核对跟踪分支。`);
    }
    if (!localTarget && targetRemote.localBranch) {
      throw new Error(`${targetRemote.name} 已由本地「${targetRemote.localBranch}」跟踪，请先准备同名目标分支「${target}」。`);
    }
    if (props.snapshot.branch !== target) {
      if (!await props.execute({ action: 'switch', ref: localTarget?.ref ?? targetRemote.ref })) return;
      await nextTick();
    }
    if (!stillSelected() || props.snapshot.branch !== target) return;
    if (props.snapshot.head !== targetRemote.sha) {
      if (props.snapshot.upstream === targetRemote.name && props.snapshot.ahead && props.snapshot.behind) {
        throw new Error(`本地「${target}」和 ${targetRemote.name} 已分叉，请先处理目标分支的改动。`);
      }
      if (!await props.execute({ action: 'merge', ref: targetRemote.ref, strategy: 'ff-only',
        expectedSourceSha: targetRemote.sha, expectedTargetSha: props.snapshot.head, expectedTargetBranch: target })) return;
      await nextTick();
    }
    if (!stillSelected() || props.snapshot.branch !== target) return;
    sourceRef.value = sourceRemote.ref;
    strategy.value = 'ff';
    mergeMessage.value = '';
  } catch (error) {
    if (stillSelected()) ElMessage.error(error instanceof Error ? error.message : '准备本地合并失败');
    return;
  } finally {
    preparingLocal.value = false;
  }
  await previewMerge();
  if (preview.value) localMergeSection.value?.scrollIntoView({ block: 'start' });
}

async function previewMerge() {
  if (busy.value || !sourceRef.value) return;
  const path = props.path, refName = sourceRef.value, target = props.snapshot.branch;
  previewing.value = true;
  preview.value = undefined;
  try {
    const data = await jsonRequest('/api/projects/git/action', { action: 'merge-preview', path, ref: refName,
      revision: props.snapshot.revision, expectedTargetBranch: target });
    if (!alive || props.path !== path || sourceRef.value !== refName || props.snapshot.branch !== target) return;
    if (data.snapshot) emit('snapshot', data.snapshot);
    preview.value = data.preview;
  } catch (error) {
    if (alive) ElMessage.error(error instanceof Error ? error.message : '读取合并预览失败');
  } finally {
    if (alive) previewing.value = false;
  }
}

async function mergeBranch() {
  if (!canMerge.value || !preview.value) return;
  const selected = preview.value, path = props.path, selectedStrategy = strategy.value, message = mergeMessage.value.trim();
  confirming.value = true;
  try {
    await ElMessageBox.confirm(`将 ${selected.sourceName} 合入 ${selected.targetName}，使用「${strategyLabel.value}」。此次操作更新当前本地分支。`, '确认合并代码', {
      confirmButtonText: '合并代码', cancelButtonText: '取消', type: 'warning',
    });
  } catch { return; }
  finally { confirming.value = false; }
  if (!alive || path !== props.path || preview.value !== selected || !canMerge.value) return;
  const ok = await props.execute({ action: 'merge', ref: selected.sourceRef, strategy: selectedStrategy, message: message || undefined,
    expectedSourceSha: selected.sourceSha, expectedTargetSha: selected.targetSha, expectedTargetBranch: selected.targetName }, '已合并到本地当前分支');
  if (!alive) return;
  preview.value = undefined;
  if (ok) mergeMessage.value = '';
  if (props.snapshot.mergeInProgress) emit('changes');
}

async function abortMerge() {
  if (busy.value) return;
  const path = props.path;
  confirming.value = true;
  try {
    await ElMessageBox.confirm(`中止 ${props.snapshot.branch} 当前进行中的合并？本次冲突解决的修改将被撤销。`, '中止合并', {
      confirmButtonText: '中止合并', cancelButtonText: '取消', type: 'warning',
    });
  } catch { return; }
  finally { confirming.value = false; }
  if (alive && props.path === path) await props.execute({ action: 'abort-merge' }, '已中止合并');
}

async function prepareRequest() {
  if (busy.value || !sourceBranch.value || !targetBranch.value || sourceBranch.value === targetBranch.value) return;
  const version = ++requestVersion;
  preparing.value = true;
  prepared.value = undefined;
  createdRequest.value = undefined;
  try {
    const data = await jsonRequest('/api/projects/git/merge-request/prepare', { path: props.path, remote: remote.value,
      sourceBranch: sourceBranch.value, targetBranch: targetBranch.value, revision: props.snapshot.revision });
    if (!alive || version !== requestVersion) return;
    prepared.value = data;
    resultUncertain.value = false;
    if (!requestTitle.value.trim()) requestTitle.value = data.title || `合并 ${sourceBranch.value} 到 ${targetBranch.value}`;
    if (!requestDescription.value.trim()) requestDescription.value = data.description || '';
  } catch (error) {
    if (alive && version === requestVersion) ElMessage.error(error instanceof Error ? error.message : '准备合并请求失败');
  } finally {
    if (alive) preparing.value = false;
  }
}

async function createRequest() {
  const selected = prepared.value;
  if (busy.value || selected?.mode !== 'api' || !selected.canCreate || !requestTitle.value.trim() || resultUncertain.value) return;
  const version = requestVersion, path = props.path, title = requestTitle.value.trim(), description = requestDescription.value;
  confirming.value = true;
  try {
    await ElMessageBox.confirm(`在 ${selected.provider} 创建合并请求：${selected.sourceBranch} → ${selected.targetBranch}，标题「${title}」。`, '确认创建合并请求', {
      confirmButtonText: '创建合并请求', cancelButtonText: '取消', type: 'warning',
    });
  } catch { return; }
  finally { confirming.value = false; }
  if (!alive || path !== props.path || version !== requestVersion || prepared.value !== selected) return;
  creating.value = true;
  try {
    const data = await jsonRequest('/api/projects/git/merge-request/create', { path, remote: selected.remote,
      sourceBranch: selected.sourceBranch, targetBranch: selected.targetBranch, revision: selected.revision,
      expectedSourceSha: selected.sourceSha, expectedTargetSha: selected.targetSha, title, description });
    if (!alive || version !== requestVersion) return;
    createdRequest.value = data.request;
    prepared.value = undefined;
    ElMessage.success(data.created ? '已创建合并请求' : '已找到现有合并请求');
    void loadRequestList();
  } catch (error) {
    if (!alive || version !== requestVersion) return;
    resultUncertain.value = true;
    prepared.value = undefined;
    ElMessage.error(error instanceof Error ? error.message : '创建结果未确认，请先查询平台上的合并请求');
    void loadRequestList();
  } finally {
    if (alive) creating.value = false;
  }
}
</script>

<template>
  <div class="merge-panel">
    <section class="surface merge-box">
      <div class="merge-heading">
        <strong>合并请求列表</strong>
        <div class="merge-actions">
          <el-select v-model="remote" :disabled="busy" aria-label="合并请求远端" placeholder="选择远端" class="request-remote">
            <el-option v-for="item in snapshot.remotes" :key="item.name" :value="item.name" :label="`${item.name} · ${item.provider}`" />
          </el-select>
          <el-button size="small" :loading="loadingRequests" :disabled="!isCodeup || busy" @click="loadRequestList">刷新列表</el-button>
        </div>
      </div>
      <template v-if="isCodeup">
        <p class="row-secondary">显示当前仓库未结束的请求。本地合并更新本机目标分支，远端请求由 Codeup 管理。</p>
        <p v-if="requestListError" class="row-secondary">{{ requestListError }}</p>
        <el-table v-else v-loading="loadingRequests" :data="requests" row-key="id" size="small" max-height="290" empty-text="没有未结束的合并请求">
          <el-table-column label="合并请求" min-width="270">
            <template #default="{ row }">
              <strong>#{{ row.id }}</strong> {{ row.title }}
              <p class="request-branches"><span>发起人：{{ row.author || '—' }}</span><span>{{ row.sourceBranch }} → {{ row.targetBranch }}</span></p>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="86">
            <template #default="{ row }">
              <el-tag v-if="row.state" size="small" effect="plain">{{ requestStateLabels[row.state.toUpperCase()] ?? row.state }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" min-width="218">
            <template #default="{ row }">
              <div class="merge-actions">
                <el-button link type="primary" :disabled="busy || !snapshot.clean || snapshot.mergeInProgress"
                  @click="prepareLocalRequestMerge(row)">准备本地合并</el-button>
                <el-button link type="primary" :disabled="busy || loadingRequests" @click="editRequestTitle(row)">编辑标题</el-button>
                <el-link v-if="safeUrl(row.url)" :href="safeUrl(row.url)" target="_blank" rel="noopener noreferrer">在 Codeup 查看</el-link>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </template>
      <p v-else class="row-secondary">请选择 Codeup 远端，或在对应代码平台查看合并请求。</p>
    </section>

    <section ref="localMergeSection" class="surface merge-box">
      <div class="merge-heading"><strong>合并代码到当前分支</strong><el-tag effect="plain">{{ snapshot.branch || '游离 HEAD' }}</el-tag></div>
      <template v-if="snapshot.mergeInProgress">
        <p class="row-secondary">当前合并尚未完成，剩余 {{ snapshot.counts.conflicts }} 个冲突文件。编辑冲突文件并暂存后，填写提交说明完成合并。</p>
        <div class="merge-actions">
          <el-button type="primary" :disabled="busy" @click="emit('changes')">{{ snapshot.counts.conflicts ? '处理冲突文件' : '继续合并提交' }}</el-button>
          <el-button type="danger" plain :disabled="busy" @click="abortMerge">中止合并</el-button>
        </div>
      </template>
      <template v-else>
        <el-form label-position="top" class="merge-form" @submit.prevent="previewMerge">
          <el-form-item label="来源分支">
            <el-select v-model="sourceRef" :disabled="busy" placeholder="选择本地或远端分支" filterable>
              <el-option v-for="item in candidates" :key="item.ref" :value="item.ref" :label="`${item.name}${item.remote ? ' (远端)' : ' (本地)'}`" />
            </el-select>
          </el-form-item>
          <el-form-item label="合并方式">
            <el-select v-model="strategy" :disabled="busy" aria-label="合并方式">
              <el-option value="ff" label="普通合并（可快进时快进）" />
              <el-option value="no-ff" label="始终创建合并提交" />
              <el-option value="ff-only" label="仅允许快进" />
            </el-select>
          </el-form-item>
          <el-form-item label="合并提交说明（可选）" class="merge-wide">
            <el-input v-model="mergeMessage" :disabled="busy || strategy === 'ff-only'" placeholder="留空使用默认合并说明" maxlength="4000" />
          </el-form-item>
        </el-form>
        <p class="row-secondary">{{ candidates.find(item => item.ref === sourceRef)?.name || '来源分支' }} → {{ snapshot.branch || '当前分支' }}。远端分支使用最近获取的记录。</p>
        <div class="merge-actions">
          <el-button :loading="previewing" :disabled="busy || !sourceRef || !snapshot.head || !snapshot.branch" @click="previewMerge">预览合并改动</el-button>
          <el-button type="primary" :disabled="!canMerge" @click="mergeBranch">合并到 {{ snapshot.branch || '当前分支' }}</el-button>
        </div>
        <p v-if="!snapshot.clean" class="row-secondary">当前工作区有未提交改动，提交后可执行合并。</p>
        <template v-if="preview">
          <div class="merge-summary">
            <strong>{{ preview.sourceName }} → {{ preview.targetName }}</strong>
            <span>{{ preview.ahead }} 个待合入提交 · 来源分支净改动 {{ preview.totals.files }} 个文件<span v-if="preview.totals.files"> · +{{ preview.totals.additions }} / -{{ preview.totals.deletions }}</span></span>
            <span>{{ preview.alreadyMerged ? '当前分支已包含来源提交' : preview.canFastForward ? '可以快进合并' : '两个分支均有独立提交，需创建合并提交' }}</span>
            <small v-if="preview.ahead > 0 && preview.totals.files === 0">来源分支有待合入的提交记录，文件内容与共同祖先一致。</small>
            <small>来源 {{ preview.sourceSha.slice(0, 8) }} · 当前 {{ preview.targetSha.slice(0, 8) }}</small>
          </div>
          <el-tabs class="merge-preview-tabs">
            <el-tab-pane :label="`待合入提交 (${preview.ahead})`">
              <el-table :data="preview.commits" size="small" max-height="260" empty-text="没有待合入提交">
                <el-table-column label="提交" width="105"><template #default="{ row }"><code>{{ row.sha.slice(0, 8) }}</code></template></el-table-column>
                <el-table-column prop="subject" label="说明" min-width="220" />
                <el-table-column prop="author" label="作者" width="125" />
                <el-table-column label="时间" width="120"><template #default="{ row }">{{ dateTime(row.date) }}</template></el-table-column>
              </el-table>
              <p v-if="preview.commitsTruncated" class="row-secondary">仅展示前 100 条提交。</p>
            </el-tab-pane>
            <el-tab-pane :label="`来源分支净改动 (${preview.totals.files})`">
              <p class="row-secondary">比较共同祖先与来源分支。实际合并结果取决于两个分支的改动。</p>
              <el-table :data="preview.files" size="small" max-height="260" empty-text="来源分支没有文件净改动">
                <el-table-column prop="path" label="文件" min-width="280" />
                <el-table-column label="行数变化" width="140"><template #default="{ row }">{{ row.binary ? '二进制文件' : `+${row.additions} / -${row.deletions}` }}</template></el-table-column>
              </el-table>
              <p v-if="preview.filesTruncated" class="row-secondary">仅展示前 100 个文件。</p>
            </el-tab-pane>
            <el-tab-pane v-if="preview.branchDiff" :label="`分支快照差异 (${preview.branchDiff.total})`" lazy>
              <p class="row-secondary">比较当前分支 {{ preview.targetName }} 和来源分支 {{ preview.sourceName }} 的文件快照。</p>
              <el-table :data="preview.branchDiff.files" size="small" max-height="260" empty-text="两个分支的文件快照一致">
                <el-table-column prop="path" label="文件" min-width="220" show-overflow-tooltip />
                <el-table-column label="差异" width="126">
                  <template #default="{ row }">{{ branchDiffStatus[row.status] || row.status }}</template>
                </el-table-column>
              </el-table>
              <p v-if="preview.branchDiff.total > preview.branchDiff.files.length" class="row-secondary">仅展示前 100 个文件。</p>
            </el-tab-pane>
          </el-tabs>
        </template>
      </template>
    </section>

    <section class="surface merge-box">
      <div class="merge-heading"><strong>创建远端合并请求</strong></div>
      <el-form label-position="top" class="merge-form" @submit.prevent="prepareRequest">
        <el-form-item label="来源分支（已推送）">
          <el-select v-model="sourceBranch" :disabled="busy" placeholder="选择来源分支" filterable>
            <el-option v-for="item in remoteBranches" :key="item.name" :value="item.name" :label="item.name" />
          </el-select>
        </el-form-item>
        <el-form-item label="目标分支">
          <el-select v-model="targetBranch" :disabled="busy" placeholder="选择目标分支" filterable>
            <el-option v-for="item in remoteBranches" :key="item.name" :value="item.name" :label="item.name" :disabled="item.name === sourceBranch" />
          </el-select>
        </el-form-item>
      </el-form>
      <p class="row-secondary">{{ sourceBranch || '来源分支' }} → {{ targetBranch || '目标分支' }}。创建请求后在代码平台审核与合入。</p>
      <div class="merge-actions">
        <el-button :loading="preparing" :disabled="busy || !sourceBranch || !targetBranch || sourceBranch === targetBranch" @click="prepareRequest">{{ queryLabel }}</el-button>
        <el-button :disabled="busy || !remote" @click="execute({ action: 'fetch', remote }, '已获取远端最新分支')">获取远端分支</el-button>
      </div>
      <div v-if="visibleRequest" class="request-result">
        <span><strong>#{{ visibleRequest.id }}</strong> {{ visibleRequest.title }}</span>
        <el-tag v-if="visibleRequest.state" size="small" effect="plain">{{ requestStateLabels[visibleRequest.state.toUpperCase()] ?? visibleRequest.state }}</el-tag>
        <el-link v-if="safeUrl(visibleRequest.url)" :href="safeUrl(visibleRequest.url)" target="_blank" rel="noopener noreferrer" type="primary">在 Codeup 查看</el-link>
      </div>
      <template v-else-if="prepared">
        <p v-if="prepared.reason" class="row-secondary">{{ prepared.reason }}</p>
        <template v-if="prepared.mode === 'api' && prepared.canCreate">
          <el-form label-position="top" class="request-details" @submit.prevent="createRequest">
            <el-form-item label="合并请求标题"><el-input v-model="requestTitle" :disabled="busy" maxlength="256" /></el-form-item>
            <el-form-item label="说明（可选）"><el-input v-model="requestDescription" :disabled="busy" type="textarea" :rows="3" maxlength="10000" /></el-form-item>
            <el-button type="primary" :loading="creating" :disabled="busy || !requestTitle.trim()" @click="createRequest">创建合并请求</el-button>
          </el-form>
        </template>
        <template v-else-if="prepared.mode === 'browser'">
          <p class="row-secondary">源分支和目标分支已准备好，在 {{ prepared.provider }} 页面填写标题并确认创建。</p>
          <el-link v-if="safeUrl(prepared.url)" :href="safeUrl(prepared.url)" target="_blank" rel="noopener noreferrer" type="primary">前往平台创建合并请求</el-link>
        </template>
        <el-link v-else-if="prepared.mode === 'unavailable' && safeUrl(prepared.repositoryUrl)" :href="safeUrl(prepared.repositoryUrl)" target="_blank" rel="noopener noreferrer" type="primary">打开代码平台</el-link>
      </template>
    </section>
  </div>
</template>

<style scoped>
.merge-panel { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.merge-box { margin: 0; padding: 14px; min-width: 0; box-shadow: none; border-radius: 9px; }
.merge-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; font-size: 13px; }
.merge-heading :deep(.el-tag) { max-width: 70%; }
.merge-heading :deep(.el-tag__content) { overflow: hidden; text-overflow: ellipsis; }
.merge-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 16px; }
.merge-form :deep(.el-form-item) { margin-bottom: 12px; min-width: 0; }
.merge-form :deep(.el-select) { width: 100%; }
.merge-wide { grid-column: 1 / -1; }
.row-secondary { margin: 8px 0 12px; font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.merge-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.merge-actions :deep(.el-button) { margin: 0; }
.merge-summary { display: flex; flex-direction: column; gap: 6px; margin-top: 16px; font-size: 12px; overflow-wrap: anywhere; }
.merge-summary small { color: var(--ui-muted); line-height: 1.7; }
.merge-preview-tabs { margin-top: 10px; }
.request-details { margin-top: 16px; }
.request-result { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-top: 14px; font-size: 13px; overflow-wrap: anywhere; }
.request-remote { width: 155px; }
.request-branches { display: flex; flex-wrap: wrap; column-gap: 12px; margin: 2px 0 0; color: var(--ui-muted); font-size: 12px; overflow-wrap: anywhere; }
@media (max-width: 760px) {
  .merge-form { grid-template-columns: minmax(0, 1fr); }
  .merge-heading { align-items: flex-start; }
}
</style>
