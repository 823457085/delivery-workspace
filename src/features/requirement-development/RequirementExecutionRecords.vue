<script setup lang="ts">
/** 原有开发记录、进度编辑和失败重试；需求台账复用同一查询。 */
import { computed, shallowRef } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { RequirementDevelopmentRecord } from '../../../shared/requirement-development';
import type { AgentRunStatus } from '../../../shared/agent-runtime';
import { useRequirementDevelopmentRetry } from './useRequirementDevelopmentRetry';
import { groupProgressText } from '../../../shared/agent-group-chat';
import { dateTime, shortPath } from '../../shared/format';
import RequirementProgressEditor from './RequirementProgressEditor.vue';
import { requirementConversationTarget, requirementStages, requirementStageLabels, requirementStageStatusLabels } from '../../../shared/requirement-development';

const emit = defineEmits<{ openRun: [id: string] }>();
const client = useQueryClient();
const queryKey = ['requirement-development'];
const endpoint = '/api/agent-runtimes/requirement-development';
const deletingId = shallowRef('');
const openingId = shallowRef('');
const query = useQuery({ queryKey, retry: false,
  queryFn: async ({ signal }): Promise<RequirementDevelopmentRecord[]> => {
    const response = await fetch(endpoint, { signal });
    const result = await response.json();
    if (!response.ok) throw new Error(response.status === 404 ? '后台尚未加载需求开发功能，需要在当前任务结束后重启本地服务。' : result.message || '需求开发记录读取失败');
    return result.records;
  }, refetchInterval: q => q.state.data?.some(item => ['preparing', 'starting'].includes(item.status) || ['queued', 'running'].includes(item.runStatus || '')) ? 2000 : 15000,
});
const records = computed(() => query.data.value || []);
const { retry, retryingId, busy } = useRequirementDevelopmentRetry({ records,
  blocked: () => query.isPending.value || !!query.error.value || !!deletingId.value,
  refresh: () => query.refetch(), openRun: id => emit('openRun', id),
});
const statusLabels: Record<AgentRunStatus, string> = { queued: '会话排队中', running: '开发会话执行中', completed: '本轮已结束 · 查看结果', failed: '本轮失败', interrupted: '已中断', cancelled: '已取消' };
function status(record: RequirementDevelopmentRecord) {
  if (record.conversationMissing) return record.groupRoomId ? '团队群聊已不存在' : '开发会话已不存在';
  if (record.groupProgress) return groupProgressText(record.groupProgress);
  if (record.runStatus) return statusLabels[record.runStatus];
  return { preparing: '正在拉取代码', starting: '正在创建会话', started: '已创建开发会话', failed: '启动失败', uncertain: '需核对启动结果' }[record.status];
}
function active(record: RequirementDevelopmentRecord) {
  return ['preparing', 'starting'].includes(record.status) || ['queued', 'running'].includes(record.runStatus || '');
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
  } finally { openingId.value = ''; }
}
async function removeRecord(record: RequirementDevelopmentRecord) {
  if (deletingId.value || openingId.value || busy.value || active(record)) return;
  deletingId.value = record.id;
  try {
    try {
      await ElMessageBox.confirm('将移除这条开发启动记录及其阶段记录，关联会话、Jira 和工作区文件会保留。', '删除开发记录',
        { type: 'warning', confirmButtonText: '删除记录', cancelButtonText: '取消' });
    } catch { return; }
    const response = await fetch(`${endpoint}/${encodeURIComponent(record.id)}/delete`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: '{}' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.deleted !== true) throw new Error(result.message || '删除开发记录失败');
    await client.cancelQueries({ queryKey, exact: true });
    client.setQueryData<RequirementDevelopmentRecord[]>(queryKey, records => records?.filter(item => item.id !== record.id));
    void client.invalidateQueries({ queryKey, exact: true });
    ElMessage.success('开发记录已删除');
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '删除开发记录失败');
  } finally { deletingId.value = ''; }
}
</script>

<template>
  <section class="development-records"><header><h3>开发启动记录</h3><el-button :loading="query.isFetching.value" @click="query.refetch()">刷新</el-button></header>
      <p v-if="query.error.value">{{ query.error.value.message }}</p>
      <el-empty v-else-if="!records.length && !query.isPending.value" description="尚未启动需求开发" :image-size="48" />
      <article v-for="record in records" :key="record.id"><div class="record-content"><strong>{{ record.input.title }}</strong><span>{{ status(record) }}</span><small>{{ dateTime(record.createdAt) }} · {{ record.input.branch }}</small><small :title="record.workspacePath || record.input.parentDirectory">{{ shortPath(record.workspacePath || record.input.parentDirectory) }}</small><small v-if="record.progress?.issueKeys.length">关联 Jira：{{ record.progress.issueKeys.join(' · ') }}</small><details v-if="record.progress"><summary>阶段进度 · {{ record.progress.sourceRunId !== record.runId ? '之前运行，待核对' : record.progress.source === 'agent-result' ? '导入本轮报告' : '人工记录' }}</summary><p v-for="stage in requirementStages" :key="stage">{{ requirementStageLabels[stage] }} · {{ requirementStageStatusLabels[record.progress.stages[stage].status] }}<small>{{ record.progress.stages[stage].evidence }}</small></p></details><p v-if="record.error || record.runError || record.progressSyncError">{{ record.error || record.runError || record.progressSyncError }}</p></div><div class="record-actions">
          <el-button v-if="record.status === 'failed' && !record.runId" :loading="retryingId === record.id" :disabled="busy || !!deletingId || !!query.error.value" @click="retry(record)">重试</el-button>
          <RequirementProgressEditor v-if="record.runId && !record.conversationMissing" :record="record" />
          <el-button v-if="requirementConversationTarget(record)" :loading="openingId === record.id" :disabled="!!deletingId" @click="openConversation(record)">{{ record.groupRoomId ? '打开团队群聊' : '打开开发会话' }}</el-button>
          <el-button type="danger" plain :loading="deletingId === record.id" :disabled="!!deletingId || !!openingId || busy || active(record)" @click="removeRecord(record)">删除记录</el-button>
        </div></article>
  </section>
</template>

<style scoped>
.development-records header{display:flex;align-items:center;justify-content:space-between;gap:16px}
summary{cursor:pointer;font-size:13px;color:var(--ui-secondary)}
.development-records{margin-top:24px}.development-records h3{font-size:15px}.development-records article{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:16px 0;border-bottom:1px solid var(--ui-border)}article strong{font-size:14px}article span{font-size:12px;margin-left:16px;color:var(--ui-accent)}article small{display:block;color:var(--ui-secondary);margin-top:6px;overflow-wrap:anywhere}article p{font-size:12px;line-height:1.7}
.record-content{min-width:0;flex:1}.record-content details{margin-top:12px}.record-actions{display:flex;flex-wrap:wrap;gap:8px}.record-actions .el-button+.el-button{margin-left:0}
</style>
