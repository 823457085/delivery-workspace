<script setup lang="ts">
/** 页面编排业务入口；聊天始终挂载保留草稿与滚动，工作面板按需加载，避免同时启动全部查询。 */
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AgentWorkspace from '../../features/agent-workbench/AgentWorkspace.vue';
import AgentAutomationPanel from '../../features/agent-workbench/AgentAutomationPanel.vue';
import { registeredWorkspaceSections, workspaceView } from './workspace-navigation';
import { agentWorkspaceContext } from '../../shared/agent-workspace-context';
import RequirementDevelopment from '../../features/requirement-development/RequirementDevelopment.vue';
import { useIntegrationPlugins, integrationComponents } from '../../plugins/runtime';
import { useCustomPlugins } from '../../features/custom-plugins/api';
import WorkspacePanelViewport from '../../shared/ui/WorkspacePanelViewport.vue';
import { LayoutGrid, MessagesSquare } from '@lucide/vue';
import { workspaceMenuIcons } from '../../shared/menu-icons';
import ThemePicker from '../../shared/theme/ThemePicker.vue';

const route = useRoute(), router = useRouter();
const integrations = useIntegrationPlugins();
const customPlugins = useCustomPlugins();
const workspaceSections = computed(() => registeredWorkspaceSections(integrations.active.value.map(plugin => plugin.id), customPlugins.plugins.value, customPlugins.navigation.value));
const pluginReady = computed(() => !view.value?.pluginId || integrations.available(view.value.pluginId));
const localPort = window.location.port || '5288';
const navigationIcons = workspaceMenuIcons;
const navigationLabels: Record<string, string> = { today: '今日', projects: '项目', execution: 'AI 交付', integration: '联调', automation: '设置' };
const workspace = ref<InstanceType<typeof AgentWorkspace>>();
const panelStates = new Map<string, unknown>();
const panelLocations = new Map<string, typeof route.query>();
const lastSectionViews = new Map<string, string>();
async function compose(prompt: string, workspacePath = '') {
  await router.push({ path: '/agent', query: {} });
  workspace.value?.compose(prompt, workspacePath);
}
provide(agentWorkspaceContext, {
  compose,
  openRun, readState: key => panelStates.get(key), saveState: (key, value) => { panelStates.set(key, value); },
});
const view = computed(() => workspaceView(route.query.view, customPlugins.plugins.value, route.query.plugin));
watch(view, current => { document.title = `${current?.label || 'Agent Studio'} · Delivery Workspace`; }, { immediate: true });
const section = computed(() => {
  const groups = registeredWorkspaceSections(integrations.active.value.map(plugin => plugin.id), customPlugins.plugins.value.map(plugin => ({ ...plugin, showInMenu: true })), customPlugins.navigation.value);
  return groups.find(group => group.items.some(item => item.id === view.value?.id));
});
const panels = {
  plugins: defineAsyncComponent(() => import('../../features/custom-plugins/CustomPluginWorkspace.vue')),
  interfaces: defineAsyncComponent(() => import('../../features/interface-center/InterfaceCenter.vue')),
  requirements: defineAsyncComponent(() => import('../../features/requirement-development/OverseasRequirements.vue')),
  'integration-execution': defineAsyncComponent(() => import('../../features/refactor-control/RefactorControl.vue')),
  today: defineAsyncComponent(() => import('../../features/workbench/Workbench.vue')),
  overview: defineAsyncComponent(() => import('../../features/workspace-overview/WorkspaceOverview.vue')),
  deployments: defineAsyncComponent(() => import('../../features/deployments/DeploymentWorkspace.vue')),
  ports: defineAsyncComponent(() => import('../../features/port-monitor/PortMonitor.vue')),
  projects: defineAsyncComponent(() => import('../../features/project-inventory/ProjectInventory.vue')),
  systems: defineAsyncComponent(() => import('../../features/system-catalog/SystemCatalog.vue')),
  execution: defineAsyncComponent(() => import('../../features/auto-delivery/AutoDelivery.vue')),
  settings: defineAsyncComponent(() => import('../../features/delivery-settings/DeliverySettings.vue')),
  messages: defineAsyncComponent(() => import('../../features/wecom-messages/WecomMessages.vue')),
  'go-studio': defineAsyncComponent(() => import('../../features/go-learning/GoLearningStudio.vue')),
};
const panel = computed(() => {
  const id = view.value?.id;
  if (!id) return undefined;
  if (view.value?.customPluginId) return panels.plugins;
  if (view.value?.pluginId) return pluginReady.value ? integrationComponents[view.value.pluginId]?.components[view.value.component || ''] : undefined;
  if (['plan', 'queue', 'runs'].includes(id)) return panels.execution;
  return panels[id as keyof typeof panels];
});
watch(() => route.query, query => {
  const current = workspaceView(query.view, customPlugins.plugins.value, query.plugin);
  if (!current) return;
  if (current.id !== 'projects') panelLocations.set(current.id, { ...query });
  const group = workspaceSections.value.find(item => item.items.some(view => view.id === current.id));
  if (group) lastSectionViews.set(group.id, current.id);
}, { immediate: true });
function open(id?: string) {
  const custom = workspaceSections.value.flatMap(section => section.items).find(item => item.id === id)?.customPluginId;
  const query = custom ? { view: 'plugins', plugin: custom } : id === 'plugins' ? { view: id } : id ? panelLocations.get(id) || { view: id } : {};
  void router.push({ path: '/agent', query });
}
function openGroup(id = '') { void router.push({ path: '/agent', query: { group: '1', ...(id ? { room: id } : {}) } }); }
function openRun(id: string) { if (id.startsWith('group:')) openGroup(id.slice(6)); else void router.push({ path: '/agent', query: { run: id } }); }
watch([() => route.query.group, () => route.query.room, workspace, view], ([group, id, target]) => {
  if (group === '1' && !view.value && target) target.openGroup(typeof id === 'string' ? id : undefined);
}, { immediate: true });
watch([() => route.query.run, workspace, view], async ([id, target]) => {
  if (!view.value && typeof id === 'string' && target) await target.openRun(id);
}, { immediate: true });
function ready(hasSession: boolean) {
  if (!hasSession && !route.query.view && !route.query.run && !route.query.group) void router.replace({ path: '/agent', query: { view: 'today' } });
}
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
  <div class="workspace-console" :class="{ 'is-chat': !view }">
    <header class="workspace-topbar">
      <button type="button" class="workspace-brand" aria-label="我的工作台" title="我的工作台" @click="open('today')">
        <span class="workspace-brand-symbol"><LayoutGrid :size="19" /></span>
        <span class="workspace-brand-name"><strong>Delivery</strong><small>Workspace</small></span>
      </button>
      <nav class="workspace-primary-nav" aria-label="主导航">
        <button type="button" :aria-current="!view ? 'page' : undefined" aria-label="会话" title="会话" @click="open()"><MessagesSquare :size="16" /><span>会话</span></button>
        <button v-for="group in workspaceSections" :key="group.id" type="button" :aria-label="group.label" :aria-current="section?.id === group.id ? 'page' : undefined" :title="group.label" @click="open(group.items.find(item => item.id === lastSectionViews.get(group.id))?.id || group.items[0].id)"><component :is="navigationIcons[group.icon || group.id] || LayoutGrid" :size="16" /><span>{{ group.shortLabel || navigationLabels[group.id] || group.label }}</span></button>
      </nav>
      <div class="workspace-topbar-tools"><span class="workspace-local">本地 <b>{{ localPort }}</b></span><ThemePicker /></div>
    </header>
  <AgentWorkspace ref="workspace" :workbench-open="!!view" @chat="open()" @group="openGroup" @ready="ready">
    <template #navigation="context">
      <nav v-if="context.placement !== 'footer'" class="workspace-navigation" aria-label="统一工作入口">
        <button type="button" :class="{ active: !view }" :aria-current="!view ? 'page' : undefined" title="会话" @click="open(); context.closeNavigation()"><MessagesSquare :size="17" /><span>会话</span></button>
        <button v-for="group in workspaceSections" :key="group.id" type="button" :class="{ active: section?.id === group.id }" :aria-label="group.label" :aria-current="section?.id === group.id ? 'page' : undefined" :title="group.label" @click="open(group.items.find(item => item.id === lastSectionViews.get(group.id))?.id || group.items[0].id); context.closeNavigation()"><component :is="navigationIcons[group.icon || group.id] || LayoutGrid" :size="17" /><span>{{ group.id === 'today' ? '今日' : group.id === 'automation' ? '设置' : group.label }}</span></button>
      </nav>
    </template>
    <template #workbench="context">
      <section v-if="view" class="workspace-panel" aria-label="工作面板">
        <header class="workspace-page-head">
          <div class="workspace-page-identity">
            <span class="workspace-page-symbol"><component :is="navigationIcons[section.icon || section.id] || LayoutGrid" v-if="section" :size="22" /></span>
            <div><p>{{ view.customPluginId ? '功能插件' : section?.label }}</p><h1>{{ view.label }}</h1></div>
          </div>
          <div class="workspace-page-tools"><span id="workspace-connection-status"></span><span class="workspace-mobile-theme"><ThemePicker /></span><button class="workspace-back" type="button" aria-label="返回会话" title="返回会话" @click="open()"><MessagesSquare :size="15" /><span>返回会话</span></button></div>
          <nav v-if="!view.customPluginId || (section?.items.length || 0) > 1" class="workspace-view-tabs" aria-label="工作面板视图"><button v-for="item in section?.items" :key="item.id" type="button" :aria-current="view.id === item.id ? 'page' : undefined" @click="open(item.id)">{{ item.label }}</button></nav>
          <div id="workspace-panel-toolbar"></div>
        </header>
        <WorkspacePanelViewport :key="view.id" :view-id="view.id">
          <div v-if="!pluginReady" class="plugin-unavailable"><h2>{{ view.label }}</h2><p>{{ integrations.query.isPending.value ? '正在读取插件状态…' : integrations.query.error.value?.message || '提供此功能的插件未启用、已移除或尚未配置。历史数据仍保留，接入后可继续使用原功能。' }}</p><el-button @click="router.push({ path: '/agent', query: { view: 'settings', settingsTab: 'plugins' } })">管理接入插件</el-button></div>
          <AgentAutomationPanel v-else-if="view.id === 'automation'" :scoped-jobs="[]" :daily-report-available="context.dailyReportAvailable" :daily-report-pending="context.dailyReportPending" :daily-report-for-date="context.dailyReportForDate" @generate-daily-report="context.generateDailyReport" @compose="compose" />
          <RequirementDevelopment v-else-if="view.id === 'design'" @open-run="openRun" />
          <component :is="panel" v-else v-bind="view.customPluginId ? { dedicated: true } : 'mode' in view ? { mode: view.mode } : {}" @open-run="openRun" />
        </WorkspacePanelViewport>
      </section>
    </template>
  </AgentWorkspace>
  </div>
</template>

<style scoped>
.workspace-navigation{display:flex;align-items:center;gap:6px;min-height:44px;padding:6px 16px;border-bottom:1px solid var(--agent-border);background:var(--agent-panel)}
.workspace-navigation button{display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border:0;border-radius:8px;background:transparent;color:var(--ui-secondary);font:inherit;font-size:13px;cursor:pointer}
.workspace-navigation button > span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workspace-navigation button:hover{background:var(--ui-hover)}
.workspace-navigation button.active{background:var(--ui-accent-soft);color:var(--ui-accent);font-weight:600}
.plugin-unavailable{padding:24px}.workspace-panel{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--ui-bg);color:var(--ui-text)}
</style>

<style src="./workspace-pages.css"></style>
<style src="../../app/design-system.css"></style>
<style src="./workspace-layout.css"></style>
