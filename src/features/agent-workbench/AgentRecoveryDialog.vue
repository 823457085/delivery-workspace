<script setup lang="ts">
import { shallowRef, watch } from 'vue';
import type { AgentRun } from '../../../shared/agent-runtime';
import { dateTime } from '../../shared/format';
import { useAgentRecovery } from './useAgentRecovery';

const props = defineProps<{ changing: string }>();
const emit = defineEmits<{ retry: [run: AgentRun]; inspect: [run: AgentRun] }>();
const open = shallowRef(false);
const { runs, loading, load } = useAgentRecovery();
const labels = { pending: '待核对', active: '原进程仍在', 'needs-review': '待确认继续', completed: '原轮次已结束', resumed: '已继续' };
watch(open, value => { if (value) void load(); });
watch(() => props.changing, (value, previous) => { if (open.value && previous && !value) void load(); });
function canRetry(run: AgentRun) {
  return run.status === 'interrupted' && run.recovery?.state === 'needs-review'
    && (!!run.sessionId || run.recovery.previousStatus === 'queued');
}
</script>

<template>
  <el-button text @click="open = true">中断任务恢复</el-button>
  <el-dialog v-model="open" title="中断任务恢复" width="min(960px, 94vw)" append-to-body>
    <p>先核对原执行状态，再逐项确认继续。已产生的文件与外部操作保留。</p>
    <el-button :loading="loading" :disabled="!!changing" @click="load(true)">核对原执行状态</el-button>
    <el-table v-loading="loading" :data="runs" row-key="id" empty-text="暂无中断恢复记录" max-height="480">
      <el-table-column label="任务" min-width="210">
        <template #default="{ row }"><el-button link @click="emit('inspect', row)">{{ row.objective }}</el-button><div>{{ row.workspacePath }}</div></template>
      </el-table-column>
      <el-table-column label="核对结果" min-width="270">
        <template #default="{ row }"><strong>{{ labels[row.recovery.state as keyof typeof labels] }}</strong><p>{{ row.recovery.message }}</p><small>{{ row.recovery.checkedAt ? dateTime(row.recovery.checkedAt) : '尚未核对' }}</small></template>
      </el-table-column>
      <el-table-column label="操作" width="120"><template #default="{ row }"><el-button :disabled="!canRetry(row) || !!changing || loading" @click="emit('retry', row)">确认继续</el-button></template></el-table-column>
    </el-table>
    <template #footer><el-button @click="open = false">关闭</el-button></template>
  </el-dialog>
</template>
