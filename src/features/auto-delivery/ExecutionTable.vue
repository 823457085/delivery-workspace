<script setup lang="ts">
/** 统一执行列表只负责展示与导航，重排、停止等写操作仍留在原详情确认流程。 */
import { inject } from 'vue';
import type { Job } from '../../../shared/hub';
import { agentWorkspaceContext } from '../../shared/agent-workspace-context';
import { dateTime } from '../../shared/format';
import StatusPill from '../../shared/ui/StatusPill.vue';
import { agentRunStatus } from '../agent-workbench/conversation';
import type { ExecutionEntry } from './execution-entries';
defineProps<{ items: ExecutionEntry[] }>();
defineEmits<{ inspect: [job: Job] }>();
const workspace = inject(agentWorkspaceContext, undefined);
</script>

<template>
  <template v-if="items.length">
  <el-table :data="items" row-key="id" class="execution-desktop">
    <el-table-column label="任务 / 会话" min-width="290"><template #default="{ row }"><strong class="row-title" :title="row.title">{{ row.title }}</strong><span class="row-secondary">{{ row.source }}<template v-if="row.job"> · {{ row.job.issueKey }}</template></span></template></el-table-column>
    <el-table-column label="当前执行状态" width="135"><template #default="{ row }"><StatusPill :value="row.status" :label="row.groupRoomId ? row.statusLabel : row.run ? agentRunStatus(row.run).label : undefined" :title="row.groupRoomId ? row.statusLabel : row.run ? agentRunStatus(row.run).title : undefined" /></template></el-table-column>
    <el-table-column label="最近结果 / 工作区" min-width="280"><template #default="{ row }"><p v-if="row.summary" class="row-secondary row-clamp execution-result" :title="row.summary">{{ row.summary }}</p><span class="row-mono execution-workspace" :title="row.workspacePath">{{ row.workspacePath }}</span><span v-if="row.branch" class="row-secondary">{{ row.branch }}</span></template></el-table-column>
    <el-table-column label="最近更新" width="135"><template #default="{ row }">{{ dateTime(row.updatedAt) }}</template></el-table-column>
    <el-table-column label="操作" width="180" fixed="right"><template #default="{ row }">
      <RouterLink v-if="row.groupRoomId" :to="{ path: '/agent', query: { group: '1', room: row.groupRoomId } }" class="hub-link">打开群聊</RouterLink>
      <el-button v-else-if="row.run && workspace" link type="primary" @click="workspace.openRun(row.run.id)">打开会话</el-button>
      <RouterLink v-else-if="row.run" :to="{ path: '/agent', query: { run: row.run.id } }" class="hub-link">打开会话</RouterLink>
      <a v-else-if="row.job?.threadId" :href="`codex://threads/${encodeURIComponent(row.job.threadId)}`" class="hub-link">打开原会话</a>
      <el-button v-if="row.job" link type="primary" @click="$emit('inspect', row.job)">任务详情</el-button>
    </template></el-table-column>
  </el-table>
  <ul class="execution-cards">
    <li v-for="item in items" :key="item.id" class="execution-card">
      <div class="execution-card-header"><strong class="execution-card-title">{{ item.title }}</strong><StatusPill :value="item.status" :label="item.groupRoomId ? item.statusLabel : item.run ? agentRunStatus(item.run).label : undefined" :title="item.groupRoomId ? item.statusLabel : item.run ? agentRunStatus(item.run).title : undefined" /></div>
      <p class="execution-card-meta">{{ item.source }}<template v-if="item.job"> · {{ item.job.issueKey }}</template> · {{ dateTime(item.updatedAt) }}</p>
      <p v-if="item.summary" class="execution-card-result" :title="item.summary">{{ item.summary }}</p>
      <dl class="execution-card-facts"><div><dt>工作区</dt><dd>{{ item.workspacePath || '未记录' }}</dd></div><div v-if="item.branch"><dt>分支</dt><dd>{{ item.branch }}</dd></div></dl>
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

<style scoped>.row-title,.execution-workspace{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hub-link{margin-right:10px}.execution-result{margin:0 0 6px;white-space:pre-line}</style>
