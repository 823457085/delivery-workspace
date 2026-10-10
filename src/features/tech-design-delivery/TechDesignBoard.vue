<script setup lang="ts">
/** 容器编排原系统事实、草稿与自动执行；只有明确确认后的命令才进入独立后台执行链。 */
import { computed, shallowRef } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ArrowUpRight, FileCheck2, FileText, GitBranch, Network, Plus } from '@lucide/vue';
import type { AutomationData } from '../../../shared/hub';
import { useSource } from '../../shared/api';
import { dateTime, searchMatches } from '../../shared/format';
import PageHeading from '../../shared/ui/PageHeading.vue';
import DesignKanban from './DesignKanban.vue';
import DesignRequestForm from './DesignRequestForm.vue';
import DesignDetail from './DesignDetail.vue';
import ExecutorOverview from './ExecutorOverview.vue';
import { buildDesignCards, cardsForView, cardLane, emptyInput, emptyReview, executionLanes, lanes, type DesignInput, type DesignReview, type DesignView } from './domain';
import { useDesignRecords } from './useDesignRecords';
import { useDesignExecutor } from './useDesignExecutor';

const source = useSource<AutomationData>('automation');
const executor = useDesignExecutor();
const { records, storageError, save, remove } = useDesignRecords();
const search = shallowRef('');
const view = shallowRef<DesignView>('executions');
const lane = shallowRef('all');
const selectedKey = shallowRef('');
const drawer = shallowRef(false);
const formVisible = shallowRef(false);
const editing = shallowRef(false);
const initialInput = shallowRef(emptyInput());
const formError = shallowRef('');
const templates = [
  { title: '需求技术方案', icon: FileText, description: 'PRD / 原型 · 代码分析 · 需求覆盖', notes: '围绕原需求逐项分析 PRD、原型与现有代码，输出前端技术方案、需求覆盖矩阵、风险与测试关注点。明确资料缺失和待确认事项。' },
  { title: '接口联动方案', icon: Network, description: '接口证据 · 字段映射 · 异常处理', notes: '重点分析前后端接口联动：从真实接口定义与代码核实字段、状态、分页、权限和错误处理，列出字段映射与联调测试关注点。未确认接口明确标为待确认。' },
  { title: '重构迁移方案', icon: GitBranch, description: '影响范围 · 兼容性 · 回归与回滚', notes: '重点分析现有实现到目标方案的迁移：梳理影响范围、依赖、兼容性、迁移步骤、回归测试与回滚方案，说明与 PRD 的差异。' },
];
const cards = computed(() => buildDesignCards(source.data.value, records.value, executor.query.data.value?.runs));
const selected = computed(() => cards.value.find((card) => card.key === selectedKey.value));
const groupedCards = computed(() => ({ executions: cardsForView(cards.value, 'executions'), drafts: cardsForView(cards.value, 'drafts'), history: cardsForView(cards.value, 'history') }));
const viewCards = computed(() => groupedCards.value[view.value]);
const visibleCards = computed(() => viewCards.value.filter((card) =>
  searchMatches([card.key, card.input.title, card.input.project, card.input.fixVersion, card.input.assignee], search.value) &&
  (lane.value === 'all' || (view.value === 'executions' ? card.execution?.status : cardLane(card)) === lane.value)));
const filterLanes = computed(() => view.value === 'executions' ? executionLanes : lanes);
const loadingView = computed(() => view.value === 'executions' ? executor.query.isPending.value : view.value === 'history' ? source.isPending.value : false);
const viewError = computed(() => view.value === 'executions' ? executor.query.error.value : view.value === 'history' ? source.error.value : null);
function changeView(next: DesignView) { view.value = next; search.value = ''; lane.value = 'all'; }
function filterExecutions(status: string) { changeView('executions'); lane.value = status; }
function useTemplate(template: typeof templates[number]) {
  showForm();
  initialInput.value = { ...emptyInput(), title: template.title, notes: template.notes };
}
function refresh() { void source.refetch(); void executor.query.refetch(); }
async function startExecution(input = selected.value?.input) {
  if (!input) return;
  if (!input.jiraStartDate || !input.jiraEndDate) { ElMessage.warning('请先填写 Jira 开始日期和结束日期'); showForm(true); return; }
  if (!input.workspacePath || !input.confluenceParentUrl) { ElMessage.warning('请先补充仓库绝对路径和准确的 Confluence 目标目录'); showForm(true); return; }
  if (await executor.start(input)) changeView('executions');
}
function open(key: string) { selectedKey.value = key; drawer.value = true; }
function showForm(edit = false) {
  editing.value = edit;
  initialInput.value = edit && selected.value ? { ...selected.value.input } : emptyInput();
  formError.value = '';
  formVisible.value = true;
}
function saveInput(input: DesignInput, autoStart = false) {
  const existing = cards.value.find((card) => card.key === input.issueKey);
  if (!editing.value && existing) { formError.value = '此 Jira 事项已在看板中，请打开已有卡片补充资料，避免重复。'; return; }
  const changed = existing && JSON.stringify(existing.input) !== JSON.stringify(input);
  if (!save({ input, review: changed ? emptyReview() : existing?.local?.review || emptyReview(),
    blockedReason: existing?.local?.blockedReason || '', updatedAt: new Date().toISOString() })) {
    formError.value = storageError.value; return;
  }
  formVisible.value = false;
  changeView('drafts');
  open(input.issueKey);
  ElMessage.success('任务输入已保存到待启动草稿，确认启动前不会执行');
  if (autoStart) void startExecution(input);
}
function saveReview(review: DesignReview, blockedReason: string) {
  const card = selected.value;
  if (!card) return;
  const now = new Date().toISOString();
  if (save({ input: card.input, review: { ...review, checkedAt: now, sourceRevision: card.sourceRevision }, blockedReason: blockedReason.trim(), updatedAt: now })) {
    ElMessage.success('人工记录已保存到本浏览器；未修改远端状态');
  } else ElMessage.error(storageError.value);
}
async function removeLocal() {
  const card = selected.value;
  if (!card?.local) return;
  try { await ElMessageBox.confirm(`只移除 ${card.key} 的本机补充资料与人工记录，不删除 Jira、文档或执行任务。此本机记录没有服务端备份。`, '移除本机记录', { type: 'warning', confirmButtonText: '移除本机记录', cancelButtonText: '保留', closeOnClickModal: false }); }
  catch { return; }
  if (remove(card.key)) { drawer.value = false; ElMessage.success('本机记录已移除，原系统事项保留'); }
  else ElMessage.error(storageError.value);
}
</script>

<template>
  <div class="tech-design-board">
    <PageHeading title="技术方案自动执行器" description="Codex 会话执行方案、发布与建单；看板保存阶段结果和回读证据。" :loading="source.isFetching.value || executor.query.isFetching.value" @refresh="refresh"><el-button type="primary" @click="showForm()"><Plus :size="15" />新建执行任务</el-button></PageHeading>
    <ExecutorOverview :dashboard="executor.query.data.value" :error="executor.query.error.value" :updated-at="executor.query.dataUpdatedAt.value" :active-status="view === 'executions' ? lane : 'all'" @filter="filterExecutions" @open="open" />
    <section class="workflow-templates" aria-label="任务模板">
      <header><h2>从模板开始</h2><span>技术方案交付</span></header>
      <div class="template-list"><button v-for="template in templates" :key="template.title" @click="useTemplate(template)"><component :is="template.icon" :size="20" /><span><strong>{{ template.title }}</strong><small>{{ template.description }}</small></span><ArrowUpRight :size="15" /></button></div>
    </section>
    <el-alert v-if="storageError" class="section-alert" type="error" :title="storageError" :closable="false" show-icon />
    <el-tabs :model-value="view" class="design-view-tabs" @update:model-value="changeView($event as DesignView)">
      <el-tab-pane :label="`自动执行 (${executor.query.data.value ? groupedCards.executions.length : '—'})`" name="executions" />
      <el-tab-pane :label="`待启动草稿 (${groupedCards.drafts.length})`" name="drafts" />
      <el-tab-pane :label="`历史方案 (${source.data.value ? groupedCards.history.length : '—'})`" name="history" />
    </el-tabs>
    <p class="view-description">{{ view === 'executions' ? '仅展示已授权任务；由 Codex 会话领取并回写阶段结果。' : view === 'drafts' ? '草稿仅保存在当前浏览器。确认授权后，任务等待 Codex 会话领取。' : `保留原系统方案、文档和人工核验记录，不计入上方自动执行统计，也不会自动重新派发。最近读取 ${dateTime(source.dataUpdatedAt.value)}。` }}</p>
    <el-alert v-if="view === 'history' && source.error.value" class="section-alert" type="error" :title="`历史记录读取失败：${source.error.value.message}；已有记录可能过期。`" :closable="false" show-icon />
    <div class="design-toolbar"><el-input v-model="search" placeholder="搜索 Jira、任务名称或版本" clearable aria-label="搜索执行任务" /><el-select v-if="view !== 'drafts'" v-model="lane" aria-label="任务状态"><el-option label="全部状态" value="all" /><el-option v-for="item in filterLanes" :key="item.id" :label="item.title" :value="item.id" /></el-select><span>显示 {{ visibleCards.length }} / {{ viewCards.length }}</span></div>
    <el-skeleton v-if="loadingView && !viewCards.length" :rows="3" animated class="board-loading" />
    <DesignKanban v-else-if="visibleCards.length" :cards="visibleCards" :view="view" @open="open" />
    <section v-else class="execution-empty"><FileCheck2 :size="30" /><h2>{{ viewError ? '暂时无法读取任务' : viewCards.length ? '没有符合筛选条件的任务' : view === 'executions' ? '还没有自动执行任务' : view === 'drafts' ? '暂无待启动草稿' : '暂无历史方案记录' }}</h2><p>{{ viewError ? '请检查连接后刷新，不要把读取失败当作没有任务。' : viewCards.length ? '调整关键词或状态筛选后重试。' : view === 'executions' ? '填写 Jira 事项、仓库和发布目录，确认授权后自动执行六个步骤。历史方案不会自动启动。' : view === 'drafts' ? '新建任务时可先保存草稿，稍后补充资料再启动。' : '原系统方案记录会显示在这里，已有任务和文档不会被删除。' }}</p><el-button v-if="viewError" @click="refresh">重新读取</el-button><el-button v-else-if="viewCards.length" @click="search = ''; lane = 'all'">清除筛选</el-button><el-button v-else-if="view !== 'history'" type="primary" @click="showForm()">新建执行任务</el-button><el-button v-if="view === 'executions' && groupedCards.history.length" text @click="changeView('history')">查看 {{ groupedCards.history.length }} 条历史方案</el-button></section>
    <p class="design-boundary">后台任务与证据持久化保存；人工登记不代表自动回读通过。停止任务不会撤销已发布的文档或已创建的 Jira，原系统队列不受影响。</p>
    <DesignRequestForm v-model="formVisible" :initial="initialInput" :editing="editing" :error="formError" @save="saveInput" />
    <DesignDetail v-if="selected" :key="selected.key" v-model="drawer" :card="selected" :executor-ready="!executor.query.error.value && !!executor.query.data.value?.health.ready" :pending="executor.pending.value" @edit="showForm(true)" @remove="removeLocal" @review="saveReview" @start="startExecution()" @resume="selected.execution && executor.resume(selected.execution, $event)" @stop="selected.execution && executor.stop(selected.execution)" />
  </div>
</template>

<style scoped>
.tech-design-board{min-width:0}.view-description{font-size:12px;line-height:1.9;color:var(--ui-secondary);margin:0 0 16px}.design-toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:18px}.design-toolbar>.el-input{width:300px}.design-toolbar>.el-select{width:160px}.design-toolbar>span{font-size:11px;color:var(--ui-muted);margin-left:auto}.board-loading{margin:20px 0}.execution-empty{padding:38px 20px;margin-bottom:20px;text-align:center;background:var(--ui-surface);border:1px dashed var(--ui-border);border-radius:10px}.execution-empty>svg{color:var(--ui-accent)}.execution-empty h2{font-size:16px;margin:14px 0 10px}.execution-empty p{font-size:12px;line-height:1.9;color:var(--ui-secondary);margin:0 auto 20px;max-width:570px}.design-boundary{font-size:11px;line-height:1.9;color:var(--ui-muted);margin:0}.heading-actions .el-button{gap:5px}@media(max-width:650px){.design-toolbar>.el-input{width:100%}.design-toolbar>.el-select{width:160px}.execution-empty{padding:26px 16px}.execution-empty .el-button{margin:4px}.design-view-tabs :deep(.el-tabs__item){padding:0 12px;font-size:12px}}
</style>

<style scoped>
.workflow-templates{margin-bottom:24px}.workflow-templates header{display:flex;align-items:center;gap:12px;margin-bottom:12px}.workflow-templates h2{font-size:14px;margin:0}.workflow-templates header>span{font-size:11px;color:var(--ui-muted)}.template-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.template-list button{display:flex;align-items:center;gap:12px;min-height:76px;padding:14px;background:var(--ui-surface);border:1px solid var(--ui-border);border-radius:8px;text-align:left;cursor:pointer;color:var(--ui-accent)}.template-list button:nth-child(2){color:var(--ui-success)}.template-list button:nth-child(3){color:var(--ui-warning)}.template-list button:hover{border-color:currentColor}.template-list button>span{flex:1;min-width:0}.template-list strong{font-size:13px;line-height:1.7;color:var(--ui-text);display:block}.template-list small{font-size:11px;line-height:1.8;color:var(--ui-secondary);display:block;overflow-wrap:anywhere}@media(max-width:1000px){.template-list{grid-template-columns:minmax(0,1fr)}.template-list button{min-height:68px}}
</style>
