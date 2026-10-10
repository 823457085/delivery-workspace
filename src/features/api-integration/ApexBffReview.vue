<script setup lang="ts">
/**
 * 设计说明：沿用既有接口 ID 和菜单归属，集中处理人员分工与人工审核。
 * 人员选择和菜单批量分配分别由子组件承接；负责人独立保存，分配不会改变联调结论。
 * 清单来源不作为任务筛选条件，保留全部已收录接口，避免更换展示方式时丢失任务与证据。
 */
import { computed, shallowRef, watch } from 'vue';
import { useWorkspacePanelState } from '../../shared/useWorkspacePanelState';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { reviewLabel, reviewStatuses, type ApexBffAssignee, type ApexBffReviewStatus, type ApexBffReviewState } from '../../../shared/apex-bff-review';
import { integrationDeferral, integrationScopeCategory, type IntegrationScopeCategory } from '../../../shared/apex-integration-scope';
import PageHeading from '../../shared/ui/PageHeading.vue';
import type { ReviewCatalogItem } from './review-catalog';
import { useIntegrationCatalog } from './useIntegrationCatalog';
import { filterReviewCatalog } from './review-filter';
import ReviewNavigation from './ReviewNavigation.vue';
import ReviewAssigneePicker from './ReviewAssigneePicker.vue';
import ReviewMenuAssignment from './ReviewMenuAssignment.vue';
import ReviewWecomPanel from './ReviewWecomPanel.vue';

const { query: catalogQuery, catalog } = useIntegrationCatalog();
const plan = computed(() => catalogQuery.data.value?.plan);
const client = useQueryClient();
const reviewKey = ['apex-bff-review'];
async function request(init?: RequestInit): Promise<ApexBffReviewState> {
  const response = await fetch('/api/apex-bff-review', init);
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || '读取审核记录失败');
  return data;
}
const query = useQuery({ queryKey: reviewKey, queryFn: ({ signal }) => request({ signal }), retry: false,
  refetchInterval: current => current.state.status === 'error' ? 5000 : false });
const reviewMutation = useMutation({
  mutationFn: (input: { action: 'confirm' | 'reopen'; id: string } | { action: 'status'; id: string; status: ApexBffReviewStatus } | { action: 'assign'; ids: string[]; assignee: ApexBffAssignee | null }) =>
    request({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }),
  onSuccess: async data => { await client.cancelQueries({ queryKey: reviewKey }); client.setQueryData(reviewKey, data); },
});

const { selectedModule, selectedPage, statusFilter, search, page, pageSize } = useWorkspacePanelState('integration', () => ({
  selectedModule: '系统配置', selectedPage: '', statusFilter: '待人工审核', search: '', page: 1, pageSize: 20,
}));
// 新筛选不读取旧版面板快照，避免缺失字段时失去响应式引用。
const { assigneeFilter } = useWorkspacePanelState('integration-assignee', () => ({ assigneeFilter: '' }));
const { categoryFilter } = useWorkspacePanelState('integration-scope', () => ({ categoryFilter: '' as IntegrationScopeCategory | '' }));
const deferredCount = computed(() => catalog.value.filter(integrationDeferral).length);
const assignmentOpen = shallowRef(false);
const wecomOpen = shallowRef(false);
const feedbackItem = shallowRef<ReviewCatalogItem>();
const savingId = shallowRef('');
const reviewAvailable = computed(() => query.data.value !== undefined && catalogQuery.data.value !== undefined);
const records = computed(() => query.data.value ?? {});
const assignees = computed(() => [...new Map(Object.values(records.value).flatMap(record => record.assignee ? [[record.assignee.name, record.assignee] as const] : [])).values()]);
const counts = computed(() => {
  const result = { confirmed: 0, pending: 0, inactive: 0 };
  for (const item of catalog.value) {
    const status = reviewLabel(records.value[item.id]);
    if (status === '已联调') result.confirmed += 1;
    else if (status === '待人工审核') result.pending += 1;
    else result.inactive += 1;
  }
  return result;
});
const matchingItems = computed(() => filterReviewCatalog(catalog.value, records.value, {
  status: reviewAvailable.value ? statusFilter.value : '', assignee: reviewAvailable.value ? assigneeFilter.value : '', search: search.value,
  category: categoryFilter.value,
}));
const filtered = computed(() => matchingItems.value.filter(item =>
  (!selectedModule.value || item.ui.module === selectedModule.value) && (!selectedPage.value || item.ui.page === selectedPage.value)));
watch(matchingItems, items => {
  if (selectedModule.value && !items.some(item => item.ui.module === selectedModule.value)) {
    selectedModule.value = '';
    selectedPage.value = '';
  } else if (selectedPage.value && !items.some(item => item.ui.module === selectedModule.value && item.ui.page === selectedPage.value)) {
    selectedPage.value = '';
  }
}, { immediate: true });
const rows = computed(() => filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value));
watch([selectedModule, selectedPage, statusFilter, assigneeFilter, categoryFilter, search, pageSize], () => { page.value = 1; });
watch(() => filtered.value.length, length => { page.value = Math.min(page.value, Math.max(1, Math.ceil(length / pageSize.value))); });
async function assignInterfaces(ids: string[], assignee: ApexBffAssignee | undefined, batch = false) {
  if (!reviewAvailable.value || savingId.value || !ids.length) return;
  savingId.value = batch ? 'menu-assignment' : ids[0];
  try {
    await reviewMutation.mutateAsync({ action: 'assign', ids, assignee: assignee ?? null });
    if (batch) assignmentOpen.value = false;
    ElMessage.success(assignee ? '负责人已保存' : '已取消分配');
  } catch (error) { ElMessage.error((error as Error).message); }
  finally { savingId.value = ''; }
}
function statusTone(item: ReviewCatalogItem) {
  const status = reviewLabel(records.value[item.id]);
  return status === '已联调' ? 'confirmed' : status === '待人工审核' ? 'pending' : '';
}
async function saveStatus(item: ReviewCatalogItem, status: ApexBffReviewStatus) {
  if (!reviewAvailable.value || savingId.value || status === reviewLabel(records.value[item.id])) return;
  savingId.value = item.id;
  try {
    await reviewMutation.mutateAsync({ action: 'status', id: item.id, status });
    ElMessage.success('接口状态已保存');
  } catch (error) { ElMessage.error((error as Error).message); }
  finally { savingId.value = ''; }
}
function refresh() { void query.refetch(); }
async function toggleReview(item: ReviewCatalogItem) {
  if (!reviewAvailable.value || savingId.value) return;
  const action = records.value[item.id]?.confirmedAt ? 'reopen' : 'confirm';
  savingId.value = item.id;
  try {
    await reviewMutation.mutateAsync({ action, id: item.id });
    ElMessage.success(action === 'confirm' ? '已标记为接口已联调' : '已撤回联调确认，原证据仍保留');
  } catch (error) { ElMessage.error((error as Error).message); }
  finally { savingId.value = ''; }
}
</script>

<template>
  <PageHeading title="APEX 接口联调" description="按模块和页面核对接口；只有人工确认后才计入已联调。" :loading="query.isFetching.value" @refresh="refresh">
    <RouterLink to="/agent?view=integration-execution" class="review-resource-link">联调执行进度</RouterLink>
    <el-button @click="feedbackItem = undefined; wecomOpen = true">企业微信机器人</el-button>
    <a v-if="plan?.contractUrl" :href="plan.contractUrl" target="_blank" rel="noreferrer" class="review-resource-link">接口文档</a>
  </PageHeading>
  <div class="review-overview surface">
    <div class="overview-main"><small>接口总数</small><strong>{{ catalog.length }}</strong><span>暂不联调 {{ deferredCount }} · 已替代 / 不再使用 {{ reviewAvailable ? counts.inactive : '—' }}</span></div>
    <div class="overview-stat confirmed"><small>已联调</small><strong>{{ reviewAvailable ? counts.confirmed : '—' }}</strong><span>仅统计人工确认</span></div>
    <div class="overview-stat pending"><small>待人工审核</small><strong>{{ reviewAvailable ? counts.pending : '—' }}</strong><span>不含已替代、不再使用</span></div>
  </div>
  <p v-if="query.error.value || catalogQuery.error.value" class="load-error">审核记录读取失败：{{ (query.error.value || catalogQuery.error.value)?.message }}</p>
  <div class="review-layout">
    <ReviewNavigation v-model:module="selectedModule" v-model:page="selectedPage" :items="matchingItems" :records="records" :available="reviewAvailable" />
    <section class="surface review-main">
      <div class="review-toolbar">
        <div><h2>{{ selectedModule || '全部模块' }}<span v-if="selectedPage"> / {{ selectedPage }}</span></h2><p>{{ filtered.length }} 条接口 · 已联调 {{ reviewAvailable ? filtered.filter(item => !!records[item.id]?.confirmedAt).length : '—' }} 条</p></div>
        <div class="review-filters">
          <el-select v-model="categoryFilter" clearable placeholder="全部联调分类" aria-label="联调分类" class="status-filter"><el-option label="本轮联调" value="本轮联调" /><el-option label="暂不联调" value="暂不联调" /></el-select>
          <el-select v-model="statusFilter" clearable :disabled="!reviewAvailable" placeholder="全部审核状态" aria-label="审核状态" class="status-filter"><el-option v-for="label in reviewStatuses" :key="label" :label="label" :value="label" /></el-select>
          <el-select v-model="assigneeFilter" filterable clearable :disabled="!reviewAvailable" placeholder="全部人员" aria-label="负责人筛选" class="assignee-filter"><el-option label="未分配" value=":unassigned" /><el-option v-for="person in assignees" :key="person.name" :label="`${person.displayName}（${person.name}）`" :value="person.name" /></el-select>
          <el-input v-model="search" clearable placeholder="搜索接口、路径、页面" aria-label="搜索接口" class="search-filter" />
          <el-button :disabled="!reviewAvailable || !!savingId" @click="assignmentOpen = true">按菜单分配</el-button>
        </div>
      </div>
      <el-table :data="rows" row-key="id" v-loading="query.isPending.value" empty-text="当前筛选下没有接口">
        <el-table-column label="接口 / 路径" min-width="300"><template #default="{ row }"><strong class="interface-title">{{ row.name }}</strong><code class="subline interface-path">{{ row.method || '方法待确认' }} {{ row.path }}</code></template></el-table-column>
        <el-table-column label="模块 / 页面" min-width="210"><template #default="{ row }"><strong>{{ row.ui.module }} / {{ row.ui.page }}</strong><code v-if="row.ui.route" class="subline interface-path">{{ row.ui.route }}</code><small v-else class="subline">{{ row.ui.kind === 'multiple' ? '关联多个页面' : row.ui.kind === 'shared' ? '跨页面公共接口' : '页面待定位' }}</small></template></el-table-column>
        <el-table-column label="开发信息" min-width="190"><template #default="{ row }"><span v-if="row.plan">契约：{{ row.plan.contractStatus }}</span><span v-else>契约未收录</span><small v-if="row.workbook" class="subline">计划备注：{{ row.workbook.planNote || row.workbook.completion || '未填写' }}</small></template></el-table-column>
        <el-table-column label="联调分类" min-width="150"><template #default="{ row }"><span>{{ integrationScopeCategory(row) }}</span><small v-if="integrationDeferral(row)" class="subline">{{ integrationDeferral(row) }}</small></template></el-table-column>
        <el-table-column label="负责人" width="210"><template #default="{ row }"><ReviewAssigneePicker :model-value="records[row.id]?.assignee" :disabled="!reviewAvailable || !!savingId" :loading="savingId === row.id" :label="`${row.name}负责人`" @update:model-value="assignInterfaces([row.id], $event)" /><small class="subline">{{ records[row.id]?.assignee?.name || '未分配' }}</small></template></el-table-column>
        <el-table-column label="人工审核" width="210" fixed="right"><template #default="{ row }"><span :class="['review-status', reviewAvailable ? statusTone(row) : '']">{{ reviewAvailable ? reviewLabel(records[row.id]) : '状态未加载' }}</span><div class="review-actions"><el-button v-if="reviewAvailable" link :type="records[row.id]?.confirmedAt ? 'info' : 'success'" :loading="savingId === row.id" :disabled="!!savingId && savingId !== row.id" @click="toggleReview(row)">{{ records[row.id]?.confirmedAt ? '撤回联调确认' : '确认联调通过' }}</el-button><el-dropdown trigger="click" :disabled="!reviewAvailable || !!savingId" @command="saveStatus(row, $event)"><el-button link type="primary" :disabled="!reviewAvailable || !!savingId">修改状态</el-button><template #dropdown><el-dropdown-menu><el-dropdown-item v-for="status in reviewStatuses" :key="status" :command="status" :disabled="!!savingId || status === reviewLabel(records[row.id])">{{ status }}</el-dropdown-item></el-dropdown-menu></template></el-dropdown></div><el-button link type="primary" @click="feedbackItem = row; wecomOpen = true">后端反馈</el-button></template></el-table-column>
      </el-table>
      <el-pagination v-if="filtered.length > pageSize" v-model:current-page="page" v-model:page-size="pageSize" :total="filtered.length" :page-sizes="[20, 50, 100]" layout="total, sizes, prev, pager, next" class="review-pagination" />
    </section>
  </div>
  <ReviewMenuAssignment v-model="assignmentOpen" :items="catalog" :records="records" :saving="!!savingId" :initial-menu="selectedPage ? `${selectedModule}/${selectedPage}` : ''" @assign="(ids, person) => assignInterfaces(ids, person, true)" />
  <ReviewWecomPanel v-model="wecomOpen" :item="feedbackItem" />
</template>

<style scoped>
.review-resource-link{display:inline-flex;align-items:center;justify-content:center;min-height:36px;padding:0 15px;border:1px solid var(--ui-border);border-radius:8px;color:var(--ui-text);font-size:12px;line-height:1;text-decoration:none;white-space:nowrap}
.review-resource-link:hover{color:var(--ui-accent);border-color:var(--ui-accent)}
.review-overview{display:grid;grid-template-columns:minmax(220px,1.5fr) repeat(2,minmax(130px,1fr));gap:0;margin-bottom:12px;overflow:hidden}
.overview-main,.overview-stat{display:grid;align-content:center;gap:5px;min-height:110px;padding:18px 22px;border-right:1px solid var(--ui-border)}
.overview-stat:last-child{border-right:0}.review-overview small{font-size:12px;color:var(--ui-muted)}
.review-overview strong{font:28px var(--mono);color:var(--ui-text)}.review-overview span{font-size:11px;color:var(--ui-muted)}
.overview-stat.confirmed strong{color:var(--ui-success)}.overview-stat.pending strong{color:var(--ui-accent)}
.load-error{color:var(--ui-danger)}
.review-layout{display:grid;grid-template-columns:260px minmax(0,1fr);align-items:start;gap:16px}.review-main{min-width:0;overflow:hidden}
.review-toolbar{display:flex;align-items:flex-end;justify-content:space-between;flex-wrap:wrap;gap:16px;padding:18px 20px;border-bottom:1px solid var(--ui-border)}
.review-toolbar h2{margin:0;font-size:16px}.review-toolbar h2 span{color:var(--ui-muted);font-weight:500}.review-toolbar p{margin:6px 0 0;font-size:12px;color:var(--ui-muted)}
.review-filters{display:flex;flex-wrap:wrap;gap:8px}.status-filter{width:150px}.assignee-filter{width:190px}.search-filter{width:210px}
.interface-title{font-size:12px}.subline{display:block;margin-top:5px;font-size:11px;line-height:1.5;color:var(--ui-muted)}.interface-path{overflow-wrap:anywhere}
.review-status{display:inline-block;padding:3px 8px;border-radius:4px;background:var(--ui-raised);font-size:12px;font-weight:600}.review-status.confirmed{background:color-mix(in srgb,var(--ui-success) 14%,var(--ui-raised));color:var(--ui-success)}
.review-status.pending{background:var(--ui-accent-soft);color:var(--ui-accent)}
.review-actions{display:flex;align-items:center;gap:12px;margin-top:4px}
.review-pagination{justify-content:flex-end;padding:10px 16px}
@media(max-width:1500px){.review-layout{grid-template-columns:220px minmax(0,1fr)}.review-overview{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(max-width:1050px){.review-layout{grid-template-columns:1fr}}
@media(max-width:950px){.review-overview{grid-template-columns:repeat(2,minmax(0,1fr))}.overview-main{grid-column:1/-1}.review-filters{width:100%}.search-filter{flex:1;min-width:180px}}
</style>
