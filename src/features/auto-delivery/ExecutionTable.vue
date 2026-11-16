<script setup lang="ts">
/**
 * 统一执行列表（借鉴 Trigger.dev v3 Runs 控制台高密度排版）：
 * 只负责展示与导航，支持一键复制工作区目录、分支与任务 ID，展示精确执行耗时；重排、停止等写操作仍留在原详情确认流程。
 */
import { inject } from 'vue';
import { ElMessage } from 'element-plus';
import { Clock, Copy, Folder, GitBranch } from '@lucide/vue';
import type { Job } from '../../../shared/hub';
import { agentWorkspaceContext } from '../../shared/agent-workspace-context';
import { dateTime } from '../../shared/format';
import StatusPill from '../../shared/ui/StatusPill.vue';
import { agentRunStatus } from '../agent-workbench/conversation';
import type { ExecutionEntry } from './execution-entries';

defineProps<{ items: ExecutionEntry[] }>();
defineEmits<{ inspect: [job: Job] }>();
const workspace = inject(agentWorkspaceContext, undefined);

function leafDir(path?: string): string {
  if (!path) return '';
  const parts = path.replaceAll('\\', '/').split('/').filter(Boolean);
  return parts.at(-1) || path;
}

function formatDuration(startIso?: string, endIso?: string): string {
  if (!startIso) return '';
  const start = Date.parse(startIso);
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return '';
  const totalSec = Math.max(1, Math.round((end - start) / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins < 60) return secs ? `${mins}m ${secs}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${String(remMins).padStart(2, '0')}m`;
}

async function copyText(text: string, label = '已复制') {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success(label);
  } catch {
    ElMessage.error('浏览器未允许复制');
  }
}
</script>

<template>
  <template v-if="items.length">
    <el-table :data="items" row-key="id" class="execution-desktop trigger-runs-table">
      <el-table-column label="任务 / 会话" min-width="290">
        <template #default="{ row }">
          <strong class="row-title" :title="row.title">{{ row.title }}</strong>
          <div class="trigger-meta-line">
            <span class="trigger-source-chip">{{ row.source }}</span>
            <span v-if="row.job?.issueKey" class="trigger-issue-chip" @click.stop="copyText(row.job.issueKey, '事项编号已复制')">
              {{ row.job.issueKey }}
            </span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="当前执行状态" width="142">
        <template #default="{ row }">
          <StatusPill
            :value="row.status"
            :label="row.groupRoomId ? row.statusLabel : row.run ? agentRunStatus(row.run).label : undefined"
            :title="row.groupRoomId ? row.statusLabel : row.run ? agentRunStatus(row.run).title : undefined"
          />
        </template>
      </el-table-column>

      <el-table-column label="最近结果 / 工作区" min-width="285">
        <template #default="{ row }">
          <p v-if="row.summary" class="row-secondary row-clamp execution-result" :title="row.summary">{{ row.summary }}</p>
          <div class="trigger-ws-row">
            <button
              v-if="row.workspacePath"
              type="button"
              class="trigger-ws-pill"
              :title="`${row.workspacePath}（点击复制路径）`"
              @click.stop="copyText(row.workspacePath, '工作区路径已复制')"
            >
              <Folder :size="11" />
              <strong>{{ leafDir(row.workspacePath) }}</strong>
              <Copy :size="10" class="trigger-copy-icon" />
            </button>
            <button
              v-if="row.branch"
              type="button"
              class="trigger-branch-pill"
              :title="`分支 ${row.branch}（点击复制）`"
              @click.stop="copyText(row.branch, '分支名称已复制')"
            >
              <GitBranch :size="11" />
              <span>{{ row.branch }}</span>
            </button>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="更新时间 / 耗时" width="148">
        <template #default="{ row }">
          <span class="trigger-time">{{ dateTime(row.updatedAt) }}</span>
          <span v-if="row.run && formatDuration(row.run.createdAt, row.run.updatedAt)" class="trigger-duration">
            <Clock :size="10" />
            {{ formatDuration(row.run.createdAt, row.run.updatedAt) }}
          </span>
        </template>
      </el-table-column>

      <el-table-column label="操作" width="176" fixed="right">
        <template #default="{ row }">
          <RouterLink v-if="row.groupRoomId" :to="{ path: '/agent', query: { group: '1', room: row.groupRoomId } }" class="hub-link">打开群聊</RouterLink>
          <el-button v-else-if="row.run && workspace" link type="primary" @click="workspace.openRun(row.run.id)">打开会话</el-button>
          <RouterLink v-else-if="row.run" :to="{ path: '/agent', query: { run: row.run.id } }" class="hub-link">打开会话</RouterLink>
          <a v-else-if="row.job?.threadId" :href="`codex://threads/${encodeURIComponent(row.job.threadId)}`" class="hub-link">打开原会话</a>
          <el-button v-if="row.job" link type="primary" @click="$emit('inspect', row.job)">任务详情</el-button>
        </template>
      </el-table-column>
    </el-table>

    <ul class="execution-cards">
      <li v-for="item in items" :key="item.id" class="execution-card">
        <div class="execution-card-header">
          <strong class="execution-card-title">{{ item.title }}</strong>
          <StatusPill
            :value="item.status"
            :label="item.groupRoomId ? item.statusLabel : item.run ? agentRunStatus(item.run).label : undefined"
            :title="item.groupRoomId ? item.statusLabel : item.run ? agentRunStatus(item.run).title : undefined"
          />
        </div>
        <p class="execution-card-meta">
          {{ item.source }}<template v-if="item.job"> · {{ item.job.issueKey }}</template> · {{ dateTime(item.updatedAt) }}
          <template v-if="item.run && formatDuration(item.run.createdAt, item.run.updatedAt)">
            · 耗时 {{ formatDuration(item.run.createdAt, item.run.updatedAt) }}
          </template>
        </p>
        <p v-if="item.summary" class="execution-card-result" :title="item.summary">{{ item.summary }}</p>
        <dl class="execution-card-facts">
          <div><dt>工作区</dt><dd>{{ item.workspacePath || '未记录' }}</dd></div>
          <div v-if="item.branch"><dt>分支</dt><dd>{{ item.branch }}</dd></div>
        </dl>
        <div class="execution-card-actions">
          <RouterLink v-if="item.groupRoomId" :to="{ path: '/agent', query: { group: '1', room: item.groupRoomId } }" class="hub-link">打开群聊</RouterLink>
          <el-button v-else-if="item.run && workspace" link type="primary" @click="workspace.openRun(item.run.id)">打开会话</el-button>
          <RouterLink v-else-if="item.run" :to="{ path: '/agent', query: { run: item.run.id } }" class="hub-link">打开会话</RouterLink>
          <a v-else-if="item.job?.threadId" :href="`codex://threads/${encodeURIComponent(item.job.threadId)}`" class="hub-link">打开原会话</a>
          <el-button v-if="item.job" link type="primary" @click="$emit('inspect', item.job)">任务详情</el-button>
        </div>
      </li>
    </ul>
  </template>
  <slot v-else name="empty"><el-empty description="当前范围没有执行记录" :image-size="56" /></slot>
</template>

<style scoped>
.row-title {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trigger-meta-line {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 4px;
}

.trigger-source-chip {
  display: inline-flex;
  align-items: center;
  height: 19px;
  padding: 0 6px;
  border: 1px solid var(--ui-border);
  border-radius: 4px;
  background: var(--ui-raised);
  color: var(--ui-secondary);
  font: 500 10.5px/1 var(--sans);
}

.trigger-issue-chip {
  display: inline-flex;
  align-items: center;
  height: 19px;
  padding: 0 6px;
  border: 1px solid color-mix(in srgb, var(--ui-accent) 32%, var(--ui-border));
  border-radius: 4px;
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
  font: 600 10.5px/1 var(--mono);
  cursor: pointer;
}

.execution-result {
  margin: 0 0 6px;
  white-space: pre-line;
}

.trigger-ws-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
}

.trigger-ws-pill,
.trigger-branch-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 190px;
  height: 21px;
  padding: 0 7px;
  border: 1px solid var(--ui-border);
  border-radius: 5px;
  background: var(--ui-raised);
  color: var(--ui-secondary);
  font: 500 11px/1 var(--mono);
  cursor: pointer;
  transition: border-color 120ms ease, color 120ms ease, background-color 120ms ease;
}

.trigger-ws-pill:hover,
.trigger-branch-pill:hover {
  border-color: color-mix(in srgb, var(--ui-accent) 42%, var(--ui-border));
  background: var(--ui-surface);
  color: var(--ui-text);
}

.trigger-ws-pill strong,
.trigger-branch-pill span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trigger-ws-pill strong {
  font-weight: 600;
  color: var(--ui-text);
}

.trigger-copy-icon {
  flex-shrink: 0;
  opacity: 0.45;
}

.trigger-ws-pill:hover .trigger-copy-icon {
  opacity: 0.95;
}

.trigger-branch-pill {
  color: var(--ui-accent);
  background: color-mix(in srgb, var(--ui-accent-soft) 55%, var(--ui-surface));
  border-color: color-mix(in srgb, var(--ui-accent) 26%, var(--ui-border));
}

.trigger-time {
  display: block;
  font: 450 11.5px/1.4 var(--mono);
  font-variant-numeric: tabular-nums;
  color: var(--ui-text);
}

.trigger-duration {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-top: 3px;
  padding: 1px 6px;
  border: 1px solid var(--ui-border);
  border-radius: 4px;
  background: var(--ui-raised);
  color: var(--ui-muted);
  font: 500 10.5px/1.2 var(--mono);
  font-variant-numeric: tabular-nums;
}

.hub-link {
  margin-right: 10px;
}
</style>
