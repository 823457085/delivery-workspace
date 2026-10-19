<script setup lang="ts">
/** 页面编排业务入口；聊天始终挂载保留草稿与滚动，工作面板按需加载，避免同时启动全部查询。 */
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AgentWorkspace from '../../features/agent-workbench/AgentWorkspace.vue';
import AgentAutomationPanel from '../../features/agent-workbench/AgentAutomationPanel.vue';
import { workspaceLocation, workspaceSections, workspaceView } from './workspace-navigation';
import { agentWorkspaceContext } from '../../shared/agent-workspace-context';
import RequirementDevelopment from '../../features/requirement-development/RequirementDevelopment.vue';
import JiraFix from '../../features/jira-fix/JiraFix.vue';
import WorkspacePanelViewport from '../../shared/ui/WorkspacePanelViewport.vue';
import { CircleCheck, FolderGit2, MessagesSquare, PackageCheck, Settings2, Sun, Terminal } from '@lucide/vue';

const route = useRoute(), router = useRouter();
const navigationIcons = { today: Sun, tasks: CircleCheck, projects: FolderGit2, execution: Terminal, delivery: PackageCheck, automation: Settings2 };
const primarySections = workspaceSections.filter(group => ['today', 'tasks', 'projects'].includes(group.id));
const secondarySections = workspaceSections.filter(group => !primarySections.includes(group));
const workspace = ref<InstanceType<typeof AgentWorkspace>>();
const panelStates = new Map<string, unknown>();
const panelLocations = new Map<string, typeof route.query>();
const lastSectionViews = new Map<string, string>();
provide(agentWorkspaceContext, {
  compose: async prompt => { await router.push({ path: '/agent', query: {} }); workspace.value?.compose(prompt); },
  openRun, readState: key => panelStates.get(key), saveState: (key, value) => { panelStates.set(key, value); },
});
const view = computed(() => workspaceView(route.query.view));
const section = computed(() => workspaceSections.find(group => group.items.some(item => item.id === view.value?.id)));
const panels = {
  today: defineAsyncComponent(() => import('../../features/workbench/Workbench.vue')),
  overview: defineAsyncComponent(() => import('../../features/workspace-overview/WorkspaceOverview.vue')),
  tasks: defineAsyncComponent(() => import('../../features/task-calendar/TaskWorkspace.vue')),
  projects: defineAsyncComponent(() => import('../../features/project-inventory/ProjectInventory.vue')),
  execution: defineAsyncComponent(() => import('../../features/auto-delivery/AutoDelivery.vue')),
  delivery: defineAsyncComponent(() => import('../../features/catchup/CatchupWorkspace.vue')),
  integration: defineAsyncComponent(() => import('../../features/api-integration/ApexBffReview.vue')),
  'integration-execution': defineAsyncComponent(() => import('../../features/integration-execution/IntegrationExecution.vue')),
  settings: defineAsyncComponent(() => import('../../features/delivery-settings/DeliverySettings.vue')),
};
const panel = computed(() => {
  const id = view.value?.id;
  if (!id) return undefined;
  if (['tasks', 'calendar', 'stats'].includes(id)) return panels.tasks;
  if (['plan', 'queue', 'runs'].includes(id)) return panels.execution;
  if (['catchup', 'merge', 'codex'].includes(id)) return panels.delivery;
  return panels[id as keyof typeof panels];
});
watch(() => route.query, query => {
  const current = workspaceView(query.view);
  if (!current) return;
  panelLocations.set(current.id, { ...query });
  const group = workspaceSections.find(item => item.items.some(view => view.id === current.id));
  if (group) lastSectionViews.set(group.id, current.id);
}, { immediate: true });
function open(id?: string) { void router.push({ path: '/agent', query: id ? panelLocations.get(id) || { view: id } : {} }); }
function openRun(id: string) { void router.push({ path: '/agent', query: { run: id } }); }
watch([() => route.query.run, workspace, view], async ([id, target]) => {
  if (!view.value && typeof id === 'string' && target) await target.openRun(id);
}, { immediate: true });
function ready(hasSession: boolean) {
  if (!hasSession && !route.query.view && !route.query.run) void router.replace({ path: '/agent', query: { view: 'today' } });
}
// 工作面板中的原有链接不离开 Agent，保留旧页面的独立访问能力。
const removeGuard = router.beforeEach((to, from) => {
  if (from.path !== '/agent' || to.path === '/agent') return;
  const target = workspaceLocation(to.path, to.query);
  if (target) return { path: target.path, query: { ...to.query, view: target.query.view } };
});
onBeforeUnmount(removeGuard);
onMounted(() => document.addEventListener('click', openThread));
onBeforeUnmount(() => document.removeEventListener('click', openThread));
function openThread(event: MouseEvent) {
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return;
  const link = (event.target as Element).closest<HTMLAnchorElement>('a[href^="codex://threads/"]');
  if (!link) return;
  const id = link.getAttribute('href')?.split('/').at(-1) || '';
  if (workspace.value?.openSession(id)) { event.preventDefault(); open(); }
}
</script>

<template>
  <AgentWorkspace ref="workspace" :workbench-open="!!view" @chat="open()" @ready="ready">
    <template #navigation="context">
      <nav class="workspace-navigation" :class="{ 'workspace-navigation-footer': context.placement === 'footer' }" :aria-label="context.placement === 'footer' ? '执行与设置' : '统一工作入口'">
        <button v-if="context.placement !== 'footer'" type="button" :class="{ active: !view }" :aria-current="!view ? 'page' : undefined" @click="open(); context.closeNavigation()"><MessagesSquare :size="17" /><span>会话</span></button>
        <button v-for="group in context.placement === 'footer' ? secondarySections : primarySections" :key="group.id" type="button" :class="{ active: section?.id === group.id, 'workspace-nav-settings': group.id === 'automation' }" :aria-label="group.label" :aria-current="section?.id === group.id ? 'page' : undefined" :title="group.label" @click="open(lastSectionViews.get(group.id) || group.items[0].id); context.closeNavigation()"><component :is="navigationIcons[group.id]" :size="17" /><span>{{ group.id === 'today' ? '今日' : group.id === 'automation' ? '设置' : group.label }}</span></button>
      </nav>
    </template>
    <template #workbench="context">
      <section v-if="view" class="workspace-panel" aria-label="工作面板">
        <header class="workspace-panel-header">
          <nav aria-label="工作面板视图"><button v-for="item in section?.items" :key="item.id" type="button" :class="{ active: view.id === item.id }" @click="open(item.id)">{{ item.label }}</button></nav>
          <div class="workspace-panel-actions"><div id="workspace-panel-toolbar"></div><button class="workspace-back" type="button" aria-label="返回会话" title="返回会话" @click="open()"><MessagesSquare :size="14" /><span>返回会话</span></button></div>
        </header>
        <WorkspacePanelViewport :key="view.id" :view-id="view.id">
          <AgentAutomationPanel v-if="view.id === 'automation'" :scoped-jobs="[]" :daily-report-available="context.dailyReportAvailable" :daily-report-pending="context.dailyReportPending" @generate-daily-report="context.generateDailyReport" @compose="context.compose" />
          <RequirementDevelopment v-else-if="view.id === 'design'" @open-run="openRun" />
          <JiraFix v-else-if="view.id === 'jira-fix'" @open-run="openRun" />
          <component :is="panel" v-else v-bind="'mode' in view ? { mode: view.mode } : {}" />
        </WorkspacePanelViewport>
      </section>
    </template>
  </AgentWorkspace>
</template>

<style scoped>
.workspace-navigation{display:flex;align-items:center;gap:6px;min-height:44px;padding:6px 16px;border-bottom:1px solid var(--agent-border);background:var(--agent-panel)}
.workspace-navigation button,.workspace-panel-header button{padding:7px 13px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--agent-secondary);font:inherit;font-size:13px;cursor:pointer}
.workspace-navigation button:hover,.workspace-panel-header button:hover{background:var(--agent-raised)}
.workspace-navigation button.active,.workspace-panel-header button.active{border-color:var(--agent-accent);background:var(--agent-raised);color:var(--agent-text)}
.workspace-panel{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--ui-bg);color:var(--ui-text)}
.workspace-panel-header{display:flex;justify-content:space-between;gap:12px;flex-shrink:0;padding:10px 18px;border-bottom:1px solid var(--agent-border);background:var(--agent-panel)}
.workspace-panel-header nav{display:flex;gap:4px;flex-wrap:wrap}
.workspace-panel-actions{display:flex;align-items:center;gap:8px;min-width:0}
.workspace-panel-header .workspace-back{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
</style>

<style src="./workspace-pages.css"></style>
