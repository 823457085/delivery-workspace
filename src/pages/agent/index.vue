<script setup lang="ts">
/** 页面编排业务入口：采用经典五区圣杯布局（Sticky Header / 左导航 240px + 自适应主舞台 + 右上下文栏 280px / Fixed Footer），叠加 Acid Graphics 视觉张力。 */
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AgentWorkspace from '../../features/agent-workbench/AgentWorkspace.vue';
import { registeredWorkspaceSections, workspaceChatQuery, workspaceMenuSections, workspaceView } from './workspace-navigation';
import { agentWorkspaceContext } from '../../shared/agent-workspace-context';
import { useIntegrationPlugins, integrationComponents } from '../../plugins/runtime';

const AgentAutomationPanel = defineAsyncComponent(() => import('../../features/agent-workbench/AgentAutomationPanel.vue'));
const RequirementDevelopment = defineAsyncComponent(() => import('../../features/requirement-development/RequirementDevelopment.vue'));
import { useCustomPlugins } from '../../features/custom-plugins/api';
import WorkspacePanelViewport from '../../shared/ui/WorkspacePanelViewport.vue';
import { ArrowUpRight, Camera, ChevronDown, Clock3, Film, LayoutGrid, Maximize2, MessagesSquare, Minimize2, PanelLeftClose, PanelLeftOpen, Pause, Play, Plus, Search, Users } from '@lucide/vue';
import { workspaceMenuIcons } from '../../shared/menu-icons';
import { ElMessage } from 'element-plus';
import ThemePicker from '../../shared/theme/ThemePicker.vue';
import { isSupportedWallpaperFile } from '../../shared/theme/customTheme';
import { designMdMeta } from '../../shared/theme/designMd';
import { useTheme } from '../../shared/theme/useTheme';
import { useImmersivePhoto } from '../../shared/theme/immersivePhoto';
import { useCinematicVideo } from '../../shared/theme/cinematicVideo';
import { isZenToggleShortcut, useZenFocus } from '../../shared/ui/zenFocus';
import WorkspaceCommandPalette from './WorkspaceCommandPalette.vue';
import { readPinnedCommandIds } from './command-palette-pins';
import { formatWorkspaceTabTitle, workspaceAttentionCount, workspaceRunningCount } from '../../features/agent-workbench/useAgentCompletionNotify';

import ImmersivePhotoStage from '../../shared/ui/ImmersivePhotoStage.vue';
import CinematicVideoStage from '../../shared/ui/CinematicVideoStage.vue';
import CustomWallpaperStage from '../../shared/ui/CustomWallpaperStage.vue';
const AmbientWallpaperShowcase = defineAsyncComponent(() => import('../../shared/ui/AmbientWallpaperShowcase.vue'));

const { current: currentTheme, customTheme, setTheme, updateCustomWallpaper, applyRandomAuroraWallpaper, cycleActiveWallpaper } = useTheme();
const { zenFocusEnabled, toggleZenFocus, openAmbientShowcase } = useZenFocus();
const commandPaletteOpen = ref(false);
const pinnedCommandIds = ref<string[]>(readPinnedCommandIds());
const paletteWallpaperInput = ref<HTMLInputElement>();
const activeDesignMd = computed(() => designMdMeta(currentTheme.value.id));
const isWallpaperThemeActive = computed(() =>
  currentTheme.value.id === 'immersive-photo'
  || currentTheme.value.id === 'cinematic-video-hero'
  || currentTheme.value.id === 'custom',
);
const { activeFrame, daylightEnabled: photoDaylightEnabled, daylightSlot: photoDaylightSlot, cycleFrame, toggleDaylight: togglePhotoDaylight } = useImmersivePhoto();
const { activeScene, loopEnabled, daylightEnabled: videoDaylightEnabled, daylightSlot: videoDaylightSlot, cycleScene, toggleLoop, toggleDaylight: toggleVideoDaylight } = useCinematicVideo();

const route = useRoute(), router = useRouter();
const integrations = useIntegrationPlugins();
const customPlugins = useCustomPlugins();
const workspaceSections = computed(() => workspaceMenuSections(integrations.active.value.map(plugin => plugin.id), customPlugins.plugins.value, customPlugins.navigation.value));
const coreSectionIds = new Set(['today', 'tasks', 'projects']);
const primaryHeaderIds = new Set(['today', 'tasks', 'projects', 'execution', 'automation']);
const coreSections = computed(() => workspaceSections.value.filter(group => coreSectionIds.has(group.id)));
const deliverySections = computed(() => workspaceSections.value.filter(group => !coreSectionIds.has(group.id) && group.id !== 'automation'));
const systemSections = computed(() => workspaceSections.value.filter(group => group.id === 'automation'));
const primaryHeaderSections = computed(() => workspaceSections.value.filter(group => primaryHeaderIds.has(group.id)));
const overflowHeaderSections = computed(() => workspaceSections.value.filter(group => !primaryHeaderIds.has(group.id)));
const railCollapsed = ref((() => {
  try { return window.localStorage.getItem('delivery-workspace.rail-collapsed') === '1'; }
  catch { return false; }
})());
function toggleRail() {
  railCollapsed.value = !railCollapsed.value;
  try { window.localStorage.setItem('delivery-workspace.rail-collapsed', railCollapsed.value ? '1' : '0'); }
  catch { /* ignore */ }
}
const pluginReady = computed(() => !view.value?.pluginId || integrations.available(view.value.pluginId));
const localPort = window.location.port || '5288';
const navigationIcons = workspaceMenuIcons;
const navigationLabels: Record<string, string> = { today: '今日', projects: '项目', execution: 'AI 交付', integration: '联调', automation: '设置' };
const workspace = ref<InstanceType<typeof AgentWorkspace>>();
const panelStates = new Map<string, unknown>();
const panelLocations = new Map<string, typeof route.query>();
const lastSectionViews = new Map<string, string>();
const activeSessionId = ref(typeof route.query.session === 'string' ? route.query.session : '');
const activeChatMode = ref<'session' | 'group'>(route.query.group === '1' ? 'group' : 'session');
const activeGroupRoomId = ref(typeof route.query.room === 'string' ? route.query.room : '');
async function compose(prompt: string, workspacePath = '') {
  activeChatMode.value = 'session';
  if (!prompt || workspacePath) activeSessionId.value = '';
  await router.push({ path: '/agent', query: activeSessionId.value ? { session: activeSessionId.value } : {} });
  workspace.value?.compose(prompt, workspacePath);
}
provide(agentWorkspaceContext, {
  compose,
  openRun, readState: key => panelStates.get(key), saveState: (key, value) => { panelStates.set(key, value); },
});
const view = computed(() => workspaceView(route.query.view, customPlugins.plugins.value, route.query.plugin));
const fullHeightPanel = computed(() => !!view.value?.embedded && pluginReady.value);
watch([view, workspaceRunningCount, workspaceAttentionCount], ([current, running, attention]) => {
  document.title = formatWorkspaceTabTitle(`${current?.label || 'Agent Studio'} · Delivery Workspace`, running, attention);
}, { immediate: true });
const section = computed(() => {
  const groups = registeredWorkspaceSections(integrations.active.value.map(plugin => plugin.id), customPlugins.plugins.value.map(plugin => ({ ...plugin, showInMenu: true })), customPlugins.navigation.value);
  return groups.find(group => group.items.some(item => item.id === view.value?.id));
});
const activeOverflowSection = computed(() => overflowHeaderSections.value.find(group => group.id === section.value?.id));
const panels = {
  plugins: defineAsyncComponent(() => import('../../features/custom-plugins/CustomPluginWorkspace.vue')),
  today: defineAsyncComponent(() => import('../../features/workbench/Workbench.vue')),
  overview: defineAsyncComponent(() => import('../../features/workspace-overview/WorkspaceOverview.vue')),
  projects: defineAsyncComponent(() => import('../../features/project-inventory/ProjectInventory.vue')),
  execution: defineAsyncComponent(() => import('../../features/auto-delivery/AutoDelivery.vue')),
  settings: defineAsyncComponent(() => import('../../features/delivery-settings/DeliverySettings.vue')),
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
function currentChatQuery() {
  return workspaceChatQuery(activeChatMode.value, activeSessionId.value, activeGroupRoomId.value);
}
function open(id?: string) {
  const custom = workspaceSections.value.flatMap(section => section.items).find(item => item.id === id)?.customPluginId;
  const query = custom ? { view: 'plugins', plugin: custom } : id === 'plugins' ? { view: id } : id ? panelLocations.get(id) || { view: id } : currentChatQuery();
  void router.push({ path: '/agent', query });
}
function openSingleChat() {
  activeChatMode.value = 'session';
  void router.push({ path: '/agent', query: activeSessionId.value ? { session: activeSessionId.value } : {} });
}
function openPaletteSession(id: string) {
  activeChatMode.value = 'session';
  activeSessionId.value = id;
  void router.push({ path: '/agent', query: { session: id } });
  workspace.value?.openSession(id);
}
function onSessionChange(id: string) {
  activeSessionId.value = id;
  if (!view.value && route.query.group !== '1' && !route.query.run) {
    activeChatMode.value = 'session';
    const current = typeof route.query.session === 'string' ? route.query.session : '';
    if (current !== id) void router.replace({ path: '/agent', query: id ? { session: id } : {} });
  }
}
function openSection(group: { id: string; items: { id: string }[] }) {
  open(group.items.find(item => item.id === lastSectionViews.get(group.id))?.id || group.items[0].id);
}
function openGroup(id?: string) {
  const nextRoom = id !== undefined ? id : activeGroupRoomId.value;
  activeChatMode.value = 'group';
  activeGroupRoomId.value = nextRoom;
  const nextQuery = { group: '1', ...(nextRoom ? { room: nextRoom } : {}) };
  if (!view.value && route.query.group === '1') {
    const currentRoom = typeof route.query.room === 'string' ? route.query.room : '';
    if (currentRoom !== nextRoom) void router.replace({ path: '/agent', query: nextQuery });
  } else {
    void router.push({ path: '/agent', query: nextQuery });
  }
}
function openRun(id: string) { if (id.startsWith('group:')) openGroup(id.slice(6)); else void router.push({ path: '/agent', query: { run: id } }); }
watch([() => route.query.group, () => route.query.room, workspace, view], ([group, id, target]) => {
  if (group === '1' && !view.value) {
    activeChatMode.value = 'group';
    activeGroupRoomId.value = typeof id === 'string' ? id : '';
    if (target) target.openGroup(typeof id === 'string' ? id : undefined);
  }
}, { immediate: true });
watch([() => route.query.run, workspace, view], async ([id, target]) => {
  if (!view.value && typeof id === 'string' && target) await target.openRun(id);
}, { immediate: true });
watch([() => route.query.session, workspace, view], ([id, target]) => {
  if (!view.value && route.query.group !== '1' && typeof id === 'string' && id && target) {
    activeChatMode.value = 'session';
    activeSessionId.value = id;
    target.openSession(id);
  }
}, { immediate: true });
function ready(hasSession: boolean) {
  if (!hasSession && !route.query.view && !route.query.run && !route.query.session && !route.query.group) void router.replace({ path: '/agent', query: { view: 'today' } });
}
function onWorkspaceShortcut(event: KeyboardEvent) {
  if (isZenToggleShortcut(event)) {
    if (document.querySelector('.el-message-box__wrapper:not([style*="display: none"])')) return;
    event.preventDefault();
    toggleZenFocus();
    ElMessage.info(zenFocusEnabled.value ? '已进入沉浸专注模式（⌘\\ 退出）' : '已恢复标准五区工作台布局');
  }
}
onMounted(() => {
  document.addEventListener('click', openThread);
  window.addEventListener('keydown', onWorkspaceShortcut);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', openThread);
  window.removeEventListener('keydown', onWorkspaceShortcut);
});
function openThread(event: MouseEvent) {
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return;
  const link = (event.target as Element).closest<HTMLAnchorElement>('a[href^="codex://threads/"]');
  if (!link) return;
  const id = link.getAttribute('href')?.split('/').at(-1) || '';
  if (workspace.value?.openSession(id)) { event.preventDefault(); open(); }
}

const fallbackQuickLinks = [
  { id: 'today', code: '01', label: '今日工作台', detail: '交付刻度 · 今日排期与记录', pinned: false },
  { id: 'overview', code: '02', label: '工作总览', detail: '自动队列 · 仓库改动 · Jira', pinned: false },
  { id: 'projects', code: '03', label: '本地项目与 Git', detail: '多工作树 · 分支与清理规则', pinned: false },
  { id: 'queue', code: '04', label: 'AI 交付队列', detail: '自动派发 · 巡检与合并请求', pinned: false },
  { id: 'settings', code: '05', label: '交付与连接设置', detail: 'Jira 凭据 · CLI 模型与策略', pinned: false },
];

const asideQuickLinks = computed(() => {
  const viewLookup = new Map<string, { label: string; sectionLabel: string }>();
  for (const sec of workspaceSections.value) {
    for (const item of sec.items) {
      if (!viewLookup.has(item.id)) {
        viewLookup.set(item.id, { label: item.label, sectionLabel: sec.label });
      }
    }
  }
  const fallbackMap = new Map(fallbackQuickLinks.map(item => [item.id, item]));
  const result: { id: string; code: string; label: string; detail: string; pinned: boolean }[] = [];
  const usedIds = new Set<string>();

  for (const pinId of pinnedCommandIds.value) {
    if (!pinId.startsWith('workspace:')) continue;
    const viewId = pinId.slice('workspace:'.length);
    if (!viewId || usedIds.has(viewId)) continue;
    const meta = viewLookup.get(viewId);
    const fb = fallbackMap.get(viewId);
    if (!meta && !fb) continue;
    usedIds.add(viewId);
    result.push({
      id: viewId,
      code: '★',
      label: meta?.label || fb?.label || viewId,
      detail: fb?.detail || `置顶常用 · ${meta?.sectionLabel || '工作区'}`,
      pinned: true,
    });
    if (result.length >= 6) break;
  }

  let seq = 1;
  for (const fb of fallbackQuickLinks) {
    if (result.length >= 6) break;
    if (usedIds.has(fb.id)) continue;
    usedIds.add(fb.id);
    result.push({
      ...fb,
      code: String(seq++).padStart(2, '0'),
    });
  }
  return result;
});

const pinnedWorkspaceCount = computed(() => asideQuickLinks.value.filter(item => item.pinned).length);

function openAccountsFromPalette() {
  const trigger = document.querySelector<HTMLButtonElement>('.cursor-accounts-trigger')
    || Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(btn => btn.textContent?.includes('多账号管理'));
  trigger?.click();
}

function refreshPageFromPalette() {
  const refreshBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('#workspace-panel-toolbar button, .workspace-page-head button, .group-quotas button'))
    .find(btn => btn.textContent?.includes('刷新'));
  refreshBtn?.click();
}

function openWallpaperPickerFromPalette() {
  paletteWallpaperInput.value?.click();
}

async function onPaletteWallpaperPicked(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (!isSupportedWallpaperFile(file)) {
    ElMessage.warning('请选择图片文件（支持 PNG / JPG / WebP / AVIF / SVG / HEIC 等）');
    return;
  }
  const saved = await updateCustomWallpaper(file);
  if (saved) ElMessage.success(`已切换壁纸：${file.name}`);
  else ElMessage.warning('壁纸已在当前会话生效');
}

async function generateWallpaperFromPalette() {
  await applyRandomAuroraWallpaper();
  ElMessage.success(`已生成流光壁纸：${customTheme.value.wallpaperName || '流光极光'}`);
}

async function cycleWallpaperFromPalette() {
  const label = await cycleActiveWallpaper();
  ElMessage.success(`已切换壁纸：${label}`);
}

function toggleDaylightFromPalette() {
  if (currentTheme.value.id === 'cinematic-video-hero') {
    toggleVideoDaylight();
    ElMessage.success(videoDaylightEnabled.value ? `已开启电影壁纸昼夜流转（${videoDaylightSlot.value.label}）` : '已关闭电影壁纸昼夜流转');
    return;
  }
  if (currentTheme.value.id !== 'immersive-photo') {
    setTheme('immersive-photo');
    togglePhotoDaylight(true);
    ElMessage.success(`已切换到沉浸摄影并开启昼夜流转（${photoDaylightSlot.value.label}）`);
    return;
  }
  togglePhotoDaylight();
  ElMessage.success(photoDaylightEnabled.value ? `已开启摄影壁纸昼夜流转（${photoDaylightSlot.value.label}）` : '已关闭摄影壁纸昼夜流转');
}
</script>

<template>
  <div
    class="workspace-console holy-grail-shell"
    :data-active-theme="currentTheme.id"
    :class="{
      'is-chat': !view,
      'is-rail-collapsed': railCollapsed,
      'is-zen-focus': zenFocusEnabled,
    }"
  >
    <!-- Immersive Photo, Cinematic Video & Custom Wallpaper Full-Viewport Backdrops -->
    <ImmersivePhotoStage v-if="currentTheme.id === 'immersive-photo'" mode="backdrop" />
    <CinematicVideoStage v-if="currentTheme.id === 'cinematic-video-hero'" mode="backdrop" />
    <CustomWallpaperStage v-if="currentTheme.id === 'custom'" />

    <!-- Zone 1: Sticky Top Header (56px) -->
    <header class="workspace-topbar hg-header" aria-label="工作台顶栏">
      <div class="hg-header-brand">
        <button type="button" class="workspace-brand" aria-label="我的工作台" title="返回今日工作台" @click="open('today')">
          <span class="workspace-brand-symbol"><LayoutGrid :size="16" /></span>
          <span class="workspace-brand-name">
            <strong class="acid-chrome" data-text="DELIVERY">DELIVERY</strong>
            <small>{{ activeDesignMd ? `${activeDesignMd.source} · :${localPort}` : `本机工作台 · :${localPort}` }}</small>
          </span>
        </button>
      </div>

      <nav class="hg-header-nav" aria-label="全局一级导航">
        <button type="button" :aria-current="!view ? 'page' : undefined" title="AI 对话" @click="open()">
          <MessagesSquare :size="14" />
          <span>AI 对话</span>
        </button>
        <button
          v-for="group in primaryHeaderSections"
          :key="group.id"
          type="button"
          :aria-label="group.label"
          :aria-current="section?.id === group.id ? 'page' : undefined"
          :title="group.label"
          @click="openSection(group)"
        >
          <component :is="navigationIcons[group.icon || group.id] || LayoutGrid" :size="14" />
          <span>{{ group.shortLabel || navigationLabels[group.id] || group.label }}</span>
        </button>
        <el-dropdown v-if="overflowHeaderSections.length" trigger="click" popper-class="hg-more-nav-popper">
          <button
            type="button"
            class="hg-more-nav-btn"
            :aria-current="activeOverflowSection ? 'page' : undefined"
            aria-label="更多工具与插件"
            title="展开更多工具与插件"
          >
            <component :is="activeOverflowSection ? (navigationIcons[activeOverflowSection.icon || activeOverflowSection.id] || LayoutGrid) : LayoutGrid" :size="14" />
            <span>{{ activeOverflowSection ? `更多 · ${activeOverflowSection.shortLabel || navigationLabels[activeOverflowSection.id] || activeOverflowSection.label}` : '更多工具' }}</span>
            <ChevronDown :size="13" />
          </button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item
                v-for="group in overflowHeaderSections"
                :key="group.id"
                :class="{ 'is-active': section?.id === group.id }"
                @click="openSection(group)"
              >
                <component :is="navigationIcons[group.icon || group.id] || LayoutGrid" :size="14" />
                <span>{{ group.label }}</span>
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </nav>

      <div class="hg-header-actions">
        <template v-if="currentTheme.id === 'cinematic-video-hero'">
          <button
            type="button"
            class="hg-frame-pill hg-cinema-pill"
            :title="`切换电影预告幕次（当前：${activeScene.title} · ${activeScene.specs}）`"
            @click="cycleScene"
          >
            <Film :size="13" />
            <span>{{ activeScene.code }} · {{ activeScene.title }}</span>
          </button>
          <button
            type="button"
            class="hg-frame-pill hg-cinema-toggle"
            :class="{ 'is-paused': !loopEnabled }"
            :aria-pressed="loopEnabled"
            :aria-label="loopEnabled ? '暂停背景视频循环' : '播放背景视频循环'"
            :title="loopEnabled ? '暂停背景循环预告片（保留海报静帧）' : '播放背景静音循环预告片'"
            @click="toggleLoop"
          >
            <Pause v-if="loopEnabled" :size="12" />
            <Play v-else :size="12" />
          </button>
        </template>
        <button
          v-else-if="currentTheme.id === 'immersive-photo'"
          type="button"
          class="hg-frame-pill"
          :title="`切换摄影画幅（当前：${activeFrame.title} · ${activeFrame.meta}）`"
          @click="cycleFrame"
        >
          <Camera :size="13" />
          <span>{{ activeFrame.code }} · {{ activeFrame.title }}</span>
        </button>
        <button
          v-if="isWallpaperThemeActive"
          type="button"
          class="hg-frame-pill hg-showcase-pill"
          aria-label="进入壁纸时钟屏保预览"
          title="全屏欣赏壁纸与数字时钟屏保（ESC 退出）"
          @click="openAmbientShowcase"
        >
          <Clock3 :size="13" />
          <span>屏保</span>
        </button>
        <button
          type="button"
          class="hg-zen-trigger"
          :class="{ active: zenFocusEnabled }"
          :aria-pressed="zenFocusEnabled"
          :aria-label="zenFocusEnabled ? '退出沉浸专注模式' : '进入沉浸专注模式'"
          :title="zenFocusEnabled ? '退出沉浸专注模式 (⌘\\ / Ctrl+\\)' : '进入沉浸专注模式：收起左右侧栏与底栏 (⌘\\ / Ctrl+\\)'"
          @click="toggleZenFocus"
        >
          <Minimize2 v-if="zenFocusEnabled" :size="13" />
          <Maximize2 v-else :size="13" />
          <span v-if="zenFocusEnabled">退出专注</span>
        </button>
        <button
          type="button"
          class="hg-cmd-trigger"
          aria-label="打开全局快速跳转与命令面板"
          title="快速搜索工作区、动作或切换主题 (⌘K / Ctrl+K)"
          @click="commandPaletteOpen = true"
        >
          <Search :size="13" />
          <span>快速跳转</span>
          <kbd>⌘K</kbd>
        </button>
        <button type="button" class="hg-acid-cta" aria-label="发起新对话" title="立即发起新对话" @click="compose('')">
          <Plus :size="14" />
          <span>新对话</span>
        </button>
        <span v-if="view" id="workspace-connection-status" class="hg-connection-slot"></span>
        <ThemePicker />
      </div>
    </header>

    <!-- Middle 3-Column Body (Zones 2, 3, 4) -->
    <AgentWorkspace ref="workspace" :workbench-open="!!view" @chat="openSingleChat" @group="openGroup" @session="onSessionChange" @ready="ready">
      <template #navigation="context">
        <nav v-if="context.placement !== 'footer'" class="workspace-navigation" aria-label="统一工作入口">
          <button type="button" :class="{ active: !view }" :aria-current="!view ? 'page' : undefined" title="会话" @click="open(); context.closeNavigation()"><MessagesSquare :size="17" /><span>会话</span></button>
          <button v-for="group in workspaceSections" :key="group.id" type="button" :class="{ active: section?.id === group.id }" :aria-label="group.label" :aria-current="section?.id === group.id ? 'page' : undefined" :title="group.label" @click="openSection(group); context.closeNavigation()"><component :is="navigationIcons[group.icon || group.id] || LayoutGrid" :size="17" /><span>{{ group.id === 'today' ? '今日' : group.id === 'automation' ? '设置' : group.label }}</span></button>
        </nav>
      </template>

      <template #workbench="context">
        <section v-if="view" class="workspace-panel hg-workbench" :class="{ 'workspace-panel--embedded': fullHeightPanel }" aria-label="工作面板">
          <div class="hg-body-grid" :class="{ 'is-embedded': fullHeightPanel, 'is-left-collapsed': railCollapsed }">
            <!-- Zone 2: Left Fixed Navigation Sidebar (240px) -->
            <aside class="hg-left-rail" aria-label="功能目录导航栏">
              <div class="hg-rail-top">
                <span class="hg-zone-tag">功能目录</span>
                <button type="button" class="workspace-rail-toggle" :aria-label="railCollapsed ? '展开左侧栏' : '收起左侧栏'" :title="railCollapsed ? '展开左侧栏' : '收起左侧栏'" @click="toggleRail">
                  <component :is="railCollapsed ? PanelLeftOpen : PanelLeftClose" :size="14" />
                </button>
              </div>

              <div class="hg-rail-studio">
                <button type="button" class="hg-studio-btn" @click="open()">
                  <MessagesSquare :size="15" />
                  <span>返回 AI 对话</span>
                </button>
                <button type="button" class="hg-studio-group" title="团队群聊协作" aria-label="团队群聊协作" @click="openGroup()">
                  <Users :size="14" />
                </button>
              </div>

              <nav class="hg-rail-groups" aria-label="工作区模块目录">
                <div v-if="coreSections.length" class="hg-rail-group">
                  <span class="hg-rail-heading">日常工作</span>
                  <div v-for="group in coreSections" :key="group.id" class="hg-rail-node">
                    <button type="button" class="hg-rail-item" :aria-current="section?.id === group.id ? 'page' : undefined" :title="group.label" @click="openSection(group)">
                      <component :is="navigationIcons[group.icon || group.id] || LayoutGrid" :size="15" />
                      <span>{{ group.label }}</span>
                    </button>
                    <div v-if="!railCollapsed && section?.id === group.id && group.items.length > 1" class="hg-rail-subitems">
                      <button v-for="sub in group.items" :key="sub.id" type="button" :aria-current="view.id === sub.id ? 'page' : undefined" @click="open(sub.id)">
                        {{ sub.label }}
                      </button>
                    </div>
                  </div>
                </div>

                <div v-if="deliverySections.length" class="hg-rail-group">
                  <span class="hg-rail-heading">扩展工具</span>
                  <div v-for="group in deliverySections" :key="group.id" class="hg-rail-node">
                    <button type="button" class="hg-rail-item" :aria-current="section?.id === group.id ? 'page' : undefined" :title="group.label" @click="openSection(group)">
                      <component :is="navigationIcons[group.icon || group.id] || LayoutGrid" :size="15" />
                      <span>{{ group.label }}</span>
                    </button>
                    <div v-if="!railCollapsed && section?.id === group.id && group.items.length > 1" class="hg-rail-subitems">
                      <button v-for="sub in group.items" :key="sub.id" type="button" :aria-current="view.id === sub.id ? 'page' : undefined" @click="open(sub.id)">
                        {{ sub.label }}
                      </button>
                    </div>
                  </div>
                </div>

                <div v-if="systemSections.length" class="hg-rail-group">
                  <span class="hg-rail-heading">系统与设置</span>
                  <div v-for="group in systemSections" :key="group.id" class="hg-rail-node">
                    <button type="button" class="hg-rail-item" :aria-current="section?.id === group.id ? 'page' : undefined" :title="group.label" @click="openSection(group)">
                      <component :is="navigationIcons[group.icon || group.id] || LayoutGrid" :size="15" />
                      <span>{{ group.label }}</span>
                    </button>
                    <div v-if="!railCollapsed && section?.id === group.id && group.items.length > 1" class="hg-rail-subitems">
                      <button v-for="sub in group.items" :key="sub.id" type="button" :aria-current="view.id === sub.id ? 'page' : undefined" @click="open(sub.id)">
                        {{ sub.label }}
                      </button>
                    </div>
                  </div>
                </div>
              </nav>
            </aside>

            <!-- Zone 3: Fluid Main Content Column (minmax(0, 1fr)) -->
            <div class="hg-main-column">
              <header class="workspace-page-head">
                <div class="workspace-page-lead">
                  <div class="workspace-page-identity">
                    <span class="workspace-page-symbol"><component :is="navigationIcons[section.icon || section.id] || LayoutGrid" v-if="section" :size="16" /></span>
                    <div><p>{{ view.customPluginId ? '扩展插件' : section?.label }}</p><h1>{{ view.label }}</h1></div>
                  </div>
                  <nav v-if="!fullHeightPanel && (!view.customPluginId || (section?.items.length || 0) > 1)" class="workspace-view-tabs" aria-label="工作面板视图">
                    <button v-for="item in section?.items" :key="item.id" type="button" :aria-current="view.id === item.id ? 'page' : undefined" @click="open(item.id)">{{ item.label }}</button>
                  </nav>
                </div>
                <div class="workspace-page-tools">
                  <div v-if="!fullHeightPanel" id="workspace-panel-toolbar"></div>
                  <span v-if="fullHeightPanel" id="workspace-embedded-actions"></span>
                  <span class="workspace-mobile-theme"><ThemePicker /></span>
                  <button class="workspace-back" type="button" aria-label="返回会话" title="返回会话" @click="open()"><MessagesSquare :size="14" /><span>返回对话</span></button>
                </div>
              </header>

              <component :is="panel" v-if="fullHeightPanel" />
              <WorkspacePanelViewport v-else :key="view.id" :view-id="view.id">
                <div v-if="!pluginReady" class="plugin-unavailable"><h2>{{ view.label }}</h2><p>{{ integrations.query.isPending.value ? '正在读取插件状态…' : integrations.query.error.value?.message || '提供此功能的插件未启用、已移除或尚未配置。历史数据仍保留，接入后可继续使用原功能。' }}</p><el-button @click="router.push({ path: '/agent', query: { view: 'settings', settingsTab: 'plugins' } })">管理接入插件</el-button></div>
                <AgentAutomationPanel v-else-if="view.id === 'automation'" :scoped-jobs="[]" :daily-report-available="context.dailyReportAvailable" :daily-report-pending="context.dailyReportPending" :daily-report-for-date="context.dailyReportForDate" @generate-daily-report="context.generateDailyReport" @compose="compose" />
                <RequirementDevelopment v-else-if="view.id === 'design'" @open-run="openRun" />
                <component :is="panel" v-else v-bind="view.customPluginId ? { dedicated: true } : 'mode' in view ? { mode: view.mode } : {}" @open-run="openRun" />
              </WorkspacePanelViewport>
            </div>

            <!-- Zone 4: Right Fixed Contextual Sidebar (280px) -->
            <aside v-if="!fullHeightPanel" class="hg-right-aside" aria-label="右侧快捷入口栏">
              <div class="hg-aside-head">
                <span class="hg-zone-tag">快捷入口</span>
              </div>
              <div id="hg-aside-slot" class="hg-aside-slot"></div>

              <div class="hg-aside-fallback">
                <section class="hg-aside-card">
                  <header><strong>当前页面</strong><span>:{{ localPort }}</span></header>
                  <p class="hg-aside-title">{{ section?.label || '工作台' }} · {{ view.label }}</p>
                  <div v-if="(section?.items.length || 0) > 1" class="hg-aside-pills">
                    <button v-for="sub in section?.items" :key="sub.id" type="button" :class="{ active: view.id === sub.id }" @click="open(sub.id)">
                      {{ sub.label }}
                    </button>
                  </div>
                </section>

                <section class="hg-aside-card">
                  <header>
                    <strong>常用功能</strong>
                    <span v-if="pinnedWorkspaceCount > 0">已置顶 {{ pinnedWorkspaceCount }}</span>
                  </header>
                  <nav class="hg-aside-links" aria-label="侧栏快捷跳转">
                    <button v-for="item in asideQuickLinks" :key="item.id" type="button" :class="{ active: view.id === item.id, 'is-pinned': item.pinned }" @click="open(item.id)">
                      <em>{{ item.code }}</em>
                      <div>
                        <strong>{{ item.label }}</strong>
                        <small>{{ item.detail }}</small>
                      </div>
                      <ArrowUpRight :size="13" />
                    </button>
                  </nav>
                </section>

                <section class="hg-aside-card hg-aside-cta-box">
                  <header><strong>AI 对话助手</strong></header>
                  <p>随时发起对话，帮您写代码、查问题或检查改动。</p>
                  <button type="button" class="hg-acid-cta full" @click="compose('')">
                    <Plus :size="14" />
                    <span>发起新对话</span>
                  </button>
                </section>
              </div>
            </aside>
          </div>
        </section>
      </template>
    </AgentWorkspace>

    <!-- Zone 5: Persistent Bottom Footer (40px) -->
    <footer class="hg-footer" aria-label="工作台页脚">
      <div class="hg-footer-left">
        <span class="hg-footer-dot"></span>
        <strong>研发交付工作台</strong>
        <span>本机 127.0.0.1:{{ localPort }}</span>
        <span class="hg-footer-sep" aria-hidden="true">·</span>
        <button type="button" class="hg-footer-cmd" title="打开命令面板 (⌘K / Ctrl+K)" @click="commandPaletteOpen = true">
          <kbd>⌘K</kbd>
          <span>命令面板</span>
        </button>
      </div>
      <div class="hg-footer-center" aria-hidden="true"></div>
      <nav class="hg-footer-links" aria-label="页脚导航链接">
        <button type="button" @click="open()">对话</button>
        <button type="button" @click="open('today')">今日</button>
        <button type="button" @click="open('overview')">总览</button>
        <button type="button" @click="open('projects')">项目</button>
        <button type="button" @click="open('queue')">队列</button>
        <button type="button" @click="open('settings')">设置</button>
      </nav>
    </footer>

    <input
      ref="paletteWallpaperInput"
      type="file"
      style="position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap"
      accept="image/*,.png,.jpg,.jpeg,.webp,.avif,.gif,.svg,.bmp,.ico,.heic,.heif"
      @change="onPaletteWallpaperPicked"
    />

    <AmbientWallpaperShowcase :local-port="localPort" />

    <WorkspaceCommandPalette
      v-model="commandPaletteOpen"
      :sections="workspaceSections"
      :current-view-id="view?.id"
      :is-chat-active="!view"
      :chat-mode="activeChatMode"
      :active-session-id="activeSessionId"
      :active-group-room-id="activeGroupRoomId"
      :rail-collapsed="railCollapsed"
      :zen-focus-enabled="zenFocusEnabled"
      :current-theme-id="currentTheme.id"
      :daylight-enabled="currentTheme.id === 'cinematic-video-hero' ? videoDaylightEnabled : photoDaylightEnabled"
      @open-view="open"
      @open-session="openPaletteSession"
      @new-chat="compose('')"
      @open-group="openGroup"
      @open-accounts="openAccountsFromPalette"
      @toggle-rail="toggleRail"
      @toggle-zen="toggleZenFocus"
      @open-showcase="openAmbientShowcase"
      @refresh-page="refreshPageFromPalette"
      @select-theme="setTheme"
      @upload-wallpaper="openWallpaperPickerFromPalette"
      @generate-wallpaper="generateWallpaperFromPalette"
      @cycle-wallpaper="cycleWallpaperFromPalette"
      @toggle-daylight="toggleDaylightFromPalette"
      @pins-change="pinnedCommandIds = $event"
    />
  </div>
</template>

<style scoped>
.workspace-navigation{display:flex;align-items:center;gap:8px;min-height:48px;padding:8px 16px;border-bottom:1px solid var(--agent-border);background:var(--agent-panel)}
.workspace-navigation button{display:inline-flex;align-items:center;gap:6px;padding:8px 12px;border:0;border-radius:var(--ds-radius-sm, 0px);background:transparent;color:var(--ui-secondary);font:500 14px/20px var(--sans);cursor:pointer}
.workspace-navigation button > span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workspace-navigation button:hover{background:var(--ui-hover);color:var(--ui-text)}
.workspace-navigation button.active{background:var(--ui-accent-soft);color:var(--ui-accent);font-weight:700}
.plugin-unavailable{padding:24px}.workspace-panel{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--ui-bg);color:var(--ui-text)}
.hg-header-nav button, .hg-header-nav :deep(.hg-more-nav-btn) { padding: 0 10px; gap: 6px; font-size: 12.5px; }
.hg-zen-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 30px;
  min-width: 30px;
  padding: 0 8px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius-sm, 7px);
  background: var(--ui-raised);
  color: var(--ui-muted);
  font: 500 12px/1 var(--sans);
  cursor: pointer;
  transition: border-color 140ms ease, color 140ms ease, background-color 140ms ease;
}
.hg-zen-trigger:hover {
  border-color: color-mix(in srgb, var(--ui-text) 24%, var(--ui-border));
  background: var(--ui-surface);
  color: var(--ui-text);
}
.hg-zen-trigger.active {
  border-color: var(--ui-accent);
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
  font-weight: 600;
}
:global(:root[data-theme='acid']) .hg-zen-trigger {
  border-radius: 0;
}
.hg-cmd-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 8px 0 9px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius-sm, 7px);
  background: var(--ui-raised);
  color: var(--ui-muted);
  font: 450 12px/1 var(--sans);
  cursor: pointer;
  transition: border-color 140ms ease, color 140ms ease, background-color 140ms ease;
}
.hg-cmd-trigger:hover {
  border-color: color-mix(in srgb, var(--ui-text) 24%, var(--ui-border));
  background: var(--ui-surface);
  color: var(--ui-text);
}
.hg-cmd-trigger kbd {
  display: inline-grid;
  place-items: center;
  height: 18px;
  padding: 0 5px;
  border: 1px solid var(--ui-border);
  border-radius: 4px;
  background: var(--ui-surface);
  color: var(--ui-secondary);
  font: 600 10px/1 var(--mono);
}
:global(:root[data-theme='acid']) .hg-cmd-trigger,
:global(:root[data-theme='acid']) .hg-cmd-trigger kbd {
  border-radius: 0;
}
.hg-footer-sep {
  color: var(--ui-muted);
  opacity: 0.5;
}
.hg-footer-cmd {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 5px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--ui-muted);
  font: 450 11px/1.2 var(--sans);
  cursor: pointer;
  transition: color 140ms ease, background-color 140ms ease;
}
.hg-footer-cmd:hover {
  background: var(--ui-hover);
  color: var(--ui-text);
}
.hg-footer-cmd kbd {
  padding: 0 4px;
  border: 1px solid var(--ui-border);
  border-radius: 3px;
  background: var(--ui-surface);
  color: var(--ui-secondary);
  font: 600 9.5px/14px var(--mono);
}
@media (max-width: 1180px) {
  .hg-cmd-trigger span { display: none; }
}
:global(.hg-more-nav-popper.el-popper) { --el-bg-color-overlay: var(--ui-surface); --el-text-color-regular: var(--ui-text); --el-fill-color-light: var(--ui-raised); border-color: var(--ui-border); border-radius: 10px; background: var(--ui-surface); box-shadow: var(--ui-shadow); }
:global(.hg-more-nav-popper .el-dropdown-menu__item) { display: flex; align-items: center; gap: 8px; border-radius: 7px; color: var(--ui-secondary); font-size: 13px; padding: 7px 12px; }
:global(.hg-more-nav-popper .el-dropdown-menu__item:hover) { background: var(--ui-raised); color: var(--ui-text); }
:global(.hg-more-nav-popper .el-dropdown-menu__item.is-active) { background: var(--ui-accent-soft); color: var(--ui-accent); font-weight: 600; }
</style>

<style src="./workspace-pages.css"></style>
<style src="../../app/design-system.css"></style>
<style src="./workspace-layout.css"></style>
<style src="../../app/design-md-themes.css"></style>
<style src="../../app/workspace-refinement.css"></style>
