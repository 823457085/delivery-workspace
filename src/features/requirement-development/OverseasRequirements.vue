<script setup lang="ts">
import { computed, reactive, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ArrowLeft, ArrowUpRight, Plus, RefreshCw, Search } from '@lucide/vue';
import type { JiraDevRequirementContext, JiraDevTaskView } from '../../../shared/jira-dev';
import { requirementConversationTarget, type RequirementDevelopmentRecord } from '../../../shared/requirement-development';
import { requirementStageStatusLabels } from '../../../shared/requirement-development';
import type { SystemCatalog } from '../../../shared/system-catalog';
import type { GroupChatDashboard } from '../../../shared/agent-group-chat';
import type { JiraDevIssueView } from '../../../shared/jira-dev';
import { emptyOverseasRequirement, filterOverseasRequirements, mergeOverseasRequirements, overseasI18nLabels, overseasRequirementPayload,
  overseasStageLabels, overseasSystemStatusLabels, type OverseasRequirement } from '../../../shared/overseas-requirements';
import { dateTime } from '../../shared/format';
import JiraDevTask from '../jira-dev/JiraDevTask.vue';
import RequirementExecutionRecords from './RequirementExecutionRecords.vue';
import RequirementProgressEditor from './RequirementProgressEditor.vue';
import OverseasRequirementEditor from './OverseasRequirementEditor.vue';
import JiraRequirementImport from './JiraRequirementImport.vue';
import { jiraDevRequest } from '../jira-dev/useJiraDevTask';
import { deskRows, deskToday, matchesDeskFocus, type DeskFocus, type RequirementDeskRow } from './requirement-desk';
import { useWorkspacePanelState } from '../../shared/useWorkspacePanelState';

const emit = defineEmits<{ openRun: [id: string] }>();
const route = useRoute(), router = useRouter(), client = useQueryClient();
const { tab, focus, page } = useWorkspacePanelState('overseas-requirements', () => ({
  tab: 'today' as 'today' | 'all' | 'develop' | 'records', focus: 'attention' as DeskFocus, page: 1,
}));
const filter = reactive({ search: '', system: '', stage: '', owner: '', version: '' });
const editing = ref<OverseasRequirement>();
const executionContext = shallowRef<JiraDevRequirementContext>();
const opening = shallowRef(false);
const importing = shallowRef(false);
const deletingId = ref('');
type RequirementSnapshot = { items: OverseasRequirement[]; systems?: string[]; removedIds?: string[] };
async function get<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || '需求读取失败');
  return data;
}
const requirements = useQuery({ queryKey: ['overseas-requirements'], retry: false,
  queryFn: ({ signal }) => get<RequirementSnapshot>('/api/overseas-requirements', signal), refetchInterval: 15000 });
const runs = useQuery({ queryKey: ['requirement-development'], retry: false,
  queryFn: async ({ signal }) => (await get<{ records: RequirementDevelopmentRecord[] }>('/api/agent-runtimes/requirement-development', signal)).records, refetchInterval: 15000 });
const catalog = useQuery({ queryKey: ['system-catalog'], queryFn: () => get<SystemCatalog>('/api/systems'), staleTime: 60000, retry: false });
const groups = useQuery({ queryKey: ['requirement-group-links'], queryFn: () => get<GroupChatDashboard>('/api/agent-runtimes/group-chat'), refetchInterval: 15000, retry: false });
watch(() => requirements.error.value || runs.error.value, error => { if (error) ElMessage.error(error.message); });
const records = computed(() => runs.data.value || []);
const items = computed(() => mergeOverseasRequirements(requirements.data.value?.items || [], records.value, requirements.data.value?.removedIds));
const selected = computed(() => items.value.find(item => item.id === route.query.requirement));
const jiraById = shallowRef<Record<string, JiraDevIssueView & { assignee?: string }>>({});
const filtered = computed(() => filterOverseasRequirements(items.value, { ...filter, search: '', stage: filter.stage === 'blocked' ? '' : filter.stage, system: '', owner: '', version: '' })
  .filter(item => {
    const row = desk.value.find(row => row.item.id === item.id);
    return (!filter.system || row?.systems.includes(filter.system)) && (filter.stage !== 'blocked' || row?.tone === 'blocked')
      && (!filter.owner || owner(item) === filter.owner) && (!filter.version || version(item) === filter.version)
      && (!filter.search.trim() || [item.title, item.issueKey, item.description, row?.blocker].join(' ').toLocaleLowerCase().includes(filter.search.trim().toLocaleLowerCase()));
  }));
const systems = computed(() => [...new Set([...(catalog.data.value?.systems.map(system => system.name) || []),
  ...(requirements.data.value?.systems || []), ...items.value.flatMap(item => item.systems.map(system => system.name))])]);
const today = computed(() => { void runs.dataUpdatedAt.value; return deskToday(); });
const desk = computed(() => deskRows(items.value, records.value, catalog.data.value?.systems || [], today.value, groups.data.value?.rooms || []));
const followUpCount = computed(() => desk.value.filter(row => row.attention).length);
const blockedCount = computed(() => desk.value.filter(row => row.tone === 'blocked').length);
const scopedDesk = computed(() => desk.value.filter(row => (!filter.system || row.systems.includes(filter.system))
  && (!filter.search.trim() || [row.item.title, row.item.issueKey, row.blocker].join(' ').toLocaleLowerCase().includes(filter.search.trim().toLocaleLowerCase()))));
const queue = computed(() => scopedDesk.value.filter(row => matchesDeskFocus(row, focus.value)));
const visibleQueue = computed(() => queue.value.slice((page.value - 1) * 12, page.value * 12));
const visibleTable = computed(() => filtered.value.slice((page.value - 1) * 20, page.value * 20));
const selectedDesk = computed(() => desk.value.find(row => row.item.id === route.query.requirement));
const rollups = computed(() => systems.value.map(name => ({ name, rows: desk.value.filter(row => row.systems.includes(name)) }))
  .sort((a, b) => b.rows.filter(row => row.attention).length - a.rows.filter(row => row.attention).length || b.rows.length - a.rows.length));
type JiraInfo = JiraDevIssueView & { assignee?: string };
const jiraTargets = computed(() => {
  const visible = tab.value === 'today' ? visibleQueue.value.map(row => row.item) : tab.value === 'all' ? visibleTable.value : [];
  return [...new Map([...visible, ...(selected.value ? [selected.value] : [])].filter(item => item.issueUrl || item.issueKey)
    .map(item => [item.id, { id: item.id, source: item.issueUrl || item.issueKey }])).values()];
});
const jira = useQuery({ queryKey: computed(() => ['requirement-desk-jira', jiraTargets.value]), enabled: computed(() => !!jiraTargets.value.length),
  staleTime: 300000, retry: false, refetchOnWindowFocus: false,
  queryFn: async ({ signal }) => {
    const targets = jiraTargets.value;
    const values = await Promise.allSettled(targets.map(async target => [target.id,
      (await jiraDevRequest<{ issue: JiraInfo }>('issue', { source: target.source }, signal)).issue] as const));
    return Object.fromEntries(values.flatMap(value => value.status === 'fulfilled' ? [value.value] : [])) as Record<string, JiraInfo>;
  },
});
watch(jira.data, value => { if (value) jiraById.value = { ...jiraById.value, ...value }; }, { immediate: true });
function jiraInfo(item: OverseasRequirement) { return jiraById.value[item.id]; }
function owner(item: OverseasRequirement) { return item.owner || jiraInfo(item)?.assignee || ''; }
function version(item: OverseasRequirement) { return item.version || jiraInfo(item)?.fixVersions?.map(value => value.name).join('、') || ''; }
function selectedSystems(item: OverseasRequirement) {
  return desk.value.find(row => row.item.id === item.id)?.systems.map(name => item.systems.find(system => system.name === name)
    || { name, status: 'pending' as const, evidence: '', previewUrl: '' }) || item.systems;
}
const queueLabels: Record<DeskFocus, string> = { attention: '需要你处理', running: '正在执行', due: '临近交付', acceptance: '等待验收', all: '全部在管需求' };
const busy = computed(() => requirements.isPending.value || runs.isPending.value);
watch([tab, focus, () => filter.search, () => filter.system, () => filter.stage, () => filter.owner, () => filter.version], () => { page.value = 1; });
watch([() => queue.value.length, () => filtered.value.length], () => {
  const total = tab.value === 'today' ? queue.value.length : filtered.value.length;
  page.value = Math.min(page.value, Math.max(1, Math.ceil(total / (tab.value === 'today' ? 12 : 20))));
});
const owners = computed(() => [...new Set(items.value.map(owner).filter(Boolean))]);
const versions = computed(() => [...new Set(items.value.map(version).filter(Boolean))]);
const detailOpen = computed({ get: () => !!selected.value && ['today', 'all'].includes(tab.value), set: value => { if (!value) closeDetail(); } });
const linkedRecords = computed(() => records.value.filter(record => selected.value?.executionIds.includes(record.id)));
const stats = computed(() => [
  { label: '需要你处理', value: scopedDesk.value.filter(row => row.attention).length, focus: 'attention' as const, note: `${scopedDesk.value.filter(row => row.tone === 'blocked').length} 项存在明确阻塞` },
  { label: '正在执行', value: scopedDesk.value.filter(row => row.running).length, focus: 'running' as const, note: '查看团队当前的执行进展' },
  { label: '临近交付', value: scopedDesk.value.filter(row => row.overdue || row.dueSoon).length, focus: 'due' as const, note: `${scopedDesk.value.filter(row => row.overdue).length} 项已逾期 · 含未来 7 天` },
  { label: '等待验收', value: scopedDesk.value.filter(row => row.awaitingAcceptance).length, focus: 'acceptance' as const, note: '核对交付证据后再确认' },
]);
function closeDetail() { const { requirement: _id, ...query } = route.query; void router.replace({ query }); }
function showDetail(item: OverseasRequirement) { void router.replace({ query: { ...route.query, requirement: item.id } }); }
function edit(item?: OverseasRequirement) {
  const value = item ? { ...item, owner: owner(item), version: version(item), systems: selectedSystems(item),
    issueUrl: item.issueUrl || jiraInfo(item)?.url || '', jiraStatus: jiraInfo(item)?.status || item.jiraStatus } : emptyOverseasRequirement(crypto.randomUUID());
  editing.value = JSON.parse(JSON.stringify(value));
}
function hasGroup(id: string) { return groups.data.value?.rooms.some(group => group.id === id); }
function deskHasConversation(row: RequirementDeskRow) {
  return row.target ? !!requirementConversationTarget(row.target) : !!row.targetGroupId && hasGroup(row.targetGroupId);
}
async function openLinkedConversation(record?: RequirementDevelopmentRecord, groupId?: string) {
  try {
    let target = '';
    if (record) {
      const { data } = await runs.refetch({ throwOnError: true });
      const current = data?.find(item => item.id === record.id);
      if (current) target = requirementConversationTarget(current);
    } else if (groupId) {
      const { data } = await groups.refetch({ throwOnError: true });
      if (data?.rooms.some(group => group.id === groupId)) target = `group:${groupId}`;
    }
    if (target) emit('openRun', target);
    else ElMessage.warning('关联会话已不存在');
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '无法核对关联会话'); }
}
function follow(row: RequirementDeskRow) {
  if (row.action === 'team' && deskHasConversation(row)) void openLinkedConversation(row.target, row.targetGroupId);
  else if (row.action === 'edit') edit(row.item);
  else if (row.action === 'develop') void openDevelopment(row.item);
  else showDetail(row.item);
}
function chooseFocus(value: DeskFocus) { tab.value = 'today'; focus.value = value; }
function cacheItem(item: OverseasRequirement) {
  client.setQueryData<RequirementSnapshot>(['overseas-requirements'], data => ({
    ...data,
    items: [...(data?.items || []).filter(value => value.id !== item.id), item],
    systems: [...new Set([...(data?.systems || []), ...item.systems.map(system => system.name)])],
  }));
}
async function remember(item: OverseasRequirement) {
  await client.cancelQueries({ queryKey: ['overseas-requirements'], exact: true }, { revert: false });
  cacheItem(item); editing.value = undefined;
}
async function imported(items: OverseasRequirement[]) {
  await client.cancelQueries({ queryKey: ['overseas-requirements'], exact: true }, { revert: false });
  items.forEach(cacheItem);
}
async function removeRequirement(item: OverseasRequirement) {
  if (deletingId.value || requirements.error.value) return;
  deletingId.value = item.id;
  try {
    await ElMessageBox.confirm(`确定从本地需求台账移除「${item.title}」？`, '删除需求', {
      type: 'warning', confirmButtonText: '删除需求', cancelButtonText: '取消',
    });
    const response = await fetch('/api/overseas-requirements/delete', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' },
      body: JSON.stringify({ id: item.id, expectedRevision: item.revision }) });
    const result: { deleted?: boolean; removedIds?: string[]; message?: string } = await response.json();
    if (!response.ok || result.deleted !== true || !Array.isArray(result.removedIds)) {
      if (response.status === 409) void requirements.refetch();
      throw new Error(result.message || '需求删除失败');
    }
    const removedIds = result.removedIds;
    await client.cancelQueries({ queryKey: ['overseas-requirements'], exact: true }, { revert: false });
    client.setQueryData<RequirementSnapshot>(['overseas-requirements'], data => ({
      ...data,
      items: (data?.items || []).filter(value => value.id !== item.id),
      removedIds: [...new Set([...(data?.removedIds || []), ...removedIds])],
    }));
    if (route.query.requirement === item.id) closeDetail();
    ElMessage.success('需求已删除');
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error instanceof Error ? error.message : '需求删除失败');
  } finally { deletingId.value = ''; }
}
async function addSystem() {
  try {
    const { value } = await ElMessageBox.prompt('输入需要管理的业务系统名称', '添加系统', { confirmButtonText: '添加', cancelButtonText: '取消',
      inputValidator: value => !!value?.trim() && value.trim().length <= 60 || '请填写 1–60 个字的系统名称' });
    const response = await fetch('/api/overseas-requirements/systems', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: JSON.stringify({ name: value }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || '系统添加失败');
    client.setQueryData<RequirementSnapshot>(['overseas-requirements'], data => ({ ...data, items: data?.items || [], systems: result.systems }));
    ElMessage.success('系统已添加');
  } catch (error) { if (error !== 'cancel' && error !== 'close') ElMessage.error(error instanceof Error ? error.message : '系统添加失败'); }
}
async function save(item: OverseasRequirement) {
  const response = await fetch('/api/overseas-requirements', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: JSON.stringify(overseasRequirementPayload(item)) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.message || '需求保存失败');
  await client.cancelQueries({ queryKey: ['overseas-requirements'], exact: true }, { revert: false });
  cacheItem(value); return value as OverseasRequirement;
}
async function openDevelopment(item?: OverseasRequirement) {
  if (opening.value || requirements.error.value) return;
  opening.value = true;
  try {
    const value = item && !item.revision ? await save(item) : item;
    executionContext.value = value ? { id: value.id, source: value.issueUrl || value.issueKey,
      details: [value.description, value.prdUrl ? `PRD：${value.prdUrl}` : '', value.prototypeUrl ? `原型：${value.prototypeUrl}` : ''].filter(Boolean).join('\n\n'),
      useI18n: value.i18n.status !== 'not_applicable', taskId: value.executionIds.at(-1) } : undefined;
    closeDetail(); tab.value = 'develop';
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '需求准备失败'); }
  finally { opening.value = false; }
}
// 预览和会话关联到业务需求；执行状态不会覆盖本机台账中的阶段或人工验收结论。
let linking: Promise<unknown> = Promise.resolve();
function linkTask(task: JiraDevTaskView) {
  if (task.workflow !== 'requirement') return;
  const contextId = executionContext.value?.id;
  linking = linking.catch(() => {}).then(async () => {
    if (items.value.some(item => item.executionIds.includes(task.taskId))) return;
    const current = items.value.find(item => item.id === contextId);
    if (contextId && !current) return;
    const issue = task.plan?.sourceIssue;
    const value = current ? JSON.parse(JSON.stringify(current)) as OverseasRequirement : {
      ...emptyOverseasRequirement(crypto.randomUUID()), title: task.title, issueKey: issue?.key || '', issueUrl: issue?.url || '',
      jiraStatus: issue?.status || '', i18n: { status: task.useI18n === false ? 'not_applicable' as const : 'pending' as const, evidence: '' },
    };
    value.executionIds.push(task.taskId);
    await save(value);
  }).catch(error => ElMessage.error(error instanceof Error ? error.message : '开发记录关联失败，请在详情中核对'));
}
function nextDevelopment() { executionContext.value = undefined; }
async function refresh() { await Promise.all([requirements.refetch(), runs.refetch(), catalog.refetch(), groups.refetch(), ...(jiraTargets.value.length ? [jira.refetch()] : [])]); }
const runStatusLabels = { queued: '排队中', running: '执行中', completed: '本轮已结束', failed: '执行失败', interrupted: '已中断', cancelled: '已取消' };
function executionStatus(record: RequirementDevelopmentRecord) {
  if (record.conversationMissing) return record.groupRoomId ? '团队群聊已不存在' : '开发会话已不存在';
  return record.runStatus ? runStatusLabels[record.runStatus] : { preparing: '准备工作区', starting: '启动会话', started: '已创建会话', failed: '启动失败', uncertain: '启动结果待核对' }[record.status];
}
</script>

<template>
  <section class="overseas-workspace">
    <header class="desk-header">
      <div class="desk-header-overview">
        <div class="desk-header-title">
          <h2>需求推进工作台</h2>
          <span>海外业务 · <time :datetime="today">{{ today }}</time></span>
        </div>
        <p class="desk-header-status">
          <span><strong>{{ followUpCount }}</strong> 项需要跟进</span>
          <span :class="{ 'has-blockers': blockedCount > 0 }"><strong>{{ blockedCount }}</strong> 项受阻</span>
        </p>
      </div>
      <div class="desk-toolbar">
        <nav class="workspace-tabs" aria-label="海外需求视图">
          <button type="button" :class="{ active: tab === 'today' }" :aria-current="tab === 'today' ? 'page' : undefined" @click="tab = 'today'">今日推进</button>
          <button type="button" :class="{ active: tab === 'all' }" :aria-current="tab === 'all' ? 'page' : undefined" @click="tab = 'all'">全部需求<span>{{ items.length }}</span></button>
          <button type="button" :class="{ active: tab === 'records' }" :aria-current="tab === 'records' ? 'page' : undefined" @click="tab = 'records'; closeDetail()">开发记录</button>
        </nav>
        <div class="desk-toolbar-actions">
          <el-button :disabled="!!requirements.error.value || requirements.isPending.value" @click="importing = true">从 Jira 导入</el-button>
          <el-button :loading="requirements.isFetching.value || runs.isFetching.value" @click="refresh"><RefreshCw :size="14" />刷新</el-button>
          <el-button type="primary" :disabled="!!requirements.error.value || requirements.isPending.value" @click="edit()"><Plus :size="15" />新建需求</el-button>
        </div>
      </div>
    </header>
    <div v-if="tab === 'today' || tab === 'all'" class="desk-metrics"><button v-for="stat in stats" :key="stat.label" :class="{ selected: tab === 'today' && focus === stat.focus }" :aria-label="`${stat.label} ${stat.value}`" @click="chooseFocus(stat.focus)"><span>{{ stat.label }}</span><strong>{{ stat.value }}</strong><small>{{ stat.note }}</small></button></div>
    <div v-if="tab === 'today'" class="desk-layout">
      <main class="desk-work">
        <header class="desk-section-heading"><div><h2>{{ queueLabels[focus] }} <small>{{ queue.length }} 项</small></h2><p>按当前记录安排下一步，执行结束后继续核对验证与验收。</p></div><el-button link type="primary" @click="focus = focus === 'all' ? 'attention' : 'all'">{{ focus === 'all' ? '返回待办' : '查看全部' }}</el-button></header>
        <div class="desk-filters"><el-input v-model="filter.search" clearable placeholder="搜索需求、Jira 或阻塞" aria-label="搜索推进事项"><template #prefix><Search :size="15" /></template></el-input><el-select v-model="filter.system" clearable filterable placeholder="全部系统" aria-label="推进系统筛选"><el-option v-for="system in systems" :key="system" :label="system" :value="system" /></el-select></div>
        <div v-loading="busy" class="desk-queue">
          <article v-for="row in visibleQueue" :key="row.item.id" :data-requirement-id="row.item.id" class="desk-card" :data-tone="row.tone">
            <div class="desk-card-status"><span class="desk-status" :data-tone="row.tone">{{ row.label }}</span><span v-if="row.overdue" class="desk-deadline">逾期 {{ -row.days! }} 天 · 计划 {{ row.item.endDate }}</span><span v-else-if="row.item.endDate" class="desk-deadline">{{ row.days === 0 ? '今天到期' : `计划 ${row.item.endDate}` }}</span></div>
            <h3><button @click="showDetail(row.item)">{{ row.item.title }}</button></h3>
            <div class="desk-card-meta"><span>{{ row.item.issueKey || '本地需求' }}</span><span v-if="jiraInfo(row.item)?.status || row.item.jiraStatus">{{ jiraInfo(row.item)?.status || row.item.jiraStatus }}</span><span v-if="owner(row.item)">{{ owner(row.item) }}</span><span v-if="version(row.item)">{{ version(row.item) }}</span></div>
            <div class="desk-card-systems"><span v-for="system in row.systems" :key="system">{{ system }}</span><button v-if="!row.systems.length" @click="edit(row.item)">关联系统</button><small>{{ row.executionLabel }}</small></div>
            <ol v-if="row.stages.length" class="desk-stage-track" aria-label="本轮阶段记录"><li v-for="stage in row.stages" :key="stage.key" :data-status="stage.status" :title="`${stage.label}：${requirementStageStatusLabels[stage.status]}`"><i aria-hidden="true"></i><span>{{ stage.label }}</span></li></ol>
            <p v-if="row.staleReport" class="desk-source-note">已有报告属于之前的运行，本轮结果仍待核对。</p>
            <p v-if="row.blocker" class="desk-blocker-preview">{{ row.blocker }}</p>
            <div class="desk-next"><span>下一步</span><p>{{ row.nextStep }}</p></div>
            <details v-if="row.blocker" class="desk-evidence"><summary>查看阻塞原始证据</summary><p>{{ row.blocker }}</p></details>
            <footer><span>{{ row.stages.length ? '依据本轮阶段记录' : row.item.revision ? '依据需求登记' : '依据开发启动记录' }}<template v-if="row.evidenceAt"> · {{ dateTime(row.evidenceAt) }}</template></span><div><el-button link type="danger" :loading="deletingId === row.item.id" :disabled="!!deletingId || !!requirements.error.value" @click="removeRequirement(row.item)">删除</el-button><el-button link @click="showDetail(row.item)">需求详情</el-button><el-button type="primary" :loading="opening && row.action === 'develop'" @click="follow(row)">{{ row.action === 'team' && !deskHasConversation(row) ? '查看记录' : row.actionLabel }}<ArrowUpRight :size="13" /></el-button></div></footer>
          </article>
          <el-empty v-if="!visibleQueue.length && !busy" :description="requirements.error.value || runs.error.value ? '需求暂时无法读取，请刷新重试' : focus === 'attention' ? '当前筛选下没有待处理事项' : '当前筛选下没有相关需求'" :image-size="60"><el-button v-if="focus !== 'all'" @click="focus = 'all'">查看全部在管需求</el-button><el-button v-else @click="importing = true">从 Jira 导入</el-button></el-empty>
        </div>
        <div v-if="queue.length > 12" class="desk-pagination"><span>{{ queue.length }} 项推进事项</span><el-pagination v-model:current-page="page" :total="queue.length" :page-size="12" layout="prev, pager, next" /></div>
      </main>
      <aside class="desk-side">
        <section class="desk-system-panel"><header><div><h2>各系统进度</h2><p>{{ systems.length }} 个可选系统 · {{ items.length }} 项在管需求</p></div><el-button link aria-label="添加业务系统" @click="addSystem"><Plus :size="15" /></el-button></header><button class="desk-system-row" :class="{ active: !filter.system }" @click="filter.system = ''"><span><strong>全部系统</strong><small>查看跨系统待办</small></span><b>{{ items.length }}</b></button><button v-for="system in rollups" :key="system.name" class="desk-system-row" :class="{ active: filter.system === system.name }" @click="filter.system = system.name"><span><strong>{{ system.name }}</strong><small>{{ system.rows.filter(row => row.attention).length }} 项待处理 · {{ system.rows.filter(row => row.running).length }} 项执行中</small></span><b>{{ system.rows.length }}</b></button><router-link class="desk-system-link" to="/agent?view=systems">打开系统目录<ArrowUpRight :size="13" /></router-link></section>
        <section class="desk-attention-panel"><h2>交付核对</h2><div><span>验证尚未完成</span><strong>{{ desk.filter(row => !row.accepted && (row.item.stage === 'verification' || row.item.systems.some(system => system.status === 'verification') || row.stages.some(stage => stage.key === 'verification' && ['pending', 'in_progress', 'blocked'].includes(stage.status)))).length }}</strong></div><div><span>多语言产物待登记</span><strong>{{ desk.filter(row => row.item.i18n.status === 'pending' && !row.accepted).length }}</strong></div><div><span>需求状态待核对</span><strong>{{ desk.filter(row => row.item.stage === 'unconfirmed').length }}</strong></div><p>阶段记录、系统交付和人工验收分别保留，不用会话结束代替验收结论。</p><el-button link @click="tab = 'all'">查看完整需求台账<ArrowUpRight :size="13" /></el-button></section>
      </aside>
    </div>
    <template v-else-if="tab === 'all'">
      <div class="requirements-layout">
        <aside class="system-navigation" aria-label="业务系统筛选"><h2>业务系统</h2><button :class="{ active: !filter.system }" @click="filter.system = ''"><span>全部系统</span><span>{{ items.length }}</span></button><button v-for="system in systems" :key="system" :class="{ active: filter.system === system }" @click="filter.system = system"><span>{{ system }}</span><span>{{ desk.filter(row => row.systems.includes(system)).length }}</span></button><button :disabled="!!requirements.error.value" @click="addSystem"><Plus :size="13" /><span>添加系统</span></button><p>系统目录和需求登记共同提供筛选范围。</p></aside>
        <main class="requirements-main">
          <div class="requirements-toolbar"><el-input v-model="filter.search" clearable placeholder="搜索需求、Jira 或阻塞" aria-label="搜索需求"><template #prefix><Search :size="15" /></template></el-input><el-select v-model="filter.stage" clearable placeholder="全部阶段" aria-label="需求阶段筛选"><el-option label="有阻塞" value="blocked" /><el-option v-for="(label, value) in overseasStageLabels" :key="value" :label="label" :value="value" /></el-select><el-select v-model="filter.owner" clearable placeholder="全部负责人" aria-label="负责人筛选"><el-option v-for="owner in owners" :key="owner" :label="owner" :value="owner" /></el-select><el-select v-model="filter.version" clearable placeholder="全部版本" aria-label="版本筛选"><el-option v-for="version in versions" :key="version" :label="version" :value="version" /></el-select></div>
          <div class="list-heading"><h2>{{ filter.system || '全部' }}需求</h2><span>{{ filtered.length }} 项</span></div>
          <el-table v-loading="requirements.isPending.value || runs.isPending.value" :data="visibleTable" row-key="id" class="requirements-table" @row-click="showDetail">
            <el-table-column label="业务需求" min-width="270"><template #default="{ row }"><button class="requirement-title" @click.stop="showDetail(row)">{{ row.title }}</button><div class="row-meta"><span>{{ row.issueKey || '本地需求' }}</span><span v-if="jiraInfo(row)?.status || row.jiraStatus">{{ jiraInfo(row)?.status || row.jiraStatus }}</span></div><p v-if="row.blocker" class="blocker-text">阻塞 · {{ row.blocker }}</p></template></el-table-column>
            <el-table-column label="关联项目" min-width="135"><template #default="{ row }"><div class="system-tags"><span v-for="system in selectedSystems(row)" :key="system.name">{{ system.name }}</span><small v-if="!selectedSystems(row).length">待关联</small></div></template></el-table-column>
            <el-table-column label="当前进展" width="130"><template #default="{ row }"><span class="stage-label">{{ desk.find(item => item.item.id === row.id)?.label }}</span></template></el-table-column>
            <el-table-column label="负责人 / 版本" min-width="125"><template #default="{ row }"><div>{{ owner(row) || '未读取负责人' }}</div><small>{{ version(row) || '版本待核对' }}</small></template></el-table-column>
            <el-table-column label="计划完成" width="118"><template #default="{ row }">{{ row.endDate || '未排期' }}</template></el-table-column>
            <el-table-column label="多语言" width="96"><template #default="{ row }">{{ overseasI18nLabels[row.i18n.status as keyof typeof overseasI18nLabels] }}</template></el-table-column>
            <el-table-column label="操作" width="130" fixed="right"><template #default="{ row }"><el-button link type="primary" @click.stop="showDetail(row)">查看详情</el-button><el-button link type="danger" :loading="deletingId === row.id" :disabled="!!deletingId || !!requirements.error.value" @click.stop="removeRequirement(row)">删除</el-button></template></el-table-column>
            <template #empty><el-empty :description="requirements.error.value || runs.error.value ? '暂时无法读取需求，请刷新重试' : items.length ? '没有符合筛选条件的需求' : '暂无需求，可以新建需求或发起开发'" :image-size="56" /></template>
          </el-table>
          <div v-if="filtered.length > 20" class="desk-pagination"><span>共 {{ filtered.length }} 项需求</span><el-pagination v-model:current-page="page" :total="filtered.length" :page-size="20" layout="prev, pager, next" /></div>
          <p class="ledger-footnote">需求阶段与交付结果按证据维护；开发会话结束后仍需核对验证与人工验收。</p>
        </main>
      </div>
    </template>
    <section v-else-if="tab === 'develop'" class="development-view"><header><el-button link @click="tab = 'today'"><ArrowLeft :size="15" />返回今日推进</el-button><span v-if="executionContext">{{ items.find(item => item.id === executionContext?.id)?.title }}</span></header><JiraDevTask :key="executionContext?.id || 'global'" workflow="requirement" :requirement-context="executionContext" @open-run="emit('openRun', $event)" @task="linkTask" @next="nextDevelopment" /></section>
    <RequirementExecutionRecords v-else @open-run="emit('openRun', $event)" />
    <el-drawer v-model="detailOpen" title="需求详情" size="min(700px, 100vw)">
      <article v-if="selected" class="requirement-detail">
        <div class="detail-heading"><span>{{ selected.issueKey || '本地需求' }}</span><span>{{ overseasStageLabels[selected.stage] }}</span></div><h2>{{ selected.title }}</h2>
        <div v-if="selectedDesk" class="detail-next"><strong>{{ selectedDesk.label }}</strong><p>下一步：{{ selectedDesk.nextStep }}</p><el-button v-if="selectedDesk.action === 'team' && deskHasConversation(selectedDesk)" link type="primary" @click="follow(selectedDesk)">{{ selectedDesk.actionLabel }}<ArrowUpRight :size="13" /></el-button></div>
        <dl class="detail-facts"><div><dt>负责人</dt><dd>{{ owner(selected) || '未读取负责人' }}</dd></div><div><dt>版本</dt><dd>{{ version(selected) || '版本待核对' }}</dd></div><div><dt>计划日期</dt><dd>{{ selected.startDate || '未排期' }} — {{ selected.endDate || '未排期' }}</dd></div><div v-if="jiraInfo(selected)?.status || selected.jiraStatus"><dt>Jira 状态</dt><dd>{{ jiraInfo(selected)?.status || selected.jiraStatus }}</dd></div></dl>
        <div class="material-links"><a v-if="selected.issueUrl || jiraInfo(selected)?.url" :href="selected.issueUrl || jiraInfo(selected)?.url" target="_blank" rel="noreferrer">Jira <ArrowUpRight :size="13" /></a><a v-if="selected.prdUrl" :href="selected.prdUrl" target="_blank" rel="noreferrer">PRD <ArrowUpRight :size="13" /></a><a v-if="selected.prototypeUrl" :href="selected.prototypeUrl" target="_blank" rel="noreferrer">原型 <ArrowUpRight :size="13" /></a></div>
        <section v-if="selected.blocker"><h3>当前阻塞</h3><p class="evidence-text">{{ selected.blocker }}</p></section>
        <section v-for="blocker in selectedDesk?.blockers || []" :key="`${blocker.record.id}:${blocker.stage}`"><h3>{{ blocker.label }}<small>本轮阶段证据</small></h3><p class="evidence-text">{{ blocker.evidence }}</p></section>
        <section><h3>系统交付 <small>{{ selectedSystems(selected).length }} 个关联项目</small></h3><el-empty v-if="!selectedSystems(selected).length" description="尚未登记涉及系统" :image-size="40" /><div v-for="system in selectedSystems(selected)" :key="system.name" class="delivery-item"><header><strong>{{ system.name }}</strong><span>{{ overseasSystemStatusLabels[system.status] }}</span></header><p class="evidence-text">{{ system.evidence || '暂无本系统的独立验证证据' }}</p><a v-if="system.previewUrl" :href="system.previewUrl" target="_blank" rel="noreferrer">打开业务预览 <ArrowUpRight :size="13" /></a></div></section>
        <section><h3>多语言交付 <small>{{ overseasI18nLabels[selected.i18n.status] }}</small></h3><p class="evidence-text">{{ selected.i18n.evidence || '暂无多语言产物或验证记录' }}</p></section>
        <section><h3>开发与验证记录 <small>{{ selected.executionIds.length }} 项关联</small></h3><p v-if="!selected.executionIds.length && !selected.groupRoomIds?.length" class="muted">尚未关联开发任务</p><p v-else-if="selected.executionIds.length && !linkedRecords.length" class="muted">当前没有可显示的开发记录。</p><div v-for="record in linkedRecords" :key="record.id" class="execution-item"><strong>{{ record.input.title }}</strong><p>{{ executionStatus(record) }} · {{ dateTime(record.createdAt) }}</p><div><RequirementProgressEditor v-if="record.runId && !record.conversationMissing" :record="record" /><el-button v-if="requirementConversationTarget(record)" link type="primary" @click="openLinkedConversation(record)">{{ record.groupRoomId ? '打开团队群聊' : '打开开发会话' }}</el-button></div></div></section>
        <section v-if="selected.groupRoomIds?.length"><h3>接续团队群聊 <small>{{ selected.groupRoomIds.length }} 项关联</small></h3><div v-for="id in selected.groupRoomIds" :key="id" class="execution-item"><strong>{{ groups.data.value?.rooms.find(group => group.id === id)?.title || '群聊暂不可读取' }}</strong><div><el-button v-if="hasGroup(id)" link type="primary" @click="openLinkedConversation(undefined, id)">打开原团队群聊</el-button></div></div></section>
        <section><h3>需求与验收标准</h3><p class="evidence-text">{{ selected.description || '暂无补充说明' }}</p></section>
        <section><h3>人工验收结论</h3><p class="evidence-text">{{ selected.acceptanceEvidence || '尚未登记人工验收结论' }}</p></section>
      </article>
      <template #footer><template v-if="selected"><el-button link type="danger" :loading="deletingId === selected.id" :disabled="!!deletingId || !!requirements.error.value" @click="removeRequirement(selected)">删除需求</el-button><el-button @click="edit(selected)">编辑需求</el-button><el-button v-if="selected.groupRoomIds?.some(hasGroup)" type="primary" @click="openLinkedConversation(undefined, selected.groupRoomIds.find(hasGroup))">进入原群聊跟进</el-button><el-button v-else type="primary" :loading="opening" :disabled="!!requirements.error.value" @click="openDevelopment(selected)">准备 / 继续开发</el-button></template></template>
    </el-drawer>
    <OverseasRequirementEditor v-if="editing" :item="editing" :records="records" :groups="groups.data.value?.rooms || []" :system-options="systems" @close="editing = undefined" @saved="remember" />
    <JiraRequirementImport v-if="importing" :existing="items" :systems="systems" @close="importing = false" @imported="imported" />
  </section>
</template>

<style scoped src="./requirement-desk.css"></style>
