<script setup lang="ts">
/** 统一执行列表只负责展示与导航，重排、停止等写操作仍留在原详情确认流程。 */
import { inject } from 'vue';
import type { Job } from '../../../shared/hub';
import { agentWorkspaceContext } from '../../shared/agent-workspace-context';
import { dateTime } from '../../shared/format';
import StatusPill from '../../shared/ui/StatusPill.vue';
import type { ExecutionEntry } from './execution-entries';
defineProps<{ items: ExecutionEntry[] }>();
defineEmits<{ inspect: [job: Job] }>();
const workspace = inject(agentWorkspaceContext, undefined);
</script>

<template>
  <el-table :data="items" row-key="id" empty-text="当前范围没有执行记录">
    <el-table-column label="任务 / 会话" min-width="290"><template #default="{ row }"><strong class="row-title" :title="row.title">{{ row.title }}</strong><span class="row-secondary">{{ row.source }}<template v-if="row.job"> · {{ row.job.issueKey }}</template></span></template></el-table-column>
    <el-table-column label="当前执行状态" width="135"><template #default="{ row }"><StatusPill :value="row.status" /></template></el-table-column>
    <el-table-column label="工作区 / 分支" min-width="240" show-overflow-tooltip><template #default="{ row }"><span class="row-mono">{{ row.workspacePath }}</span><span class="row-secondary">{{ row.branch }}</span></template></el-table-column>
    <el-table-column label="最近更新" width="135"><template #default="{ row }">{{ dateTime(row.updatedAt) }}</template></el-table-column>
    <el-table-column label="操作" width="180" fixed="right"><template #default="{ row }">
      <el-button v-if="row.run && workspace" link type="primary" @click="workspace.openRun(row.run.id)">打开会话</el-button>
      <RouterLink v-else-if="row.run" :to="{ path: '/agent', query: { run: row.run.id } }" class="hub-link">打开会话</RouterLink>
      <a v-else-if="row.job?.threadId" :href="`codex://threads/${encodeURIComponent(row.job.threadId)}`" class="hub-link">打开原会话</a>
      <el-button v-if="row.job" link type="primary" @click="$emit('inspect', row.job)">任务详情</el-button>
    </template></el-table-column>
  </el-table>
</template>

<style scoped>.row-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hub-link{margin-right:10px}</style>
