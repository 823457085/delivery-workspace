<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue';
import { agentProviderLabels, type AgentProvider, type AgentRun } from '../../../shared/agent-runtime';
import { dateTime } from '../../shared/format';
import { useAgentRecovery } from './useAgentRecovery';

const props = defineProps<{ changing: string }>();
const emit = defineEmits<{ retry: [run: AgentRun]; inspect: [run: AgentRun] }>();
const open = shallowRef(false);
const { runs, loading, load } = useAgentRecovery();
const labels = { pending: '待核对', active: '原进程仍在', 'needs-review': '待确认继续', completed: '原轮次已结束', resumed: '已继续' };
const stats = computed(() => ({
  total: runs.value.length,
  needsReview: runs.value.filter(run => canRetry(run)).length,
  pending: runs.value.filter(run => ['pending', 'active'].includes(run.recovery?.state || '')).length,
  resolved: runs.value.filter(run => ['completed', 'resumed'].includes(run.recovery?.state || '')).length,
}));
watch(open, value => { if (value) void load(); });
watch(() => props.changing, (value, previous) => { if (open.value && previous && !value) void load(); });
function canRetry(run: AgentRun) {
  return run.status === 'interrupted' && run.recovery?.state === 'needs-review'
    && (!!run.sessionId || run.recovery.previousStatus === 'queued');
}
</script>

<template>
  <el-button text @click="open = true">中断任务恢复</el-button>
  <el-dialog v-model="open" title="中断任务恢复" width="min(960px, 94vw)" class="recovery-dialog" append-to-body>
    <div class="recovery-banner">
      <div class="recovery-banner-main">
        <p class="recovery-desc">先核对原执行状态，再逐项确认继续。已产生的文件与外部操作保留。</p>
        <div v-if="stats.total" class="recovery-stats" aria-label="恢复任务统计">
          <span class="stat-chip">共 <b>{{ stats.total }}</b> 条</span>
          <span v-if="stats.needsReview" class="stat-chip is-warning">待确认继续 <b>{{ stats.needsReview }}</b></span>
          <span v-if="stats.pending" class="stat-chip is-info">待核对 / 运行中 <b>{{ stats.pending }}</b></span>
          <span v-if="stats.resolved" class="stat-chip is-success">已结束 / 已继续 <b>{{ stats.resolved }}</b></span>
        </div>
      </div>
      <el-button class="recovery-check-btn" type="primary" plain :loading="loading" :disabled="!!changing" @click="load(true)">核对原执行状态</el-button>
    </div>
    <el-table v-loading="loading" :data="runs" row-key="id" class="recovery-table" empty-text="暂无中断恢复记录" max-height="480">
      <el-table-column label="任务" min-width="310">
        <template #default="{ row }">
          <div class="recovery-task-cell">
            <el-button link class="recovery-task-link" :title="row.objective" @click="emit('inspect', row)">{{ row.objective }}</el-button>
            <div class="recovery-task-sub">
              <span v-if="row.provider" class="recovery-provider-tag">{{ agentProviderLabels[row.provider as AgentProvider] || row.provider }}</span>
              <span v-if="row.branch" class="recovery-branch-tag">{{ row.branch }}</span>
              <div class="recovery-workspace" :title="row.workspacePath">{{ row.workspacePath }}</div>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="核对结果" min-width="270">
        <template #default="{ row }">
          <div class="recovery-result-cell">
            <div class="recovery-result-head">
              <strong class="recovery-state-badge" :class="`is-${row.recovery?.state || 'pending'}`">{{ labels[row.recovery.state as keyof typeof labels] }}</strong>
              <small class="recovery-checked-time">{{ row.recovery.checkedAt ? dateTime(row.recovery.checkedAt) : '尚未核对' }}</small>
            </div>
            <p class="recovery-result-message">{{ row.recovery.message || '尚未核对原执行状态，请点击上方按钮核对。' }}</p>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="132" align="right">
        <template #default="{ row }">
          <div class="recovery-action-cell">
            <el-button size="small" :type="canRetry(row) ? 'primary' : 'default'" :plain="!canRetry(row)" :disabled="!canRetry(row) || !!changing || loading" @click="emit('retry', row)">确认继续</el-button>
          </div>
        </template>
      </el-table-column>
    </el-table>
    <template #footer><el-button @click="open = false">关闭</el-button></template>
  </el-dialog>
</template>

<style scoped>
.recovery-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
  padding: 12px 16px;
  border: 1px solid var(--ui-border, var(--el-border-color-lighter));
  border-radius: 10px;
  background: color-mix(in srgb, var(--ui-raised, var(--el-fill-color-light)) 65%, transparent);
}
.recovery-banner-main {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.recovery-desc {
  margin: 0;
  color: var(--ui-secondary, var(--el-text-color-regular));
  font-size: 13px;
  line-height: 1.6;
}
.recovery-stats {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.stat-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--ui-surface, var(--el-bg-color));
  border: 1px solid var(--ui-border, var(--el-border-color-lighter));
  color: var(--ui-muted, var(--el-text-color-secondary));
  font-size: 11.5px;
  line-height: 1.5;
}
.stat-chip b {
  font-weight: 600;
  color: var(--ui-text, var(--el-text-color-primary));
}
.stat-chip.is-warning {
  border-color: color-mix(in srgb, var(--el-color-warning) 36%, transparent);
  background: color-mix(in srgb, var(--el-color-warning) 10%, transparent);
  color: var(--el-color-warning-dark-2, #b88230);
}
.stat-chip.is-warning b { color: inherit; }
.stat-chip.is-info {
  border-color: color-mix(in srgb, var(--el-color-primary) 32%, transparent);
  background: color-mix(in srgb, var(--el-color-primary) 10%, transparent);
  color: var(--el-color-primary);
}
.stat-chip.is-info b { color: inherit; }
.stat-chip.is-success {
  border-color: color-mix(in srgb, var(--el-color-success) 32%, transparent);
  background: color-mix(in srgb, var(--el-color-success) 10%, transparent);
  color: var(--el-color-success-dark-2, #3e8e41);
}
.stat-chip.is-success b { color: inherit; }
.recovery-check-btn {
  flex-shrink: 0;
}
.recovery-table {
  border: 1px solid var(--ui-border, var(--el-border-color-lighter));
  border-radius: 10px;
  overflow: hidden;
}
.recovery-table :deep(th.el-table__cell) {
  background: color-mix(in srgb, var(--ui-raised, var(--el-fill-color-light)) 75%, transparent);
  color: var(--ui-secondary, var(--el-text-color-secondary));
  font-size: 12px;
  font-weight: 600;
  padding: 10px 0;
}
.recovery-table :deep(td.el-table__cell) {
  padding: 13px 0;
  vertical-align: middle;
}
.recovery-task-cell {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
}
.recovery-task-link {
  height: auto;
  padding: 0;
  border: 0;
  font-size: 13.5px;
  font-weight: 600;
  line-height: 1.55;
  color: var(--ui-text, var(--el-text-color-primary));
  text-align: left;
  white-space: normal;
  justify-content: flex-start;
}
.recovery-task-link:hover {
  color: var(--ui-accent, var(--el-color-primary));
}
.recovery-task-link :deep(> span) {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  word-break: break-word;
  white-space: normal;
  text-align: left;
}
.recovery-task-sub {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  width: 100%;
  min-width: 0;
}
.recovery-provider-tag,
.recovery-branch-tag {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 5px;
  background: var(--ui-raised, var(--el-fill-color-light));
  border: 1px solid var(--ui-border, var(--el-border-color-lighter));
  color: var(--ui-secondary, var(--el-text-color-secondary));
  font-size: 11px;
  line-height: 1.45;
}
.recovery-branch-tag {
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.recovery-workspace {
  flex: 1 1 180px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ui-muted, var(--el-text-color-secondary));
  font: 11.5px/1.5 var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.recovery-result-cell {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.recovery-result-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.recovery-state-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 600;
  line-height: 1.5;
  background: var(--ui-raised, var(--el-fill-color-light));
  color: var(--ui-secondary, var(--el-text-color-regular));
  border: 1px solid var(--ui-border, var(--el-border-color-lighter));
}
.recovery-state-badge.is-needs-review {
  background: color-mix(in srgb, var(--el-color-warning) 13%, transparent);
  border-color: color-mix(in srgb, var(--el-color-warning) 35%, transparent);
  color: var(--el-color-warning-dark-2, #b88230);
}
.recovery-state-badge.is-active {
  background: color-mix(in srgb, var(--el-color-primary) 12%, transparent);
  border-color: color-mix(in srgb, var(--el-color-primary) 32%, transparent);
  color: var(--el-color-primary);
}
.recovery-state-badge.is-completed,
.recovery-state-badge.is-resumed {
  background: color-mix(in srgb, var(--el-color-success) 12%, transparent);
  border-color: color-mix(in srgb, var(--el-color-success) 32%, transparent);
  color: var(--el-color-success-dark-2, #3e8e41);
}
.recovery-checked-time {
  color: var(--ui-muted, var(--el-text-color-secondary));
  font: 11.5px/1.4 var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.recovery-result-message {
  margin: 0;
  color: var(--ui-secondary, var(--el-text-color-regular));
  font-size: 12.5px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.recovery-action-cell {
  display: flex;
  justify-content: flex-end;
  align-items: center;
}
:global(.recovery-dialog .el-dialog__title) {
  font-family: var(--sans, -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif);
  font-size: 17px;
  font-weight: 650;
}
:global(.recovery-dialog .el-dialog__body) {
  padding-top: 16px;
}
@media (max-width: 640px) {
  .recovery-banner {
    flex-direction: column;
    align-items: stretch;
  }
  .recovery-check-btn {
    width: 100%;
  }
}
</style>
