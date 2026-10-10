<script setup lang="ts">
/** 布局只处理导航与展示；各业务数据在独立 Feature 内读取，避免总面板耦合所有加载状态。 */
import { computed, shallowRef, watch } from 'vue';
import { useRoute } from 'vue-router';
import { PanelsTopLeft, LayoutDashboard, CalendarDays, FolderGit2, ListTodo, Terminal, History, Kanban,
  GitMerge, Code2, Settings2, ChevronRight, PanelLeftClose, PanelLeftOpen, FileCheck2, Bot } from '@lucide/vue';
import { navigation, allNavigation } from '../navigation';
import ThemePicker from '../../shared/theme/ThemePicker.vue';
const route = useRoute();
const collapsed = shallowRef(false);
const immersive = computed(() => route.meta.immersive === true);
const icons = { workbench: PanelsTopLeft, overview: LayoutDashboard, calendar: CalendarDays, projects: FolderGit2, plan: ListTodo,
  queue: Terminal, runs: History, board: Kanban, merge: GitMerge, code: Code2, settings: Settings2, design: FileCheck2, bot: Bot };
const current = computed(() => allNavigation.find((item) => route.path === item.path || ('prefix' in item && typeof item.prefix === 'string' && route.path.startsWith(item.prefix))));
const currentGroup = computed(() => navigation.find((group) => group.items.includes(current.value!))?.group || '工作空间');
const tabs = computed(() => route.path.startsWith('/tasks') ? [
  { path: '/tasks/calendar', title: '日历视图' }, { path: '/tasks/list', title: '任务列表' }, { path: '/tasks/stats', title: '任务统计' },
] : route.path.startsWith('/catchup') ? navigation[2].items : route.path.startsWith('/delivery') ? navigation[1].items.filter((item) => item.path.startsWith('/delivery/')) : []);
watch(() => route.path, () => { document.title = `${current.value?.title || '工作总览'} · Delivery Workspace`; }, { immediate: true });
</script>
<template>
  <RouterView v-if="immersive" />
  <div v-else class="hub" :class="{ 'is-collapsed': collapsed }">
    <aside class="hub-sidebar">
      <RouterLink class="hub-brand" to="/workbench"><span class="hub-brand-mark"><PanelsTopLeft :size="22" /></span><div><strong>Delivery Workspace</strong><small>研发交付工作空间</small></div></RouterLink>
      <div class="workspace-switch"><span class="workspace-letter">A</span><div><strong>APEX / 我的工作空间</strong><small>Jira · Git · Codex</small></div></div>
      <nav class="hub-navigation" aria-label="全部业务导航"><div v-for="group in navigation" :key="group.group" class="nav-group"><p>{{ group.group }}</p><RouterLink v-for="item in group.items" :key="item.path" :to="item.path" :title="item.title" :aria-label="item.title" :class="{ selected: current?.path === item.path }"><component :is="icons[item.icon as keyof typeof icons]" :size="17" /><span>{{ item.title }}</span><i v-if="current?.path === item.path"></i></RouterLink></div></nav>
      <div class="hub-sidebar-bottom"><div class="sidebar-user"><span>DW</span><div><strong>本机用户</strong><small>本机独立面板</small></div></div></div>
    </aside>
    <div class="hub-main"><header class="hub-topbar"><div class="hub-breadcrumb"><button :aria-label="collapsed ? '展开导航' : '收起导航'" @click="collapsed = !collapsed"><PanelLeftOpen v-if="collapsed" :size="18" /><PanelLeftClose v-else :size="18" /></button><span>{{ currentGroup }}</span><ChevronRight :size="13" /><strong>{{ current?.title }}</strong></div><div class="hub-topbar-actions"><span class="connection-boundary"><i></i>LOCAL :5199 <b>/</b> UNIFIED BACKEND</span><ThemePicker /></div></header>
      <div v-if="tabs.length" class="hub-page-tabs" role="tablist" aria-label="业务子视图"><RouterLink v-for="tab in tabs" :key="tab.path" :to="tab.path" role="tab" :aria-selected="route.path === tab.path" :class="{ active: route.path === tab.path }">{{ tab.title }}</RouterLink></div>
      <div class="hub-content"><RouterView /></div>
      <footer class="hub-footer"><span>DELIVERY WORKSPACE <i> / </i> VUE + ELEMENT PLUS</span><span>统一后端提供业务数据 · 写操作需确认 · Mastra 实验数据独立</span></footer>
    </div>
  </div>
</template>
