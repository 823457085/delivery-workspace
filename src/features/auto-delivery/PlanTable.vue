<script setup lang="ts">
import type { PlanItem } from '../../../shared/hub';
import { safeUrl, day } from '../../shared/format';
import StatusPill from '../../shared/ui/StatusPill.vue';
import { projectRoutingLabel } from './plan-list';
defineProps<{ items: PlanItem[] }>();
defineEmits<{ inspect: [item: PlanItem] }>();
</script>
<template>
  <template v-if="items.length">
  <el-table :data="items" row-key="issue.key" class="execution-desktop">
    <el-table-column label="Jira 事项 / 快照状态" min-width="300"><template #default="{ row }">
      <a :href="safeUrl(row.issue.url)" target="_blank" class="hub-link">{{ row.issue.key }}</a>
      <strong class="row-title">{{ row.issue.summary }}</strong>
      <div class="plan-status"><StatusPill :value="row.issue.status" :label="row.issue.status" /><span v-if="row.issue.parent" class="row-secondary">父任务 {{ row.issue.parent.key }}</span></div>
    </template></el-table-column>
    <el-table-column label="计划日期" width="145"><template #default="{ row }"><span class="row-mono">{{ day(row.issue.startDate) }}</span><span class="row-secondary">至 {{ day(row.issue.endDate || row.issue.dueDate) }}</span></template></el-table-column>
    <el-table-column label="巡检判定" min-width="220"><template #default="{ row }"><span class="row-title">{{ row.action }}</span><span class="row-secondary">{{ row.categoryLabel }}</span><span v-if="row.dependencyKeys?.length" class="row-secondary">依赖 {{ row.dependencyKeys.join('、') }}</span></template></el-table-column>
    <el-table-column label="匹配项目 / 工作区" min-width="240"><template #default="{ row }"><strong class="row-title">{{ projectRoutingLabel(row.projectRouting) }}</strong><span v-if="row.projectRouting?.reason" class="row-secondary">{{ row.projectRouting.reason }}</span><span class="row-mono">{{ row.workspace?.displayPath || row.workspace?.path || row.workspaceEvidence?.label || '未匹配工作区' }}</span><span v-if="row.workspace?.path" class="row-secondary">{{ row.workspaceEvidence?.label }}</span><span class="row-secondary">{{ row.workspace?.branch }}</span></template></el-table-column>
    <el-table-column label="详情" width="65" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="$emit('inspect', row)">查看</el-button></template></el-table-column>
  </el-table>
  <ul class="execution-cards">
    <li v-for="item in items" :key="item.issue.key" class="execution-card">
      <div class="execution-card-header">
        <div class="execution-card-title"><a :href="safeUrl(item.issue.url)" target="_blank" class="hub-link">{{ item.issue.key }}</a><strong>{{ item.issue.summary }}</strong></div>
        <StatusPill :value="item.issue.status" :label="item.issue.status" />
      </div>
      <p v-if="item.issue.parent" class="execution-card-meta">父任务 {{ item.issue.parent.key }}</p>
      <p class="execution-card-result">{{ item.action }}</p>
      <dl class="execution-card-facts">
        <div><dt>计划日期</dt><dd>{{ day(item.issue.startDate) }} 至 {{ day(item.issue.endDate || item.issue.dueDate) }}</dd></div>
        <div><dt>执行类型</dt><dd>{{ item.categoryLabel }}</dd></div>
        <div v-if="item.dependencyKeys?.length"><dt>依赖</dt><dd>{{ item.dependencyKeys.join('、') }}</dd></div>
        <div><dt>匹配项目</dt><dd>{{ projectRoutingLabel(item.projectRouting) }}<span v-if="item.projectRouting?.reason" class="row-secondary">{{ item.projectRouting.reason }}</span></dd></div>
        <div><dt>工作区（快照）</dt><dd>{{ item.workspace?.displayPath || item.workspace?.path || item.workspaceEvidence?.label || '未匹配工作区' }}<span v-if="item.workspace?.path && item.workspaceEvidence?.label" class="row-secondary">{{ item.workspaceEvidence.label }}</span><span v-if="item.workspace?.branch" class="row-secondary">{{ item.workspace.branch }}</span></dd></div>
      </dl>
      <div class="execution-card-actions"><el-button link type="primary" @click="$emit('inspect', item)">查看</el-button></div>
    </li>
  </ul>
  </template>
  <slot v-else name="empty"><el-empty description="当前范围没有自动化计划" :image-size="56" /></slot>
</template>
<style scoped>.plan-status{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:6px}.plan-status .row-secondary{margin-top:0}</style>
