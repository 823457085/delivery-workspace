<script setup lang="ts">
/** 总览汇总 Jira 任务、本地项目与 Git、以及 AI 自动交付队列状态。 */
import { computed, inject } from 'vue';
import { agentWorkspaceContext } from '../../shared/agent-workspace-context';
import { ArrowUpRight, CalendarDays, Terminal, FolderGit2, ChevronRight, Clock3, Settings2 } from '@lucide/vue';
import type { AutomationData, IssueResponse, ProjectsData } from '../../../shared/hub';
import { useSource } from '../../shared/api';
import { isDone, dateTime } from '../../shared/format';
import PageHeading from '../../shared/ui/PageHeading.vue';
import MetricStrip from '../../shared/ui/MetricStrip.vue';
import StatusPill from '../../shared/ui/StatusPill.vue';
const automation = useSource<AutomationData>('automation');
const workspace = inject(agentWorkspaceContext, undefined);
const issues = useSource<IssueResponse>('issues', { allTime: 'true', includeSubtasks: 'true', includeDone: 'true', maxResults: '5000' });
const projects = useSource<ProjectsData>('projects');
const dirtyProjects = computed(() => (projects.data.value?.projects || []).filter(item => !item.clean));
const metrics = computed(() => [
  { label: '我的 Jira 任务', value: issues.data.value?.issues.length, note: issues.data.value ? `未完成 ${issues.data.value.issues.filter((item) => !isDone(item)).length} 项 · ${issues.data.value.source} 来源` : '正在连接 Jira', tone: 'primary' },
  { label: '本地项目工作区', value: projects.data.value?.projects.length, note: projects.data.value ? `存在未提交改动 ${dirtyProjects.value.length} 个` : '扫描本地目录中' },
  { label: '自动交付队列', value: automation.data.value?.jobs.length, note: automation.data.value?.settings.enabled ? '定时巡检已启用' : '定时巡检已暂停', tone: 'warning' },
  { label: '已巡检执行记录', value: automation.data.value?.runs.length, note: `下次巡检：${dateTime(automation.data.value?.nextRun)}`, tone: 'success' },
]);
const recentJobs = computed(() => (automation.data.value?.jobs || []).slice(0, 6));
const recentIssues = computed(() => issues.data.value?.issues.slice(0, 5) || []);
const queries = [automation, issues, projects];
const errors = computed(() => queries.filter((query) => query.error.value).map((query) => query.error.value?.message));
const refresh = () => Promise.all(queries.map((query) => query.refetch()));
const shortcuts = computed(() => [
  { title: '本地项目与 Git', description: '选文件夹、代码浏览、分支与提交推送', value: projects.data.value?.projects.length, path: '/projects', icon: FolderGit2 },
  { title: '任务日历', description: 'Jira 日历、列表与统计', value: issues.data.value?.issues.length, path: '/tasks/calendar', icon: CalendarDays },
  { title: '执行队列', description: 'Jira 需求/缺陷自动派发与执行记录', value: automation.data.value?.jobs.length, path: '/delivery/queue', icon: Terminal },
  { title: '交付与连接设置', description: '配置 Jira、CLI 模型、思考强度与自动策略', value: automation.data.value?.settings.enabled ? 'ON' : 'OFF', path: '/settings', icon: Settings2 },
]);
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
  <div v-if="!workspace" class="quick-entry-grid"><RouterLink v-for="item in shortcuts" :key="item.path" :to="item.path" class="surface"><span class="entry-icon"><component :is="item.icon" :size="20" /></span><div><strong>{{ item.title }}</strong><small>{{ item.description }}</small></div><span class="entry-count">{{ item.value ?? '—' }}</span><ArrowUpRight :size="15" /></RouterLink></div>
  <div class="overview-grid">
    <div class="overview-main">
      <section class="surface attention-panel"><div class="surface-header"><div><h2>自动交付任务队列 <span>{{ recentJobs.length }}</span></h2><p>Jira 任务自动派发、分支创建与状态流转记录</p></div><RouterLink to="/delivery/queue" class="hub-link">查看队列 <ChevronRight :size="13" /></RouterLink></div><div v-if="automation.isPending.value" class="surface-body"><el-skeleton :rows="5" animated /></div><div v-else class="attention-list"><RouterLink v-for="item in recentJobs" :key="item.id" to="/delivery/queue"><span class="attention-icon"><Clock3 :size="17" /></span><div><strong>{{ item.title || item.issueKey }}</strong><small>{{ item.issueKey }} · {{ item.branch || '待分配分支' }} · {{ item.categoryLabel || item.status }}</small></div><StatusPill :value="item.status" /><ChevronRight :size="14" /></RouterLink><el-empty v-if="!recentJobs.length" description="当前队列暂无自动交付任务，可在交付设置或执行计划中开启" :image-size="60" /></div></section>
      <section class="surface"><div class="surface-header"><div><h2>最近更新的 Jira 任务</h2><p>当前查询来源：{{ issues.data.value?.source || '读取中' }}</p></div><RouterLink to="/tasks/list" class="hub-link">全部任务</RouterLink></div><el-table :data="recentIssues"><el-table-column label="任务" min-width="280"><template #default="{ row }"><RouterLink :to="`/tasks/list?q=${row.key}`" class="row-title">{{ row.summary }}</RouterLink><span class="row-secondary">{{ row.key }} · {{ row.projectName }}</span></template></el-table-column><el-table-column label="状态" width="110"><template #default="{ row }"><StatusPill :value="row.status" /></template></el-table-column><el-table-column label="更新时间" width="125"><template #default="{ row }"><span class="row-mono">{{ dateTime(row.updated) }}</span></template></el-table-column></el-table></section>
    </div>
    <aside class="overview-aside" aria-label="工作区连接与项目">
      <section class="surface"><div class="surface-header"><h2>运行与连接状态</h2></div><div class="source-statuses"><div><span>Jira 自动巡检</span><b>{{ automation.data.value?.settings.enabled ? '已启用' : automation.data.value ? '已暂停' : '读取中' }}</b></div><div><span>自动创建 AI 任务</span><b>{{ automation.data.value?.settings.autoCreateCodex ? '开启' : '关闭' }}</b></div><div><span>自动推进 Jira 状态</span><b>{{ automation.data.value?.settings.autoTransitionJira ? '开启' : '关闭' }}</b></div><div><span>自动创建合并请求</span><b>{{ automation.data.value?.settings.autoCreateMergeRequest ? '开启' : '关闭' }}</b></div><div><span>本地工作区扫描</span><b>{{ projects.data.value ? `${projects.data.value.projects.length} 个工作区` : projects.error.value ? '读取失败' : '扫描中' }}</b></div><RouterLink to="/settings" class="hub-link">配置连接与自动交付策略 <ArrowUpRight :size="13" /></RouterLink></div></section>
      <section class="surface"><div class="surface-header"><div><h2>本地项目与改动</h2><p>点击进入项目查看代码、分支、Diff 与提交推送</p></div><RouterLink to="/projects" class="hub-link">管理项目</RouterLink></div><div class="attention-list"><RouterLink v-for="proj in (projects.data.value?.projects || []).slice(0, 5)" :key="proj.path" :to="`/projects?q=${encodeURIComponent(proj.displayName || proj.projectName)}`"><span class="attention-icon"><FolderGit2 :size="17" /></span><div><strong>{{ proj.displayName || proj.projectName }}</strong><small>{{ proj.branch }} · {{ proj.displayPath }}</small></div><StatusPill :value="proj.clean ? 'completed' : 'warning'" :label="proj.clean ? '干净' : `${proj.changed} 项改动`" /><ChevronRight :size="14" /></RouterLink><el-empty v-if="!(projects.data.value?.projects || []).length" description="暂未扫描到项目，请前往本地项目选择文件夹" :image-size="56" /></div></section>
    </aside>
  </div>
</template>
<style scoped>
.overview-grid{display:grid;grid-template-columns:minmax(0,1.9fr) minmax(285px,1fr);gap:20px}.surface-header h2>span{margin-left:7px;font-size:11px;background:var(--ui-accent-soft);color:var(--ui-muted);padding:2px 6px;border-radius:4px}.surface-header>a{display:flex;align-items:center;gap:4px;white-space:nowrap}.attention-list>a{display:flex;gap:12px;align-items:center;padding:17px 20px;border-bottom:1px solid var(--ui-border)}.attention-list>a:hover{background:var(--ui-surface)}.attention-list>a:last-child{border-bottom:0}.attention-icon{width:33px;height:33px;display:grid;place-items:center;flex-shrink:0;border-radius:7px;background:var(--ui-warning-bg);color:var(--ui-warning)}.attention-icon.danger{color:var(--ui-danger);background:var(--ui-danger-bg)}.attention-list>a>div{min-width:0;flex:1}.attention-list strong{display:block;font-size:13px;font-weight:500;color:var(--ui-text)}.attention-list small{display:block;font-size:11px;color:var(--ui-muted);margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.attention-list>a>svg{color:var(--ui-muted)}.delivery-progress{display:flex;align-items:flex-end;justify-content:space-between;margin:2px 0 20px}.delivery-progress strong{font:35px var(--mono);letter-spacing:-1.5px}.delivery-progress strong small{font-size:17px;color:var(--ui-muted);letter-spacing:-.5px}.delivery-progress>span{font-size:11px;color:var(--ui-muted);padding-bottom:4px}.progress-legend{margin-top:25px}.progress-legend>div{display:flex;align-items:center;font-size:12px;gap:9px;margin:17px 0;color:var(--ui-muted)}.progress-legend i{width:7px;height:7px;background:var(--ui-accent-soft);border-radius:50%}.progress-legend i.approved{background:var(--ui-accent)}.progress-legend i.waiting{background:var(--ui-warning)}.progress-legend i.blocked{background:var(--ui-danger)}.progress-legend b{margin-left:auto;font:12px var(--mono);color:var(--ui-secondary)}.target-note{border:1px solid var(--ui-border);background:var(--ui-accent-soft);border-radius:6px;padding:12px;margin-top:23px}.target-note span{display:block;font-size:11px;color:var(--ui-muted);margin-bottom:7px}.target-note code{font-size:11px;color:var(--ui-secondary);overflow-wrap:anywhere}.quick-entry-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:15px}.quick-entry-grid>a{display:flex;gap:11px;align-items:center;padding:19px 15px}.entry-icon{width:36px;height:36px;display:grid;place-items:center;flex-shrink:0;background:var(--ui-accent-soft);color:var(--ui-accent);border-radius:8px}.quick-entry-grid strong{display:block;font-size:12px;font-weight:550}.quick-entry-grid small{display:block;font-size:11px;color:var(--ui-muted);margin-top:6px}.entry-count{font:18px var(--mono);color:var(--ui-muted);margin-left:auto}.quick-entry-grid>a>svg{color:var(--ui-muted);flex-shrink:0}.source-statuses{padding:5px 20px 20px}.source-statuses>div{display:flex;justify-content:space-between;align-items:center;padding:14px 0;border-bottom:1px solid var(--ui-border);font-size:11px;gap:10px}.source-statuses>div>span{color:var(--ui-muted)}.source-statuses b{font-weight:500;font-size:11px;color:var(--ui-secondary)}.overview-warning{font-size:11px;line-height:1.9;color:var(--ui-secondary);background:var(--ui-warning-bg);border:1px solid var(--ui-border);padding:10px;border-radius:5px}.source-statuses>a{display:flex;align-items:center;gap:4px;margin-top:15px}
@media(max-width:1250px){.quick-entry-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.overview-grid{grid-template-columns:minmax(0,1.6fr) minmax(260px,1fr)}}@media(max-width:1050px){.overview-grid{grid-template-columns:1fr}.progress-panel .surface-body{display:grid;grid-template-columns:1fr 1fr;gap:12px 24px}.progress-panel .el-progress{align-self:center}.progress-legend{margin:0}.target-note{align-self:center;margin:0}}@media(max-width:550px){.quick-entry-grid{grid-template-columns:1fr}.attention-list>a>.status-pill{display:none}.progress-panel .surface-body{display:block}.progress-legend{margin-top:15px}.target-note{margin-top:15px}}
</style>
