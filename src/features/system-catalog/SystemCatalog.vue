<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import type { InputInstance } from 'element-plus';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ArrowUpRight, Check, Copy, FolderGit2, GitBranch, Globe2, KeyRound, LayoutGrid, PanelTop, Plus, Search, Star, Trash2, X } from '@lucide/vue';
import type { LocalProject, ProjectsData } from '../../../shared/hub';
import { repositoryKey, systemWebUrl, type CatalogSystem, type SystemAccount, type SystemAccountsRead, type SystemCatalog, type SystemEnvironment, type SystemProjectSave } from '../../../shared/system-catalog';
import { useSource } from '../../shared/api';
import { dateTime } from '../../shared/format';
import { useWorkspacePanelState } from '../../shared/useWorkspacePanelState';
import PageHeading from '../../shared/ui/PageHeading.vue';
import {
  classifyEnvironmentTier,
  countTopEnvironments,
  environmentTierLabel,
  extractUrlHost,
  sortSystemsWithPins,
} from './catalog-studio';

const BrowserAccountImport = defineAsyncComponent(() => import('./BrowserAccountImport.vue'));
const SystemProjectDialog = defineAsyncComponent(() => import('./SystemProjectDialog.vue'));

const PINNED_STORAGE_KEY = 'delivery-workspace.pinned-systems:v1';
function loadPinnedSystemIds(): string[] {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(PINNED_STORAGE_KEY) : null;
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

const router = useRouter(), client = useQueryClient();
async function api<T>(path = '', input?: unknown): Promise<T> {
  const response = await fetch(`/api/systems${path}`, { cache: 'no-store', ...(input === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: JSON.stringify(input),
  }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || '读取系统导航失败');
  return result;
}
const query = useQuery({ queryKey: ['system-catalog'], queryFn: () => api<SystemCatalog>(), staleTime: 60_000, retry: false });
const projects = useSource<ProjectsData>('projects');
const { search, environment, catalogLayout } = useWorkspacePanelState('systems', () => ({
  search: '',
  environment: '全部',
  catalogLayout: 'grid' as 'grid' | 'tabs',
}));
const searchInputRef = ref<InputInstance>();
const pinnedSystemIds = ref<string[]>(loadPinnedSystemIds());
const copiedToken = shallowRef('');
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

const systemTab = shallowRef('');
const syncing = shallowRef(false), detailsOpen = shallowRef(false), selectedId = shallowRef('');
const browserImportOpen = shallowRef(false);
const projectDialog = shallowRef<'manual' | 'excel' | null>(null);
const removingId = shallowRef('');
const systems = computed(() => [...(query.data.value?.systems || []), ...(query.data.value?.localSystems || [])]);
const selected = computed(() => systems.value.find(system => system.id === selectedId.value));
const allEnvironments = computed(() => systems.value.flatMap(system => system.environments));
const environmentNames = computed(() => [...new Set(allEnvironments.value.map(env => env.name))]);
const quickEnvironmentPills = computed(() => countTopEnvironments(allEnvironments.value, 6));
const matches = (system: CatalogSystem) => {
  const key = repositoryKey(system.repository);
  return key ? (projects.data.value?.projects || []).filter(project => repositoryKey(project.remoteUrl) === key) : [];
};
const visible = computed(() => {
  const filtered = systems.value.map(system => ({
    ...system,
    environments: system.environments.filter(env => (environment.value === '全部' || env.name === environment.value)
      && `${system.name} ${system.repository} ${env.name} ${env.url} ${env.branch} ${env.notes}`.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase())),
  })).filter(system => system.environments.length);
  return sortSystemsWithPins(filtered, pinnedSystemIds.value);
});
const activeSystemId = computed(() => visible.value.some(system => system.id === systemTab.value)
  ? systemTab.value : visible.value[0]?.id || '');
const selectedWorkspaces = computed(() => selected.value ? matches(selected.value) : []);
const activePath = shallowRef('');
const activeWorkspace = computed(() => selectedWorkspaces.value.find(item => item.path === activePath.value) || selectedWorkspaces.value[0]);
watch(query.error, error => { if (error) ElMessage.error(error.message); });
watch(selected, system => { if (!system) detailsOpen.value = false; });

function isSystemPinned(id: string): boolean {
  return pinnedSystemIds.value.includes(id);
}
function togglePinSystem(id: string) {
  const next = isSystemPinned(id)
    ? pinnedSystemIds.value.filter(item => item !== id)
    : [id, ...pinnedSystemIds.value];
  pinnedSystemIds.value = next;
  try {
    window.localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(next));
  } catch { /* ignore */ }
}

async function copyQuickValue(value: string, tokenKey: string, label = '内容') {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    copiedToken.value = tokenKey;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      if (copiedToken.value === tokenKey) copiedToken.value = '';
    }, 1500);
    ElMessage.success(`已复制${label}`);
  } catch {
    ElMessage.error('浏览器未允许复制');
  }
}

function onCatalogKeydown(event: KeyboardEvent) {
  if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target as HTMLElement | null;
  if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return;
  if (document.querySelector('.el-dialog, .el-drawer, .cmd-palette-backdrop')) return;
  event.preventDefault();
  searchInputRef.value?.focus();
}
onMounted(() => document.addEventListener('keydown', onCatalogKeydown));
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onCatalogKeydown);
  if (copiedTimer) clearTimeout(copiedTimer);
});

async function sync() {
  syncing.value = true;
  try { client.setQueryData(['system-catalog'], await api<SystemCatalog>('/sync', {})); ElMessage.success('项目资料已同步'); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : '同步失败'); }
  finally { syncing.value = false; }
}
async function removeProject(system: CatalogSystem) {
  if (removingId.value || syncing.value) return;
  const isLocal = query.data.value?.localSystems?.some(project => project.id === system.id);
  removingId.value = system.id;
  try {
    try {
      await ElMessageBox.confirm(isLocal
        ? `删除「${system.name}」的本机导航记录、环境和已保存账号？`
        : `将「${system.name}」从本机系统导航移除？以后同步时也会继续隐藏。`,
      '删除项目', { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消', closeOnClickModal: false });
    } catch { return; }
    const catalog = await api<SystemCatalog>('/projects/remove', { systemId: system.id });
    await client.cancelQueries({ queryKey: ['system-catalog'] });
    client.setQueryData(['system-catalog'], catalog);
    ElMessage.success('项目已从系统导航移除');
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '删除项目失败'); }
  finally { removingId.value = ''; }
}
function openDetails(system: CatalogSystem) { selectedId.value = system.id; activePath.value = ''; detailsOpen.value = true; }
function openGit(project: LocalProject) {
  detailsOpen.value = false;
  void router.push({ path: '/agent', query: { view: 'projects', workspace: project.path, git: '1' } });
}
async function copy(value: string) {
  try { await navigator.clipboard.writeText(value); ElMessage.success('已复制'); }
  catch { ElMessage.error('浏览器未允许复制'); }
}
const repositoryName = (url: string) => repositoryKey(url).split('/').at(-1) || '未收录仓库';
const discrepancy = (env: SystemEnvironment) => !!env.url && !!env.sourceHref && env.url !== env.sourceHref;
function projectSaved(result: SystemProjectSave) {
  client.setQueryData(['system-catalog'], result.catalog);
  search.value = ''; environment.value = '全部';
  systemTab.value = result.systemId;
  projectDialog.value = null;
  ElMessage.success(result.added ? `已保存 ${result.added} 个项目环境` : '项目环境已收录');
}

const accountsOpen = shallowRef(false), accountsLoading = shallowRef(false), saving = shallowRef(false);
const accountTarget = shallowRef<{ system: string; environment: SystemEnvironment }>();
const accountRevision = shallowRef<string>();
const drafts = ref<SystemAccount[]>([]);
let accountRequest = 0, accountsDisposed = false;
function clearAccounts() {
  accountRequest++; drafts.value = []; accountTarget.value = undefined; accountRevision.value = undefined;
  accountsLoading.value = false; saving.value = false;
}
onBeforeUnmount(() => { accountsDisposed = true; clearAccounts(); });
function isCurrentAccountRequest(request: number) { return !accountsDisposed && accountsOpen.value && request === accountRequest; }
async function openAccounts(system: CatalogSystem, env: SystemEnvironment) {
  if (accountsDisposed) return;
  const request = ++accountRequest;
  drafts.value = []; accountRevision.value = undefined; saving.value = false;
  accountTarget.value = { system: system.name, environment: env }; accountsOpen.value = true; accountsLoading.value = true;
  try {
    const result = await api<SystemAccountsRead>('/accounts/read', { environmentId: env.id });
    if (!isCurrentAccountRequest(request)) return;
    if (!result.revision) throw new Error('账号读取结果已失效');
    drafts.value = result.accounts; accountRevision.value = result.revision;
  } catch (error) {
    if (isCurrentAccountRequest(request)) { ElMessage.error(error instanceof Error ? error.message : '读取账号失败'); accountsOpen.value = false; }
  } finally { if (request === accountRequest && !accountsDisposed) accountsLoading.value = false; }
}
function addAccount() {
  if (!accountsOpen.value || saving.value || !accountRevision.value) return;
  drafts.value.push({ id: crypto.randomUUID(), username: '', password: '', hasUsername: false, hasPassword: false, sourceUrl: '', origin: 'local' });
}
async function saveAccounts() {
  if (!accountTarget.value || accountsLoading.value || saving.value || !accountRevision.value || !accountsOpen.value || accountsDisposed) return;
  const request = accountRequest;
  const input = { environmentId: accountTarget.value.environment.id, expectedRevision: accountRevision.value,
    accounts: drafts.value.map(({ id, username, password }) => ({ id, username, password })) };
  saving.value = true;
  try {
    const data = await api<SystemCatalog>('/accounts/save', input);
    if (!isCurrentAccountRequest(request)) return;
    client.setQueryData(['system-catalog'], data); accountsOpen.value = false; ElMessage.success('账号已保存到本机');
  } catch (error) {
    if (isCurrentAccountRequest(request)) ElMessage.error(error instanceof Error ? error.message : '保存失败');
  } finally { if (request === accountRequest && !accountsDisposed) saving.value = false; }
}
</script>

<template>
  <section class="system-catalog" aria-label="系统导航">
    <PageHeading title="系统导航" description="前端系统、环境账号与 Git" :loading="query.isFetching.value" @refresh="query.refetch()">
      <el-button :disabled="syncing || !systems.length" @click="browserImportOpen = true">导入浏览器账号</el-button>
      <el-button :loading="syncing" :disabled="!!removingId" @click="sync">从 Confluence 同步</el-button>
    </PageHeading>
    <header class="catalog-heading">
      <div><span class="catalog-eyebrow">DEVELOPER PORTAL · 网址与账号目录</span><p>业务入口、多环境分支、测试账号与本地 Git 工作区集中联动，支持常用置顶与一键复制。</p></div>
      <dl class="catalog-counts">
        <div><dt>个业务系统</dt><dd>{{ systems.length }}</dd></div>
        <div><dt>个环境 / 分支</dt><dd>{{ allEnvironments.length }}</dd></div>
        <div><dt>个环境有账号</dt><dd>{{ allEnvironments.filter(env => env.accounts.length).length }}</dd></div>
      </dl>
    </header>
    <div class="catalog-board">
      <div class="catalog-filters" role="group" aria-label="系统筛选">
        <el-input
          ref="searchInputRef"
          v-model="search"
          clearable
          placeholder="搜索系统、域名、仓库或分支"
          aria-label="搜索系统"
          @keydown.esc="search = ''"
        >
          <template #prefix><Search :size="15" /></template>
          <template v-if="!search" #suffix><kbd class="catalog-kbd">/</kbd></template>
        </el-input>
        <el-select v-model="environment" aria-label="筛选环境"><el-option label="全部环境" value="全部" /><el-option v-for="name in environmentNames" :key="name" :label="name" :value="name" /></el-select>
        <div class="catalog-project-actions">
          <div class="catalog-layout-switch" role="group" aria-label="切换门户布局">
            <button type="button" :class="{ 'is-active': catalogLayout === 'grid' }" :aria-pressed="catalogLayout === 'grid'" title="矩阵总览（同时浏览全部系统）" @click="catalogLayout = 'grid'">
              <LayoutGrid :size="13" /><span>矩阵总览</span>
            </button>
            <button type="button" :class="{ 'is-active': catalogLayout === 'tabs' }" :aria-pressed="catalogLayout === 'tabs'" title="单系统标签页" @click="catalogLayout = 'tabs'">
              <PanelTop :size="13" /><span>系统标签</span>
            </button>
          </div>
          <el-button @click="projectDialog = 'excel'">Excel 导入</el-button>
          <el-button type="primary" @click="projectDialog = 'manual'"><Plus :size="15" />添加项目</el-button>
        </div>
      </div>

      <div v-if="quickEnvironmentPills.length" class="catalog-env-pills" role="tablist" aria-label="常用环境快捷过滤">
        <button
          type="button"
          class="catalog-env-pill"
          :class="{ 'is-active': environment === '全部' }"
          @click="environment = '全部'"
        >
          <span>全部环境</span><b>{{ allEnvironments.length }}</b>
        </button>
        <button
          v-for="pill in quickEnvironmentPills"
          :key="pill.name"
          type="button"
          class="catalog-env-pill"
          :class="{ 'is-active': environment === pill.name }"
          @click="environment = environment === pill.name ? '全部' : pill.name"
        >
          <span class="catalog-tier-dot" :data-tier="classifyEnvironmentTier(pill.name)"></span>
          <span>{{ pill.name }}</span>
          <b>{{ pill.count }}</b>
        </button>
      </div>

      <div v-if="query.isPending.value" class="catalog-loading"><el-skeleton :rows="8" animated /></div>
      <el-empty v-else-if="!visible.length" class="catalog-empty" :image-size="72" :description="systems.length ? '没有匹配的系统' : '暂未读取到系统入口'">
        <el-button v-if="!systems.length" @click="query.refetch()">重新读取</el-button>
      </el-empty>

      <!-- Homepage / Backstage Multi-System Matrix Grid -->
      <div v-else-if="catalogLayout === 'grid'" class="catalog-matrix-grid">
        <article v-for="system in visible" :key="system.id" class="catalog-system catalog-matrix-card" :class="{ 'is-pinned': isSystemPinned(system.id) }">
          <header class="system-card-heading">
            <span class="system-symbol"><Globe2 :size="19" /></span>
            <div class="system-card-title">
              <div class="system-title-row">
                <h2><button class="system-title" type="button" @click="openDetails(system)">{{ system.name }}</button></h2>
                <span v-if="isSystemPinned(system.id)" class="system-pinned-badge">置顶</span>
              </div>
              <span class="system-repository" :title="system.repository">
                {{ system.region }}<i>·</i>{{ repositoryName(system.repository) }}
                <template v-if="matches(system).length"><i>·</i><b class="system-ws-count">{{ matches(system).length }} 个本地工作区</b></template>
              </span>
            </div>
            <div class="system-card-actions">
              <button
                type="button"
                class="catalog-pin-btn"
                :class="{ 'is-pinned': isSystemPinned(system.id) }"
                :aria-label="isSystemPinned(system.id) ? `取消置顶 ${system.name}` : `置顶 ${system.name}`"
                :title="isSystemPinned(system.id) ? '取消置顶' : '置顶到门户首位'"
                @click="togglePinSystem(system.id)"
              >
                <Star :size="14" :fill="isSystemPinned(system.id) ? 'currentColor' : 'none'" />
              </button>
              <el-button size="small" @click="openDetails(system)"><FolderGit2 :size="14" />Git 详情</el-button>
              <el-button size="small" class="remove-project-btn" :loading="removingId === system.id"
                :disabled="syncing || (!!removingId && removingId !== system.id)" @click="removeProject(system)"><Trash2 :size="13" /></el-button>
            </div>
          </header>
          <div class="system-environments">
            <div v-for="env in system.environments" :key="env.id" class="system-environment">
              <div class="environment-label">
                <span class="env-tier-badge" :data-tier="classifyEnvironmentTier(env.name)">{{ environmentTierLabel(classifyEnvironmentTier(env.name)) }}</span>
                <strong>{{ env.name }}</strong>
                <button
                  v-if="env.branch"
                  type="button"
                  class="env-branch-chip"
                  :title="`点击复制分支 ${env.branch}`"
                  @click="copyQuickValue(env.branch, `branch:${env.id}`, `分支 ${env.branch}`)"
                >
                  <Check v-if="copiedToken === `branch:${env.id}`" :size="11" />
                  <GitBranch v-else :size="11" />
                  <span>{{ env.branch }}</span>
                </button>
              </div>
              <div class="environment-address">
                <template v-if="env.url">
                  <a :href="systemWebUrl(env.url)" target="_blank" rel="noopener noreferrer" :title="env.url">{{ extractUrlHost(env.url) || env.url }}</a>
                  <span class="env-url-full">{{ env.url }}</span>
                </template>
                <span v-else class="muted">{{ env.notes || '暂无网页入口' }}</span>
                <small v-if="discrepancy(env)">原文链接目标不同 · <button type="button" @click="openDetails(system)">查看详情</button></small>
              </div>
              <div class="environment-actions">
                <button
                  v-if="env.url"
                  type="button"
                  class="catalog-copy-chip"
                  :class="{ 'is-copied': copiedToken === `url:${env.id}` }"
                  :title="`复制环境地址 ${env.url}`"
                  @click="copyQuickValue(env.url, `url:${env.id}`, '环境地址')"
                >
                  <Check v-if="copiedToken === `url:${env.id}`" :size="12" />
                  <Copy v-else :size="12" />
                  <span>{{ copiedToken === `url:${env.id}` ? '已复制' : '复制' }}</span>
                </button>
                <el-button text size="small" :aria-label="`${system.name} ${env.name}账号`" @click="openAccounts(system, env)"><KeyRound :size="13" />{{ env.accounts.length ? `${env.accounts.length} 账号` : '账号' }}</el-button>
                <a v-if="env.url" class="visit-system" :href="systemWebUrl(env.url)" target="_blank" rel="noopener noreferrer" :aria-label="`访问 ${system.name} ${env.name}`">访问<ArrowUpRight :size="13" /></a>
              </div>
            </div>
          </div>
          <footer class="system-card-footer">
            <a v-if="system.source.url" :href="systemWebUrl(system.source.url)" target="_blank" rel="noopener noreferrer">{{ system.source.title }}<template v-if="system.source.version"> · v{{ system.source.version }}</template></a>
            <span v-else>{{ system.source.title }}</span>
            <span>{{ system.environments.length }} 个环境</span>
          </footer>
        </article>
      </div>

      <!-- Classic Single-System Tabs Mode -->
      <el-tabs v-else :model-value="activeSystemId" class="catalog-tabs" @update:model-value="systemTab = String($event)">
        <el-tab-pane v-for="system in visible" :key="system.id" :label="`${isSystemPinned(system.id) ? '★ ' : ''}${system.name}`" :name="system.id" lazy>
          <article v-if="system.id === activeSystemId" class="catalog-system">
            <header class="system-card-heading">
              <span class="system-symbol"><Globe2 :size="20" /></span>
              <div class="system-card-title">
                <h2><button class="system-title" type="button" @click="openDetails(system)">{{ system.name }}</button></h2>
                <span class="system-repository" :title="system.repository">{{ system.region }}<i>·</i>{{ repositoryName(system.repository) }}</span>
              </div>
              <div class="system-card-actions">
                <button
                  type="button"
                  class="catalog-pin-btn"
                  :class="{ 'is-pinned': isSystemPinned(system.id) }"
                  @click="togglePinSystem(system.id)"
                >
                  <Star :size="14" :fill="isSystemPinned(system.id) ? 'currentColor' : 'none'" />
                </button>
                <el-button size="small" @click="openDetails(system)"><FolderGit2 :size="15" />Git 信息</el-button>
                <el-button size="small" class="remove-project-btn" :loading="removingId === system.id"
                  :disabled="syncing || (!!removingId && removingId !== system.id)" @click="removeProject(system)"><Trash2 :size="14" />删除项目</el-button>
              </div>
            </header>
            <div class="system-environments">
              <div v-for="env in system.environments" :key="env.id" class="system-environment">
                <div class="environment-label">
                  <span class="env-tier-badge" :data-tier="classifyEnvironmentTier(env.name)">{{ environmentTierLabel(classifyEnvironmentTier(env.name)) }}</span>
                  <strong>{{ env.name }}</strong>
                  <button
                    v-if="env.branch"
                    type="button"
                    class="env-branch-chip"
                    :title="`点击复制分支 ${env.branch}`"
                    @click="copyQuickValue(env.branch, `branch:${env.id}`, `分支 ${env.branch}`)"
                  >
                    <Check v-if="copiedToken === `branch:${env.id}`" :size="11" />
                    <GitBranch v-else :size="11" />
                    <span>{{ env.branch }}</span>
                  </button>
                </div>
                <div class="environment-address">
                  <a v-if="env.url" :href="systemWebUrl(env.url)" target="_blank" rel="noopener noreferrer" :title="env.url">{{ env.url }}</a>
                  <span v-else class="muted">{{ env.notes || '暂无网页入口' }}</span>
                  <small v-if="discrepancy(env)">原文链接目标不同 · <button type="button" @click="openDetails(system)">查看详情</button></small>
                </div>
                <div class="environment-actions">
                  <button
                    v-if="env.url"
                    type="button"
                    class="catalog-copy-chip"
                    :class="{ 'is-copied': copiedToken === `url:${env.id}` }"
                    @click="copyQuickValue(env.url, `url:${env.id}`, '环境地址')"
                  >
                    <Check v-if="copiedToken === `url:${env.id}`" :size="12" />
                    <Copy v-else :size="12" />
                    <span>{{ copiedToken === `url:${env.id}` ? '已复制' : '复制地址' }}</span>
                  </button>
                  <el-button text size="small" :aria-label="`${system.name} ${env.name}账号`" @click="openAccounts(system, env)"><KeyRound :size="13" />{{ env.accounts.length ? `${env.accounts.length} 个账号` : '未收录' }}</el-button>
                  <a v-if="env.url" class="visit-system" :href="systemWebUrl(env.url)" target="_blank" rel="noopener noreferrer" :aria-label="`访问 ${system.name} ${env.name}`">访问<ArrowUpRight :size="13" /></a>
                </div>
              </div>
            </div>
            <footer class="system-card-footer">
              <a v-if="system.source.url" :href="systemWebUrl(system.source.url)" target="_blank" rel="noopener noreferrer">{{ system.source.title }}<template v-if="system.source.version"> · v{{ system.source.version }}</template></a>
              <span v-else>{{ system.source.title }}</span>
              <span>{{ matches(system).length ? `${matches(system).length} 个本地工作区` : '尚未关联本地工作区' }}</span>
            </footer>
          </article>
        </el-tab-pane>
      </el-tabs>
    </div>
    <footer class="catalog-sources"><span>同步于 {{ dateTime(query.data.value?.syncedAt) }}</span><a v-for="source in query.data.value?.sources" :key="source.id" :href="systemWebUrl(source.url)" target="_blank" rel="noopener noreferrer">{{ source.title }}</a></footer>

    <el-drawer v-if="detailsOpen" v-model="detailsOpen" :title="selected?.name || '系统详情'" size="min(840px, 96vw)" class="system-detail-drawer" append-to-body destroy-on-close>
      <div v-if="selected" class="system-details">
        <section><h3>代码仓库</h3><a v-if="selected.repository" class="repository-link" :href="systemWebUrl(selected.repository)" target="_blank" rel="noopener noreferrer"><FolderGit2 :size="17" />{{ selected.repository }}<ArrowUpRight :size="15" /></a><p v-else class="muted">资料中未提供代码仓库</p></section>
        <section><h3>本地 Git</h3><el-skeleton v-if="projects.isPending.value" :rows="3" animated /><template v-else-if="selectedWorkspaces.length"><el-select v-model="activePath" :placeholder="activeWorkspace?.displayPath" class="workspace-select" aria-label="选择本地工作区"><el-option v-for="project in selectedWorkspaces" :key="project.path" :value="project.path" :label="`${project.branch} · ${project.displayPath}`" /></el-select><div v-if="activeWorkspace" class="workspace-summary"><span><GitBranch :size="15" />当前分支 <strong>{{ activeWorkspace.branch }}</strong></span><span>{{ activeWorkspace.clean ? '工作区干净' : `${activeWorkspace.changed} 处本地改动` }}</span></div><el-button v-if="activeWorkspace" type="primary" @click="openGit(activeWorkspace)"><FolderGit2 :size="15" />提交 / 合并 · 打开 Git 管理</el-button></template><template v-else><p class="muted">{{ projects.error.value ? '本地项目暂未读取成功，可到项目页面重新读取。' : '尚未找到相同仓库的本地工作区。' }}</p><el-button @click="router.push({ path: '/agent', query: { view: 'projects', q: selected.repository ? repositoryName(selected.repository) : selected.name } })">到本地项目添加或克隆</el-button></template></section>
        <section><h3>环境与发布信息</h3><article v-for="env in selected.environments" :key="env.id" class="detail-environment"><header><strong>{{ env.name }}</strong><span v-if="env.branch"><GitBranch :size="13" />{{ env.branch }}</span><el-button text @click="openAccounts(selected, env)"><KeyRound :size="14" />环境账号</el-button></header><dl><template v-if="env.url"><dt>访问地址</dt><dd><a :href="systemWebUrl(env.url)" target="_blank" rel="noopener noreferrer">{{ env.url }}</a></dd></template><template v-if="discrepancy(env)"><dt>原文链接目标</dt><dd><a :href="systemWebUrl(env.sourceHref)" target="_blank" rel="noopener noreferrer">{{ env.sourceHref }}</a><p class="muted">原文显示地址与链接目标不一致，待资料维护者确认。</p></dd></template><template v-if="env.pipeline && env.pipeline !== '-'"><dt>流水线</dt><dd>{{ env.pipeline }}</dd></template><template v-if="env.notes"><dt>备注</dt><dd>{{ env.notes }}</dd></template></dl></article></section>
        <p class="detail-source">来源：<a v-if="selected.source.url" :href="systemWebUrl(selected.source.url)" target="_blank" rel="noopener noreferrer">{{ selected.source.title }}<template v-if="selected.source.version"> · v{{ selected.source.version }}</template></a><span v-else>{{ selected.source.title }}</span></p>
      </div>
    </el-drawer>

    <el-dialog v-if="accountsOpen" v-model="accountsOpen" :title="`环境账号 · ${accountTarget?.system || ''} · ${accountTarget?.environment.name || ''}`" width="min(720px, 95vw)" :close-on-click-modal="false" :close-on-press-escape="!saving" :show-close="!saving" destroy-on-close class="system-accounts-dialog" @close="clearAccounts">
      <p class="account-storage-note">当前仅展示文档和本机已收录账号。Chrome 保存的账号可从页面顶部导入。</p>
      <div class="system-account-editor"><a v-if="accountTarget?.environment.url" :href="systemWebUrl(accountTarget.environment.url)" target="_blank" rel="noopener noreferrer">{{ accountTarget.environment.url }}<ArrowUpRight :size="14" /></a><el-skeleton v-if="accountsLoading" :rows="4" animated /><template v-else><el-empty v-if="!drafts.length" description="暂未收录该环境账号，可在本机补充" :image-size="70" /><article v-for="(account, index) in drafts" :key="account.id" class="account-entry"><header><strong>账号 {{ index + 1 }}</strong><a v-if="account.sourceUrl" :href="systemWebUrl(account.sourceUrl)" target="_blank" rel="noopener noreferrer">查看资料来源</a><span v-else class="muted">本机保存</span><el-button text :disabled="saving" :aria-label="`移除账号 ${index + 1}`" @click="drafts.splice(index, 1)"><X :size="15" /></el-button></header><label :for="`system-username-${index}`">账号</label><div class="account-input"><el-input :id="`system-username-${index}`" v-model="account.username" type="password" show-password autocomplete="off" :disabled="saving" placeholder="填写账号" /><el-button :disabled="!account.username" :aria-label="`复制账号 ${index + 1}`" @click="copy(account.username)"><Copy :size="14" /></el-button></div><label :for="`system-password-${index}`">密码</label><div class="account-input"><el-input :id="`system-password-${index}`" v-model="account.password" type="password" show-password autocomplete="new-password" :disabled="saving" placeholder="未收录密码" /><el-button :disabled="!account.password" :aria-label="`复制密码 ${index + 1}`" @click="copy(account.password)"><Copy :size="14" /></el-button></div></article><el-button :disabled="saving || drafts.length >= 20" @click="addAccount"><Plus :size="14" />添加账号</el-button></template><p class="account-storage-note">账号密码默认隐藏；补充内容仅保存到当前本机工作台。</p></div>
      <template #footer><el-button :disabled="saving" @click="accountsOpen = false">关闭</el-button><el-button type="primary" :loading="saving" :disabled="accountsLoading || saving || !accountRevision" @click="saveAccounts">保存到本机</el-button></template>
    </el-dialog>
    <BrowserAccountImport v-if="browserImportOpen" v-model="browserImportOpen" :systems="systems" @imported="catalog => client.setQueryData(['system-catalog'], catalog)" />
    <SystemProjectDialog v-if="projectDialog" :mode="projectDialog" @close="projectDialog = null" @saved="projectSaved" />
  </section>
</template>

<style scoped>
:global(.system-detail-drawer.el-drawer) {
  color: var(--ui-text);
  background: var(--ui-bg);
}

.system-catalog {
  --catalog-gap: var(--tile-gap, 16px);
  --catalog-pad: var(--tile-pad, 16px);
  --catalog-card-pad: clamp(12px, 1.3vw, 18px);
  --catalog-border: var(--tile-edge, var(--ui-border));
  --catalog-radius: var(--ds-radius-lg, 14px);
  --catalog-control: var(--ds-control-height, 34px);
  min-width: 0;
  color: var(--ui-text);
}

.system-catalog .catalog-heading {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(260px, auto);
  align-items: center;
  gap: 10px 20px;
  margin: 0 0 var(--catalog-gap);
  padding: 11px var(--catalog-pad);
  border: 1px solid var(--catalog-border);
  border-radius: var(--ds-radius, 8px);
  background: var(--ui-surface);
  box-shadow: var(--tile-shadow, none);
}
.catalog-heading h1 { margin: 2px 0 4px; font-size: 16px; font-weight: 600; letter-spacing: -.015em; }
.catalog-eyebrow { color: var(--ui-muted); font: 600 10.5px/1.3 var(--mono); letter-spacing: .06em; }
.catalog-heading p { margin: 3px 0 0; color: var(--ui-secondary); font-size: 12.5px; line-height: 1.55; }
.catalog-counts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); min-width: 0; margin: 0; }
.catalog-counts > div { display: grid; gap: 2px; min-width: 0; padding-inline: 12px; border-inline-start: 1px solid var(--ui-divider); }
.catalog-counts > div:last-child { padding-inline-end: 0; }
.catalog-counts dt { grid-row: 2; color: var(--ui-muted); font-size: 11px; line-height: 1.4; }
.catalog-counts dd { grid-row: 1; margin: 0; font: 600 21px/1.2 var(--sans); font-variant-numeric: tabular-nums; }

.catalog-board {
  min-width: 0;
  border: 1px solid var(--catalog-border);
  border-radius: var(--catalog-radius);
  background: var(--ui-surface);
  box-shadow: var(--tile-shadow, none);
}
.system-catalog .catalog-filters {
  display: grid;
  grid-template-columns: minmax(0, 360px) minmax(128px, 168px) minmax(max-content, 1fr);
  align-items: center;
  gap: 10px;
  margin: 0;
  padding: 14px var(--catalog-card-pad) 10px;
}
.catalog-filters > :is(.el-input, .el-select) { width: 100%; min-width: 0; }
.catalog-kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border: 1px solid var(--ui-border);
  border-radius: 4px;
  background: var(--ui-raised);
  color: var(--ui-muted);
  font: 500 10.5px/1 var(--mono);
}
.catalog-project-actions { display: flex; align-items: center; justify-content: end; flex-wrap: wrap; gap: 8px; }
.catalog-project-actions :deep(.el-button) { margin: 0; }
.catalog-project-actions :deep(.el-button span) { display: flex; align-items: center; gap: 4px; }

.catalog-layout-switch {
  display: inline-flex;
  padding: 2px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius-xs, 6px);
  background: var(--ui-raised);
}
.catalog-layout-switch > button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 9px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--ui-secondary);
  font-size: 11.5px;
  cursor: pointer;
}
.catalog-layout-switch > button.is-active {
  background: var(--ui-surface);
  color: var(--ui-accent);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06);
}

.catalog-env-pills {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 var(--catalog-card-pad) 12px;
  border-bottom: 1px solid var(--ui-divider);
}
.catalog-env-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 9px;
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  background: var(--ui-raised);
  color: var(--ui-secondary);
  font-size: 11.5px;
  cursor: pointer;
}
.catalog-env-pill:hover {
  border-color: color-mix(in srgb, var(--ui-accent) 42%, var(--ui-border));
  color: var(--ui-text);
}
.catalog-env-pill.is-active {
  border-color: color-mix(in srgb, var(--ui-accent) 48%, transparent);
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
  font-weight: 600;
}
.catalog-env-pill b {
  font: 600 10.5px/1 var(--mono);
  font-variant-numeric: tabular-nums;
}
.catalog-tier-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ui-muted);
}
.catalog-tier-dot[data-tier='prod'] { background: #ef4444; }
.catalog-tier-dot[data-tier='stage'] { background: #8b5cf6; }
.catalog-tier-dot[data-tier='test'] { background: #10b981; }
.catalog-tier-dot[data-tier='dev'] { background: #3b82f6; }

/* Homepage / Backstage Matrix Grid */
.catalog-matrix-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(500px, 100%), 1fr));
  gap: 14px;
  padding: 14px var(--catalog-card-pad);
}
.catalog-matrix-card {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius-sm, 10px);
  background: var(--ui-surface);
  overflow: hidden;
  transition: border-color .15s ease;
}
.catalog-matrix-card:hover {
  border-color: color-mix(in srgb, var(--ui-accent) 36%, var(--ui-border));
}
.catalog-matrix-card.is-pinned {
  border-color: color-mix(in srgb, var(--ui-accent) 45%, var(--ui-border));
  box-shadow: inset 0 2px 0 var(--ui-accent);
}
.catalog-matrix-card .system-environments {
  flex: 1;
}

.catalog-board .catalog-tabs :deep(.el-tabs__header) {
  margin: 0;
  padding: 8px var(--catalog-card-pad) 10px;
  border-bottom: 1px solid var(--ui-divider);
}
.catalog-tabs :deep(.el-tabs__nav) { gap: 4px; }
.catalog-tabs :deep(.el-tabs__nav-wrap::after), .catalog-tabs :deep(.el-tabs__active-bar) { display: none; }
.catalog-board .catalog-tabs :deep(.el-tabs__item) {
  height: 34px;
  padding-inline: 12px;
  border-radius: var(--ds-radius-sm, 8px);
  color: var(--ui-secondary);
  font-size: 13px;
  white-space: nowrap;
}
.catalog-tabs :deep(.el-tabs__item:hover) { background: var(--ui-hover); color: var(--ui-text); }
.catalog-tabs :deep(.el-tabs__item.is-active) { background: var(--ui-accent-soft); color: var(--ui-accent); font-weight: 650; }
.catalog-tabs :deep(.el-tabs__item:focus-visible) { outline: 2px solid var(--ui-accent); outline-offset: -2px; }
.catalog-system { container: catalog-system / inline-size; }

.system-card-heading { display: flex; align-items: center; gap: 12px; padding: 14px var(--catalog-card-pad); }
.system-symbol { display: grid; place-items: center; flex-shrink: 0; width: 38px; height: 38px; border-radius: var(--ds-radius-sm, 8px); background: var(--ui-accent-soft); color: var(--ui-accent); }
.system-card-title { flex: 1; min-width: 0; }
.system-title-row { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.system-card-heading h2 { margin: 0; font-size: 15.5px; line-height: 1.4; }
.system-pinned-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
  font: 600 10px/1.4 var(--sans);
}
.system-title {
  max-width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ui-text);
  font: inherit;
  font-weight: 650;
  text-align: start;
  overflow-wrap: anywhere;
  cursor: pointer;
}
.system-title:hover { color: var(--ui-accent); text-decoration: underline; }
.system-repository { display: block; margin-top: 2px; color: var(--ui-secondary); font-size: 11.5px; line-height: 1.5; overflow-wrap: anywhere; }
.system-repository i { padding-inline: 5px; font-style: normal; }
.system-ws-count { font-weight: 500; color: var(--ui-accent); }

.catalog-pin-btn {
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  background: var(--ui-surface);
  color: var(--ui-muted);
  cursor: pointer;
}
.catalog-pin-btn:hover,
.catalog-pin-btn.is-pinned {
  border-color: color-mix(in srgb, #f59e0b 55%, var(--ui-border));
  color: #f59e0b;
  background: color-mix(in srgb, #f59e0b 10%, var(--ui-surface));
}

.system-card-actions { display: flex; align-items: center; flex-wrap: wrap; flex-shrink: 0; gap: 6px; }
.system-card-actions :deep(.el-button) { margin: 0; }
.system-card-actions :deep(.el-button > span) { display: flex; align-items: center; gap: 5px; }
.system-card-actions :deep(.remove-project-btn) { color: var(--ui-secondary); }
.system-card-actions :deep(.remove-project-btn:hover:not(:disabled)) {
  border-color: color-mix(in srgb, var(--ui-danger) 42%, var(--ui-border));
  background: var(--ui-danger-bg);
  color: var(--ui-danger);
}

.system-environments { padding: 0 var(--catalog-card-pad); }
.system-environment {
  display: grid;
  grid-template-columns: minmax(150px, 1.1fr) minmax(0, 2.2fr) auto;
  grid-template-areas: 'label address actions';
  align-items: center;
  gap: 6px 12px;
  padding: 9px 0;
  border-top: 1px solid var(--ui-divider);
}
.environment-label { grid-area: label; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; min-width: 0; }
.environment-label strong { font-size: 12.5px; font-weight: 600; overflow-wrap: anywhere; }
.env-tier-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 5px;
  border-radius: 4px;
  font: 700 9.5px/1.35 var(--mono);
  letter-spacing: 0.03em;
  background: var(--ui-raised);
  color: var(--ui-muted);
  border: 1px solid var(--ui-border);
}
.env-tier-badge[data-tier='prod'] {
  color: #ef4444;
  border-color: color-mix(in srgb, #ef4444 35%, var(--ui-border));
  background: color-mix(in srgb, #ef4444 10%, var(--ui-surface));
}
.env-tier-badge[data-tier='stage'] {
  color: #8b5cf6;
  border-color: color-mix(in srgb, #8b5cf6 35%, var(--ui-border));
  background: color-mix(in srgb, #8b5cf6 10%, var(--ui-surface));
}
.env-tier-badge[data-tier='test'] {
  color: #10b981;
  border-color: color-mix(in srgb, #10b981 35%, var(--ui-border));
  background: color-mix(in srgb, #10b981 10%, var(--ui-surface));
}
.env-tier-badge[data-tier='dev'] {
  color: #3b82f6;
  border-color: color-mix(in srgb, #3b82f6 35%, var(--ui-border));
  background: color-mix(in srgb, #3b82f6 10%, var(--ui-surface));
}

.env-branch-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
  padding: 1px 6px;
  border: 1px solid var(--ui-border);
  border-radius: 5px;
  background: var(--ui-raised);
  color: var(--ui-secondary);
  font: 11px/1.4 var(--mono);
  cursor: pointer;
}
.env-branch-chip:hover {
  border-color: var(--ui-accent);
  color: var(--ui-accent);
}
.environment-label svg { flex-shrink: 0; }
.environment-address { grid-area: address; min-width: 0; color: var(--ui-secondary); font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
.environment-address > a { display: block; min-width: 0; color: var(--ui-accent); font: 500 12px/1.4 var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.environment-address > a:hover { text-decoration: underline; }
.env-url-full { display: block; color: var(--ui-muted); font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.environment-address small { display: block; margin-top: 3px; color: var(--ui-secondary); font-size: 11px; }
.environment-address button { padding: 0; border: 0; background: transparent; color: var(--ui-accent); font: inherit; text-decoration: underline; cursor: pointer; }
.environment-actions { grid-area: actions; display: flex; flex-wrap: wrap; align-items: center; justify-content: end; gap: 6px; }
.environment-actions :deep(.el-button) { min-height: 28px; margin: 0; padding: 3px 6px; color: var(--ui-secondary); font-size: 11.5px; }
.environment-actions :deep(.el-button span) { display: flex; align-items: center; gap: 4px; }

.catalog-copy-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 26px;
  padding: 0 7px;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  background: var(--ui-surface);
  color: var(--ui-secondary);
  font-size: 11.5px;
  cursor: pointer;
}
.catalog-copy-chip:hover {
  border-color: var(--ui-accent);
  color: var(--ui-accent);
}
.catalog-copy-chip.is-copied {
  border-color: #10b981;
  color: #10b981;
}

.visit-system {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  background: var(--ui-surface);
  color: var(--ui-text);
  font-size: 11.5px;
  text-decoration: none;
  white-space: nowrap;
}
.visit-system:hover { border-color: var(--ui-accent); background: var(--ui-hover); color: var(--ui-accent); }

.system-catalog .system-card-footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 5px 12px;
  padding: 8px var(--catalog-card-pad);
  border-top: 1px solid var(--ui-divider);
  background: var(--ui-raised);
  color: var(--ui-secondary);
  font-size: 11.5px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.system-card-footer a:hover, .catalog-sources a:hover { color: var(--ui-accent); text-decoration: underline; }
.catalog-sources { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 14px; color: var(--ui-secondary); font-size: 12px; overflow-wrap: anywhere; }
.catalog-loading { padding: var(--catalog-pad); }
.system-catalog .catalog-empty { padding-block: 26px; }

:root[data-theme='acid'] .catalog-env-pill,
:root[data-theme='acid'] .catalog-layout-switch,
:root[data-theme='acid'] .catalog-layout-switch > button,
:root[data-theme='acid'] .catalog-matrix-card,
:root[data-theme='acid'] .catalog-pin-btn,
:root[data-theme='acid'] .env-tier-badge,
:root[data-theme='acid'] .env-branch-chip,
:root[data-theme='acid'] .catalog-copy-chip,
:root[data-theme='acid'] .visit-system,
:root[data-theme='acid'] .catalog-kbd {
  border-radius: 0 !important;
}

@container workspace-page (max-width: 780px) {
  .system-catalog .catalog-filters { grid-template-columns: minmax(0, 1fr); }
  .catalog-project-actions { justify-content: start; }
}

@container workspace-page (max-width: 640px) {
  .system-catalog .catalog-heading { grid-template-columns: minmax(0, 1fr); gap: 10px; padding-block: 12px; }
  .catalog-counts { padding-top: 9px; border-top: 1px solid var(--ui-divider); }
  .catalog-counts > div:first-child { padding-inline-start: 0; border-inline-start: 0; }
  .catalog-counts > div { padding-inline: 9px; }
  .catalog-counts dd { font-size: 21px; }
}

@container catalog-system (max-width: 620px) {
  .system-environment { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: 'label actions' 'address actions'; }
}

@container catalog-system (max-width: 440px) {
  .system-card-heading { flex-wrap: wrap; }
  .system-card-title { flex-basis: calc(100% - 52px); }
  .system-environment { grid-template-columns: minmax(0, 1fr); grid-template-areas: 'label' 'address' 'actions'; }
  .environment-actions { justify-content: start; }
  .environment-address > a { overflow: visible; white-space: normal; overflow-wrap: anywhere; }
}

.muted{color:var(--ui-muted)}.system-details{display:flex;flex-direction:column;gap:26px;font-size:13px;color:var(--ui-text)}.system-details h3{margin:0 0 14px;font-size:14px;font-weight:600}.system-details a{color:var(--el-color-primary);overflow-wrap:anywhere}.repository-link{display:flex;align-items:flex-start;gap:7px;line-height:1.8}.repository-link svg{flex-shrink:0;margin-top:3px}.workspace-select{width:100%}.workspace-summary{display:flex;flex-wrap:wrap;gap:10px 20px;margin:14px 0 18px;color:var(--ui-muted);font-size:12px}.workspace-summary span{display:inline-flex;align-items:center;gap:6px}.workspace-summary strong{color:var(--ui-text)}.system-details :deep(.el-button span){display:inline-flex;align-items:center;gap:6px}.detail-environment{padding:16px;border:1px solid var(--ui-border);border-radius:9px;margin-bottom:12px}.detail-environment header{display:flex;align-items:center;gap:13px}.detail-environment header>span{display:flex;gap:4px;align-items:center;color:var(--ui-muted);font-size:12px}.detail-environment header>.el-button{margin-left:auto}.detail-environment dl{display:grid;grid-template-columns:90px minmax(0,1fr);gap:12px;margin:14px 0 0;font-size:12px;line-height:1.7}.detail-environment dt{color:var(--ui-muted)}.detail-environment dd{margin:0;overflow-wrap:anywhere;white-space:pre-line}.detail-environment dd p{margin:6px 0 0}.detail-source{color:var(--ui-muted);font-size:11px}
.system-account-editor{font-size:13px;color:var(--ui-text)}.system-account-editor>a{display:inline-flex;gap:5px;align-items:center;max-width:100%;overflow-wrap:anywhere;color:var(--el-color-primary);margin-bottom:16px}.account-entry{border:1px solid var(--ui-border);padding:15px 16px;border-radius:9px;margin-bottom:14px}.account-entry header{display:flex;align-items:center;gap:10px;margin-bottom:12px}.account-entry header>a,.account-entry header>span{font-size:11px;margin-left:auto}.account-entry header>a{color:var(--el-color-primary)}.account-entry header>.el-button{padding:2px;height:24px;margin:0}.account-entry label{display:block;font-size:12px;margin-bottom:6px}.account-input{display:flex;gap:8px;margin-bottom:12px}.account-input:last-child{margin-bottom:0}.account-input>.el-button{margin-left:0}.account-storage-note{margin:18px 0 0;font-size:11px;color:var(--ui-muted)}.system-account-editor>.el-button :deep(span){display:flex;align-items:center;gap:5px}
@media (max-width: 650px) {
  .detail-environment { padding: 12px; }
  .detail-environment dl { grid-template-columns: 1fr; gap: 5px; }
  .detail-environment dt { margin-top: 6px; }
  .detail-environment header { flex-wrap: wrap; gap: 8px; }
  .account-entry { padding: 12px; }
}
</style>
