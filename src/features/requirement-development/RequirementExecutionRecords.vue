<script setup lang="ts">
/** 原有开发记录、进度编辑和失败重试；融合 GitHub Spec-Kit / OpenHands 全链路阶段进度条、即时过滤与一键复制分支/目录。 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import type { InputInstance } from 'element-plus';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Check, Copy, FolderGit2, GitBranch, Search } from '@lucide/vue';
import type { RequirementDevelopmentRecord } from '../../../shared/requirement-development';
import type { AgentRunStatus } from '../../../shared/agent-runtime';
import { useRequirementDevelopmentRetry } from './useRequirementDevelopmentRetry';
import { groupProgressText } from '../../../shared/agent-group-chat';
import { dateTime, shortPath } from '../../shared/format';
import RequirementProgressEditor from './RequirementProgressEditor.vue';
import {
  requirementConversationTarget,
  requirementStages,
  requirementStageLabels,
  requirementStageStatusLabels,
} from '../../../shared/requirement-development';
import {
  classifyDeliveryRecordState,
  computeSpecStageProgress,
  summarizeDeliveryRecords,
  type SpecRecordBucket,
} from './spec-delivery-studio';

const emit = defineEmits<{ openRun: [id: string] }>();
const client = useQueryClient();
const queryKey = ['requirement-development'];
const endpoint = '/api/agent-runtimes/requirement-development';
const deletingId = shallowRef('');
const openingId = shallowRef('');

const searchQuery = ref('');
const bucketFilter = shallowRef<'all' | SpecRecordBucket>('all');
const searchInputRef = ref<InputInstance>();
const copiedToken = shallowRef('');
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

const query = useQuery({
  queryKey,
  retry: false,
  refetchIntervalInBackground: false,
  queryFn: async ({ signal }): Promise<RequirementDevelopmentRecord[]> => {
    const response = await fetch(endpoint, { signal });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(
        response.status === 404
          ? '后台尚未加载需求开发功能，需要在当前任务结束后重启本地服务。'
          : result.message || '需求开发记录读取失败',
      );
    }
    return result.records;
  },
  refetchInterval: q =>
    q.state.data?.some(
      item => ['preparing', 'starting'].includes(item.status) || ['queued', 'running'].includes(item.runStatus || ''),
    )
      ? 2000
      : 15000,
});

const records = computed(() => query.data.value || []);
const telemetry = computed(() => summarizeDeliveryRecords(records.value));

const filteredRecords = computed(() => {
  const needle = searchQuery.value.trim().toLowerCase();
  return records.value.filter(record => {
    if (bucketFilter.value !== 'all' && classifyDeliveryRecordState(record) !== bucketFilter.value) return false;
    if (!needle) return true;
    const haystack = [
      record.input.title,
      record.input.issueKey,
      record.input.branch,
      record.workspacePath,
      record.input.parentDirectory,
      ...(record.progress?.issueKeys || []),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(needle);
  });
});

const { retry, retryingId, busy } = useRequirementDevelopmentRetry({
  records,
  blocked: () => query.isPending.value || !!query.error.value || !!deletingId.value,
  refresh: () => query.refetch(),
  openRun: id => emit('openRun', id),
});

const statusLabels: Record<AgentRunStatus, string> = {
  queued: '会话排队中',
  running: '开发会话执行中',
  completed: '本轮已结束 · 查看结果',
  failed: '本轮失败',
  interrupted: '已中断',
  cancelled: '已取消',
};
function status(record: RequirementDevelopmentRecord) {
  if (record.conversationMissing) return record.groupRoomId ? '团队群聊已不存在' : '开发会话已不存在';
  if (record.groupProgress) return groupProgressText(record.groupProgress);
  if (record.runStatus) return statusLabels[record.runStatus];
  return {
    preparing: '正在拉取代码',
    starting: '正在创建会话',
    started: '已创建开发会话',
    failed: '启动失败',
    uncertain: '需核对启动结果',
  }[record.status];
}
function active(record: RequirementDevelopmentRecord) {
  return ['preparing', 'starting'].includes(record.status) || ['queued', 'running'].includes(record.runStatus || '');
}
function stageProgress(record: RequirementDevelopmentRecord) {
  return computeSpecStageProgress(record.progress?.stages, requirementStages);
}

async function copyText(value: string, token: string, label: string) {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    copiedToken.value = token;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      if (copiedToken.value === token) copiedToken.value = '';
    }, 1500);
    ElMessage.success(`已复制${label}`);
  } catch {
    ElMessage.error('浏览器未允许复制');
  }
}

async function openConversation(record: RequirementDevelopmentRecord) {
  if (openingId.value || deletingId.value) return;
  openingId.value = record.id;
  try {
    const { data } = await query.refetch({ throwOnError: true });
    const current = data?.find(item => item.id === record.id);
    const target = current && requirementConversationTarget(current);
    if (target) emit('openRun', target);
    else ElMessage.warning('关联会话已不存在');
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '无法核对关联会话');
  } finally {
    openingId.value = '';
  }
}
async function removeRecord(record: RequirementDevelopmentRecord) {
  if (deletingId.value || openingId.value || busy.value || active(record)) return;
  deletingId.value = record.id;
  try {
    try {
      await ElMessageBox.confirm(
        '将移除这条开发启动记录及其阶段记录，关联会话、Jira 和工作区文件会保留。',
        '删除开发记录',
        { type: 'warning', confirmButtonText: '删除记录', cancelButtonText: '取消' },
      );
    } catch {
      return;
    }
    const response = await fetch(`${endpoint}/${encodeURIComponent(record.id)}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' },
      body: '{}',
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.deleted !== true) throw new Error(result.message || '删除开发记录失败');
    await client.cancelQueries({ queryKey, exact: true });
    client.setQueryData<RequirementDevelopmentRecord[]>(queryKey, list => list?.filter(item => item.id !== record.id));
    void client.invalidateQueries({ queryKey, exact: true });
    ElMessage.success('开发记录已删除');
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '删除开发记录失败');
  } finally {
    deletingId.value = '';
  }
}

function onRecordsKeydown(event: KeyboardEvent) {
  if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target as HTMLElement | null;
  if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return;
  if (document.querySelector('.el-dialog, .el-drawer, .cmd-palette-backdrop')) return;
  event.preventDefault();
  searchInputRef.value?.focus();
}

onMounted(() => document.addEventListener('keydown', onRecordsKeydown));
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onRecordsKeydown);
  if (copiedTimer) clearTimeout(copiedTimer);
});
</script>

<template>
  <section class="development-records">
    <!-- Spec-Kit / OpenHands Telemetry Strip -->
    <div v-if="records.length" class="spec-telemetry-strip">
      <div class="spec-telemetry-tile">
        <span>总启动记录</span>
        <strong>{{ telemetry.total }}</strong>
      </div>
      <div class="spec-telemetry-tile is-primary">
        <span>执行中会话</span>
        <strong>{{ telemetry.running }}</strong>
      </div>
      <div class="spec-telemetry-tile is-success">
        <span>本轮已完成</span>
        <strong>{{ telemetry.completed }}</strong>
      </div>
      <div class="spec-telemetry-tile" :class="{ 'is-danger': telemetry.failed > 0 }">
        <span>异常 / 待重试</span>
        <strong>{{ telemetry.failed }}</strong>
      </div>
    </div>

    <header class="records-toolbar">
      <div class="records-search">
        <el-input
          ref="searchInputRef"
          v-model="searchQuery"
          clearable
          placeholder="搜索需求标题、Jira 单号、分支或目录…"
          aria-label="筛选需求开发记录"
          @keydown.esc="searchQuery = ''"
        >
          <template #prefix><Search :size="14" /></template>
          <template v-if="!searchQuery" #suffix><kbd class="records-kbd">/</kbd></template>
        </el-input>
      </div>
      <div class="records-pills" role="tablist" aria-label="记录状态过滤">
        <button type="button" :class="{ 'is-active': bucketFilter === 'all' }" @click="bucketFilter = 'all'">
          全部 <b>{{ telemetry.total }}</b>
        </button>
        <button type="button" :class="{ 'is-active': bucketFilter === 'running' }" @click="bucketFilter = 'running'">
          执行中 <b>{{ telemetry.running }}</b>
        </button>
        <button type="button" :class="{ 'is-active': bucketFilter === 'completed' }" @click="bucketFilter = 'completed'">
          已完成 <b>{{ telemetry.completed }}</b>
        </button>
        <button type="button" :class="{ 'is-active': bucketFilter === 'failed' }" @click="bucketFilter = 'failed'">
          异常 <b>{{ telemetry.failed }}</b>
        </button>
      </div>
      <el-button class="records-refresh-btn" :loading="query.isFetching.value" @click="query.refetch()">刷新</el-button>
    </header>

    <p v-if="query.error.value" class="record-error">{{ query.error.value.message }}</p>
    <el-empty
      v-else-if="!filteredRecords.length && !query.isPending.value"
      :description="records.length ? '当前筛选条件下无匹配记录' : '尚未启动需求开发'"
      :image-size="48"
    />

    <div class="records-list">
      <article
        v-for="record in filteredRecords"
        :key="record.id"
        class="record-card"
        :class="{ 'is-active': active(record), 'is-failed': record.status === 'failed' || record.runStatus === 'failed' }"
      >
        <div class="record-content">
          <div class="record-title-row">
            <strong>{{ record.input.title }}</strong>
            <span class="record-status-pill" :class="{ 'is-active': active(record), 'is-failed': record.status === 'failed' || record.runStatus === 'failed' }">
              {{ status(record) }}
            </span>
            <span v-if="record.progress" class="record-spec-meter" :title="`Spec 阶段完成度 ${stageProgress(record).completedCount}/${stageProgress(record).totalCount}`">
              阶段 {{ stageProgress(record).completedCount }}/{{ stageProgress(record).totalCount }} · {{ stageProgress(record).percent }}%
            </span>
          </div>

          <div class="record-meta-row">
            <small>{{ dateTime(record.createdAt) }}</small>
            <button
              type="button"
              class="record-copy-chip"
              :class="{ 'is-copied': copiedToken === `br:${record.id}` }"
              :title="`复制分支 ${record.input.branch}`"
              @click="copyText(record.input.branch, `br:${record.id}`, `分支 ${record.input.branch}`)"
            >
              <Check v-if="copiedToken === `br:${record.id}`" :size="11" /><GitBranch v-else :size="11" />
              <code>{{ record.input.branch }}</code>
            </button>
            <button
              v-if="record.workspacePath || record.input.parentDirectory"
              type="button"
              class="record-copy-chip"
              :class="{ 'is-copied': copiedToken === `dir:${record.id}` }"
              :title="`复制路径 ${record.workspacePath || record.input.parentDirectory}`"
              @click="copyText(record.workspacePath || record.input.parentDirectory, `dir:${record.id}`, '工作目录路径')"
            >
              <Check v-if="copiedToken === `dir:${record.id}`" :size="11" /><FolderGit2 v-else :size="11" />
              <span>{{ shortPath(record.workspacePath || record.input.parentDirectory) }}</span>
              <Copy :size="10" />
            </button>
            <small v-if="record.progress?.issueKeys.length" class="record-issues">Jira：{{ record.progress.issueKeys.join(' · ') }}</small>
          </div>

          <div v-if="record.progress" class="record-stage-pills" aria-label="研发阶段状态">
            <span
              v-for="stage in requirementStages"
              :key="stage"
              class="record-stage-pill"
              :data-stage-status="record.progress.stages[stage].status"
              :title="record.progress.stages[stage].evidence || ''"
            >
              <b>{{ requirementStageLabels[stage] }}</b>
              <i>{{ requirementStageStatusLabels[record.progress.stages[stage].status] }}</i>
            </span>
          </div>

          <details v-if="record.progress" class="record-stage-details">
            <summary>
              查看各阶段依据 · {{ record.progress.sourceRunId !== record.runId ? '之前运行，待核对' : record.progress.source === 'agent-result' ? '导入本轮报告' : '人工记录' }}
            </summary>
            <p v-for="stage in requirementStages" :key="stage">
              <strong>{{ requirementStageLabels[stage] }} · {{ requirementStageStatusLabels[record.progress.stages[stage].status] }}</strong>
              <small>{{ record.progress.stages[stage].evidence || '暂无文字记录' }}</small>
            </p>
          </details>
          <p v-if="record.error || record.runError || record.progressSyncError" class="record-error">
            {{ record.error || record.runError || record.progressSyncError }}
          </p>
        </div>

        <div class="record-actions">
          <el-button v-if="record.status === 'failed' && !record.runId" :loading="retryingId === record.id" :disabled="busy || !!deletingId || !!query.error.value" @click="retry(record)">重试</el-button>
          <RequirementProgressEditor v-if="record.runId && !record.conversationMissing" :record="record" />
          <el-button v-if="requirementConversationTarget(record)" type="primary" plain :loading="openingId === record.id" :disabled="!!deletingId" @click="openConversation(record)">
            {{ record.groupRoomId ? '打开团队群聊' : '打开开发会话' }}
          </el-button>
          <el-button type="danger" plain :loading="deletingId === record.id" :disabled="!!deletingId || !!openingId || busy || active(record)" @click="removeRecord(record)">删除记录</el-button>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.development-records { margin-top: 12px; display: grid; gap: 12px; }
.spec-telemetry-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}
.spec-telemetry-tile {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius, 8px);
  background: var(--ui-surface);
}
.spec-telemetry-tile span { font-size: 11.5px; color: var(--ui-muted); }
.spec-telemetry-tile strong { font: 650 18px/1.2 var(--mono); font-variant-numeric: tabular-nums; color: var(--ui-text); }
.spec-telemetry-tile.is-primary strong { color: var(--ui-accent); }
.spec-telemetry-tile.is-success strong { color: #10b981; }
.spec-telemetry-tile.is-danger strong { color: #ef4444; }

.records-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 10px;
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius, 8px);
  background: var(--ui-surface);
}
.records-search { flex: 1 1 220px; max-width: 340px; }
.records-kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border: 1px solid var(--ui-border);
  border-radius: 4px;
  background: var(--ui-raised);
  color: var(--ui-muted);
  font: 500 10.5px/1 var(--mono);
}
.records-pills { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; }
.records-pills > button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 9px;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  background: var(--ui-raised);
  color: var(--ui-secondary);
  font-size: 12px;
  cursor: pointer;
}
.records-pills > button.is-active {
  border-color: color-mix(in srgb, var(--ui-accent) 45%, transparent);
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
  font-weight: 600;
}
.records-pills > button b { font: 600 11px/1 var(--mono); font-variant-numeric: tabular-nums; }
.records-refresh-btn { margin-left: auto; }

.records-list { display: grid; gap: 10px; }
.record-card { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding: 14px 16px; border: 1px solid var(--ui-border); border-radius: var(--ds-radius, 10px); background: var(--ui-surface); transition: border-color .2s; }
.record-card.is-active { border-color: color-mix(in srgb, var(--ui-accent) 42%, var(--ui-border)); }
.record-card.is-failed { border-color: color-mix(in srgb, var(--ui-danger) 42%, var(--ui-border)); }
.record-content { display: grid; gap: 8px; min-width: 0; flex: 1; }
.record-title-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; }
.record-title-row strong { font-size: 14px; font-weight: 600; color: var(--ui-text); }
.record-status-pill { display: inline-flex; align-items: center; padding: 2px 9px; border-radius: 999px; background: var(--ui-accent-soft); color: var(--ui-accent); font-size: 12px; font-weight: 500; }
.record-status-pill.is-failed { background: var(--ui-danger-bg); color: var(--ui-danger); }
.record-spec-meter {
  padding: 2px 7px;
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  background: var(--ui-raised);
  color: var(--ui-secondary);
  font: 500 11px/1.4 var(--mono);
  font-variant-numeric: tabular-nums;
}
.record-meta-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; color: var(--ui-secondary); font-size: 12px; }
.record-copy-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 7px;
  border: 1px solid var(--ui-border);
  border-radius: 5px;
  background: var(--ui-raised);
  color: var(--ui-secondary);
  font-size: 11px;
  cursor: pointer;
}
.record-copy-chip:hover { border-color: var(--ui-accent); color: var(--ui-accent); }
.record-copy-chip.is-copied { border-color: #10b981; color: #10b981; }
.record-copy-chip code { font: 500 11px/1 var(--mono); color: inherit; }
.record-issues { color: var(--ui-accent); font-weight: 500; }
.record-stage-pills { display: flex; flex-wrap: wrap; gap: 6px; }
.record-stage-pill { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border: 1px solid var(--ui-border); border-radius: 6px; background: var(--ui-raised); font-size: 11px; line-height: 16px; }
.record-stage-pill b { color: var(--ui-text); font-weight: 500; }
.record-stage-pill i { font-style: normal; color: var(--ui-muted); }
.record-stage-pill[data-stage-status="completed"] { border-color: color-mix(in srgb, var(--ui-success, #16a34a) 35%, var(--ui-border)); background: color-mix(in srgb, var(--ui-success, #16a34a) 8%, var(--ui-surface)); }
.record-stage-pill[data-stage-status="completed"] i { color: var(--ui-success, #16a34a); font-weight: 600; }
.record-stage-pill[data-stage-status="in_progress"] { border-color: color-mix(in srgb, var(--ui-accent) 38%, var(--ui-border)); background: var(--ui-accent-soft); }
.record-stage-pill[data-stage-status="in_progress"] i { color: var(--ui-accent); font-weight: 600; }
.record-stage-pill[data-stage-status="blocked"] { border-color: color-mix(in srgb, var(--ui-danger) 40%, var(--ui-border)); background: var(--ui-danger-bg); }
.record-stage-pill[data-stage-status="blocked"] i { color: var(--ui-danger); font-weight: 600; }
.record-stage-details { font-size: 12px; }
.record-stage-details summary { cursor: pointer; color: var(--ui-accent); font-size: 12px; user-select: none; }
.record-stage-details p { display: grid; gap: 2px; margin: 8px 0 0; font-size: 12px; line-height: 18px; }
.record-stage-details small { color: var(--ui-secondary); overflow-wrap: anywhere; }
.record-error { margin: 0; color: var(--ui-danger); font-size: 12px; line-height: 18px; }
.record-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; flex-shrink: 0; }
.record-actions .el-button + .el-button { margin-left: 0; }

:root[data-theme='acid'] .spec-telemetry-tile,
:root[data-theme='acid'] .records-toolbar,
:root[data-theme='acid'] .records-pills > button,
:root[data-theme='acid'] .record-card,
:root[data-theme='acid'] .record-copy-chip,
:root[data-theme='acid'] .record-stage-pill,
:root[data-theme='acid'] .record-spec-meter,
:root[data-theme='acid'] .records-kbd {
  border-radius: 0 !important;
}

@media (max-width: 760px) {
  .spec-telemetry-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .record-card { flex-direction: column; }
  .record-actions { width: 100%; }
}
</style>
