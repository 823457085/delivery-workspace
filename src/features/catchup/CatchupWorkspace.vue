<script setup lang="ts">
/** 同域编排执行与合入子视图，统一使用来源版本号；写操作仍由原服务端校验。 */
import { computed, shallowRef, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { CatchupData, MergeData, CatchupRequirement, MergeItem } from '../../../shared/hub';
import { useSource, useSourceActions, readSource } from '../../shared/api';
import PageHeading from '../../shared/ui/PageHeading.vue';
import QueryState from '../../shared/ui/QueryState.vue';
import RecordDrawer from '../../shared/ui/RecordDrawer.vue';
import ExecutionBoard from './ExecutionBoard.vue';
import RequirementDetail from './RequirementDetail.vue';
import MergeBoard from './MergeBoard.vue';
import MergeDetail from './MergeDetail.vue';
import CodexQueue from './CodexQueue.vue';
import type { QueueEntry } from './domain';
import { directMergeReasonError } from './domain';
const props = defineProps<{ mode: string }>();
const route = useRoute();
const boardQuery = useSource<CatchupData>('catchup'), mergeQuery = useSource<MergeData>('merge');
const { data: board } = boardQuery, { data: merge } = mergeQuery;
const actions = useSourceActions();
const selectedRequirementId = shallowRef(''), selectedMergeId = shallowRef('');
const requirementOpen = shallowRef(false), mergeOpen = shallowRef(false), jiraOpen = shallowRef(false), jiraLoading = shallowRef(false), acting = shallowRef(false);
const jiraReport = shallowRef<unknown>();
const selectedRequirement = computed(() => board.value?.requirements.find((item) => item.id === selectedRequirementId.value));
const selectedMerge = computed(() => merge.value?.items.find((item) => item.requirementId === selectedMergeId.value));
const title = computed(() => props.mode === 'execution' ? '追平执行' : props.mode === 'merge' ? '合入审核' : '追平 Codex 队列');
const loading = computed(() => boardQuery.isFetching.value || mergeQuery.isFetching.value);
const currentError = computed(() => props.mode === 'execution' ? boardQuery.error.value : props.mode === 'merge' ? mergeQuery.error.value : boardQuery.error.value || mergeQuery.error.value);
const hasData = computed(() => props.mode === 'execution' ? !!board.value : props.mode === 'merge' ? !!merge.value : !!board.value && !!merge.value);
const actionLabels: Record<string, string> = { start: '启动还原', pause: '暂停执行', resume: '恢复执行', finish: '结束本轮执行' };
async function refresh() { await Promise.all([boardQuery.refetch(), mergeQuery.refetch()]); }
function inspectRequirement(item: CatchupRequirement) { selectedRequirementId.value = item.id; requirementOpen.value = true; }
function inspectMerge(item: MergeItem) { selectedMergeId.value = item.requirementId; mergeOpen.value = true; }
function inspectEntry(entry: QueueEntry) { if (entry.kind === 'execution') { const item = board.value?.requirements.find((item) => item.id === entry.requirementId); if (item) inspectRequirement(item); } else { const item = merge.value?.items.find((item) => item.requirementId === entry.requirementId); if (item) inspectMerge(item); } }
async function executionAction(action: string) {
  if (!selectedRequirement.value || !board.value || acting.value) return;
  acting.value = true;
  try { await actions.execute('catchup-action', { action, requirementIds: [selectedRequirement.value.id], expectedRevision: board.value.executionRevision }, `确认${actionLabels[action]}`, action === 'pause' ? board.value.executionSemantics.pause : action === 'finish' ? board.value.executionSemantics.finish : '这会改变原追平执行状态，现有调度器可能派发 Codex、修改对应工作区并更新 Jira。'); } finally { acting.value = false; }
}
async function mergeAction(action: string, label: string) {
  if (!selectedMerge.value || !merge.value || acting.value) return;
  acting.value = true;
  try { await actions.execute('merge-action', { requirementId: selectedMerge.value.requirementId, action, expectedRevision: merge.value.revision }, `确认：${label}`, action === 'approve' ? `你将批准 ${selectedMerge.value.requirementId} 的当前证据，并授权合入调度器继续真实合入 ${merge.value.target.branch}、提交和推送。请确认已核对完整用例、N/A 理由与截图；后续状态在当前面板查看，无需切换页面。` : '这会启动或重排该需求的真实执行任务。后台按当前阶段决定后续动作，可能修改工作区；请确认操作对象与阶段。后续状态在当前面板查看，无需切换页面。'); } finally { acting.value = false; }
}
async function directMerge() {
  if (!selectedMerge.value?.directMergeAction?.enabled || !merge.value || acting.value) return;
  // 在填写原因之前固定操作对象、版本和源 SHA；切换详情或后台更新不能悄悄改成另一项提交。
  const item = selectedMerge.value, targetBranch = merge.value.target.branch;
  const payload = { requirementId: item.requirementId, action: 'direct-merge', expectedRevision: merge.value.revision, expectedSourceSha: item.sourceRemoteSha };
  acting.value = true;
  try {
    let reason: string;
    try {
      const result = await ElMessageBox.prompt(`仅用于当前环境无法完成自测的需求。${item.requirementId} 的失败和未验证记录会保留，不会改为自测通过。请写明环境限制和例外原因。`, '例外直接合入 · 填写原因', {
        inputType: 'textarea', inputValue: '', inputPlaceholder: '例如：此需求依赖特殊分期环境，i18n-test 不支持；本次先合入，后续在对应环境补测。',
        inputValidator: directMergeReasonError, confirmButtonText: '下一步：核对合入范围', cancelButtonText: '取消', closeOnClickModal: false,
      });
      reason = result.value.trim();
    } catch { return; }
    await actions.execute('merge-action', { ...payload, reason }, `确认例外直接合入 ${payload.requirementId}`, `原因：${reason}。源分支 ${item.sourceBranch}，源提交 ${payload.expectedSourceSha}，目标分支 ${targetBranch}。确认后会跳过当前自测门槛，授权合入调度器执行该提交的真实合入、提交和推送；Git 冲突、版本与源 SHA 校验仍保留。此操作不代表自测通过，也不自动完成 Jira。后续状态在当前面板查看，无需切换页面。`);
  } finally { acting.value = false; }
}
async function checkJira() { jiraLoading.value = true; jiraReport.value = undefined; try { jiraReport.value = await readSource('merge-jira'); jiraOpen.value = true; } catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); } finally { jiraLoading.value = false; } }
async function syncJira() {
  const ok = await actions.execute('merge-jira', {}, '确认同步 Jira 完成状态', '这会按交付规则更新真实 Jira 事项状态。请核对本次只读报告后再执行。');
  if (ok) await checkJira();
}
watch(() => props.mode, () => { requirementOpen.value = false; mergeOpen.value = false; });
watch([() => route.query.requirement, () => props.mode, () => !!board.value, () => !!merge.value], () => {
  const id = route.query.requirement;
  if (props.mode === 'execution') { const item = board.value?.requirements.find(item => item.id === id); if (item) inspectRequirement(item); }
  else { const item = merge.value?.items.find(item => item.requirementId === id); if (item) inspectMerge(item); }
}, { immediate: true });
</script>
<template>
  <PageHeading :title="title" description="冻结需求 → 功能还原 → 合入自测 → 人工审核 → Git 交付；每个阶段保留独立状态与证据。" :loading="loading" @refresh="refresh" />
  <QueryState :loading="loading" :error="currentError" :has-data="hasData" @retry="refresh"><ExecutionBoard v-if="mode === 'execution' && board" :board="board" @inspect="inspectRequirement" /><MergeBoard v-else-if="mode === 'merge' && merge" :merge="merge" @inspect="inspectMerge" @check-jira="checkJira" /><CodexQueue v-else-if="board && merge" :board="board" :merge="merge" @inspect="inspectEntry" @review="inspectMerge" /></QueryState>
  <p v-if="jiraLoading" class="source-footnote">正在只读核对 Jira，没有同步或关闭事项…</p>
  <RecordDrawer v-model="requirementOpen" :title="selectedRequirement?.title || '需求详情'" :subtitle="selectedRequirement?.id" :record="selectedRequirement"><RequirementDetail v-if="selectedRequirement" :item="selectedRequirement" /><template #footer><el-button v-for="action in selectedRequirement?.execution.allowedActions || []" :key="action" :loading="acting" :disabled="acting" :type="action === 'finish' ? 'warning' : 'primary'" plain @click="executionAction(action)">{{ actionLabels[action] || action }}</el-button></template></RecordDrawer>
  <RecordDrawer v-model="mergeOpen" :title="selectedMerge?.title || '合入详情'" :subtitle="selectedMerge?.requirementId" :record="selectedMerge"><MergeDetail v-if="selectedMerge && merge" :key="selectedMerge.requirementId" :item="selectedMerge" :target-branch="merge.target.branch" /><template #footer><el-button v-if="selectedMerge?.directMergeAction?.enabled" type="warning" plain :disabled="acting" @click="directMerge">例外直接合入</el-button><el-button v-if="selectedMerge?.reviewRetryAction?.enabled" :disabled="acting" @click="mergeAction(selectedMerge.reviewRetryAction.action, selectedMerge.reviewRetryAction.label)">{{ selectedMerge.reviewRetryAction.label }}</el-button><el-button v-if="selectedMerge?.action?.enabled" type="primary" :loading="acting" @click="mergeAction(selectedMerge.action.action, selectedMerge.action.label)">{{ selectedMerge.action.label }}</el-button></template></RecordDrawer>
  <RecordDrawer v-model="jiraOpen" title="Jira 完成情况 · 只读核对" :record="jiraReport"><template #footer><el-button type="warning" :disabled="!jiraReport" :loading="actions.pending.value || jiraLoading" @click="syncJira">同步 Jira 完成状态</el-button></template></RecordDrawer>
</template>
