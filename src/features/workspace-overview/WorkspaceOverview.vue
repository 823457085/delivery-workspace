<script setup lang="ts">
/** 总览汇总 Jira 任务、本地项目与 Git、以及 AI 自动交付队列状态（借鉴 Glance / Backstage / Linear 指挥舱范式）。 */
import { computed, defineAsyncComponent, inject, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import type { InputInstance } from 'element-plus';
import { ElMessage } from 'element-plus';
import { agentWorkspaceContext } from '../../shared/agent-workspace-context';
import { ArrowUpRight, CalendarDays, Check, ChevronRight, Clock3, Copy, FolderGit2, GitBranch, Search, Settings2, Sparkles, Terminal } from '@lucide/vue';
import type { AutomationData, IssueResponse, JiraIssue, LocalProject, ProjectsData } from '../../../shared/hub';
import { useSource } from '../../shared/api';
import { isDone, dateTime } from '../../shared/format';
import { jiraQuickPrompt } from '../agent-workbench/agent-quick-actions';
import { suggestIssueBranchName } from '../task-calendar/task-triage-studio';
import PageHeading from '../../shared/ui/PageHeading.vue';
import MetricStrip from '../../shared/ui/MetricStrip.vue';
import StatusPill from '../../shared/ui/StatusPill.vue';
import { useHolyGrailAside } from '../../shared/ui/useHolyGrailAside';

const JiraIssueDrawer = defineAsyncComponent(() => import('../jira-issue/JiraIssueDrawer.vue'));

const automation = useSource<AutomationData>('automation');
const workspace = inject(agentWorkspaceContext, undefined);
const hgAsideActive = useHolyGrailAside(Boolean(workspace));
const issues = useSource<IssueResponse>('issues', { allTime: 'true', includeSubtasks: 'true', includeDone: 'false', maxResults: '200' });
const projects = useSource<ProjectsData>('projects');

const overviewQuery = ref('');
const searchInputRef = ref<InputInstance>();
const drawerOpen = shallowRef(false);
const selectedIssue = shallowRef<JiraIssue>();
const copiedToken = shallowRef('');
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

const dirtyProjects = computed(() => (projects.data.value?.projects || []).filter(item => !item.clean));
function sourceLabel(source?: string) {
  if (source === 'jira') return '实时同步';
  if (source === 'cache') return '本地缓存';
  if (source === 'mock') return '演示数据';
  return source || '读取中';
}
const unfinishedIssueCount = computed(() => issues.data.value?.issues.filter((item) => !isDone(item)).length);
const metrics = computed(() => [
  { label: '待办 Jira 任务', value: unfinishedIssueCount.value, note: issues.data.value ? `${sourceLabel(issues.data.value.source)}` : '正在连接 Jira', tone: 'primary' as const },
  { label: '本地项目工作区', value: projects.data.value?.projects.length, note: projects.data.value ? `存在未提交改动 ${dirtyProjects.value.length} 个` : '扫描本地目录中' },
  { label: '自动交付队列', value: automation.data.value?.jobs.length, note: automation.data.value?.settings.enabled ? '定时巡检已启用' : '定时巡检已暂停', tone: automation.data.value && !automation.data.value.settings.enabled ? ('warning' as const) : undefined },
  { label: '已巡检执行记录', value: automation.data.value?.runs.length, note: `下次巡检：${dateTime(automation.data.value?.nextRun)}`, tone: 'success' as const },
]);

const needle = computed(() => overviewQuery.value.trim().toLowerCase());

const recentJobs = computed(() => {
  const list = automation.data.value?.jobs || [];
  const filtered = needle.value
    ? list.filter(item => `${item.issueKey} ${item.title || ''} ${item.branch || ''} ${item.status || ''}`.toLowerCase().includes(needle.value))
    : list;
  return filtered.slice(0, 6);
});

const prioritizedProjects = computed(() => {
  const list = [...(projects.data.value?.projects || [])].sort((a, b) => {
    if (a.clean !== b.clean) return a.clean ? 1 : -1;
    if (b.changed !== a.changed) return b.changed - a.changed;
    return (a.displayName || a.projectName).localeCompare(b.displayName || b.projectName, 'zh-CN');
  });
  const filtered = needle.value
    ? list.filter(p => `${p.displayName} ${p.projectName} ${p.branch} ${p.displayPath}`.toLowerCase().includes(needle.value))
    : list;
  return filtered.slice(0, 6);
});

const recentIssues = computed(() => {
  const list = issues.data.value?.issues || [];
  const filtered = needle.value
    ? list.filter(row => `${row.key} ${row.summary} ${row.projectName} ${row.status}`.toLowerCase().includes(needle.value))
    : list;
  return filtered.slice(0, 6);
});

const queries = [automation, issues, projects];
const errors = computed(() => queries.filter((query) => query.error.value).map((query) => query.error.value?.message));
const refresh = () => Promise.all(queries.map((query) => query.refetch()));
const shortcuts = computed(() => [
  { title: '本地项目与 Git', description: '选文件夹、代码浏览、分支与提交推送', value: projects.data.value?.projects.length, path: '/projects', icon: FolderGit2 },
  { title: '任务日历', description: 'Jira 日历、列表与统计', value: unfinishedIssueCount.value, path: '/tasks/calendar', icon: CalendarDays },
  { title: '执行队列', description: 'Jira 需求/缺陷自动派发与执行记录', value: automation.data.value?.jobs.length, path: '/delivery/queue', icon: Terminal },
  { title: '交付与连接设置', description: '配置 Jira、CLI 模型、思考强度与自动策略', value: automation.data.value?.settings.enabled ? '已开启' : '已关闭', path: '/settings', icon: Settings2 },
]);

function inspectIssue(issue: JiraIssue) {
  selectedIssue.value = issue;
  drawerOpen.value = true;
}
function inspectIssueByKey(key: string) {
  const found = issues.data.value?.issues.find(item => item.key === key);
  selectedIssue.value = found || ({ key, url: '', summary: key } as JiraIssue);
  drawerOpen.value = true;
}
function composeForProject(proj: LocalProject) {
  workspace?.compose(
    `请检查本地工作区「${proj.displayName || proj.projectName}」（分支 \`${proj.branch}\`）当前的改动状态并协助推进开发。`,
    proj.path,
  );
}
async function copyQuick(value: string, tokenKey: string, label: string) {
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

function onOverviewKeydown(event: KeyboardEvent) {
  if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target as HTMLElement | null;
  if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return;
  if (document.querySelector('.el-dialog, .el-drawer, .cmd-palette-backdrop')) return;
  event.preventDefault();
  searchInputRef.value?.focus();
}
onMounted(() => document.addEventListener('keydown', onOverviewKeydown));
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onOverviewKeydown);
  if (copiedTimer) clearTimeout(copiedTimer);
});
</script>
<template>
  <PageHeading title="工作总览" description="把本地项目 Git 管理、Jira 任务、AI 编码和自动交付放在一个工作空间里。" :loading="queries.some((query) => query.isFetching.value)" @refresh="refresh" />
  <el-alert
    v-for="error in errors"
    :key="error"
    class="section-alert"
    :title="error?.includes('未配置鉴权') ? 'Jira 尚未配置连接凭据，请前往「交付与连接设置」填写 Jira 地址与 API Token' : error"
    :type="error?.includes('未配置鉴权') ? 'info' : 'error'"
    :closable="false"
    show-icon
  />
  <MetricStrip :items="metrics" />

  <!-- Glance / Backstage Instant Command Pulse Bar -->
  <div class="overview-pulse-bar surface">
    <div class="overview-pulse-search">
      <el-input
        ref="searchInputRef"
        v-model="overviewQuery"
        clearable
        placeholder="跨模块秒筛：队列任务、本地工作树、Jira 单号或分支…"
        aria-label="跨模块筛选工作总览"
        @keydown.esc="overviewQuery = ''"
      >
        <template #prefix><Search :size="14" /></template>
        <template v-if="!overviewQuery" #suffix><kbd class="overview-kbd">/</kbd></template>
      </el-input>
    </div>
    <div class="overview-pulse-chips">
      <RouterLink to="/projects" class="overview-pulse-chip" :class="{ 'is-alert': dirtyProjects.length > 0 }">
        <FolderGit2 :size="13" />
        <span>未提交工作区 <b>{{ dirtyProjects.length }}</b></span>
      </RouterLink>
      <RouterLink to="/tasks/list" class="overview-pulse-chip">
        <CalendarDays :size="13" />
        <span>待办 Jira <b>{{ unfinishedIssueCount ?? 0 }}</b></span>
      </RouterLink>
      <RouterLink to="/delivery/queue" class="overview-pulse-chip">
        <Terminal :size="13" />
        <span>交付队列 <b>{{ automation.data.value?.jobs.length ?? 0 }}</b></span>
      </RouterLink>
    </div>
  </div>

  <div v-if="!workspace" class="quick-entry-grid"><RouterLink v-for="item in shortcuts" :key="item.path" :to="item.path" class="surface"><span class="entry-icon"><component :is="item.icon" :size="20" /></span><div><strong>{{ item.title }}</strong><small>{{ item.description }}</small></div><span class="entry-count">{{ item.value ?? '—' }}</span><ArrowUpRight :size="15" /></RouterLink></div>

  <div class="overview-bento-trio" :class="{ 'is-hg-stage': hgAsideActive }">
    <section class="surface attention-panel">
      <div class="surface-header"><div><h2>自动交付任务队列 <span>{{ recentJobs.length }}</span></h2><p>Jira 任务自动派发与状态流转</p></div><RouterLink to="/delivery/queue" class="hub-link">查看队列 <ChevronRight :size="13" /></RouterLink></div>
      <div v-if="automation.isPending.value" class="surface-body"><el-skeleton :rows="4" animated /></div>
      <div v-else class="attention-list">
        <RouterLink v-for="item in recentJobs" :key="item.id" to="/delivery/queue">
          <span class="attention-icon"><Clock3 :size="16" /></span>
          <div>
            <strong>{{ item.title || item.issueKey }}</strong>
            <small>{{ item.issueKey }} · {{ item.branch || '待分配分支' }} · {{ item.categoryLabel || item.status }}</small>
          </div>
          <StatusPill :value="item.status" />
          <ChevronRight :size="14" />
        </RouterLink>
        <el-empty v-if="!recentJobs.length" :description="needle ? '没有匹配的队列任务' : '当前队列暂无自动交付任务'" :image-size="48" />
      </div>
    </section>

    <section class="surface">
      <div class="surface-header"><div><h2>本地项目与改动（脏工作区优先）</h2><p>优先聚焦未提交工作树，一键复制分支或带入 AI</p></div><RouterLink to="/projects" class="hub-link">管理项目 <ChevronRight :size="13" /></RouterLink></div>
      <div class="attention-list">
        <div v-for="proj in prioritizedProjects" :key="proj.path" class="overview-project-row">
          <RouterLink :to="{ path: '/agent', query: { view: 'projects', workspace: proj.path, git: '1' } }" class="overview-project-main">
            <span class="attention-icon"><FolderGit2 :size="16" /></span>
            <div class="overview-project-copy">
              <strong>{{ proj.displayName || proj.projectName }}</strong>
              <small>
                <span class="overview-mono-branch">{{ proj.branch }}</span>
                <span v-if="proj.ahead" class="overview-sync-up">↑{{ proj.ahead }}</span>
                <span v-if="proj.behind" class="overview-sync-down">↓{{ proj.behind }}</span>
                <span>· {{ proj.displayPath }}</span>
              </small>
            </div>
          </RouterLink>
          <div class="overview-row-actions">
            <button
              type="button"
              class="overview-micro-btn"
              :class="{ 'is-copied': copiedToken === `proj:${proj.path}` }"
              :title="`复制分支 ${proj.branch}`"
              @click="copyQuick(proj.branch, `proj:${proj.path}`, `分支 ${proj.branch}`)"
            >
              <Check v-if="copiedToken === `proj:${proj.path}`" :size="11" /><GitBranch v-else :size="11" />
            </button>
            <button v-if="workspace" type="button" class="overview-micro-btn is-ai" title="将该工作区带入 AI 会话" @click="composeForProject(proj)">
              <Sparkles :size="11" /><span>AI</span>
            </button>
            <StatusPill :value="proj.clean ? 'completed' : 'warning'" :label="proj.clean ? '干净' : `${proj.changed} 项改动`" />
          </div>
        </div>
        <el-empty v-if="!prioritizedProjects.length" :description="needle ? '没有匹配的本地工作区' : '暂未扫描到项目'" :image-size="48" />
      </div>
    </section>

    <Teleport defer to="#hg-aside-slot" :disabled="!hgAsideActive">
      <div class="overview-aside-stack" :class="{ 'is-teleported': hgAsideActive }">
        <section class="surface overview-status-card"><div class="surface-header"><div><h2>运行与连接策略</h2><p>自动化开关与扫描引擎状态</p></div></div><div class="source-statuses"><div><span>Jira 自动巡检</span><b>{{ automation.data.value?.settings.enabled ? '已启用' : automation.data.value ? '已暂停' : '读取中' }}</b></div><div><span>自动创建 AI 任务</span><b>{{ automation.data.value?.settings.autoCreateCodex ? '开启' : '关闭' }}</b></div><div><span>自动推进 Jira 状态</span><b>{{ automation.data.value?.settings.autoTransitionJira ? '开启' : '关闭' }}</b></div><div><span>自动创建合并请求</span><b>{{ automation.data.value?.settings.autoCreateMergeRequest ? '开启' : '关闭' }}</b></div><div><span>本地工作区扫描</span><b>{{ projects.data.value ? `${projects.data.value.projects.length} 个工作区` : projects.error.value ? '读取失败' : '扫描中' }}</b></div><RouterLink to="/settings" class="hub-link">配置连接与自动交付策略 <ArrowUpRight :size="13" /></RouterLink></div></section>
        <section v-if="hgAsideActive" class="surface overview-aside-shortcuts">
          <div class="surface-header"><div><h2>空间快捷导航</h2><p>高频模块直达</p></div></div>
          <nav class="overview-mini-links">
            <RouterLink v-for="item in shortcuts" :key="item.path" :to="item.path">
              <span class="entry-icon"><component :is="item.icon" :size="15" /></span>
              <div><strong>{{ item.title }}</strong><small>{{ item.description }}</small></div>
              <b class="entry-count">{{ item.value ?? '—' }}</b>
            </RouterLink>
          </nav>
        </section>
      </div>
    </Teleport>
  </div>

  <section class="surface overview-jira-ledger">
    <div class="surface-header"><div><h2>最近更新的待办任务</h2><p>数据状态：{{ sourceLabel(issues.data.value?.source) }} · 点击单号就地展开详情抽屉</p></div><RouterLink to="/tasks/list" class="hub-link">全部任务 <ChevronRight :size="13" /></RouterLink></div>
    <el-table :data="recentIssues">
      <el-table-column label="任务" min-width="300">
        <template #default="{ row }">
          <div class="overview-issue-cell">
            <div class="overview-issue-head">
              <button type="button" class="overview-key-pill" @click="inspectIssue(row)">{{ row.key }}</button>
              <span class="row-secondary">{{ row.projectName }}</span>
            </div>
            <button type="button" class="overview-issue-title" @click="inspectIssue(row)">{{ row.summary }}</button>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="快捷操作" width="160">
        <template #default="{ row }">
          <div class="overview-row-actions">
            <button
              type="button"
              class="overview-micro-btn"
              :class="{ 'is-copied': copiedToken === `issue:${row.key}` }"
              :title="`复制推荐分支名 ${suggestIssueBranchName(row.key, row.issueType)}`"
              @click="copyQuick(suggestIssueBranchName(row.key, row.issueType), `issue:${row.key}`, '推荐分支')"
            >
              <Check v-if="copiedToken === `issue:${row.key}`" :size="11" /><Copy v-else :size="11" /><span>分支</span>
            </button>
            <button
              v-if="workspace"
              type="button"
              class="overview-micro-btn is-ai"
              @click="workspace.compose(jiraQuickPrompt(row))"
            >
              <Sparkles :size="11" /><span>AI 处理</span>
            </button>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="120"><template #default="{ row }"><StatusPill :value="row.status" /></template></el-table-column>
      <el-table-column label="更新时间" width="150"><template #default="{ row }"><span class="row-mono">{{ dateTime(row.updated) }}</span></template></el-table-column>
    </el-table>
  </section>

  <JiraIssueDrawer
    v-if="drawerOpen"
    v-model="drawerOpen"
    :issue="selectedIssue"
    :issue-key="selectedIssue?.key"
    @changed="issues.refetch()"
    @inspect="inspectIssueByKey"
  />
</template>
<style scoped>
.overview-pulse-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px 14px;
  padding: 10px 14px;
  margin-bottom: 16px;
}
.overview-pulse-search {
  flex: 1 1 280px;
  max-width: 440px;
}
.overview-kbd {
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
.overview-pulse-chips {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.overview-pulse-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  background: var(--ui-raised);
  color: var(--ui-secondary);
  font-size: 12px;
  text-decoration: none;
  transition: border-color .14s ease, color .14s ease;
}
.overview-pulse-chip:hover {
  border-color: var(--ui-accent);
  color: var(--ui-accent);
}
.overview-pulse-chip.is-alert {
  border-color: color-mix(in srgb, #f59e0b 45%, var(--ui-border));
  color: var(--ui-text);
}
.overview-pulse-chip b {
  font: 600 11.5px/1 var(--mono);
  font-variant-numeric: tabular-nums;
  color: var(--ui-text);
}

.overview-project-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--ui-divider);
}
.overview-project-row:last-child { border-bottom: 0; }
.overview-project-row:hover { background: var(--ui-hover); }

.attention-list > a {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--ui-divider);
  color: var(--ui-text);
  text-decoration: none;
  transition: background .14s ease;
}
.attention-list > a:last-child { border-bottom: 0; }
.attention-list > a:hover { background: var(--ui-hover); }
.attention-list > a > div { min-width: 0; }
.attention-list > a strong {
  display: block;
  font-size: 13px;
  font-weight: 560;
  color: var(--ui-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.attention-list > a small {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  color: var(--ui-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.attention-list > a > svg {
  color: var(--ui-muted);
  flex-shrink: 0;
}
.attention-icon {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius-xs, 6px);
  background: var(--ui-raised);
  color: var(--ui-secondary);
  flex-shrink: 0;
}
:global(:root[data-theme='acid']) .attention-icon {
  border-radius: 0 !important;
}
.overview-project-main {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1;
  text-decoration: none;
  color: inherit;
}
.overview-project-copy { min-width: 0; flex: 1; }
.overview-project-copy strong { display: block; font-size: 13px; color: var(--ui-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.overview-project-copy small { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; margin-top: 2px; font-size: 11px; color: var(--ui-muted); }
.overview-mono-branch { font: 500 11px/1.3 var(--mono); color: var(--ui-secondary); }
.overview-sync-up { font: 600 10.5px/1.2 var(--mono); color: #10b981; }
.overview-sync-down { font: 600 10.5px/1.2 var(--mono); color: #f59e0b; }

.overview-row-actions {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}
.overview-micro-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 23px;
  padding: 0 7px;
  border: 1px solid var(--ui-border);
  border-radius: 5px;
  background: var(--ui-surface);
  color: var(--ui-secondary);
  font-size: 11px;
  cursor: pointer;
}
.overview-micro-btn:hover { border-color: var(--ui-accent); color: var(--ui-accent); }
.overview-micro-btn.is-copied { border-color: #10b981; color: #10b981; }
.overview-micro-btn.is-ai { border-color: color-mix(in srgb, var(--ui-accent) 32%, var(--ui-border)); color: var(--ui-accent); }

.overview-issue-cell { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; }
.overview-issue-head { display: flex; align-items: center; gap: 8px; }
.overview-issue-head .row-secondary { margin: 0; }
.overview-key-pill {
  padding: 1px 6px;
  border: 1px solid color-mix(in srgb, var(--ui-accent) 28%, var(--ui-border));
  border-radius: 5px;
  background: color-mix(in srgb, var(--ui-accent-soft) 55%, var(--ui-surface));
  color: var(--ui-accent);
  font: 600 11px/1.4 var(--mono);
  cursor: pointer;
}
.overview-key-pill:hover { border-color: var(--ui-accent); background: var(--ui-accent-soft); }
.overview-issue-title {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ui-text);
  font: 550 13px/1.45 var(--sans);
  text-align: left;
  cursor: pointer;
}
.overview-issue-title:hover { color: var(--ui-accent); text-decoration: underline; }

:global(:root[data-theme='acid']) .overview-pulse-chip,
:global(:root[data-theme='acid']) .overview-micro-btn,
:global(:root[data-theme='acid']) .overview-key-pill,
:global(:root[data-theme='acid']) .overview-kbd {
  border-radius: 0 !important;
}

.overview-bento-trio {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(0, 1.25fr) minmax(270px, 0.9fr);
  gap: 18px;
  margin-bottom: 18px;
  align-items: stretch;
}
.overview-bento-trio.is-hg-stage {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.overview-bento-trio > .surface,
.overview-aside-stack > .surface {
  margin-bottom: 0 !important;
  display: flex;
  flex-direction: column;
}
.overview-aside-stack {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.overview-aside-stack.is-teleported .surface {
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius);
  background: var(--ui-surface) !important;
  box-shadow: none;
  overflow: hidden;
}
.overview-aside-stack.is-teleported .surface-header {
  padding: 12px 14px;
  border-bottom: 1px solid var(--ui-divider);
}
.overview-aside-stack.is-teleported .surface-header h2 {
  font-size: 13.5px;
  line-height: 19px;
  margin: 0;
}
.overview-aside-stack.is-teleported .surface-header p {
  font-size: 11px;
  color: var(--ui-muted);
  margin: 2px 0 0;
}
.overview-aside-stack.is-teleported .source-statuses {
  padding: 4px 12px 12px;
}
.overview-mini-links {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px 12px;
}
.overview-mini-links > a {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius-xs);
  background: var(--ui-raised);
  text-decoration: none;
}
.overview-mini-links > a:hover {
  border-color: var(--ui-accent);
  background: var(--ui-hover);
}
:global(:root[data-theme='acid'] .overview-mini-links > a:hover) {
  border-color: var(--acid-yellow, #e6ff00);
  box-shadow: 2px 2px 0 var(--acid-violet, #a020f0);
}
.overview-mini-links .entry-icon {
  width: 28px;
  height: 28px;
  border-radius: var(--ds-radius-xs);
}
.overview-mini-links strong {
  display: block;
  font-size: 12px;
  line-height: 1.3;
  color: var(--ui-text);
}
.overview-mini-links small {
  display: block;
  font-size: 10.5px;
  line-height: 1.3;
  color: var(--ui-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.overview-mini-links .entry-count {
  font: 600 12px/1 var(--mono);
  color: var(--ui-text);
  font-variant-numeric: tabular-nums;
}
@media (max-width: 1180px) {
  .overview-bento-trio {
    grid-template-columns: 1fr;
  }
  .overview-bento-trio.is-hg-stage {
    grid-template-columns: 1fr;
  }
}
</style>
