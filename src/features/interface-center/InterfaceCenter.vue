<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { ChevronRight, Folder, Layers, Plus, RefreshCw, Search } from '@lucide/vue';
import type { ApiCatalog, ApiOperation, ApiOperationDetail, ApiProject, ApiProjectDetail } from '../../../shared/interface-center';
import PageHeading from '../../shared/ui/PageHeading.vue';
import { dateTime } from '../../shared/format';
import { errorMessage, interfaceApi, projectPath } from './api';
import ImportDialog from './ImportDialog.vue';
import OperationDetail from './OperationDetail.vue';
import ApifoxConnectionDialog from './ApifoxConnectionDialog.vue';

const projects = shallowRef<ApiProject[]>([]), operations = shallowRef<ApiOperation[]>([]);
const activeId = ref(''), loading = ref(true), projectLoading = ref(false);
const group = ref(''), directorySearch = ref(''), search = ref(''), method = ref(''), page = ref(1);
const project = computed(() => projects.value.find(item => item.id === activeId.value));
const sourceGroups = computed(() => [
  { label: 'Apifox', projects: projects.value.filter(item => item.source.kind === 'apifox') },
  { label: 'BFF 仓库', projects: projects.value.filter(item => item.source.kind === 'repository') },
  { label: '本地项目', projects: projects.value.filter(item => item.source.kind === 'file' || item.source.kind === 'manual') },
].filter(item => item.projects.length));
const sourceGroup = computed(() => sourceGroups.value.find(item => item.projects.some(entry => entry.id === activeId.value))?.label);
const canRefreshSource = computed(() => {
  const source = project.value?.source;
  return !!(source?.kind === 'apifox' && source.apifoxTeamId && source.apifoxProjectId
    || source?.kind === 'repository' && source.repositoryPath && source.ref && source.file);
});
const total = computed(() => projects.value.reduce((count, item) => count + item.operationCount, 0));
const directory = computed(() => (project.value?.groups || []).filter(item => item.name.toLocaleLowerCase().includes(directorySearch.value.trim().toLocaleLowerCase())));
const methods = computed(() => [...new Set(operations.value.map(item => item.method))].sort());
const filtered = computed(() => operations.value.filter(item => (!group.value || item.tags.includes(group.value) || (!item.tags.length && group.value === '未分类'))
  && (!method.value || item.method === method.value)
  && `${item.summary} ${item.path} ${item.method}`.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase())));
const rows = computed(() => filtered.value.slice((page.value - 1) * 25, page.value * 25));
watch([group, search, method], () => { page.value = 1; });
let catalogRequest = 0, projectRequest = 0, detailRequest = 0;
const selectionKey = 'delivery-interface-center-project';
function remember(id: string) { try { localStorage.setItem(selectionKey, id); } catch { /* 浏览器存储受限时只保留本次选择。 */ } }
function remembered() { try { return localStorage.getItem(selectionKey) || ''; } catch { return ''; } }
async function loadCatalog(preferred?: string) {
  const request = ++catalogRequest;
  loading.value = true;
  try {
    const result = await interfaceApi<ApiCatalog>();
    if (request !== catalogRequest) return;
    projects.value = result.projects;
    const nextId = result.projects.find(item => item.id === (preferred || activeId.value || remembered()))?.id || result.projects[0]?.id || '';
    if (nextId === activeId.value) await loadProject(nextId);
    else activeId.value = nextId;
  } catch (error) { if (request === catalogRequest) ElMessage.error(errorMessage(error)); }
  finally { if (request === catalogRequest) loading.value = false; }
}
async function loadProject(id: string) {
  const request = ++projectRequest;
  operations.value = []; projectLoading.value = !!id;
  if (!id) return;
  try {
    const result = await interfaceApi<ApiProjectDetail>(projectPath(id));
    if (request !== projectRequest || activeId.value !== id) return;
    operations.value = result.operations;
    projects.value = projects.value.map(item => item.id === id ? result.project : item);
    if (group.value && !result.project.groups.some(item => item.name === group.value)) group.value = '';
    if (method.value && !result.operations.some(item => item.method === method.value)) method.value = '';
    page.value = Math.min(page.value, Math.max(1, Math.ceil(filtered.value.length / 25)));
  } catch (error) { if (request === projectRequest) ElMessage.error(errorMessage(error)); }
  finally { if (request === projectRequest) projectLoading.value = false; }
}
watch(activeId, id => { group.value = ''; directorySearch.value = ''; search.value = ''; method.value = ''; page.value = 1; detailOpen.value = false; remember(id); void loadProject(id); });
onMounted(() => { void loadCatalog(); });
onBeforeUnmount(() => { catalogRequest++; projectRequest++; detailRequest++; });

const newProjectOpen = ref(false), projectName = ref(''), projectDescription = ref(''), creating = ref(false);
function newProject() { projectName.value = ''; projectDescription.value = ''; newProjectOpen.value = true; }
async function createProject() {
  if (creating.value || !projectName.value.trim()) return;
  creating.value = true;
  try {
    const created = await interfaceApi<ApiProject>('/projects', { name: projectName.value.trim(), description: projectDescription.value.trim() });
    newProjectOpen.value = false; await loadCatalog(created.id); ElMessage.success('项目已添加，可继续导入接口');
  } catch (error) { ElMessage.error(errorMessage(error)); }
  finally { creating.value = false; }
}
const importOpen = ref(false), importCurrent = ref(false), refreshingSource = ref(false);
const importMode = ref<'file' | 'repository' | 'apifox'>('apifox');
const apifoxOpen = ref(false);
function openImport(current = false, refresh = false) {
  importCurrent.value = current;
  refreshingSource.value = refresh;
  importMode.value = current ? 'file' : refresh && project.value?.source.kind === 'repository' ? 'repository' : 'apifox';
  importOpen.value = true;
}
async function imported(id?: string) { detailOpen.value = false; await loadCatalog(id || activeId.value); }
const detailOpen = ref(false), detailLoading = ref(false), detail = shallowRef<ApiOperationDetail>();
async function openDetail(operation: ApiOperation) {
  const request = ++detailRequest, projectId = activeId.value;
  detail.value = undefined; detailOpen.value = true; detailLoading.value = true;
  try {
    const result = await interfaceApi<ApiOperationDetail>(`${projectPath(projectId)}/operation?key=${encodeURIComponent(operation.key)}`);
    if (request === detailRequest && activeId.value === projectId && detailOpen.value) detail.value = result;
  } catch (error) { if (request === detailRequest) { ElMessage.error(errorMessage(error)); detailOpen.value = false; } }
  finally { if (request === detailRequest) detailLoading.value = false; }
}
watch(detailOpen, value => { if (!value) { detailRequest++; detail.value = undefined; detailLoading.value = false; } });
</script>

<template>
  <section class="interface-center" aria-label="接口联调中心">
    <PageHeading title="接口联调中心" description="集中管理 Apifox、BFF 仓库与本地接口" :loading="loading || projectLoading" @refresh="loadCatalog()" />
    <header class="center-heading">
      <div class="center-heading-title"><h1>接口联调中心</h1><div class="catalog-totals"><strong>{{ projects.length }}</strong> 个项目<span>·</span><strong>{{ total }}</strong> 个接口</div></div>
      <div class="center-heading-actions">
        <el-button @click="apifoxOpen = true">Apifox 连接</el-button>
        <el-button @click="newProject"><Plus :size="15" />新建本地项目</el-button>
        <el-button type="primary" @click="openImport()"><RefreshCw :size="15" />同步来源</el-button>
      </div>
    </header>
    <div class="project-bar">
      <div class="project-picker"><label for="interface-project-picker">当前项目</label><el-select id="interface-project-picker" v-model="activeId" filterable placeholder="选择项目" aria-label="选择接口项目" :disabled="loading && !projects.length"><el-option-group v-for="entry in sourceGroups" :key="entry.label" :label="entry.label"><el-option v-for="item in entry.projects" :key="item.id" :value="item.id" :label="item.name"><span class="project-option-name">{{ item.name }}</span><span class="project-option-count">{{ item.operationCount }}</span></el-option></el-option-group></el-select></div>
      <div v-if="project" class="project-meta"><div class="project-meta-title"><el-tag v-if="sourceGroup" size="small">{{ sourceGroup }}</el-tag><el-tag v-if="project.version" type="info" size="small">{{ project.version }}</el-tag><span>{{ project.operationCount }} 个接口 · {{ project.groups.length }} 个分类</span></div><div class="project-source"><span>{{ project.source.label }}</span><code v-if="project.source.commit">{{ project.source.ref }} · {{ project.source.commit.slice(0, 12) }}</code><span>更新于 {{ dateTime(project.updatedAt) }}</span></div></div>
      <el-button v-if="canRefreshSource" size="small" @click="openImport(false, true)"><RefreshCw :size="13" />更新来源</el-button>
      <details v-if="project?.description" :key="project.id" class="project-description-toggle"><summary>项目说明</summary><p class="project-description">{{ project.description }}</p></details>
    </div>
    <div v-if="loading && !projects.length" class="catalog-skeleton"><el-skeleton :rows="8" animated /></div>
    <el-empty v-else-if="!project" description="同步 Apifox 项目或 BFF 仓库到这里" :image-size="100"><el-button @click="newProject">新建项目</el-button><el-button type="primary" @click="openImport()">同步来源</el-button></el-empty>
    <template v-else>
      <div class="catalog-layout">
        <aside class="module-sidebar" aria-label="接口模块目录"><header><Layers :size="15" /><strong>模块目录</strong></header><el-input v-model="directorySearch" size="small" clearable placeholder="搜索分类" aria-label="搜索接口分类"><template #prefix><Search :size="13" /></template></el-input><nav><button type="button" :class="{ selected: !group }" :aria-current="!group ? 'page' : undefined" @click="group = ''"><Folder :size="14" /><span>全部接口</span><small>{{ project.operationCount }}</small></button><button v-for="item in directory" :key="item.name" type="button" :class="{ selected: group === item.name }" :aria-current="group === item.name ? 'page' : undefined" :title="item.name" @click="group = item.name"><Folder :size="14" /><span>{{ item.name }}</span><small>{{ item.count }}</small></button><el-empty v-if="directorySearch && !directory.length" description="没有匹配分类" :image-size="45" /></nav></aside>
        <main class="interface-list" aria-label="当前项目接口列表">
          <header class="list-header"><div><h2>{{ group || '全部接口' }}</h2><span>{{ filtered.length }} 个接口</span></div><div class="list-filters"><el-input v-model="search" clearable placeholder="搜索接口名称、路径" aria-label="搜索接口名称或路径"><template #prefix><Search :size="14" /></template></el-input><el-select v-model="method" clearable placeholder="全部方法" aria-label="筛选请求方法"><el-option v-for="value in methods" :key="value" :label="value" :value="value" /></el-select></div></header>
          <div class="table-viewport"><el-table v-loading="projectLoading" :data="rows" row-key="key" height="100%" class="interface-table" empty-text="当前项目下没有匹配的接口" @row-click="openDetail">
            <el-table-column label="方法" width="86"><template #default="{ row }"><span :class="['http-method', row.method.toLowerCase()]">{{ row.method }}</span></template></el-table-column>
            <el-table-column label="接口 / 路径" min-width="250"><template #default="{ row }"><button type="button" class="operation-name" @click.stop="openDetail(row)">{{ row.summary || row.path }}</button><code class="operation-path">{{ row.path }}</code></template></el-table-column>
            <el-table-column label="分类" min-width="150"><template #default="{ row }"><span class="operation-tags">{{ row.tags.join(' / ') || '未分类' }}</span><el-tag v-if="row.deprecated" size="small" type="info" class="deprecated-tag">已废弃</el-tag></template></el-table-column>
            <el-table-column width="44"><template #default><ChevronRight :size="14" class="row-chevron" /></template></el-table-column>
          </el-table></div>
          <div v-if="!project.operationCount && !projectLoading" class="empty-import"><el-button @click="openImport(true)">导入此项目的接口</el-button></div>
          <footer class="list-footer"><span>显示 {{ filtered.length ? (page - 1) * 25 + 1 : 0 }}–{{ Math.min(page * 25, filtered.length) }} / {{ filtered.length }}</span><el-pagination v-model:current-page="page" :page-size="25" :total="filtered.length" layout="prev, pager, next" :pager-count="5" size="small" hide-on-single-page /></footer>
        </main>
      </div>
    </template>
    <el-dialog v-model="newProjectOpen" title="新建接口项目" width="460px" class="interface-new-dialog" :close-on-click-modal="!creating" :close-on-press-escape="!creating" :show-close="!creating"><el-form label-position="top" :disabled="creating" @submit.prevent="createProject"><el-form-item label="项目名称" required><el-input v-model="projectName" maxlength="100" aria-label="接口项目名称" placeholder="例如：商家 PC BFF" /></el-form-item><el-form-item label="项目说明"><el-input v-model="projectDescription" aria-label="接口项目说明" type="textarea" :rows="3" maxlength="1000" placeholder="项目负责的业务范围" /></el-form-item></el-form><template #footer><el-button :disabled="creating" @click="newProjectOpen = false">取消</el-button><el-button type="primary" :loading="creating" :disabled="!projectName.trim()" @click="createProject">创建项目</el-button></template></el-dialog>
    <ImportDialog v-model="importOpen" :project="project" :projects="projects" :current="importCurrent" :refresh="refreshingSource" :initial-mode="importMode" @imported="imported" @connect="apifoxOpen = true" />
    <ApifoxConnectionDialog v-model="apifoxOpen" />
    <el-drawer v-model="detailOpen" title="接口文档" size="min(1040px, 96vw)" append-to-body class="interface-detail-drawer" destroy-on-close><OperationDetail :detail="detail" :project="project" :loading="detailLoading" /></el-drawer>
  </section>
</template>

<style scoped>
.interface-center{display:flex;flex-direction:column;gap:12px;width:100%;height:100%;min-width:0;min-height:0;margin:0 auto;color:var(--ui-text)}
.center-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;flex-shrink:0}
.center-heading-title{display:flex;align-items:baseline;gap:16px;flex-wrap:wrap;min-width:0}
.center-heading h1{font-size:20px;line-height:1.4;font-weight:600;letter-spacing:-.02em;margin:0}
.center-heading-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.center-heading-actions>.el-button{margin:0}
.interface-center :deep(.el-button>span){display:inline-flex;align-items:center;gap:6px}
.interface-center :deep(.page-heading){min-height:32px;margin:0}
.catalog-totals{display:flex;align-items:center;gap:5px;color:var(--ui-muted);font-size:11px;white-space:nowrap}
.catalog-totals strong{font-size:12px;color:var(--ui-secondary);font-weight:500}
.catalog-totals>span{margin:0 3px}
.project-bar{display:flex;align-items:center;gap:10px 20px;flex-wrap:wrap;flex-shrink:0;min-width:0;padding:0 0 12px;border-bottom:1px solid var(--ui-border)}
.project-picker{display:flex;align-items:center;gap:10px;flex:0 1 350px;min-width:0}
.project-picker>label{color:var(--ui-muted);font-size:11px;white-space:nowrap;flex-shrink:0}
.project-picker>.el-select{flex:1;min-width:0}
.project-option-name{display:inline-block;max-width:calc(100% - 45px);overflow:hidden;text-overflow:ellipsis;vertical-align:bottom}
.project-option-count{float:right;color:var(--ui-muted);font-size:11px}
.project-meta{display:flex;align-items:center;gap:6px 18px;flex-wrap:wrap;flex:1 1 320px;min-width:0}
.project-meta-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.project-meta-title>span:last-child{color:var(--ui-muted);font-size:11px}
.project-source{display:flex;align-items:center;flex-wrap:wrap;gap:4px 12px;color:var(--ui-muted);font-size:10px;line-height:1.6;min-width:0}
.project-source>span,.project-source>code{overflow-wrap:anywhere;min-width:0}
.project-description-toggle{min-width:0}
.project-description-toggle[open]{flex-basis:100%}
.project-description-toggle>summary{width:max-content;max-width:100%;font-size:11px;color:var(--ui-muted);cursor:pointer}
.project-description-toggle>summary:focus-visible{outline:2px solid var(--ui-accent);outline-offset:3px}
.project-description{font-size:12px;line-height:1.8;color:var(--ui-secondary);white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0 0;max-height:100px;overflow:auto}
.catalog-layout{display:grid;grid-template-columns:208px minmax(0,1fr);flex:1;min-width:0;min-height:0;border:1px solid var(--ui-border);border-radius:8px;overflow:hidden;background:var(--ui-surface)}
.module-sidebar{display:flex;flex-direction:column;padding:14px 10px 10px;min-width:0;min-height:0;border-right:1px solid var(--ui-border)}
.module-sidebar>header{display:flex;align-items:center;gap:8px;margin:0 6px 12px;font-size:12px;flex-shrink:0}
.module-sidebar>header>svg{color:var(--ui-muted)}
.module-sidebar>.el-input{margin-bottom:8px;flex-shrink:0}
.module-sidebar nav{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}
.module-sidebar nav>button{display:flex;align-items:center;gap:8px;width:100%;padding:9px 8px;border:0;border-radius:5px;background:transparent;color:var(--ui-secondary);font:inherit;font-size:11px;text-align:left;cursor:pointer}
.module-sidebar nav>button:hover{background:var(--ui-hover)}
.module-sidebar nav>button.selected{color:var(--ui-accent);background:var(--ui-accent-soft);font-weight:600}
.module-sidebar nav>button>svg{flex-shrink:0}
.module-sidebar nav>button>span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.module-sidebar nav>button>small{color:var(--ui-muted);font:10px var(--ds-code,monospace)}
.interface-list{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}
.list-header{display:flex;align-items:center;justify-content:space-between;gap:10px 16px;flex-wrap:wrap;flex-shrink:0;padding:12px 16px;border-bottom:1px solid var(--ui-divider)}
.list-header>div:first-child{display:flex;gap:10px;align-items:baseline;min-width:0;flex:1 1 120px}
.list-header h2{font-size:13px;margin:0;font-weight:600;overflow-wrap:anywhere}
.list-header>div>span{color:var(--ui-muted);font-size:11px;white-space:nowrap}
.list-filters{display:flex;gap:8px;flex:1 1 320px;min-width:0;max-width:440px}
.list-filters>.el-input{flex:1;min-width:0}
.list-filters>.el-select{width:112px;flex-shrink:0}
.table-viewport{flex:1;min-height:0;min-width:0;overflow:hidden}
.interface-table{width:100%}
.interface-table :deep(.el-table__body-wrapper .el-scrollbar__wrap){overscroll-behavior:contain}
.interface-table :deep(.el-table__row){cursor:pointer}
.interface-table :deep(.el-table__cell){padding:10px 0}
.interface-table :deep(th.el-table__cell){padding:8px 0;font-size:11px}
.interface-table :deep(.cell){padding-left:14px;padding-right:12px}
.http-method{display:inline-flex;font:600 10px/1.5 var(--ds-code,monospace);color:var(--el-color-primary);padding:3px 6px;border-radius:4px;background:var(--el-color-primary-light-9)}
.http-method.get{color:var(--el-color-success);background:var(--el-color-success-light-9)}
.http-method.post{color:var(--el-color-warning);background:var(--el-color-warning-light-9)}
.http-method.delete{color:var(--el-color-danger);background:var(--el-color-danger-light-9)}
.operation-name{display:block;padding:0;border:0;background:transparent;color:var(--ui-text);font:inherit;font-size:12px;line-height:1.7;text-align:left;cursor:pointer;overflow-wrap:anywhere;max-width:100%}
.operation-name:hover{color:var(--ui-accent)}
.operation-path{display:block;color:var(--ui-muted);font:10px/1.7 var(--ds-code,monospace);margin-top:2px;overflow-wrap:anywhere}
.operation-tags{font-size:11px;line-height:1.7;overflow-wrap:anywhere;color:var(--ui-secondary)}
.deprecated-tag{display:block;width:max-content;margin-top:5px}
.row-chevron{color:var(--ui-muted)}
.list-footer{display:flex;align-items:center;justify-content:space-between;gap:8px 12px;flex-shrink:0;min-height:48px;padding:8px 14px;border-top:1px solid var(--ui-divider)}
.list-footer>span{font-size:10px;color:var(--ui-muted);white-space:nowrap}
.empty-import{display:flex;justify-content:center;flex-shrink:0;padding:5px 16px 16px}
.catalog-skeleton{padding:20px}
.module-sidebar button:focus-visible,.operation-name:focus-visible{outline:2px solid var(--ui-accent);outline-offset:2px}
@media(min-width:801px){
  :global(.workspace-panel-content:has(>.workspace-page-body>.interface-center)){overflow:hidden}
  :global(.workspace-page-body:has(>.interface-center)){height:100%;min-height:0}
}
@media(max-width:1200px){
  .catalog-layout{grid-template-columns:184px minmax(0,1fr)}
  .center-heading-title{gap:10px}
  .project-bar{gap:8px 16px}
  .project-meta{flex-basis:280px}
}
@media(max-width:800px){
  .interface-center{height:auto;gap:12px}
  .center-heading{align-items:flex-start}
  .center-heading-actions{justify-content:flex-start}
  .catalog-layout{grid-template-columns:minmax(0,1fr);flex:none}
  .module-sidebar{border-right:0;border-bottom:1px solid var(--ui-border);padding:12px}
  .module-sidebar>header{margin-bottom:10px}
  .module-sidebar>.el-input{max-width:300px}
  .module-sidebar nav{display:flex;gap:4px;max-height:132px;flex-wrap:wrap;flex:none}
  .module-sidebar nav>button{width:auto;max-width:100%}
  .module-sidebar nav>button>span{max-width:220px}
  .interface-list{height:clamp(360px,66dvh,680px)}
  .project-picker{flex-basis:100%}
  .project-meta{flex-basis:220px}
  .list-header{padding:12px}
  .list-filters{max-width:none}
  .list-footer{flex-wrap:wrap}
}
@media(max-width:480px){
  .center-heading-title{flex-basis:100%;justify-content:space-between}
  .center-heading-actions{gap:6px}
  .center-heading-actions>.el-button{padding-inline:9px}
  .catalog-totals{font-size:10px}
  .list-filters>.el-select{width:104px}
  .list-footer{padding:8px 10px}
}
@media(min-width:801px){
  @container workspace-page (max-width:760px){
    .center-heading{align-items:flex-start}
    .center-heading-actions{justify-content:flex-start}
    .catalog-layout{grid-template-columns:170px minmax(0,1fr)}
    .project-picker{flex-basis:100%}
    .project-meta{flex-basis:260px}
  }
  @container workspace-page (max-width:540px){
    .catalog-layout{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}
    .module-sidebar{max-height:180px;border-right:0;border-bottom:1px solid var(--ui-border)}
    .list-footer{flex-wrap:wrap}
  }
}
</style>

<style>
.interface-new-dialog.el-dialog{max-width:calc(100vw - 32px)}
.interface-detail-drawer .el-drawer__header{margin-bottom:0;padding:16px 20px;border-bottom:1px solid var(--ui-border)}
.interface-detail-drawer .el-drawer__body{padding:20px;overflow:hidden;min-height:0}
@media(max-width:600px){.interface-detail-drawer .el-drawer__header{padding:14px 16px}.interface-detail-drawer .el-drawer__body{padding:16px}}
</style>
