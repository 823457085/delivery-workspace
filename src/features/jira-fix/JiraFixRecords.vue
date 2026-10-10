<script setup lang="ts">
import type { JiraFixRecord } from '../../../shared/jira-fix';
import { dateTime } from '../../shared/format';
defineProps<{ records: JiraFixRecord[]; loading: boolean; refreshing: boolean; error: string; busy: boolean; retryingId: string }>();
const emit = defineEmits<{ refresh: []; openRun: [id: string]; handoff: [record: JiraFixRecord]; retry: [record: JiraFixRecord] }>();
function status(record: JiraFixRecord) {
  if (record.runStatus) return { queued: '会话排队中', running: '修复会话执行中', completed: '本轮已结束 · 查看结果', failed: '本轮失败', interrupted: '已中断', cancelled: '已取消' }[record.runStatus];
  return { preparing: '正在准备代码目录', starting: '正在创建会话', started: '已创建修复会话', failed: '启动失败', uncertain: '需核对启动结果' }[record.status];
}
</script>

<template>
  <section class="fix-records">
    <header class="records-heading"><h3>修复启动记录</h3><el-button :loading="refreshing" @click="emit('refresh')">刷新</el-button></header>
    <p v-if="error">{{ error }}</p>
    <el-table v-else v-loading="loading" :data="records" empty-text="尚未启动 Jira 修复">
      <el-table-column label="Jira / 分支" min-width="260"><template #default="{ row }"><strong>{{ row.issue?.key || row.input.issueKey }} · {{ row.issue?.summary }}</strong><div>{{ row.input.branch }}</div><small>{{ dateTime(row.createdAt) }}</small></template></el-table-column>
      <el-table-column label="状态 / 工作目录" min-width="300"><template #default="{ row }"><div>{{ status(row) }}</div><div class="workspace-path">{{ row.workspacePath || row.input.parentDirectory }}</div><p v-if="row.error || row.runError">{{ row.error || row.runError }}</p></template></el-table-column>
      <el-table-column label="会话 / Jira 交接" width="180"><template #default="{ row }"><el-button v-if="row.status === 'failed' && !row.runId" link type="primary" :loading="retryingId === row.id" :disabled="busy || !!error" @click="emit('retry', row)">重试</el-button><el-button v-if="row.runId" link type="primary" @click="emit('openRun', row.runId)">打开修复会话</el-button><div v-if="row.runStatus === 'completed'"><el-button link type="primary" @click="emit('handoff', row)">{{ row.handoff?.status === 'completed' ? '查看交接结果' : row.handoff ? '核对 Jira 交接' : '交接 Jira' }}</el-button></div><small v-if="row.handoff">{{ { completed: '已交接', failed: '交接未完成', uncertain: '写入结果待核对', submitting: '正在交接' }[row.handoff.status as string] }}</small></template></el-table-column>
    </el-table>
  </section>
</template>

<style scoped>
.fix-records{margin-top:24px}.records-heading{display:flex;align-items:center;justify-content:space-between;gap:16px}.records-heading h3{font-size:15px}.workspace-path{overflow-wrap:anywhere;font-size:12px;color:var(--ui-secondary)}
</style>
