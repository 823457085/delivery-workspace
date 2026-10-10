<script setup lang="ts">
/** 只聚合可运行阶段；待审核单列，不占并发，不混入自动交付的普通 Jira 队列。 */
import { computed } from 'vue';
import { useWorkspacePanelState } from '../../shared/useWorkspacePanelState';
import type { CatchupData, MergeData, MergeItem } from '../../../shared/hub';
import { catchupQueue, type QueueEntry } from './domain';
import { searchMatches, dateTime } from '../../shared/format';
import StatusPill from '../../shared/ui/StatusPill.vue';
import MetricStrip from '../../shared/ui/MetricStrip.vue';
const props = defineProps<{ board: CatchupData; merge: MergeData }>();
defineEmits<{ inspect: [entry: QueueEntry]; review: [item: MergeItem] }>();
const { search } = useWorkspacePanelState('catchup-queue', () => ({ search: '' }));
const entries = computed(() => catchupQueue(props.board, props.merge));
const rows = computed(() => entries.value.filter((entry) => searchMatches(entry, search.value)));
const waiting = computed(() => props.merge.items.filter((item) => item.status === 'AWAITING_REVIEW').sort((a, b) => (a.order ?? 999) - (b.order ?? 999)));
const metrics = computed(() => [
  { label: '运行 / 派发中', value: entries.value.filter((item) => ['running','dispatched','dispatching'].includes(item.status)).length, note: `需求并发上限 ${props.board.dispatcher.maxConcurrent || 8}`, tone: 'primary' },
  { label: '等待执行', value: entries.value.filter((item) => item.status === 'queued').length, note: '功能还原 + 合入自测 + Git 交付' },
  { label: '已暂停', value: entries.value.filter((item) => item.status === 'paused').length, note: '不等于强制终止运行中工具' },
  { label: '人工审核区', value: waiting.value.length, note: '不占执行并发，Git 交付串行', tone: 'warning' },
]);
</script>
<template><MetricStrip :items="metrics" /><div class="surface"><div class="surface-header"><div><h2>追平阶段队列</h2><p>调度器 {{ board.dispatcher.displayStatus }} · 心跳 {{ dateTime(board.dispatcher.lastHeartbeatAt) }}</p></div><StatusPill :value="board.dispatcher.status" /></div><div class="filter-bar"><el-input v-model="search" placeholder="搜索需求、任务 ID 或工作区" clearable /><span class="filter-count">{{ rows.length }} 条可见阶段记录</span></div><el-table :data="rows" empty-text="当前没有排队或运行中的追平任务"><el-table-column label="需求 / 阶段" min-width="290"><template #default="{ row }"><span class="row-mono">{{ row.requirementId }} · {{ row.stage }}</span><span class="row-title">{{ row.title }}</span></template></el-table-column><el-table-column label="状态" width="130"><template #default="{ row }"><StatusPill :value="row.status" /></template></el-table-column><el-table-column label="真实任务 / 工作区" min-width="320"><template #default="{ row }"><span class="row-mono">{{ row.threadId || '尚未创建任务' }}</span><span class="row-secondary">{{ row.workspace }}</span><span class="row-secondary">{{ row.branch }}</span></template></el-table-column><el-table-column label="更新时间" width="130"><template #default="{ row }">{{ dateTime(row.updatedAt) }}</template></el-table-column><el-table-column label="操作" width="85"><template #default="{ row }"><el-button link type="primary" @click="$emit('inspect', row)">详情</el-button></template></el-table-column></el-table><p class="empty-note">会话已完成的历史仍在“追平执行”和“合入审核”中；空队列不代表原系统没有任务。</p></div><div class="surface"><div class="surface-header"><div><h2>待人工审核</h2><p>查看逐条用例和截图后，再决定通过或退回补测。</p></div><span class="row-secondary">{{ waiting.length }} 项</span></div><el-table :data="waiting" empty-text="当前没有待审核项"><el-table-column label="需求" min-width="350"><template #default="{ row }"><span class="row-mono">{{ row.requirementId }}</span><span class="row-title">{{ row.title }}</span></template></el-table-column><el-table-column label="证据" min-width="180"><template #default="{ row }">{{ row.reviewGate.passedTestCaseIds.length }} PASS · {{ row.reviewGate.skippedTestCaseIds.length }} N/A<span class="row-secondary">{{ row.reviewGate.screenshotCount }} 张功能截图</span></template></el-table-column><el-table-column label="操作" width="120"><template #default="{ row }"><el-button link type="primary" @click="$emit('review', row)">审核证据</el-button></template></el-table-column></el-table></div></template>
