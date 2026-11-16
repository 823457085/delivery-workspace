<script setup lang="ts">
import AgentSidebarHeader from './AgentSidebarHeader.vue';
/**
 * 设计说明：会话列表只呈现会话摘要并上报选择，不持有远端状态，也不发起 CLI 操作。
 * 将它从容器拆出可保持主面板只负责编排；工具使用原生折叠保留组件挂载，把固定高度让给会话列表。
 */
import { computed, shallowRef, watch } from 'vue';
import { ChevronDown, Folder, Pin, RotateCw, Search, Settings2, Trash2, X } from '@lucide/vue';
import { agentConversationProjectPath, compareAgentConversations, type AgentConversation } from './conversation';
import AgentSessionItem from './AgentSessionItem.vue';
import { isPinnedAgentSession } from './session-pins';
import { matchesSessionQuickFilter, summarizeSessionQuickFilters, type SessionQuickFilter } from './session-quick-filter';

const props = defineProps<{ conversations: AgentConversation[]; selectedId: string; changing: string; pinnedIds: ReadonlySet<string> }>();
const emit = defineEmits<{ select: [id: string]; create: []; groups: []; sync: []; remove: [conversations: AgentConversation[]]; rename: [id: string, title: string] }>();
const collapsedGroupsStorageKey = 'agent-session-collapsed-groups:v1';
function readCollapsedGroups() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return new Set<string>();
    const raw = window.localStorage.getItem(collapsedGroupsStorageKey);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? new Set(parsed.filter((item): item is string => typeof item === 'string')) : new Set<string>();
  } catch { return new Set<string>(); }
}
function saveCollapsedGroups(values: ReadonlySet<string>) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(collapsedGroupsStorageKey, JSON.stringify([...values]));
  } catch { /* ignore storage quota or SSR */ }
}
const query = shallowRef('');
const showOlder = shallowRef(false);
const projectFilter = shallowRef('all');
const quickFilter = shallowRef<SessionQuickFilter>('all');
const batchMode = shallowRef(false);
const checkedIds = shallowRef(new Set<string>());
const expandedGroups = shallowRef(new Set<string>());
const collapsedGroups = shallowRef(readCollapsedGroups());
const previewLimit = 10;
const recentWindowMs = 7 * 24 * 60 * 60 * 1000;

type ConversationGroup = { path: string; label: string; conversations: AgentConversation[] };

const recentConversations = computed(() => {
  const cutoff = Date.now() - recentWindowMs;
  return props.conversations.filter((conversation) => Date.parse(conversation.updatedAt) >= cutoff);
});
const olderConversationCount = computed(() => {
  const cutoff = Date.now() - recentWindowMs;
  return props.conversations.filter((conversation) => !isPinnedAgentSession(props.pinnedIds, conversation)
    && Date.parse(conversation.updatedAt) < cutoff).length;
});
const scopedConversations = computed(() => (query.value.trim() || showOlder.value || quickFilter.value !== 'all') ? props.conversations : recentConversations.value);

function passQuickFilter(conversation: AgentConversation) {
  return typeof matchesSessionQuickFilter === 'function'
    ? matchesSessionQuickFilter(conversation, quickFilter.value)
    : true;
}

const quickFilterCounts = computed(() =>
  typeof summarizeSessionQuickFilters === 'function'
    ? summarizeSessionQuickFilters(props.conversations)
    : { all: props.conversations.length, active: 0, changed: 0, attention: 0 },
);

function matchesConversation(conversation: AgentConversation, term: string) {
  if (!term) return true;
  return [conversation.title, conversation.latest.baseBranch || conversation.latest.branch, conversation.latest.sessionId,
    agentConversationProjectPath(conversation),
    ...conversation.runs.flatMap((run) => [run.objective, run.result, run.error])]
    .some((value) => (value || '').toLowerCase().includes(term));
}

function getWorkspaceLabel(workspacePath: string) {
  const parts = workspacePath.replaceAll('\\', '/').split('/').filter(Boolean);
  const executorIndex = parts.findIndex((part, index) => part === '.data' && parts[index + 1] === 'design-executor');
  if (executorIndex > 0) return `${parts[executorIndex - 1]} / design-executor`;

  const leaf = parts.at(-1) || '未指定工作区';
  if (['admin', 'delivery-admin'].includes(leaf.toLowerCase())) return parts.at(-2) || leaf;
  return leaf;
}

const projectGroups = computed<ConversationGroup[]>(() => {
  const grouped = new Map<string, AgentConversation[]>();
  scopedConversations.value.forEach((conversation) => {
    const path = agentConversationProjectPath(conversation) || '未指定工作区';
    grouped.set(path, [...(grouped.get(path) || []), conversation]);
  });

  const duplicateLabels = new Map<string, number>();
  grouped.forEach((_, path) => {
    const label = getWorkspaceLabel(path);
    duplicateLabels.set(label, (duplicateLabels.get(label) || 0) + 1);
  });

  return [...grouped.entries()]
    .map(([path, conversations]) => {
      const baseLabel = getWorkspaceLabel(path);
      const parts = path.replaceAll('\\', '/').split('/').filter(Boolean);
      const label = duplicateLabels.get(baseLabel)! > 1 ? `${parts.at(-2) || '工作区'} / ${baseLabel}` : baseLabel;
      return { path, label, conversations };
    })
    .sort((left, right) => compareAgentConversations(left.conversations[0]!, right.conversations[0]!));
});

const visibleGroups = computed<ConversationGroup[]>(() => {
  const term = query.value.trim().toLowerCase();
  return projectGroups.value
    .filter((group) => projectFilter.value === 'all' || group.path === projectFilter.value)
    .map((group) => {
      const conversations = group.conversations.filter((conversation) => !isPinnedAgentSession(props.pinnedIds, conversation) && passQuickFilter(conversation));
      if (!term || [group.label, group.path].some((value) => value.toLowerCase().includes(term))) return { ...group, conversations };
      return {
        ...group,
        conversations: conversations.filter((conversation) => matchesConversation(conversation, term)),
      };
    })
    .filter((group) => group.conversations.length > 0);
});

const pinnedConversations = computed(() => {
  const term = query.value.trim().toLowerCase();
  return props.conversations
    .filter((conversation) => isPinnedAgentSession(props.pinnedIds, conversation) && passQuickFilter(conversation))
    .filter((conversation) => projectFilter.value === 'all' || agentConversationProjectPath(conversation) === projectFilter.value)
    .filter((conversation) => matchesConversation(conversation, term)
      || [getWorkspaceLabel(agentConversationProjectPath(conversation)), agentConversationProjectPath(conversation)]
        .some((value) => value.toLowerCase().includes(term)))
    .sort(compareAgentConversations);
});
const visibleConversationCount = computed(() => pinnedConversations.value.length
  + visibleGroups.value.reduce((total, group) => total + group.conversations.length, 0));
const availableConversationCount = computed(() => props.conversations.filter((conversation) => isPinnedAgentSession(props.pinnedIds, conversation)).length
  + scopedConversations.value.filter((conversation) => !isPinnedAgentSession(props.pinnedIds, conversation)).length);
const hasVisibleConversations = computed(() => pinnedConversations.value.length > 0 || visibleGroups.value.length > 0);
const batchConversations = computed(() => [...pinnedConversations.value, ...visibleGroups.value.flatMap(group => group.conversations)]);
const checkedConversations = computed(() => batchConversations.value.filter(conversation => checkedIds.value.has(conversation.id)));
const allChecked = computed(() => batchConversations.value.length > 0 && checkedConversations.value.length === batchConversations.value.length);

watch(batchConversations, conversations => {
  const available = new Set(conversations.map(conversation => conversation.id));
  const retained = new Set([...checkedIds.value].filter(id => available.has(id)));
  if (retained.size !== checkedIds.value.size) checkedIds.value = retained;
});

function toggleChecked(id: string) {
  if (props.changing) return;
  const next = new Set(checkedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  checkedIds.value = next;
}

function toggleAllChecked() {
  if (props.changing) return;
  checkedIds.value = allChecked.value ? new Set() : new Set(batchConversations.value.map(conversation => conversation.id));
}

function cancelBatch() {
  batchMode.value = false;
  checkedIds.value = new Set();
}

function displayedConversations(group: ConversationGroup) {
  if (batchMode.value || query.value.trim() || projectFilter.value !== 'all' || quickFilter.value !== 'all' || expandedGroups.value.has(group.path)) return group.conversations;
  const conversations = group.conversations.slice(0, previewLimit);
  const selected = group.conversations.find((conversation) => conversation.id === props.selectedId);
  if (selected && !conversations.some((conversation) => conversation.id === selected.id)) {
    conversations[conversations.length - 1] = selected;
  }
  return conversations;
}

function toggleGroupExpansion(path: string) {
  const next = new Set(expandedGroups.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  expandedGroups.value = next;
}

function isGroupCollapsed(path: string) {
  if (batchMode.value || query.value.trim() || projectFilter.value !== 'all' || quickFilter.value !== 'all') return false;
  return collapsedGroups.value.has(path);
}

function toggleGroup(path: string) {
  const next = new Set(collapsedGroups.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  collapsedGroups.value = next;
  saveCollapsedGroups(next);
}
</script>

<template>
  <aside class="session-sidebar" aria-label="Agent 会话列表">
    <AgentSidebarHeader mode="session" @select="emit('groups')" @create="emit('create')" />
    <slot name="navigation" />
    <div class="session-filter-deck" role="search" aria-label="会话检索与目录过滤">
      <label class="session-search"><Search :size="13" /><input v-model="query" type="search" placeholder="搜索会话、正文或分支…" @keydown.esc="query = ''" /><button v-if="query" type="button" class="session-search-clear" aria-label="清空搜索" title="清空搜索 (Esc)" @click.prevent="query = ''"><X :size="12" /></button></label>
      <label class="project-filter"><Folder :size="13" /><select v-model="projectFilter" aria-label="按项目目录筛选"><option value="all">全部项目目录（{{ projectGroups.length }}）</option><option v-for="group in projectGroups" :key="group.path" :value="group.path">{{ group.label }}（{{ group.conversations.length }}）</option></select><ChevronDown :size="13" /></label>
      <div class="session-quick-pills" role="tablist" aria-label="按会话状态快速筛选">
        <button type="button" role="tab" :aria-selected="quickFilter === 'all'" :class="{ active: quickFilter === 'all' }" @click="quickFilter = 'all'">全部</button>
        <button type="button" role="tab" :aria-selected="quickFilter === 'active'" :class="{ active: quickFilter === 'active' }" @click="quickFilter = quickFilter === 'active' ? 'all' : 'active'">进行中<em v-if="quickFilterCounts.active">{{ quickFilterCounts.active }}</em></button>
        <button type="button" role="tab" :aria-selected="quickFilter === 'changed'" :class="{ active: quickFilter === 'changed' }" @click="quickFilter = quickFilter === 'changed' ? 'all' : 'changed'">有改代码<em v-if="quickFilterCounts.changed">{{ quickFilterCounts.changed }}</em></button>
        <button type="button" role="tab" :aria-selected="quickFilter === 'attention'" :class="{ active: quickFilter === 'attention', 'is-alert': quickFilterCounts.attention > 0 }" @click="quickFilter = quickFilter === 'attention' ? 'all' : 'attention'">异常<em v-if="quickFilterCounts.attention">{{ quickFilterCounts.attention }}</em></button>
      </div>
    </div>
    <div class="session-sidebar-heading">
      <strong>{{ query.trim() ? '全量检索结果' : showOlder ? '全部历史会话' : '置顶与最近 7 天' }}</strong>
      <span>{{ visibleConversationCount }} / {{ availableConversationCount }}</span>
      <button v-if="olderConversationCount > 0 && !query.trim()" type="button" class="older-toggle-btn" @click="showOlder = !showOlder">
        {{ showOlder ? '仅近7天' : `+更早(${olderConversationCount})` }}
      </button>
    </div>
    <div v-if="batchMode" class="session-batch-toolbar">
      <label><input type="checkbox" aria-label="全选当前筛选结果" :checked="allChecked" :indeterminate="checkedConversations.length > 0 && !allChecked" :disabled="!!changing || !batchConversations.length" @change="toggleAllChecked" />全选</label>
      <span>已选 {{ checkedConversations.length }}</span>
      <button type="button" class="session-batch-delete" :disabled="!!changing || !checkedConversations.length" @click="emit('remove', checkedConversations)">{{ changing === 'conversations:delete' ? '删除中…' : '删除' }}</button>
      <button type="button" :disabled="!!changing" @click="cancelBatch">取消</button>
    </div>
    <div v-if="hasVisibleConversations" class="session-list">
      <section v-if="pinnedConversations.length" class="pinned-group">
        <div class="pinned-heading"><Pin :size="12" /><strong>置顶</strong><span>{{ pinnedConversations.length }}</span></div>
        <AgentSessionItem v-for="conversation in pinnedConversations" :key="conversation.id" :conversation="conversation"
          :selected="conversation.id === selectedId" :selecting="batchMode" :checked="checkedIds.has(conversation.id)" :disabled="!!changing"
          :search-query="query.trim()"
          @select="emit('select', $event)" @toggle="toggleChecked" @rename="(id, title) => emit('rename', id, title)" />
      </section>
      <section v-for="group in visibleGroups" :key="group.path" class="project-group">
        <button type="button" class="project-heading" :title="group.path" :aria-expanded="!isGroupCollapsed(group.path)" @click="toggleGroup(group.path)"><ChevronDown :size="12" :class="{ collapsed: isGroupCollapsed(group.path) }" /><Folder :size="13" /><strong>{{ group.label }}</strong><span>{{ group.conversations.length }}</span></button>
        <div v-show="!isGroupCollapsed(group.path)" class="project-conversations">
          <AgentSessionItem v-for="conversation in displayedConversations(group)" :key="conversation.id" :conversation="conversation"
            :selected="conversation.id === selectedId" :selecting="batchMode" :checked="checkedIds.has(conversation.id)" :disabled="!!changing"
            :search-query="query.trim()"
            @select="emit('select', $event)" @toggle="toggleChecked" @rename="(id, title) => emit('rename', id, title)" />
          <button v-if="!batchMode && !query.trim() && projectFilter === 'all' && group.conversations.length > previewLimit" type="button" class="project-more" @click="toggleGroupExpansion(group.path)">{{ expandedGroups.has(group.path) ? '收起更多' : `展开显示 ${group.conversations.length - previewLimit} 个` }}</button>
        </div>
      </section>
    </div>
    <el-empty v-else :description="recentConversations.length || pinnedIds.size ? '没有匹配的会话' : '最近 7 天没有会话'" :image-size="48" />
    <details class="session-tools">
      <summary><Settings2 :size="15" /><span>会话工具</span><ChevronDown :size="13" class="tools-chevron" /></summary>
      <div class="session-tools-content">
      <button type="button" class="studio-sync-sessions" :disabled="!!changing || !hasVisibleConversations || batchMode" @click="batchMode = true"><Trash2 :size="15" /><span>批量删除会话</span></button>
      <button type="button" class="studio-sync-sessions" :disabled="!!changing" aria-label="同步本机会话" title="同步本机会话" @click="emit('sync')"><RotateCw :size="15" :class="{ spinning: changing === 'codex:sync' }" /><span>同步本机会话</span></button>
      <slot name="tools" />
      </div>
    </details>
    <slot name="navigation-footer" />
  </aside>
</template>

<style scoped>

.older-toggle-btn{margin-left:auto;padding:2px 7px;border:1px solid var(--ui-border);border-radius:999px;background:var(--ui-raised);color:var(--ui-accent);font:500 11px/16px var(--mono);cursor:pointer;transition:border-color 160ms ease,background 160ms ease}.older-toggle-btn:hover{border-color:var(--ui-accent);background:var(--ui-accent-soft)}
.session-quick-pills{display:flex;align-items:center;gap:4px;margin:0 10px 4px;overflow-x:auto;scrollbar-width:none}.session-quick-pills::-webkit-scrollbar{display:none}.session-quick-pills button{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 7px;border:1px solid var(--ui-border);border-radius:999px;background:var(--ui-raised);color:var(--ui-muted);font:500 11px/1 var(--sans);white-space:nowrap;cursor:pointer;transition:background 160ms ease,color 160ms ease,border-color 160ms ease}.session-quick-pills button:hover{color:var(--ui-text);border-color:color-mix(in srgb,var(--ui-accent) 40%,var(--ui-border))}.session-quick-pills button.active{border-color:color-mix(in srgb,var(--ui-accent) 45%,var(--ui-border));background:var(--ui-accent-soft);color:var(--ui-accent);font-weight:600}.session-quick-pills button em{padding:0 4px;border-radius:999px;background:color-mix(in srgb,var(--ui-surface) 75%,transparent);font:600 10px/14px var(--mono);font-style:normal;font-variant-numeric:tabular-nums}.session-quick-pills button.is-alert:not(.active) em{color:var(--ui-danger,#dc2626)}
.session-batch-toolbar{display:flex;align-items:center;gap:8px;min-height:36px;margin:0 12px 6px;color:var(--ui-secondary);font-size:12px;line-height:16px}.session-batch-toolbar label{display:flex;align-items:center;gap:6px;white-space:nowrap;cursor:pointer}.session-batch-toolbar input{margin:0;accent-color:var(--ui-accent)}.session-batch-toolbar>span{flex:1;white-space:nowrap;color:var(--ui-muted)}.session-batch-toolbar button{padding:4px 6px;border:0;border-radius:6px;background:transparent;color:var(--ui-secondary);font:500 12px/16px var(--sans);cursor:pointer}.session-batch-toolbar button:hover:not(:disabled){background:var(--ui-hover);color:var(--ui-text)}.session-batch-toolbar .session-batch-delete{color:var(--ui-danger,var(--ui-accent))}.session-batch-toolbar button:disabled{opacity:.45;cursor:not-allowed}
.session-sidebar{display:flex;flex-direction:column;min-width:0;min-height:0;height:100%;overflow:hidden;background:var(--ui-surface);border-right:1px solid var(--ui-border);color:var(--ui-text);box-shadow:none}
.sync-sessions{display:flex;align-items:center;gap:8px;height:30px;margin:0 10px 6px;padding:0 10px;border:1px solid var(--ui-border);border-radius:var(--ds-radius-xs,7px);background:var(--ui-raised);color:var(--ui-secondary);font:500 12px/16px var(--sans);cursor:pointer;transition:background 300ms cubic-bezier(0.22,1,0.36,1),border-color 300ms cubic-bezier(0.22,1,0.36,1),color 300ms cubic-bezier(0.22,1,0.36,1)}.sync-sessions:hover:not(:disabled){border-color:color-mix(in srgb,var(--ui-accent) 42%,var(--ui-border));background:var(--ui-hover);color:var(--ui-text)}.sync-sessions:disabled{cursor:not-allowed;opacity:.6}.sync-sessions span{flex:1;text-align:left}.sync-sessions small{padding:2px 6px;border-radius:6px;background:var(--ui-accent-soft);color:var(--ui-accent);font:500 12px/16px var(--mono);font-variant-numeric:tabular-nums}.spinning{animation:spin .8s linear infinite}.session-search{display:flex;align-items:center;gap:6px;height:30px;margin:0 10px 5px;padding:0 8px;border:1px solid var(--ui-border);border-radius:var(--ds-radius-xs,7px);background:var(--ui-raised);color:var(--ui-muted);transition:border-color 300ms cubic-bezier(0.22,1,0.36,1)}.session-search:focus-within{border-color:var(--ui-accent);color:var(--ui-accent)}.session-search input{min-width:0;flex:1;border:0;outline:0;background:transparent;color:var(--ui-text);font:400 12px/18px var(--sans)}.session-search input::placeholder{color:var(--ui-muted)}.session-search input[type="search"]::-webkit-search-cancel-button{-webkit-appearance:none;display:none}.session-search-clear{display:grid;place-items:center;width:18px;height:18px;padding:0;border:0;border-radius:999px;background:transparent;color:var(--ui-muted);cursor:pointer;flex-shrink:0}.session-search-clear:hover{background:var(--ui-hover);color:var(--ui-text)}
.session-sidebar-heading{display:flex;align-items:center;gap:6px;min-height:30px;padding:0 10px;color:var(--ui-muted)}.session-sidebar-heading strong{font:500 11.5px/16px var(--sans);letter-spacing:.01em}.session-sidebar-heading span{padding:1px 7px;border:1px solid var(--ui-border);border-radius:9999px;background:var(--ui-raised);font:500 11px/15px var(--mono);font-variant-numeric:tabular-nums}.session-list{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:2px 8px 10px}.pinned-group{margin:0 0 10px;padding:0 0 6px;border-bottom:1px solid var(--ui-border)}.pinned-heading{display:flex;align-items:center;gap:6px;height:28px;padding:0 8px;color:var(--ui-secondary)}.pinned-heading strong{font:600 11.5px/16px var(--sans)}.pinned-heading span{margin-left:auto;color:var(--ui-muted);font:500 11px/15px var(--mono);font-variant-numeric:tabular-nums}.runtime-footer{position:relative;padding:12px 16px;border-top:1px solid var(--ui-border);background:var(--ui-surface)}.runtime-footer>div{display:flex;align-items:center;gap:8px;min-height:24px;color:var(--ui-secondary);font:400 12px/16px var(--sans)}.runtime-footer i{width:6px;height:6px;border-radius:9999px;background:var(--ui-muted)}.runtime-footer i.ready{background:var(--ui-success)}.runtime-footer small{margin-left:auto;color:var(--ui-muted);font:400 12px/16px var(--mono);font-variant-numeric:tabular-nums}.runtime-footer button{position:absolute;right:12px;top:-36px;display:grid;place-items:center;width:28px;height:28px;border:1px solid var(--ui-border);border-radius:8px;background:var(--ui-surface);color:var(--ui-muted);cursor:pointer;transition:background 300ms cubic-bezier(0.22,1,0.36,1),color 300ms cubic-bezier(0.22,1,0.36,1)}.runtime-footer button:hover{background:var(--ui-raised);color:var(--ui-text)}.session-sidebar:deep(.el-empty){margin:auto;padding:32px 12px}.session-sidebar:deep(.el-empty__description p){color:var(--ui-muted);font-size:12px}@keyframes spin{to{transform:rotate(360deg)}}
.project-filter{display:flex;align-items:center;gap:6px;height:30px;margin:0 10px 5px;padding:0 8px;border:1px solid var(--ui-border);border-radius:var(--ds-radius-xs,7px);background:var(--ui-raised);color:var(--ui-muted);transition:border-color 300ms cubic-bezier(0.22,1,0.36,1)}.project-filter:focus-within{border-color:var(--ui-accent);color:var(--ui-accent)}.project-filter select{min-width:0;height:100%;flex:1;appearance:none;border:0;outline:0;background:transparent;color:var(--ui-text);font:400 12px/18px var(--sans);cursor:pointer;overflow:hidden;text-overflow:ellipsis}.project-filter option{background:var(--ui-surface);color:var(--ui-text)}.project-filter>svg:last-child{pointer-events:none;flex-shrink:0}.project-group{margin-bottom:6px}.project-heading{display:flex;align-items:center;gap:6px;width:100%;height:28px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--ui-secondary);text-align:left;cursor:pointer;transition:background 300ms cubic-bezier(0.22,1,0.36,1),color 300ms cubic-bezier(0.22,1,0.36,1)}.project-heading:hover{background:var(--ui-raised);color:var(--ui-text)}.project-heading svg{flex:0 0 auto;color:var(--ui-muted);transition:transform 300ms cubic-bezier(0.22,1,0.36,1)}.project-heading svg.collapsed{transform:rotate(-90deg)}.project-heading strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:600 12px/16px var(--sans)}.project-heading span{margin-left:auto;color:var(--ui-muted);font:500 11px/15px var(--mono);font-variant-numeric:tabular-nums}.project-more{display:block;margin:2px 8px 0;padding:4px 0;border:0;background:transparent;color:var(--ui-muted);font:500 12px/16px var(--sans);cursor:pointer}.project-more:hover{color:var(--ui-text)}
</style>
