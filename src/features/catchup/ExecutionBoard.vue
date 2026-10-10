<script setup lang="ts">
/** 以需求为业务单元呈现执行状态；正式交付、会话完成和排除范围保持分列。 */
import { computed } from 'vue';
import { useWorkspacePanelState } from '../../shared/useWorkspacePanelState';
import type { CatchupData, CatchupRequirement } from '../../../shared/hub';
import { searchMatches, dateTime } from '../../shared/format';
import MetricStrip from '../../shared/ui/MetricStrip.vue';
import StatusPill from '../../shared/ui/StatusPill.vue';
const props = defineProps<{ board: CatchupData }>();
defineEmits<{ inspect: [item: CatchupRequirement] }>();
const { search, domain, wave, status, page } = useWorkspacePanelState('catchup-execution', () => ({ search: '', domain: '', wave: '', status: 'all', page: 1 }));
const rows = computed(() => props.board.requirements.filter((item) => searchMatches([item.id, item.title, item.goal, item.session.jiraKey], search.value) && (!domain.value || domain.value === item.businessDomain) && (!wave.value || wave.value === item.wave) && (status.value === 'all' || status.value === 'excluded' && !!item.execution.exclusionReason || status.value === item.execution.status && !item.execution.exclusionReason)));
const metrics = computed(() => [
  { label: '冻结需求', value: props.board.counts.requirements, note: `${props.board.counts.acceptanceCriteria} 条验收标准` },
  { label: '功能还原进行中', value: props.board.executionStatuses.IN_PROGRESS, note: '不等于 Codex 当前运行数量', tone: 'primary' },
  { label: '工作包 / 页面落点', value: props.board.counts.workPackages, note: `${props.board.counts.landings} 个架构落点` },
  { label: '移出 Admin 范围', value: props.board.requirements.filter((item) => item.execution.exclusionReason).length, note: '保留审计记录，不自动重新执行' },
]);
</script>
<template>
  <MetricStrip :items="metrics" />
  <div class="surface"><div class="filter-bar"><el-input v-model="search" placeholder="搜索需求、业务名称或 Jira" clearable @input="page = 1" /><el-select v-model="domain" placeholder="全部业务域" clearable aria-label="业务域" @change="page = 1"><el-option v-for="value in board.domains" :key="value" :label="value" :value="value" /></el-select><el-select v-model="wave" placeholder="全部波次" clearable aria-label="交付波次" @change="page = 1"><el-option v-for="value in board.waves" :key="value" :label="value" :value="value" /></el-select><el-select v-model="status" aria-label="执行范围" @change="page = 1"><el-option label="全部状态 / 含排除项" value="all" /><el-option label="进行中" value="IN_PROGRESS" /><el-option label="未开始" value="NOT_STARTED" /><el-option label="已暂停" value="PAUSED" /><el-option label="已结束" value="ENDED" /><el-option label="移出 Admin 范围" value="excluded" /></el-select><span class="filter-count">{{ rows.length }} / {{ board.requirements.length }} 项</span></div>
    <el-table :data="rows.slice((page - 1) * 15, page * 15)" row-key="id" empty-text="没有符合筛选条件的需求"><el-table-column label="需求 / 业务目标" min-width="310"><template #default="{ row }"><span class="row-mono">{{ row.id }} · {{ row.session.jiraKey || '未关联 Jira' }}</span><span class="row-title">{{ row.title }}</span><span class="row-secondary row-clamp">{{ row.goal }}</span></template></el-table-column><el-table-column label="领域 / 波次" width="150"><template #default="{ row }"><span>{{ row.businessDomain }}</span><span class="row-secondary">{{ row.wave }}</span></template></el-table-column><el-table-column label="功能执行 / 会话" width="155"><template #default="{ row }"><StatusPill :value="row.execution.exclusionReason ? 'HOLD' : row.execution.status" /><span class="row-secondary"><StatusPill :value="row.session.status" /></span></template></el-table-column><el-table-column label="交付覆盖" width="142"><template #default="{ row }"><span>{{ row.acceptanceCriteriaCount }} AC · {{ row.workPackageCount }} 工作包</span><span class="row-secondary"><StatusPill :value="row.deliveryStatus" /></span></template></el-table-column><el-table-column label="下一步 / 排除原因" min-width="240"><template #default="{ row }"><span class="row-clamp">{{ row.execution.exclusionReason || row.nextAction }}</span><span class="row-secondary">{{ dateTime(row.session.updatedAt || row.execution.updatedAt) }}</span></template></el-table-column><el-table-column label="操作" width="110" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="$emit('inspect', row)">需求详情</el-button></template></el-table-column></el-table>
    <div class="table-footer"><span>执行版本 {{ board.executionRevision }} · 会话完成不代表正式验收</span><el-pagination v-model:current-page="page" :page-size="15" :total="rows.length" layout="prev, pager, next" /></div></div>
</template>
