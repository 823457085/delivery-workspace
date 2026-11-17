<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue';
import { ElMessage } from 'element-plus';
import { Check, Copy, FolderGit2, GitBranch, Search } from '@lucide/vue';
import type { JiraFixRecord } from '../../../shared/jira-fix';
import { groupProgressText } from '../../../shared/agent-group-chat';
import { dateTime, shortPath } from '../../shared/format';
import {
  classifyDeliveryRecordState,
  summarizeDeliveryRecords,
  type SpecRecordBucket,
} from '../requirement-development/spec-delivery-studio';

const props = defineProps<{
  records: JiraFixRecord[];
  loading: boolean;
  refreshing: boolean;
  error: string;
  busy: boolean;
  retryingId: string;
}>();
const emit = defineEmits<{ refresh: []; openRun: [id: string]; handoff: [record: JiraFixRecord]; retry: [record: JiraFixRecord] }>();

const searchQuery = ref('');
const bucketFilter = shallowRef<'all' | SpecRecordBucket>('all');
const copiedToken = shallowRef('');
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

const telemetry = computed(() => summarizeDeliveryRecords(props.records));
const filteredRecords = computed(() => {
  const needle = searchQuery.value.trim().toLowerCase();
  return props.records.filter(record => {
    if (bucketFilter.value !== 'all' && classifyDeliveryRecordState(record) !== bucketFilter.value) return false;
    if (!needle) return true;
    const haystack = [
      record.issue?.key,
      record.issue?.summary,
      record.input.issueKey,
      record.input.branch,
      record.workspacePath,
      record.input.parentDirectory,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(needle);
  });
});

function status(record: JiraFixRecord) {
  if (record.groupProgress) return groupProgressText(record.groupProgress);
  if (record.runStatus) {
    return {
      queued: '会话排队中',
      running: '修复会话执行中',
      completed: '本轮已结束 · 查看结果',
      failed: '本轮失败',
      interrupted: '已中断',
      cancelled: '已取消',
    }[record.runStatus];
  }
  return {
    preparing: '正在准备代码目录',
    starting: '正在创建会话',
    started: '已创建修复会话',
    failed: '启动失败',
    uncertain: '需核对启动结果',
  }[record.status];
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

onBeforeUnmount(() => {
  if (copiedTimer) clearTimeout(copiedTimer);
});
</script>

<template>
  <section class="fix-records">
    <div v-if="records.length" class="fix-telemetry-strip">
      <div class="fix-telemetry-tile"><span>总修复记录</span><strong>{{ telemetry.total }}</strong></div>
      <div class="fix-telemetry-tile is-primary"><span>执行中会话</span><strong>{{ telemetry.running }}</strong></div>
      <div class="fix-telemetry-tile is-success"><span>本轮已完成</span><strong>{{ telemetry.completed }}</strong></div>
      <div class="fix-telemetry-tile" :class="{ 'is-danger': telemetry.failed > 0 }"><span>异常 / 待重试</span><strong>{{ telemetry.failed }}</strong></div>
    </div>

    <header class="records-toolbar">
      <div class="records-search">
        <el-input
          v-model="searchQuery"
          clearable
          placeholder="搜索缺陷单号、标题、分支或工作目录…"
          aria-label="筛选 Jira 修复记录"
          @keydown.esc="searchQuery = ''"
        >
          <template #prefix><Search :size="14" /></template>
        </el-input>
      </div>
      <div class="records-pills" role="tablist" aria-label="修复记录状态过滤">
        <button type="button" :class="{ 'is-active': bucketFilter === 'all' }" @click="bucketFilter = 'all'">全部 <b>{{ telemetry.total }}</b></button>
        <button type="button" :class="{ 'is-active': bucketFilter === 'running' }" @click="bucketFilter = 'running'">执行中 <b>{{ telemetry.running }}</b></button>
        <button type="button" :class="{ 'is-active': bucketFilter === 'completed' }" @click="bucketFilter = 'completed'">已完成 <b>{{ telemetry.completed }}</b></button>
        <button type="button" :class="{ 'is-active': bucketFilter === 'failed' }" @click="bucketFilter = 'failed'">异常 <b>{{ telemetry.failed }}</b></button>
      </div>
      <el-button class="records-refresh-btn" :loading="refreshing" @click="emit('refresh')">刷新</el-button>
    </header>

    <p v-if="error" class="fix-error">{{ error }}</p>
    <el-table v-else v-loading="loading" :data="filteredRecords" :empty-text="records.length ? '当前筛选无匹配的修复记录' : '尚未启动 Jira 修复'" class="fix-table">
      <el-table-column label="Jira / 分支" min-width="260">
        <template #default="{ row }">
          <strong class="fix-issue-title">{{ row.issue?.key || row.input.issueKey }} · {{ row.issue?.summary }}</strong>
          <div class="fix-meta">
            <button
              type="button"
              class="fix-copy-chip"
              :class="{ 'is-copied': copiedToken === `br:${row.id}` }"
              :title="`复制分支 ${row.input.branch}`"
              @click="copyText(row.input.branch, `br:${row.id}`, `分支 ${row.input.branch}`)"
            >
              <Check v-if="copiedToken === `br:${row.id}`" :size="11" /><GitBranch v-else :size="11" />
              <code>{{ row.input.branch }}</code>
            </button>
            <small>{{ dateTime(row.createdAt) }}</small>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="状态 / 工作目录" min-width="300">
        <template #default="{ row }">
          <span class="fix-status-pill" :class="{ 'is-failed': row.status === 'failed' || row.runStatus === 'failed' }">{{ status(row) }}</span>
          <div class="workspace-path-row">
            <button
              v-if="row.workspacePath || row.input.parentDirectory"
              type="button"
              class="fix-copy-chip"
              :class="{ 'is-copied': copiedToken === `dir:${row.id}` }"
              :title="`复制目录 ${row.workspacePath || row.input.parentDirectory}`"
              @click="copyText(row.workspacePath || row.input.parentDirectory, `dir:${row.id}`, '工作目录')"
            >
              <Check v-if="copiedToken === `dir:${row.id}`" :size="11" /><FolderGit2 v-else :size="11" />
              <span>{{ shortPath(row.workspacePath || row.input.parentDirectory) }}</span>
              <Copy :size="10" />
            </button>
          </div>
          <p v-if="row.error || row.runError" class="fix-error">{{ row.error || row.runError }}</p>
        </template>
      </el-table-column>
      <el-table-column label="会话 / Jira 交接" width="210">
        <template #default="{ row }">
          <div class="fix-actions">
            <el-button v-if="row.status === 'failed' && !row.runId" size="small" :loading="retryingId === row.id" :disabled="busy || !!error" @click="emit('retry', row)">重试</el-button>
            <el-button v-if="row.groupRoomId || row.runId" size="small" type="primary" plain @click="emit('openRun', row.groupRoomId ? `group:${row.groupRoomId}` : row.runId)">
              {{ row.groupRoomId ? '打开团队群聊' : '打开修复会话' }}
            </el-button>
            <el-button v-if="row.runStatus === 'completed'" size="small" @click="emit('handoff', row)">
              {{ row.handoff?.status === 'completed' ? '查看交接结果' : row.handoff ? '核对 Jira 交接' : '交接 Jira' }}
            </el-button>
          </div>
          <small v-if="row.handoff" class="handoff-state">
            {{ { completed: '已交接', failed: '交接未完成', uncertain: '写入结果待核对', submitting: '正在交接' }[row.handoff.status as string] }}
          </small>
        </template>
      </el-table-column>
    </el-table>
  </section>
</template>

<style scoped>
.fix-records { margin-top: 12px; display: grid; gap: 12px; }
.fix-telemetry-strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.fix-telemetry-tile { display: flex; flex-direction: column; gap: 3px; padding: 10px 12px; border: 1px solid var(--ui-border); border-radius: var(--ds-radius, 8px); background: var(--ui-surface); }
.fix-telemetry-tile span { font-size: 11.5px; color: var(--ui-muted); }
.fix-telemetry-tile strong { font: 650 18px/1.2 var(--mono); font-variant-numeric: tabular-nums; color: var(--ui-text); }
.fix-telemetry-tile.is-primary strong { color: var(--ui-accent); }
.fix-telemetry-tile.is-success strong { color: #10b981; }
.fix-telemetry-tile.is-danger strong { color: #ef4444; }

.records-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; padding: 10px 12px; border: 1px solid var(--ui-border); border-radius: var(--ds-radius, 8px); background: var(--ui-surface); }
.records-search { flex: 1 1 220px; max-width: 340px; }
.records-pills { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; }
.records-pills > button { display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 9px; border: 1px solid var(--ui-border); border-radius: 6px; background: var(--ui-raised); color: var(--ui-secondary); font-size: 12px; cursor: pointer; }
.records-pills > button.is-active { border-color: color-mix(in srgb, var(--ui-accent) 45%, transparent); background: var(--ui-accent-soft); color: var(--ui-accent); font-weight: 600; }
.records-pills > button b { font: 600 11px/1 var(--mono); font-variant-numeric: tabular-nums; }
.records-refresh-btn { margin-left: auto; }

.fix-table { border: 1px solid var(--ui-border); border-radius: var(--ds-radius, 10px); overflow: hidden; }
.fix-issue-title { display: block; color: var(--ui-text); font-size: 13px; line-height: 20px; }
.fix-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; margin-top: 4px; color: var(--ui-muted); font-size: 12px; }
.fix-copy-chip { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 7px; border: 1px solid var(--ui-border); border-radius: 5px; background: var(--ui-raised); color: var(--ui-secondary); font-size: 11px; cursor: pointer; }
.fix-copy-chip:hover { border-color: var(--ui-accent); color: var(--ui-accent); }
.fix-copy-chip.is-copied { border-color: #10b981; color: #10b981; }
.fix-copy-chip code { font: 500 11px/1 var(--mono); color: inherit; }
.fix-status-pill { display: inline-flex; align-items: center; padding: 2px 9px; border-radius: 999px; background: var(--ui-accent-soft); color: var(--ui-accent); font-size: 12px; font-weight: 500; }
.fix-status-pill.is-failed { background: var(--ui-danger-bg); color: var(--ui-danger); }
.workspace-path-row { margin-top: 5px; }
.fix-error { margin: 4px 0 0; color: var(--ui-danger); font-size: 12px; }
.fix-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.fix-actions :deep(.el-button + .el-button) { margin-left: 0; }
.handoff-state { display: block; margin-top: 6px; color: var(--ui-muted); font-size: 11px; }

:root[data-theme='acid'] .fix-telemetry-tile,
:root[data-theme='acid'] .records-toolbar,
:root[data-theme='acid'] .records-pills > button,
:root[data-theme='acid'] .fix-table,
:root[data-theme='acid'] .fix-copy-chip {
  border-radius: 0 !important;
}

@media (max-width: 760px) {
  .fix-telemetry-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
