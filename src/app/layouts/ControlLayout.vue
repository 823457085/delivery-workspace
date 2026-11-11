<script setup lang="ts">
/** 布局只处理导航与展示；各业务数据在独立 Feature 内读取，避免总面板耦合所有加载状态。 */
import { computed, shallowRef, watch } from 'vue';
import { useRoute } from 'vue-router';
import { PanelsTopLeft, LayoutDashboard, CalendarDays, FolderGit2, ListTodo, Terminal, History, Kanban,
  GitMerge, Code2, Settings2, ChevronRight, PanelLeftClose, PanelLeftOpen, FileCheck2, Bot, Rocket, RadioTower } from '@lucide/vue';
import { registeredNavigation } from '../navigation';
import { useIntegrationPlugins } from '../../plugins/runtime';
const plugins = useIntegrationPlugins();
const navigation = computed(() => registeredNavigation(plugins.active.value.map(plugin => plugin.id)));
const allNavigation = computed(() => navigation.value.flatMap(group => group.items));
import ThemePicker from '../../shared/theme/ThemePicker.vue';
import WorkspaceVersionStatus from '../../shared/version/WorkspaceVersionStatus.vue';
const route = useRoute();
const collapsed = shallowRef(false);
const immersive = computed(() => route.meta.immersive === true);
const icons = { workbench: PanelsTopLeft, overview: LayoutDashboard, calendar: CalendarDays, projects: FolderGit2, plan: ListTodo,
  queue: Terminal, runs: History, board: Kanban, merge: GitMerge, code: Code2, settings: Settings2, design: FileCheck2, bot: Bot, deployments: Rocket, ports: RadioTower };
const current = computed(() => allNavigation.value.find((item) => route.path === item.path || ('prefix' in item && typeof item.prefix === 'string' && route.path.startsWith(item.prefix))));
const currentGroup = computed(() => navigation.value.find((group) => group.items.includes(current.value!))?.group || '工作空间');
const localPort = typeof window !== 'undefined' && window.location.port ? window.location.port : '5288';
const tabs = computed(() => navigation.value.find(group => group.items.some(item => item.path === route.path))?.items || []);
watch(() => route.path, () => { document.title = route.path === '/agent' ? 'Agent Studio · Delivery Workspace' : `${current.value?.title || '工作总览'} · Delivery Workspace`; }, { immediate: true });
</script>
<template>
  <RouterView v-if="immersive" />
  <div v-else class="hub" :class="{ 'is-collapsed': collapsed }">
    <aside class="hub-sidebar">
      <RouterLink class="hub-brand" to="/workbench"><span class="hub-brand-mark"><PanelsTopLeft :size="22" /></span><div><strong>Delivery Workspace</strong><small>本地研发与 AI 交付工作台</small></div></RouterLink>
      <div class="workspace-switch"><span class="workspace-letter">D</span><div><strong>我的工作空间</strong><small>插件 · Git · AI Agent</small></div></div>
      <nav class="hub-navigation" aria-label="全部业务导航"><div v-for="group in navigation" :key="group.group" class="nav-group"><p>{{ group.group }}</p><RouterLink v-for="item in group.items" :key="item.path" :to="item.path" :title="item.title" :aria-label="item.title" :class="{ selected: current?.path === item.path }"><component :is="icons[item.icon as keyof typeof icons]" :size="17" /><span>{{ item.title }}</span><i v-if="current?.path === item.path"></i></RouterLink></div></nav>
      <div class="hub-sidebar-bottom"><div class="sidebar-user"><span>DW</span><div><strong>本机用户</strong><small>独立本地工作台</small></div></div></div>
    </aside>
    <div class="hub-main"><header class="hub-topbar"><div class="hub-breadcrumb"><button :aria-label="collapsed ? '展开导航' : '收起导航'" @click="collapsed = !collapsed"><PanelLeftOpen v-if="collapsed" :size="18" /><PanelLeftClose v-else :size="18" /></button><span>{{ currentGroup }}</span><ChevronRight :size="13" /><strong>{{ current?.title }}</strong></div><div class="hub-topbar-actions"><span class="connection-boundary"><i></i>LOCAL :{{ localPort }} <b>/</b> SHARE EDITION</span><WorkspaceVersionStatus /><ThemePicker /></div></header>
      <div v-if="tabs.length" class="hub-page-tabs" role="tablist" aria-label="业务子视图"><RouterLink v-for="tab in tabs" :key="tab.path" :to="tab.path" role="tab" :aria-selected="route.path === tab.path" :class="{ active: route.path === tab.path }">{{ tab.title }}</RouterLink></div>
      <div class="hub-content"><RouterView /></div>
      <footer class="hub-footer"><span>DELIVERY WORKSPACE <i> / </i> SHARE EDITION</span><span>本地 Git + Jira 自动化 + 多 Agent 协作工作台</span></footer>
    </div>
  </div>
</template>
