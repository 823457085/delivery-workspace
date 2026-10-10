<script setup lang="ts">
/** 入口编排各模块会话、聚合证据和回测表单；后台队列负责执行，每组进度独立呈现。 */
import { computed } from 'vue';
import type { AgentRun } from '../../../shared/agent-runtime';
import { reviewLabel } from '../../../shared/apex-bff-review';
import MetricStrip from '../../shared/ui/MetricStrip.vue';
import QueryState from '../../shared/ui/QueryState.vue';
import ExecutionEvidence from './ExecutionEvidence.vue';
import ExecutionRetest from './ExecutionRetest.vue';
import { executionRequest } from './execution-plan';
import { useIntegrationExecution } from './useIntegrationExecution';

const { catalogQuery, progress, reviews, runtime, interfaces, tasks, runs, active, metrics, sending, refresh, start, startAll, stop, openRun } = useIntegrationExecution();
const ready = computed(() => !!progress.data.value?.automation && !!reviews.data.value && !!runtime.data.value);
const error = computed(() => catalogQuery.error.value || progress.error.value || reviews.error.value || runtime.error.value);
const stateLabels = { queued: '排队中', running: '执行中', completed: '本轮执行结束', failed: '执行失败', interrupted: '执行中断', cancelled: '已停止' };
const taskRows = computed(() => tasks.value.map(task => ({ ...task,
  running: !!task.run && ['queued', 'running'].includes(task.run.status),
  stateLabel: task.deferred ? '暂不联调' : task.run ? stateLabels[task.run.status] : task.pending ? '待执行' : '无待执行查询',
  updatedAt: [task.progress?.updatedAt || '', task.run?.updatedAt || ''].sort().at(-1),
})));
const canStartAll = computed(() => ready.value && taskRows.value.some(task => !task.deferred && !task.running && task.pending > 0));
const reviewStatus = computed(() => Object.fromEntries(interfaces.value.map(item => [item.id, reviewLabel(reviews.data.value?.[item.id])])));
const recentRuns = computed(() => runs.value.slice(0, 10));
function taskTitle(run: AgentRun) {
  const request = executionRequest(run);
  const title = tasks.value.find(task => task.id === request?.taskId)?.title || '联调执行';
  return request?.kind === 'retest' ? `${title} · 回测 ${request.issueId}` : title;
}
</script>

<template>
  <section class="integration-execution" aria-label="联调执行进度">
    <header class="execution-heading">
      <div><h2>联调执行</h2><p>{{ progress.data.value?.automation.assignee || '未配置负责人' }} · 全部名下接口 · 按模块独立会话并行执行</p></div>
      <div class="execution-actions">
        <el-button :loading="progress.isFetching.value" @click="refresh">刷新进度</el-button>
        <el-button type="primary" :disabled="!canStartAll" :loading="sending" @click="startAll">并行执行待办</el-button>
      </div>
    </header>
    <QueryState :loading="progress.isPending.value" :error="error" :has-data="!!progress.data.value" @retry="refresh">
      <MetricStrip :items="metrics" />
      <section class="execution-tasks surface" aria-label="各模块执行会话">
        <div class="tasks-title"><h3>模块执行会话</h3><small>{{ active.length }} 个会话执行或排队 · 进度每 5 秒刷新</small></div>
        <el-table :data="taskRows" row-key="id" empty-text="所选负责人当前没有联调任务">
          <el-table-column label="模块 / 会话" min-width="200"><template #default="{ row }"><strong>{{ row.title }}</strong><small v-if="row.module !== row.title" class="task-detail">{{ row.module }}</small></template></el-table-column>
          <el-table-column label="接口" width="120"><template #default="{ row }">{{ row.total }} 条<small class="task-detail">本轮 {{ row.executable }} · 暂不联调 {{ row.deferredCount }}</small><small class="task-detail">待查询 {{ row.pending }}</small></template></el-table-column>
          <el-table-column label="本轮检查进度" width="130"><template #default="{ row }">{{ row.checked }} / {{ row.executable }}<small class="task-detail">实测通过 {{ row.passed }}</small></template></el-table-column>
          <el-table-column label="执行状态" prop="stateLabel" width="135" />
          <el-table-column label="当前步骤" min-width="260"><template #default="{ row }">{{ row.current }}<small v-if="row.run?.error" class="task-detail execution-event">{{ row.run.error }}</small></template></el-table-column>
          <el-table-column label="最后更新" min-width="165"><template #default="{ row }">{{ row.updatedAt ? new Date(row.updatedAt).toLocaleString() : '—' }}</template></el-table-column>
          <el-table-column label="操作" width="170"><template #default="{ row }">
            <el-button v-if="row.run && openRun" link type="primary" @click="openRun(row.run.id)">查看会话</el-button>
            <el-button v-if="row.running" link :disabled="sending" @click="stop(row.run)">停止</el-button>
            <el-button v-else link type="primary" :disabled="!ready || sending || row.deferred || !row.pending" @click="start({ kind: 'integration', taskId: row.id })">执行本组</el-button>
          </template></el-table-column>
        </el-table>
        <p class="execution-note">同一页面由一个会话负责。暂不联调项保留负责人、历史结果与证据，本轮执行和回测均跳过；自动检查通过后仍需人工确认。</p>
      </section>
      <ExecutionRetest :issues="progress.data.value?.issues || []" :environment="progress.data.value?.automation?.environment || ''" :busy="sending" @submit="start" />
      <ExecutionEvidence v-if="progress.data.value" :progress="progress.data.value" :interfaces="interfaces" :review-status="reviewStatus" />
      <section class="execution-history surface">
        <h3>执行记录</h3>
        <el-table :data="recentRuns" row-key="id" empty-text="尚无后台执行记录">
          <el-table-column label="任务" min-width="180"><template #default="{ row }">{{ taskTitle(row) }}</template></el-table-column>
          <el-table-column label="执行状态" width="150"><template #default="{ row }">{{ stateLabels[row.status as keyof typeof stateLabels] }}</template></el-table-column>
          <el-table-column label="开始时间" min-width="160"><template #default="{ row }">{{ new Date(row.createdAt).toLocaleString() }}</template></el-table-column>
          <el-table-column label="部署版本" min-width="140"><template #default="{ row }">{{ executionRequest(row)?.version || '—' }}</template></el-table-column>
          <el-table-column label="记录" width="100"><template #default="{ row }"><el-button v-if="openRun" link type="primary" @click="openRun(row.id)">查看会话</el-button></template></el-table-column>
        </el-table>
      </section>
    </QueryState>
  </section>
</template>

<style scoped>
.integration-execution{max-width:1500px;margin:0 auto;color:var(--ui-text)}
.execution-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:18px}
.execution-heading h2{margin:0;font-size:22px}.execution-heading p{margin:8px 0 0;font-size:13px;color:var(--ui-secondary)}
.execution-actions{display:flex;gap:10px;flex-wrap:wrap}.execution-actions :deep(.el-button){margin-left:0}
.execution-tasks{padding:18px 20px;margin:18px 0}.tasks-title{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px}.tasks-title h3{font-size:15px;margin:0}
.tasks-title small,.task-detail{font-size:12px;color:var(--ui-secondary);line-height:1.7}.task-detail{display:block;margin-top:4px}
.execution-event{overflow-wrap:anywhere}.execution-note{margin:12px 0 0;font-size:12px;color:var(--ui-muted);line-height:1.7}
.execution-history{margin-top:18px;padding:18px}.execution-history h3{font-size:15px;margin:0 0 12px}
@media(max-width:720px){.execution-heading{align-items:flex-start;flex-direction:column}}
</style>
