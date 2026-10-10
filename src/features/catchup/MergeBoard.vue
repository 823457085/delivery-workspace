<script setup lang="ts">
/** 默认聚焦待处理，历史完成与范围排除保留独立入口；筛选仅作用于列表，不修改业务状态。 */
import { computed, watch } from 'vue';
import { useWorkspacePanelState } from '../../shared/useWorkspacePanelState';
import type { MergeData, MergeItem } from '../../../shared/hub';
import { searchMatches, safeUrl, dateTime, statusLabels } from '../../shared/format';
import MetricStrip from '../../shared/ui/MetricStrip.vue';
import StatusPill from '../../shared/ui/StatusPill.vue';
import { mergeItemGroup, type MergeListScope } from './domain';
const props = defineProps<{ merge: MergeData }>();
defineEmits<{ inspect: [item: MergeItem]; checkJira: [] }>();
const { search, status, git, page, scope } = useWorkspacePanelState('merge', () => ({ search: '', status: 'all', git: 'all', page: 1, scope: 'pending' as MergeListScope }));
const groups = computed(() => {
  const result: Record<MergeListScope, MergeItem[]> = { pending: [], completed: [], excluded: [], all: props.merge.items };
  for (const item of props.merge.items) result[mergeItemGroup(item)].push(item);
  return result;
});
const scopedItems = computed(() => groups.value[scope.value]);
const availableStatuses = computed(() => [...new Set(scopedItems.value.map((item) => item.status))]);
const rows = computed(() => scopedItems.value.filter((item) => searchMatches([item.requirementId, item.title, item.jiraKey, item.functionSummary, item.sourceBranch], search.value) && (status.value === 'all' || status.value === item.status) && (git.value === 'all' || (git.value === 'merged') === item.merged)));
function resetFilters() { search.value = ''; status.value = 'all'; git.value = 'all'; page.value = 1; }
watch(() => rows.value.length, (length) => { page.value = Math.min(page.value, Math.max(1, Math.ceil(length / 15))); });
const metrics = computed(() => [
  { label: 'Admin 交付范围', value: props.merge.summary.sequenceTotal, note: `${props.merge.summary.total} 项审计记录，${groups.value.excluded.length} 项无需合入（已移出范围）` },
  { label: '自测审核通过', value: props.merge.summary.APPROVED, note: `审核进度 ${props.merge.summary.progressPercent}% · 例外已合入 ${props.merge.summary.EXCEPTION_MERGED || 0} 项（不计通过）`, tone: 'success' },
  { label: '待人工审核', value: props.merge.summary.AWAITING_REVIEW, note: `${props.merge.summary.BLOCKED} 项阻塞，均可查看完整原因`, tone: 'warning' },
  { label: 'Git 已包含', value: props.merge.summary.merged, note: '祖先关系不代表自测审核通过', tone: 'primary' },
]);
</script>
<template>
  <MetricStrip :items="metrics" />
  <div class="surface target-branch"><div><span class="row-secondary">统一目标分支</span><a class="hub-link" :href="safeUrl(merge.target.url)" target="_blank">{{ merge.target.branch }}</a><span class="row-mono">本地 {{ merge.target.localSha || '未获取' }}<br>远端 {{ merge.target.remoteSha || '未获取' }}</span></div><div><StatusPill :value="merge.source.targetFresh ? 'PASS' : 'BLOCKED'" :label="merge.source.targetFresh ? '来源报告：目标一致' : '目标需核查'" /><span class="row-secondary">检查时间 {{ dateTime(merge.source.checkedAt) }}</span><el-button link type="primary" @click="$emit('checkJira')">只读核对 Jira 完成情况</el-button></div></div>
  <div class="surface">
    <div class="quick-filters">
      <el-radio-group v-model="scope" aria-label="合入快捷筛选" @change="resetFilters">
        <el-radio-button value="pending">待处理 {{ groups.pending.length }}</el-radio-button>
        <el-radio-button value="completed">已合入 / 已完成 {{ groups.completed.length }}</el-radio-button>
        <el-radio-button value="excluded">无需合入 {{ groups.excluded.length }}</el-radio-button>
        <el-radio-button value="all">全部 {{ groups.all.length }}</el-radio-button>
      </el-radio-group>
      <p v-if="scope === 'pending'">仅显示尚需处理的合入项，已隐藏 Git 已包含、已完成和无需合入的需求；历史审核与范围复核记录可在“已合入 / 已完成”中查看。</p>
      <p v-else-if="scope === 'completed'">Git 已包含或已完成本轮交付的需求，无需重复合入；原自测、阻塞及范围复核状态仍保留，不代表业务验收通过。</p>
      <p v-else-if="scope === 'excluded'">原“暂缓”项已移出 Admin 交付范围，无需继续合入；仅保留业务需求与历史记录。</p>
      <p v-else>保留全部审计记录，含已完成和已移出 Admin 交付范围的需求。</p>
    </div>
    <div class="filter-bar"><el-input v-model="search" placeholder="搜索需求、Jira 或分支" clearable @input="page = 1" /><el-select v-model="status" aria-label="自测审核状态" @change="page = 1"><el-option label="全部自测状态" value="all" /><el-option v-for="value in availableStatuses" :key="value" :label="value === 'HOLD' ? '无需合入' : statusLabels[value] || value" :value="value" /></el-select><el-select v-model="git" aria-label="Git 合入状态" @change="page = 1"><el-option label="全部 Git 状态" value="all" /><el-option label="Git 已包含" value="merged" /><el-option label="Git 未包含" value="unmerged" /></el-select><el-button v-if="search || status !== 'all' || git !== 'all'" link type="primary" @click="resetFilters">清空条件</el-button><span class="filter-count">当前 {{ rows.length }} / {{ scopedItems.length }} 项 · 总计 {{ merge.items.length }} 项</span></div>
    <el-table :data="rows.slice((page - 1) * 15, page * 15)" row-key="requirementId" empty-text="没有符合筛选条件的合入项"><el-table-column label="序号" width="65"><template #default="{ row }">{{ row.order ?? '—' }}</template></el-table-column><el-table-column label="需求 / 功能" min-width="290"><template #default="{ row }"><span class="row-mono">{{ row.requirementId }} · {{ row.jiraKey }}</span><span class="row-title">{{ row.title }}</span><span class="row-secondary row-clamp">{{ row.functionSummary }}</span></template></el-table-column><el-table-column label="自测审核 / Git" width="148"><template #default="{ row }"><StatusPill :value="row.status" :label="mergeItemGroup(row) === 'excluded' ? '无需合入' : undefined" /><span v-if="mergeItemGroup(row) !== 'excluded'" class="row-secondary"><StatusPill :value="row.gitStatus" /></span></template></el-table-column><el-table-column label="用例 / 截图" width="165"><template #default="{ row }"><span>{{ row.reviewGate.passedTestCaseIds.length }} PASS · {{ row.reviewGate.skippedTestCaseIds.length }} N/A</span><span class="row-secondary">{{ row.reviewGate.screenshotCount }} 张功能图 · {{ row.testPlan.coverage.p0Total }} P0</span><span v-if="row.reviewGate.failedTestCaseIds.length || row.reviewGate.missingTestCaseIds.length" class="row-secondary">{{ row.reviewGate.failedTestCaseIds.length }} 失败 / {{ row.reviewGate.missingTestCaseIds.length }} 缺失</span></template></el-table-column><el-table-column label="结果 / 阻塞原因" min-width="280"><template #default="{ row }"><span class="row-clamp">{{ mergeItemGroup(row) === 'excluded' ? row.decisionNote : row.pipeline.error || row.scopeReviewNote || row.pipeline.result || row.decisionNote }}</span><span class="row-secondary">{{ dateTime(row.pipeline.updatedAt) }}</span></template></el-table-column><el-table-column label="操作" width="120" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="$emit('inspect', row)">{{ row.status === 'AWAITING_REVIEW' ? '审核证据' : '完整详情' }}</el-button></template></el-table-column></el-table>
    <div class="table-footer"><span>合入版本 {{ merge.revision }} · 点击详情查看逐条用例及截图</span><el-pagination v-model:current-page="page" :total="rows.length" :page-size="15" layout="prev, pager, next" /></div></div>
  <el-collapse class="surface"><el-collapse-item title="合入规则与范围说明" name="rules"><ol class="merge-rules"><li v-for="rule in merge.mergeRules" :key="rule">{{ rule }}</li></ol></el-collapse-item></el-collapse>
</template>
<style scoped>.quick-filters{padding:18px 20px 0}.quick-filters p{font-size:12px;color:var(--ui-muted);line-height:1.8;margin:12px 0 0}.quick-filters:deep(.el-radio-group){gap:8px}.quick-filters:deep(.el-radio-button__inner){border:1px solid var(--ui-border);border-radius:6px;box-shadow:none;font-weight:600}.target-branch{padding:17px 20px;display:flex;justify-content:space-between;gap:20px;align-items:center}.target-branch .row-mono{display:block;margin-top:9px}.target-branch>div:last-child{text-align:right;flex-shrink:0}.merge-rules{font-size:12px;line-height:2;color:var(--ui-muted);padding:0 35px}.surface:deep(.el-collapse-item__header){padding:0 20px}@media(max-width:750px){.target-branch{flex-direction:column;align-items:stretch}.target-branch>div:last-child{text-align:left}}</style>
