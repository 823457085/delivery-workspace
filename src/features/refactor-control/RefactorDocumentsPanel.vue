<script setup lang="ts">
import { computed, shallowRef, useTemplateRef, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { Download, FileSpreadsheet, Play, RefreshCw, Search, Upload } from '@lucide/vue';
import { refactorDocumentStateLabels as stateLabels, type RefactorDocument, type RefactorDocumentRow } from '../../../shared/refactor-workspace';
import type { RefactorProjectStatus } from '../../../shared/refactor-projects';
import { refactorArtifactUrl, refactorWorkspaceBase, refactorWorkspaceQueryKey, refactorWorkspaceRequest } from './useRefactorControl';

interface WorkspaceDashboard { revision: string; documents: RefactorDocument[]; projects: RefactorProjectStatus[] }
interface DocumentSelection { action: 'integrate' | 'retest'; moduleIds: string[]; issueIds: string[]; interfaceIds: string[] }
const emit = defineEmits<{ launch: [selection: DocumentSelection]; changed: []; projects: [] }>();
const client = useQueryClient();
const query = useQuery({ queryKey: refactorWorkspaceQueryKey,
  queryFn: ({ signal }) => refactorWorkspaceRequest<WorkspaceDashboard>('', undefined, signal), refetchInterval: 5_000, retry: false });
const fileInput = useTemplateRef<HTMLInputElement>('fileInput');
const selectedFile = shallowRef<File>();
const importProjectId = shallowRef(''), documentId = shallowRef(''), bindProjectId = shallowRef('');
const uploading = shallowRef(false), binding = shallowRef(false), selectedIds = shallowRef<string[]>([]);
const stateFilter = shallowRef(''), search = shallowRef('');
const sourceStatusFilter = shallowRef<string>(), reporterFilter = shallowRef<string>();
const documents = computed(() => query.data.value?.documents || []);
const projects = computed(() => query.data.value?.projects || []);
const current = computed(() => documents.value.find(document => document.id === documentId.value));
const sourceStatusOptions = computed(() => [...new Set((current.value?.rows || []).map(row => row.sourceStatus || ''))].sort((a, b) => a.localeCompare(b, 'zh-CN')));
const reporterOptions = computed(() => [...new Set((current.value?.rows || []).map(row => row.reporter || ''))].sort((a, b) => a.localeCompare(b, 'zh-CN')));
const resultLabels = { passed: '本轮通过', failed: '本轮不通过', blocked: '本轮阻塞', not_run: '本轮未执行' };
const stateLabel = (row: RefactorDocumentRow) => row.state === 'passed' && row.latest?.status === 'passed' ? '本轮通过' : stateLabels[row.state];
const resultLabel = (row: RefactorDocumentRow) => row.latest ? resultLabels[row.latest.status] : '';
const counts = computed(() => Object.entries(stateLabels).map(([state, label]) => ({ state, label: state === 'passed' ? '通过记录' : label,
  count: current.value?.rows.filter(row => row.state === state).length || 0 })));
const visibleRows = computed(() => {
  const term = search.value.trim().toLowerCase();
  return (current.value?.rows || []).filter(row => (!stateFilter.value || row.state === stateFilter.value)
    && (sourceStatusFilter.value == null || (row.sourceStatus || '') === sourceStatusFilter.value)
    && (reporterFilter.value == null || (row.reporter || '') === reporterFilter.value)
    && (!term || [row.issueId, row.title, row.method, row.path, row.sourceStatus, row.notes, row.latest?.actual].join(' ').toLowerCase().includes(term)));
});
function disabledReason(row: RefactorDocumentRow) {
  if (!current.value?.projectId || !current.value.moduleId || !projects.value.some(project => project.id === current.value?.projectId)) return '请先关联重构项目';
  if (row.state === 'blocked') return '暂不联调，需先确认测试条件';
  if (!row.path) return '缺少接口路径，先核对原文';
  if (!row.method) return '缺少请求方法，先核对原文';
  if (row.state === 'pending_test' && row.method.toUpperCase() !== 'GET') return '首次测试写接口需要先确认测试数据';
  return '';
}
const selectedRows = computed(() => visibleRows.value.filter(row => selectedIds.value.includes(row.id) && !disabledReason(row)));
const testRows = computed(() => selectedRows.value.filter(row => row.state === 'pending_test'));
const retestRows = computed(() => selectedRows.value.filter(row => row.state !== 'pending_test'));
const selectableRows = computed(() => visibleRows.value.filter(row => !disabledReason(row)));
const allSelected = computed(() => !!selectableRows.value.length && selectableRows.value.every(row => selectedIds.value.includes(row.id)));
watch(() => query.error.value?.message, message => { if (message) ElMessage.error(message); });
watch(() => [...new Set(documents.value.map(document => document.exportError).filter(Boolean))].join('；'),
  message => { if (message) ElMessage.error(message); }, { immediate: true });
watch(documents, value => {
  if (!value.some(document => document.id === documentId.value)) documentId.value = value[0]?.id || '';
}, { immediate: true });
watch(projects, value => { if (!value.some(project => project.id === importProjectId.value)) importProjectId.value = ''; });
watch(() => [current.value?.id, current.value?.projectId], () => { bindProjectId.value = current.value?.projectId || ''; }, { immediate: true });
watch([stateFilter, search, sourceStatusFilter, reporterFilter], () => {
  const visibleIds = new Set(visibleRows.value.map(row => row.id));
  selectedIds.value = selectedIds.value.filter(id => visibleIds.has(id));
});
watch(documentId, () => { selectedIds.value = []; stateFilter.value = ''; search.value = ''; sourceStatusFilter.value = undefined; reporterFilter.value = undefined; });
function time(value: string) { return new Date(value).toLocaleString('zh-CN', { hour12: false }); }
function chooseFile(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0];
  if (file && (!/\.xlsx$/i.test(file.name) || file.size > 40 * 1024 * 1024)) {
    selectedFile.value = undefined; input.value = ''; ElMessage.error('请选择 40 MB 以内的 .xlsx 联调文档'); return;
  }
  selectedFile.value = file;
}
function fileBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('文档读取失败，请重新选择文件'));
    reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1));
    reader.readAsDataURL(file);
  });
}
async function importDocument() {
  const file = selectedFile.value, revision = query.data.value?.revision;
  if (!file || !revision || uploading.value) return;
  uploading.value = true;
  try {
    const previous = new Set(documents.value.map(document => document.id));
    const next = await refactorWorkspaceRequest<WorkspaceDashboard>('/import', {
      name: file.name, data: await fileBase64(file), projectId: importProjectId.value, revision,
    });
    client.setQueryData(refactorWorkspaceQueryKey, next);
    documentId.value = next.documents.find(document => !previous.has(document.id))?.id
      || next.documents.find(document => document.name === file.name)?.id || documentId.value;
    selectedFile.value = undefined; if (fileInput.value) fileInput.value.value = '';
    emit('changed'); ElMessage.success('文档已导入，原文与图片已保留');
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); }
  finally { uploading.value = false; }
}
async function bindProject() {
  const document = current.value, revision = query.data.value?.revision;
  if (!document || !revision || !bindProjectId.value || binding.value) return;
  binding.value = true;
  try {
    const next = await refactorWorkspaceRequest<WorkspaceDashboard>('/bind', { documentId: document.id, projectId: bindProjectId.value, revision });
    client.setQueryData(refactorWorkspaceQueryKey, next); selectedIds.value = [];
    emit('changed'); ElMessage.success('已关联执行项目');
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : String(error)); }
  finally { binding.value = false; }
}
function toggleRow(id: string, checked: boolean) {
  selectedIds.value = checked ? [...new Set([...selectedIds.value, id])] : selectedIds.value.filter(value => value !== id);
}
function toggleAll(checked: boolean) {
  const ids = new Set(selectableRows.value.map(row => row.id));
  selectedIds.value = checked ? [...ids] : selectedIds.value.filter(id => !ids.has(id));
}
function launch(action: DocumentSelection['action'], rows: RefactorDocumentRow[]) {
  if (!current.value?.moduleId || !rows.length || rows.some(row => disabledReason(row))
    || action === 'integrate' && rows.some(row => row.state !== 'pending_test')
    || action === 'retest' && rows.some(row => row.state === 'pending_test')) return;
  emit('launch', { action, moduleIds: [current.value.moduleId],
    interfaceIds: action === 'integrate' ? rows.map(row => row.id) : [], issueIds: action === 'retest' ? rows.map(row => row.id) : [] });
}
const documentUrl = (document: RefactorDocument, action: 'original' | 'export') => `${refactorWorkspaceBase}/documents/${encodeURIComponent(document.id)}/${action}`;
</script>

<template>
  <section class="refactor-documents" aria-label="联调文档管理">
    <div class="documents-import">
      <div class="documents-section-title"><FileSpreadsheet :size="19" /><div><h2>从联调文档开始</h2><p>导入问题清单，执行结果写回原表对应行，保留全部问题、图片和历史记录后导出。</p></div></div>
      <div class="documents-import-fields">
        <div class="documents-file-picker">
          <input ref="fileInput" type="file" accept=".xlsx" hidden :disabled="uploading" @change="chooseFile" />
          <el-button aria-label="选择联调 Excel 文档" :disabled="uploading" @click="fileInput?.click()">选择文件</el-button>
          <span :title="selectedFile?.name">{{ selectedFile?.name || '未选择任何文件' }}</span>
        </div>
        <el-select v-model="importProjectId" class="documents-project-select" aria-label="导入时关联项目" :disabled="uploading" :empty-values="[null, undefined]">
          <el-option value="" label="稍后关联执行项目" /><el-option v-for="project in projects" :key="project.id" :value="project.id" :label="project.name" />
        </el-select>
        <el-button type="primary" class="documents-import-button" :disabled="!selectedFile || uploading || !query.data.value" @click="importDocument"><Upload :size="14" />{{ uploading ? '正在导入…' : '导入文档' }}</el-button>
      </div>
      <p class="documents-caption">支持 .xlsx，最大 40 MB。未关联项目也可先导入分析；原文“通过”保留为历史结论，本轮结果以实际执行证据为准。</p>
    </div>
    <el-skeleton v-if="query.isPending.value" :rows="6" animated />
    <el-empty v-else-if="query.isError.value && !query.data.value" description="联调文档暂不可读" :image-size="70"><el-button @click="query.refetch()">重新读取</el-button></el-empty>
    <el-empty v-else-if="!documents.length" description="还没有导入联调文档" :image-size="70"><div class="documents-empty-actions"><el-button @click="fileInput?.click()">选择联调文档</el-button><el-button @click="emit('projects')">管理项目组</el-button></div></el-empty>
    <template v-else>
      <div class="documents-switcher"><label>联调文档<el-select v-model="documentId" aria-label="切换联调文档"><el-option v-for="document in documents" :key="document.id" :value="document.id" :label="`${document.name} · ${document.rows.length} 项`" /></el-select></label><button class="control-icon" type="button" aria-label="刷新联调文档" :disabled="query.isFetching.value" @click="query.refetch()"><RefreshCw :size="15" :class="{ spinning: query.isFetching.value }" /></button></div>
      <section v-if="current" class="documents-detail" :aria-label="`${current.name} 联调清单`">
        <div class="documents-top-bar">
          <header class="documents-header"><div><h2>{{ current.name }}</h2><p>{{ time(current.importedAt) }} 导入 · {{ current.rows.length }} 项 · 保留 {{ current.imageCount }} 张图片</p></div><div class="documents-actions"><a class="control-button" :href="documentUrl(current, 'original')" download><Download :size="14" />原始文档</a><a class="control-button" :href="documentUrl(current, 'export')" download><Download :size="14" />基于原表导出 XLSX</a></div></header>
          <div class="documents-binding"><span>执行项目</span><el-select v-model="bindProjectId" aria-label="文档关联执行项目" :disabled="binding" :empty-values="[null, undefined]"><el-option value="" label="选择项目组中的项目" /><el-option v-for="project in projects" :key="project.id" :value="project.id" :label="project.name" /></el-select><button class="control-button" type="button" :disabled="!bindProjectId || bindProjectId === current.projectId || binding" @click="bindProject">{{ binding ? '关联中…' : '关联项目' }}</button><button class="documents-text-button" type="button" @click="emit('projects')">管理项目组</button></div>
        </div>
        <div class="documents-state-filters" aria-label="文档状态分类"><button type="button" :aria-pressed="!stateFilter" :class="{ selected: !stateFilter }" @click="stateFilter = ''"><span>全部记录</span><strong>{{ current.rows.length }}</strong></button><button v-for="item in counts" :key="item.state" type="button" :aria-pressed="stateFilter === item.state" :class="{ selected: stateFilter === item.state }" @click="stateFilter = item.state"><span>{{ item.label }}</span><strong>{{ item.count }}</strong></button></div>
        <details v-if="current.warnings.length" class="documents-recognition"><summary>导入识别说明 · {{ current.warnings.length }} 项</summary><ul><li v-for="(warning, index) in current.warnings" :key="index">{{ warning }}</li></ul></details>
        <div class="documents-table-toolbar"><span>已选 {{ selectedRows.length }} 项 · 当前 {{ visibleRows.length }} 项</span><div class="documents-row-filters"><el-select v-model="sourceStatusFilter" aria-label="筛选原文状态" placeholder="全部原文状态" clearable :empty-values="[null, undefined]"><el-option v-for="value in sourceStatusOptions" :key="value" :value="value" :label="value || '未填写'" /></el-select><el-select v-model="reporterFilter" aria-label="筛选提出人员" placeholder="全部提出人员" clearable :empty-values="[null, undefined]"><el-option v-for="value in reporterOptions" :key="value" :value="value" :label="value || '未填写'" /></el-select></div><label class="control-search"><Search :size="14" /><input v-model="search" type="search" aria-label="搜索联调文档记录" placeholder="搜索编号、接口或问题" maxlength="200" /></label><div class="documents-actions"><button class="control-button" type="button" :disabled="!testRows.length" @click="launch('integrate', testRows)"><Play :size="12" />测试所选<template v-if="testRows.length"> {{ testRows.length }}</template></button><button class="control-button primary" type="button" :disabled="!retestRows.length" @click="launch('retest', retestRows)"><Play :size="12" />复测所选<template v-if="retestRows.length"> {{ retestRows.length }}</template></button></div></div>
        <el-table :data="visibleRows" row-key="id" max-height="620" class="documents-table" empty-text="当前筛选没有联调记录">
          <el-table-column width="40" align="center"><template #header><input type="checkbox" aria-label="选择当前可执行联调记录" :checked="allSelected" :disabled="!selectableRows.length" @change="toggleAll(($event.target as HTMLInputElement).checked)" /></template><template #default="{ row }"><input type="checkbox" :aria-label="`选择联调记录 ${row.issueId || row.id}`" :checked="selectedIds.includes(row.id)" :disabled="!!disabledReason(row)" :title="disabledReason(row)" @change="toggleRow(row.id, ($event.target as HTMLInputElement).checked)" /></template></el-table-column>
          <el-table-column type="expand" width="32"><template #default="{ row }"><dl class="documents-original"><dt>原始请求</dt><dd>{{ row.request || '未填写' }}</dd><dt>请求参数</dt><dd>{{ row.parameters || '未填写' }}</dd><dt>预期结果</dt><dd>{{ row.expected || '未填写' }}</dd><dt>原实际结果</dt><dd>{{ row.actual || '未填写' }}</dd><dt>原始备注</dt><dd>{{ row.notes || '未填写' }}</dd></dl></template></el-table-column>
          <el-table-column label="原编号 / 来源" min-width="176"><template #default="{ row }"><strong>{{ row.issueId || '未填写编号' }}</strong><small>{{ row.sheetName }} · 第 {{ row.row }} 行</small></template></el-table-column>
          <el-table-column label="接口 / 问题" min-width="285"><template #default="{ row }"><strong>{{ row.title || row.path || '未填写问题摘要' }}</strong><code>{{ row.method }} {{ row.path || '接口路径待核对' }}</code><small>{{ current.projectName || '尚未关联项目' }}</small></template></el-table-column>
          <el-table-column label="原文状态" min-width="125"><template #default="{ row }"><span>{{ row.sourceStatus || '未填写' }}</span></template></el-table-column>
          <el-table-column label="处理分类" min-width="130"><template #default="{ row }"><span>{{ stateLabel(row) }}</span><small v-if="disabledReason(row)">{{ disabledReason(row) }}</small></template></el-table-column>
          <el-table-column label="最新执行结果" min-width="240"><template #default="{ row }"><template v-if="row.latest"><strong>{{ resultLabel(row) }}</strong><p>{{ row.latest.actual }}</p><small>{{ row.latest.environment }} · {{ row.latest.version || '未填写版本' }} · {{ time(row.latest.checkedAt) }}</small><a v-for="file in row.latest.evidence" :key="file" class="documents-evidence" :href="refactorArtifactUrl(row.latest.jobId, file)" target="_blank" rel="noopener noreferrer">{{ file }}</a></template><small v-else>尚无本轮实测结果</small></template></el-table-column>
          <el-table-column label="操作" width="84" fixed="right"><template #default="{ row }"><span :title="disabledReason(row)"><el-button link type="primary" :disabled="!!disabledReason(row)" @click="launch(row.state === 'pending_test' ? 'integrate' : 'retest', [row])">{{ row.state === 'pending_test' ? '测试' : '复测' }}</el-button></span></template></el-table-column>
        </el-table>
      </section>
    </template>
  </section>
</template>
