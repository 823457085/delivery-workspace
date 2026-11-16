<script setup lang="ts">
/**
 * 全局命令与快速跳转面板（⌘K / Ctrl+K）
 * 借鉴 GitHub 开源工作台 Plane / OpenCode / Open WebUI / Zed / LobeChat：
 * 支持实时检索单人 AI 会话与团队协作群聊（@ 前缀）、直达工作区视图（/ 前缀）、触发高频动作（> 前缀）及切换 23 套主题预设（# 前缀）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, shallowRef, useTemplateRef, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { CornerDownLeft, Layers, MessagesSquare, Palette, Pin, RadioTower, Search, Sparkles, Star, Users, X } from '@lucide/vue';
import { agentProviderLabels, type AgentRuntimeDashboard } from '../../../shared/agent-runtime';
import type { PortSnapshot } from '../../../shared/port-monitor';
import type { ThemePreference } from '../../shared/theme/theme';
import { dateTime } from '../../shared/format';
import { buildAgentConversationList } from '../../features/agent-workbench/conversation';
import { readGroupDashboard } from '../../features/agent-workbench/group-chat-api';
import { useAgentBookmarks } from '../../features/agent-workbench/useAgentBookmarks';
import type { WorkspaceSection } from './workspace-navigation';
import {
  buildCommandPaletteItems,
  filterCommandPaletteItems,
  type CommandCategory,
  type CommandPaletteItem,
  type CommandPaletteThread,
} from './command-palette';
import {
  readCommandUsageList,
  recordCommandUsageEntry,
  writeCommandUsageList,
  type CommandUsageEntry,
} from './command-palette-history';
import {
  buildPortCommandItems,
  readPinnedCommandIds,
  togglePinnedCommandId,
  writePinnedCommandIds,
} from './command-palette-pins';

const props = defineProps<{
  sections: WorkspaceSection[];
  currentViewId?: string;
  isChatActive: boolean;
  chatMode: 'session' | 'group';
  activeSessionId?: string;
  activeGroupRoomId?: string;
  railCollapsed: boolean;
  zenFocusEnabled?: boolean;
  currentThemeId: string;
  daylightEnabled?: boolean;
}>();

const open = defineModel<boolean>({ default: false });

const emit = defineEmits<{
  openView: [id?: string];
  openSession: [sessionId: string];
  newChat: [];
  openGroup: [roomId?: string];
  openAccounts: [];
  toggleRail: [];
  toggleZen: [];
  openShowcase: [];
  refreshPage: [];
  selectTheme: [theme: ThemePreference];
  uploadWallpaper: [];
  generateWallpaper: [];
  cycleWallpaper: [];
  toggleDaylight: [];
  pinsChange: [ids: string[]];
}>();

const queryClient = useQueryClient();
const runtimeQuery = useQuery<AgentRuntimeDashboard>({
  queryKey: ['agent-runtimes'],
  staleTime: 15_000,
  enabled: computed(() => open.value),
  retry: false,
  queryFn: async ({ signal }) => {
    const response = await fetch('/api/agent-runtimes?status=0', { signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Agent 状态读取失败');
    const current = queryClient.getQueryData<AgentRuntimeDashboard>(['agent-runtimes']);
    return current && current.revision > data.revision ? current : data;
  },
});

const groupQuery = useQuery({
  queryKey: ['agent-group-chat'],
  staleTime: 15_000,
  enabled: computed(() => open.value),
  retry: false,
  queryFn: ({ signal }) => readGroupDashboard(signal),
});

function leafFolder(path?: string) {
  if (!path) return '';
  const parts = path.replaceAll('\\', '/').split('/').filter(Boolean);
  return parts.at(-1) || '';
}

const liveThreads = computed<CommandPaletteThread[]>(() => {
  const entries: { updatedMs: number; thread: CommandPaletteThread }[] = [];
  const rooms = groupQuery.data.value?.rooms || [];
  for (const room of rooms) {
    const folder = leafFolder(room.workspacePath) || '未指定目录';
    entries.push({
      updatedMs: Date.parse(room.updatedAt) || 0,
      thread: {
        id: room.id,
        kind: 'group',
        title: room.title || '未命名团队群聊',
        subtitle: `团队协作群 · ${folder} · ${dateTime(room.updatedAt)}`,
        badge: '群聊',
        keywords: `${room.workspacePath} ${room.title}`,
        active: props.isChatActive && props.chatMode === 'group' && props.activeGroupRoomId === room.id,
      },
    });
  }

  const runtimeData = runtimeQuery.data.value;
  if (runtimeData) {
    const soloRuns = (runtimeData.runs || []).filter(run => run.team?.interactionMode !== 'group');
    const conversations = buildAgentConversationList(
      soloRuns,
      runtimeData.codexSessions || [],
      {},
      runtimeData.conversationTitles || {},
    );
    for (const conv of conversations) {
      if (conv.archived) continue;
      const providerLabel = agentProviderLabels[conv.latest.provider] || conv.latest.provider;
      const folder = leafFolder(conv.latest.workspacePath) || '未绑定项目';
      entries.push({
        updatedMs: Date.parse(conv.updatedAt) || 0,
        thread: {
          id: conv.id,
          kind: 'session',
          title: conv.title || '未命名会话',
          subtitle: `${providerLabel} · ${folder} · ${dateTime(conv.updatedAt)}`,
          badge: providerLabel,
          keywords: `${conv.latest.workspacePath} ${conv.latest.branch} ${conv.latest.provider}`,
          active: props.isChatActive && props.chatMode === 'session' && props.activeSessionId === conv.id,
        },
      });
    }
  }

  return entries
    .sort((a, b) => (Number(!!b.thread.active) - Number(!!a.thread.active)) || (b.updatedMs - a.updatedMs))
    .slice(0, 40)
    .map(entry => entry.thread);
});

const bookmarkStore = useAgentBookmarks();
const usageEntries = shallowRef<CommandUsageEntry[]>(readCommandUsageList());
const pinnedIds = shallowRef<string[]>(readPinnedCommandIds());
const openedAtMs = shallowRef(Date.now());
const query = shallowRef('');
const category = shallowRef<'all' | CommandCategory>('all');
const activeIndex = shallowRef(0);
const searchInput = useTemplateRef<HTMLInputElement>('searchInput');
const listContainer = useTemplateRef<HTMLDivElement>('listContainer');

const portsNeeded = computed(() => {
  if (!open.value) return false;
  const q = query.value.trim();
  return (
    category.value === 'port'
    || q.startsWith(':')
    || q.startsWith('：')
    || q.includes('端口')
    || q.toLowerCase().includes('port')
    || pinnedIds.value.some(id => id.startsWith('port:'))
  );
});

const portsQuery = useQuery<PortSnapshot>({
  queryKey: ['cmd-palette-ports'],
  staleTime: 12_000,
  enabled: portsNeeded,
  retry: false,
  queryFn: async ({ signal }) => {
    const response = await fetch('/api/ports', { signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '端口列表读取失败');
    return data;
  },
});

const portItems = computed(() => buildPortCommandItems(portsQuery.data.value));

const allItems = computed(() =>
  buildCommandPaletteItems({
    sections: props.sections,
    currentViewId: props.currentViewId,
    isChatActive: props.isChatActive,
    chatMode: props.chatMode,
    railCollapsed: props.railCollapsed,
    zenFocusEnabled: props.zenFocusEnabled,
    currentThemeId: props.currentThemeId,
    daylightEnabled: props.daylightEnabled,
    threads: liveThreads.value,
    bookmarks: bookmarkStore.bookmarks.value,
    ports: portItems.value,
  }),
);

const filteredItems = computed(() =>
  filterCommandPaletteItems(
    allItems.value,
    query.value,
    category.value,
    usageEntries.value,
    openedAtMs.value,
    pinnedIds.value,
  ),
);

const groupedSections = computed(() => {
  const labels: Record<CommandCategory, string> = {
    action: '快捷动作',
    bookmark: '重点收藏书签',
    thread: '最近会话与协作群聊',
    port: '本机监听端口',
    workspace: '工作区视图',
    theme: '外观主题预设',
  };
  const order: CommandCategory[] = ['action', 'bookmark', 'thread', 'port', 'workspace', 'theme'];
  const groups: { key: string; label: string; entries: { item: CommandPaletteItem; flatIndex: number }[] }[] = [];
  let flatCursor = 0;

  const showTopPins = !query.value.trim() && category.value === 'all';
  const pinnedShown = new Set<string>();
  if (showTopPins) {
    const pinnedEntries = filteredItems.value
      .filter(item => item.pinned)
      .map(item => {
        pinnedShown.add(item.id);
        return { item, flatIndex: flatCursor++ };
      });
    if (pinnedEntries.length) {
      groups.push({ key: 'pinned', label: '置顶常用 (⌘P)', entries: pinnedEntries });
    }
  }

  for (const cat of order) {
    const entries = filteredItems.value
      .filter(item => item.category === cat && !pinnedShown.has(item.id))
      .map(item => ({ item, flatIndex: flatCursor++ }));
    if (entries.length) {
      groups.push({ key: cat, label: labels[cat], entries });
    }
  }
  return groups;
});

const navigableItems = computed(() => groupedSections.value.flatMap(group => group.entries.map(entry => entry.item)));

watch([query, category], () => {
  activeIndex.value = 0;
});

watch(open, async isOpen => {
  if (isOpen) {
    openedAtMs.value = Date.now();
    usageEntries.value = readCommandUsageList();
    pinnedIds.value = readPinnedCommandIds();
    bookmarkStore.reloadBookmarks();
    query.value = '';
    category.value = 'all';
    activeIndex.value = 0;
    await nextTick();
    searchInput.value?.focus();
  }
});

function togglePin(item?: CommandPaletteItem) {
  if (!item) return;
  const result = togglePinnedCommandId(pinnedIds.value, item.id);
  pinnedIds.value = result.ids;
  writePinnedCommandIds(result.ids);
  emit('pinsChange', result.ids);
  ElMessage.success(result.pinned ? `已置顶到常用：${item.title}` : `已取消置顶：${item.title}`);
  searchInput.value?.focus();
}

function scrollActiveIntoView() {
  void nextTick(() => {
    const container = listContainer.value;
    if (!container) return;
    const target = container.querySelector<HTMLElement>(`[data-cmd-index="${activeIndex.value}"]`);
    target?.scrollIntoView({ block: 'nearest' });
  });
}

function stepSelection(delta: 1 | -1) {
  const total = navigableItems.value.length;
  if (!total) return;
  activeIndex.value = (activeIndex.value + delta + total) % total;
  scrollActiveIntoView();
}

function executeItem(item?: CommandPaletteItem, shiftKey = false) {
  if (!item) return;
  const nextUsage = recordCommandUsageEntry(usageEntries.value, item.id);
  usageEntries.value = nextUsage;
  writeCommandUsageList(nextUsage);
  open.value = false;
  if (item.category === 'port' && item.portNumber) {
    if (shiftKey) {
      emit('openView', 'ports');
    } else {
      window.open(`http://127.0.0.1:${item.portNumber}`, '_blank', 'noopener,noreferrer');
    }
    return;
  }
  if (item.category === 'bookmark') {
    if (item.bookmarkContent) {
      navigator.clipboard?.writeText(item.bookmarkContent)
        .then(() => ElMessage.success('已复制收藏内容，可直接粘贴使用'))
        .catch(() => {
          if (item.sessionId) emit('openSession', item.sessionId);
        });
    } else if (item.sessionId) {
      emit('openSession', item.sessionId);
    }
    return;
  }
  if (item.category === 'thread') {
    if (item.groupRoomId) emit('openGroup', item.groupRoomId);
    else if (item.sessionId) emit('openSession', item.sessionId);
    return;
  }
  if (item.category === 'workspace' && item.viewId) {
    emit('openView', item.viewId);
    return;
  }
  if (item.category === 'theme' && item.themeId) {
    emit('selectTheme', item.themeId);
    return;
  }
  switch (item.actionId) {
    case 'new-chat':
      emit('newChat');
      break;
    case 'new-group':
      emit('openGroup');
      break;
    case 'open-chat':
      emit('openView', undefined);
      break;
    case 'open-accounts':
      emit('openAccounts');
      break;
    case 'toggle-rail':
      emit('toggleRail');
      break;
    case 'toggle-zen':
      emit('toggleZen');
      break;
    case 'open-showcase':
      emit('openShowcase');
      break;
    case 'refresh-page':
      emit('refreshPage');
      break;
    case 'upload-wallpaper':
      emit('uploadWallpaper');
      break;
    case 'generate-wallpaper':
      emit('generateWallpaper');
      break;
    case 'cycle-wallpaper':
      emit('cycleWallpaper');
      break;
    case 'toggle-daylight':
      emit('toggleDaylight');
      break;
  }
}

function onPaletteKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return;
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'p') {
    event.preventDefault();
    togglePin(navigableItems.value[activeIndex.value]);
    return;
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    stepSelection(1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    stepSelection(-1);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    executeItem(navigableItems.value[activeIndex.value], event.shiftKey);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    open.value = false;
  }
}

function onGlobalKeydown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') {
    if (document.querySelector('.el-message-box__wrapper:not([style*="display: none"])')) return;
    event.preventDefault();
    open.value = !open.value;
  }
}

onMounted(() => window.addEventListener('keydown', onGlobalKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKeydown));

const filterTabs = computed<{ id: 'all' | CommandCategory; label: string }[]>(() => [
  { id: 'all', label: '全部' },
  { id: 'thread', label: '会话' },
  ...(bookmarkStore.bookmarks.value.length ? [{ id: 'bookmark' as const, label: '收藏' }] : []),
  { id: 'workspace', label: '工作区' },
  { id: 'port', label: '端口' },
  { id: 'action', label: '动作' },
  { id: 'theme', label: '主题' },
]);
</script>

<template>
  <Teleport to="body">
    <Transition name="cmd-palette-fade">
      <div
        v-if="open"
        class="cmd-palette-backdrop"
        role="dialog"
        aria-modal="true"
        aria-label="全局快速跳转与命令面板"
        @mousedown.self="open = false"
        @keydown="onPaletteKeydown"
      >
        <div class="cmd-palette-panel">
          <header class="cmd-palette-head">
            <Search :size="16" class="cmd-search-icon" />
            <input
              ref="searchInput"
              v-model="query"
              type="text"
              class="cmd-search-input"
              placeholder="搜索会话、工作区、端口或动作…（@ 会话，: 端口，> 动作，# 主题）"
              aria-label="命令面板搜索"
              autocomplete="off"
              spellcheck="false"
            />
            <button
              v-if="query"
              type="button"
              class="cmd-clear-btn"
              aria-label="清空搜索"
              @click="query = ''; searchInput?.focus()"
            >
              <X :size="13" />
            </button>
            <div class="cmd-filter-pills" role="tablist" aria-label="命令分类筛选">
              <button
                v-for="tab in filterTabs"
                :key="tab.id"
                type="button"
                role="tab"
                :aria-selected="category === tab.id"
                :class="{ active: category === tab.id }"
                @click="category = tab.id; searchInput?.focus()"
              >
                {{ tab.label }}
              </button>
            </div>
          </header>

          <div ref="listContainer" class="cmd-palette-list" role="listbox">
            <template v-if="groupedSections.length">
              <section v-for="group in groupedSections" :key="group.key" class="cmd-group">
                <header class="cmd-group-title">
                  <span>{{ group.label }}</span>
                  <small>{{ group.entries.length }}</small>
                </header>
                <div
                  v-for="entry in group.entries"
                  :key="entry.item.id"
                  role="option"
                  tabindex="-1"
                  class="cmd-item"
                  :class="{
                    'is-selected': activeIndex === entry.flatIndex,
                    'is-current': entry.item.active,
                    'is-pinned': entry.item.pinned,
                  }"
                  :aria-selected="activeIndex === entry.flatIndex"
                  :data-cmd-index="entry.flatIndex"
                  @mouseenter="activeIndex = entry.flatIndex"
                  @click="executeItem(entry.item, $event.shiftKey)"
                >
                  <span v-if="entry.item.colors" class="cmd-theme-swatches" aria-hidden="true">
                    <i :style="{ background: entry.item.colors[0] }" />
                    <i :style="{ background: entry.item.colors[1] }" />
                    <i :style="{ background: entry.item.colors[2] }" />
                  </span>
                  <span v-else class="cmd-item-icon" aria-hidden="true">
                    <Sparkles v-if="entry.item.category === 'action'" :size="14" />
                    <Star v-else-if="entry.item.category === 'bookmark'" :size="14" />
                    <RadioTower v-else-if="entry.item.category === 'port'" :size="14" />
                    <Users v-else-if="entry.item.category === 'thread' && entry.item.groupRoomId" :size="14" />
                    <MessagesSquare v-else-if="entry.item.category === 'thread'" :size="14" />
                    <Palette v-else-if="entry.item.category === 'theme'" :size="14" />
                    <Layers v-else :size="14" />
                  </span>

                  <span class="cmd-item-body">
                    <strong>
                      {{ entry.item.title }}
                      <em v-if="entry.item.active" class="cmd-current-tag">当前</em>
                      <em v-if="entry.item.pinned" class="cmd-pin-tag">置顶</em>
                      <em v-else-if="entry.item.frequentlyUsed" class="cmd-freq-tag">常用</em>
                    </strong>
                    <small>{{ entry.item.subtitle }}</small>
                  </span>

                  <span class="cmd-item-tail">
                    <kbd v-if="entry.item.shortcut" class="cmd-shortcut-kbd">{{ entry.item.shortcut }}</kbd>
                    <span v-if="entry.item.badge" class="cmd-item-badge">{{ entry.item.badge }}</span>
                    <button
                      type="button"
                      class="cmd-pin-btn"
                      :class="{ active: entry.item.pinned }"
                      :aria-label="entry.item.pinned ? `取消置顶 ${entry.item.title}` : `置顶 ${entry.item.title}`"
                      :title="entry.item.pinned ? '取消置顶 (⌘P)' : '置顶到顶部与常用功能 (⌘P)'"
                      @click.stop="togglePin(entry.item)"
                    >
                      <Pin :size="12" />
                    </button>
                    <kbd v-if="activeIndex === entry.flatIndex" class="cmd-enter-kbd" aria-hidden="true">
                      <CornerDownLeft :size="11" />
                    </kbd>
                  </span>
                </div>
              </section>
            </template>
            <div v-else class="cmd-empty">
              <p>
                {{
                  portsNeeded && portsQuery.isPending.value
                    ? '正在扫描本机监听端口…'
                    : `未找到匹配「${query}」的会话、工作区、端口或动作`
                }}
              </p>
              <small>试试输入 : 检索本机监听端口，@ 检索历史对话，&gt; 查看动作，或 # 切换主题</small>
            </div>
          </div>

          <footer class="cmd-palette-foot">
            <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
            <span><kbd>↵</kbd> 执行</span>
            <span><kbd>⌘P</kbd> 置顶</span>
            <span><kbd>:</kbd> 端口</span>
            <span><kbd>@</kbd> 会话</span>
            <span><kbd>&gt;</kbd> 动作</span>
            <span><kbd>#</kbd> 主题</span>
            <span class="cmd-foot-right"><kbd>ESC</kbd> 关闭</span>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.cmd-palette-backdrop {
  position: fixed;
  inset: 0;
  z-index: 3200;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 11vh 16px 24px;
  background: rgba(9, 11, 16, 0.42);
  backdrop-filter: blur(5px);
  -webkit-backdrop-filter: blur(5px);
}

.cmd-palette-panel {
  display: flex;
  flex-direction: column;
  width: min(640px, 94vw);
  max-height: min(540px, 76vh);
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius-lg, 12px);
  background: var(--ui-surface);
  color: var(--ui-text);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.26), 0 2px 8px rgba(0, 0, 0, 0.08);
}

:global(:root[data-theme='acid']) .cmd-palette-panel {
  border-radius: 0;
  border-color: var(--ui-accent);
  box-shadow: 6px 6px 0 var(--acid-violet, #a020f0);
}

.cmd-palette-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-surface);
}

.cmd-search-icon {
  flex-shrink: 0;
  color: var(--ui-muted);
}

.cmd-search-input {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--ui-text);
  font: 450 13.5px/20px var(--sans);
}

.cmd-search-input::placeholder {
  color: var(--ui-muted);
}

.cmd-clear-btn {
  display: inline-grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--ui-border);
  border-radius: 5px;
  background: var(--ui-raised);
  color: var(--ui-muted);
  cursor: pointer;
}

.cmd-clear-btn:hover {
  color: var(--ui-text);
}

.cmd-filter-pills {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--ui-border);
  border-radius: 7px;
  background: var(--ui-raised);
  flex-shrink: 0;
}

.cmd-filter-pills button {
  height: 22px;
  padding: 0 7px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--ui-muted);
  font: 500 11px/1 var(--sans);
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease;
}

.cmd-filter-pills button:hover {
  color: var(--ui-text);
}

.cmd-filter-pills button.active {
  background: var(--ui-surface);
  color: var(--ui-text);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
}

.cmd-palette-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 8px 8px;
  overscroll-behavior: contain;
}

.cmd-group + .cmd-group {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--ui-divider);
}

.cmd-group-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px 5px;
  color: var(--ui-muted);
  font: 600 11px/1.2 var(--sans);
  letter-spacing: 0.02em;
}

.cmd-group-title small {
  font: 500 10.5px/1 var(--mono);
  font-variant-numeric: tabular-nums;
}

.cmd-item {
  box-sizing: border-box;
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7px 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--ui-text);
  text-align: left;
  cursor: pointer;
  user-select: none;
  transition: background-color 100ms ease, border-color 100ms ease;
}

.cmd-item.is-selected {
  border-color: color-mix(in srgb, var(--ui-text) 16%, var(--ui-border));
  background: var(--ui-raised);
}

:global(:root[data-theme='acid']) .cmd-item.is-selected {
  border-radius: 0;
  border-color: var(--ui-accent);
  background: var(--ui-accent-soft);
}

.cmd-item-icon {
  display: inline-grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  background: var(--ui-surface);
  color: var(--ui-secondary);
}

.cmd-item.is-selected .cmd-item-icon {
  color: var(--ui-text);
  border-color: color-mix(in srgb, var(--ui-text) 22%, var(--ui-border));
}

.cmd-theme-swatches {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  width: 26px;
  height: 26px;
  padding: 0 3px;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  background: var(--ui-surface);
}

.cmd-theme-swatches i {
  width: 6px;
  height: 12px;
  border-radius: 2px;
  border: 1px solid rgba(128, 128, 128, 0.25);
}

.cmd-item-body {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.cmd-item-body strong {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font: 550 12.5px/1.35 var(--sans);
  color: var(--ui-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cmd-current-tag {
  padding: 1px 5px;
  border: 1px solid color-mix(in srgb, var(--ui-success) 32%, var(--ui-border));
  border-radius: 4px;
  background: var(--ui-success-bg);
  color: var(--ui-success);
  font: 600 10px/1.2 var(--sans);
  font-style: normal;
  flex-shrink: 0;
}

.cmd-freq-tag {
  padding: 1px 5px;
  border: 1px solid color-mix(in srgb, var(--ui-accent) 30%, var(--ui-border));
  border-radius: 4px;
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
  font: 600 10px/1.2 var(--sans);
  font-style: normal;
  flex-shrink: 0;
}

.cmd-pin-tag {
  padding: 1px 5px;
  border: 1px solid color-mix(in srgb, var(--ui-warning) 35%, var(--ui-border));
  border-radius: 4px;
  background: var(--ui-warning-bg);
  color: var(--ui-warning);
  font: 600 10px/1.2 var(--sans);
  font-style: normal;
  flex-shrink: 0;
}

.cmd-item-tail {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.cmd-shortcut-kbd {
  padding: 2px 5px;
  border: 1px solid var(--ui-border);
  border-radius: 4px;
  background: var(--ui-raised);
  color: var(--ui-secondary);
  font: 600 10px/1.2 var(--mono);
  white-space: nowrap;
}

.cmd-pin-btn {
  display: inline-grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--ui-muted);
  opacity: 0;
  cursor: pointer;
  transition: opacity 120ms ease, color 120ms ease, background-color 120ms ease, border-color 120ms ease;
}

.cmd-item:hover .cmd-pin-btn,
.cmd-item.is-selected .cmd-pin-btn,
.cmd-pin-btn.active {
  opacity: 1;
}

.cmd-pin-btn:hover {
  border-color: var(--ui-border);
  background: var(--ui-surface);
  color: var(--ui-text);
}

.cmd-pin-btn.active {
  border-color: color-mix(in srgb, var(--ui-warning) 36%, var(--ui-border));
  background: var(--ui-warning-bg);
  color: var(--ui-warning);
}

.cmd-item-body small {
  color: var(--ui-muted);
  font: 400 11.5px/1.35 var(--sans);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cmd-item-badge {
  padding: 2px 6px;
  border: 1px solid var(--ui-border);
  border-radius: 5px;
  background: var(--ui-surface);
  color: var(--ui-muted);
  font: 500 10.5px/1.2 var(--sans);
  white-space: nowrap;
}

.cmd-enter-kbd {
  display: inline-grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border: 1px solid var(--ui-border);
  border-radius: 4px;
  background: var(--ui-surface);
  color: var(--ui-text);
}

.cmd-empty {
  display: grid;
  gap: 4px;
  padding: 32px 16px;
  text-align: center;
  color: var(--ui-secondary);
}

.cmd-empty p {
  margin: 0;
  font-size: 13px;
  font-weight: 500;
}

.cmd-empty small {
  color: var(--ui-muted);
  font-size: 11.5px;
}

.cmd-palette-foot {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 7px 14px;
  border-top: 1px solid var(--ui-border);
  background: var(--ui-raised);
  color: var(--ui-muted);
  font: 450 11px/1 var(--sans);
}

.cmd-palette-foot span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.cmd-palette-foot kbd {
  display: inline-grid;
  place-items: center;
  min-width: 18px;
  height: 17px;
  padding: 0 4px;
  border: 1px solid var(--ui-border);
  border-radius: 4px;
  background: var(--ui-surface);
  color: var(--ui-secondary);
  font: 600 10px/1 var(--mono);
}

.cmd-foot-right {
  margin-left: auto;
}

.cmd-palette-fade-enter-active,
.cmd-palette-fade-leave-active {
  transition: opacity 130ms ease;
}

.cmd-palette-fade-enter-active .cmd-palette-panel,
.cmd-palette-fade-leave-active .cmd-palette-panel {
  transition: transform 130ms cubic-bezier(0.22, 1, 0.36, 1), opacity 130ms ease;
}

.cmd-palette-fade-enter-from,
.cmd-palette-fade-leave-to {
  opacity: 0;
}

.cmd-palette-fade-enter-from .cmd-palette-panel,
.cmd-palette-fade-leave-to .cmd-palette-panel {
  transform: translateY(-6px) scale(0.985);
  opacity: 0;
}

@media (max-width: 640px) {
  .cmd-filter-pills {
    display: none;
  }
}
</style>
