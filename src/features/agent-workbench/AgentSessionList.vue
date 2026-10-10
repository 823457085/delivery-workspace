<script setup lang="ts">
import AgentAvatar from './AgentAvatar.vue';
/**
 * 设计说明：会话列表只呈现会话摘要并上报选择，不持有远端状态，也不发起 CLI 操作。
 * 将它从容器拆出可保持主面板只负责编排；表格方案不利于连续会话定位，因此不再作为主交互。
 */
import { computed, shallowRef } from 'vue';
import { ChevronDown, Folder, MessageSquarePlus, Pin, RotateCw, Search } from '@lucide/vue';
import type { AgentRuntimeHealth, AgentUsageLimits, CodexSyncState } from '../../../shared/agent-runtime';
import { agentRunProjectPath, type AgentConversation } from './conversation';
import AgentSessionItem from './AgentSessionItem.vue';
import AgentUsageQuota from './AgentUsageQuota.vue';
import { isPinnedAgentSession } from './session-pins';
import ThemePicker from '../../shared/theme/ThemePicker.vue';

const props = defineProps<{ conversations: AgentConversation[]; selectedId: string; runtimes: AgentRuntimeHealth[];
  syncState?: CodexSyncState; usage?: AgentUsageLimits; changing: string; pinnedIds: ReadonlySet<string> }>();
const emit = defineEmits<{ select: [id: string]; create: []; refresh: []; sync: [] }>();
const query = shallowRef('');
const projectFilter = shallowRef('all');
const expandedGroups = shallowRef(new Set<string>());
const collapsedGroups = shallowRef(new Set<string>());
const previewLimit = 5;
const recentWindowMs = 7 * 24 * 60 * 60 * 1000;

type ConversationGroup = { path: string; label: string; conversations: AgentConversation[] };

const recentConversations = computed(() => {
  const cutoff = Date.now() - recentWindowMs;
  return props.conversations.filter((conversation) => Date.parse(conversation.updatedAt) >= cutoff);
});

function matchesConversation(conversation: AgentConversation, term: string) {
  if (!term) return true;
  return [conversation.title, conversation.latest.baseBranch || conversation.latest.branch, conversation.latest.sessionId,
    agentRunProjectPath(conversation.latest),
    ...conversation.runs.flatMap((run) => [run.objective, run.result, run.error])]
    .some((value) => value.toLowerCase().includes(term));
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
  recentConversations.value.forEach((conversation) => {
    const path = agentRunProjectPath(conversation.latest) || '未指定工作区';
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
    .sort((left, right) => Date.parse(right.conversations[0]?.updatedAt || '') - Date.parse(left.conversations[0]?.updatedAt || ''));
});

const visibleGroups = computed<ConversationGroup[]>(() => {
  const term = query.value.trim().toLowerCase();
  return projectGroups.value
    .filter((group) => projectFilter.value === 'all' || group.path === projectFilter.value)
    .map((group) => {
      const conversations = group.conversations.filter((conversation) => !isPinnedAgentSession(props.pinnedIds, conversation));
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
    .filter((conversation) => isPinnedAgentSession(props.pinnedIds, conversation))
    .filter((conversation) => projectFilter.value === 'all' || agentRunProjectPath(conversation.latest) === projectFilter.value)
    .filter((conversation) => matchesConversation(conversation, term)
      || [getWorkspaceLabel(agentRunProjectPath(conversation.latest)), agentRunProjectPath(conversation.latest)]
        .some((value) => value.toLowerCase().includes(term)))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
});
const visibleConversationCount = computed(() => pinnedConversations.value.length
  + visibleGroups.value.reduce((total, group) => total + group.conversations.length, 0));
const availableConversationCount = computed(() => props.conversations.filter((conversation) => isPinnedAgentSession(props.pinnedIds, conversation)).length
  + recentConversations.value.filter((conversation) => !isPinnedAgentSession(props.pinnedIds, conversation)).length);
const hasVisibleConversations = computed(() => pinnedConversations.value.length > 0 || visibleGroups.value.length > 0);

function displayedConversations(group: ConversationGroup) {
  if (query.value.trim() || projectFilter.value !== 'all' || expandedGroups.value.has(group.path)) return group.conversations;
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
  if (query.value.trim() || projectFilter.value !== 'all') return false;
  return collapsedGroups.value.has(path);
}

function toggleGroup(path: string) {
  const next = new Set(collapsedGroups.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  collapsedGroups.value = next;
}
</script>

<template>
  <aside class="session-sidebar" aria-label="Agent 会话列表">
    <header class="agent-brand"><span><AgentAvatar :size="36" /></span><div><strong>启元</strong><small>本机 AI 开发工作台</small></div><ThemePicker class="agent-theme-picker" /></header>
    <button type="button" class="create-session" aria-label="新建 Agent 会话" @click="emit('create')"><MessageSquarePlus :size="16" /> 新对话</button>
    <button type="button" class="sync-sessions" :disabled="!!changing" @click="emit('sync')"><RotateCw :size="13" :class="{ spinning: changing === 'codex:sync' }" /><span>同步本机会话</span><small v-if="syncState?.syncedAt">{{ recentConversations.length }}</small></button>
    <label class="session-search"><Search :size="13" /><input v-model="query" type="search" placeholder="搜索会话、消息、分支或工作区" /></label>
    <label class="project-filter"><Folder :size="13" /><select v-model="projectFilter" aria-label="按项目目录筛选"><option value="all">全部项目目录（{{ projectGroups.length }}）</option><option v-for="group in projectGroups" :key="group.path" :value="group.path">{{ group.label }}（{{ group.conversations.length }}）</option></select><ChevronDown :size="13" /></label>
    <div class="session-sidebar-heading"><strong>置顶与最近 7 天</strong><span>{{ visibleConversationCount }} / {{ availableConversationCount }}</span></div>
    <div v-if="hasVisibleConversations" class="session-list">
      <section v-if="pinnedConversations.length" class="pinned-group">
        <div class="pinned-heading"><Pin :size="12" /><strong>置顶</strong><span>{{ pinnedConversations.length }}</span></div>
        <AgentSessionItem v-for="conversation in pinnedConversations" :key="conversation.id" :conversation="conversation"
          :selected="conversation.id === selectedId" @select="emit('select', $event)" />
      </section>
      <section v-for="group in visibleGroups" :key="group.path" class="project-group">
        <button type="button" class="project-heading" :title="group.path" :aria-expanded="!isGroupCollapsed(group.path)" @click="toggleGroup(group.path)"><ChevronDown :size="12" :class="{ collapsed: isGroupCollapsed(group.path) }" /><Folder :size="13" /><strong>{{ group.label }}</strong><span>{{ group.conversations.length }}</span></button>
        <div v-show="!isGroupCollapsed(group.path)" class="project-conversations">
          <AgentSessionItem v-for="conversation in displayedConversations(group)" :key="conversation.id" :conversation="conversation"
            :selected="conversation.id === selectedId" @select="emit('select', $event)" />
          <button v-if="!query.trim() && projectFilter === 'all' && group.conversations.length > previewLimit" type="button" class="project-more" @click="toggleGroupExpansion(group.path)">{{ expandedGroups.has(group.path) ? '收起更多' : `展开显示 ${group.conversations.length - previewLimit} 个` }}</button>
        </div>
      </section>
    </div>
    <el-empty v-else :description="recentConversations.length || pinnedIds.size ? '没有匹配的会话' : '最近 7 天没有会话'" :image-size="48" />
    <footer class="runtime-footer">
      <div v-for="runtime in runtimes" :key="runtime.provider"><i :class="{ ready: runtime.ready }"></i><span>{{ runtime.label }}</span><small>{{ runtime.ready ? '已连接' : '未连接' }}</small></div>
      <AgentUsageQuota :usage="usage" />
      <button type="button" aria-label="刷新执行器状态" @click="emit('refresh')"><RotateCw :size="13" /></button>
    </footer>
  </aside>
</template>

<style scoped>
.session-sidebar{display:flex;flex-direction:column;min-width:0;min-height:0;height:100%;overflow:hidden;background:linear-gradient(180deg,var(--agent-panel-strong) 0,var(--agent-panel) 100%);border-right:1px solid var(--agent-border);color:var(--agent-text);box-shadow:8px 0 28px #0002}.agent-brand{display:flex;align-items:center;gap:10px;height:68px;padding:0 14px;border-bottom:1px solid var(--agent-border)}.agent-brand>span{display:grid;place-items:center;width:36px;height:36px;border-radius:11px;background:linear-gradient(145deg,var(--agent-cyan),var(--agent-accent));color:#fff;box-shadow:0 8px 24px color-mix(in srgb,var(--agent-accent) 32%,transparent)}.agent-brand>div{min-width:0;flex:1}.agent-brand strong,.agent-brand small{display:block}.agent-brand strong{font-size:14px;letter-spacing:.1px}.agent-brand small{margin-top:4px;color:var(--agent-muted);font-size:9px}.agent-brand:deep(.theme-trigger){min-height:30px;padding:5px 8px;border-color:var(--agent-border);background:var(--agent-raised);color:var(--agent-secondary);font-size:9px}.agent-brand:deep(.theme-trigger:hover){border-color:var(--agent-accent);background:var(--agent-panel-strong)}.create-session{display:flex;align-items:center;justify-content:center;gap:8px;height:44px;margin:14px 14px 16px;border:1px solid color-mix(in srgb,var(--agent-accent) 50%,transparent);border-radius:11px;background:linear-gradient(105deg,var(--agent-cyan),var(--agent-accent));color:#fff;font-size:13px;font-weight:650;cursor:pointer;box-shadow:0 10px 24px color-mix(in srgb,var(--agent-accent) 25%,transparent);transition:transform .18s ease,filter .18s ease}.create-session:hover{filter:brightness(1.08);transform:translateY(-1px)}
.sync-sessions{display:flex;align-items:center;gap:7px;height:32px;margin:-7px 14px 10px;padding:0 10px;border:1px solid #343e51;border-radius:8px;background:#1d2330;color:#bfc7d5;font-size:10px;cursor:pointer}.sync-sessions:hover:not(:disabled){border-color:#565b91;background:#252b3b;color:#fff}.sync-sessions:disabled{cursor:not-allowed;opacity:.6}.sync-sessions span{flex:1;text-align:left}.sync-sessions small{padding:2px 6px;border-radius:7px;background:#2b3142;color:#aaa4ff;font:8px var(--mono)}.spinning{animation:spin .8s linear infinite}.session-search{display:flex;align-items:center;gap:7px;height:32px;margin:0 14px 4px;padding:0 9px;border:1px solid #2d3647;border-radius:8px;background:#111722;color:#737f92}.session-search:focus-within{border-color:#5b5f99;color:#aaa4ff}.session-search input{min-width:0;flex:1;border:0;outline:0;background:transparent;color:#dce1ea;font-size:10px}.session-search input::placeholder{color:#687386}
.session-sidebar-heading{display:flex;align-items:center;gap:8px;min-height:34px;padding:0 16px;color:var(--agent-muted)}.session-sidebar-heading strong{font-size:9px;text-transform:uppercase;letter-spacing:1px}.session-sidebar-heading span{padding:2px 7px;border:1px solid var(--agent-border);border-radius:9px;background:var(--agent-panel-strong);font:9px var(--mono)}.session-list{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:2px 10px 12px}.pinned-group{margin:0 0 10px;padding:0 0 9px;border-bottom:1px solid var(--agent-border)}.pinned-heading{display:flex;align-items:center;gap:7px;height:29px;padding:0 7px;color:var(--agent-accent)}.pinned-heading strong{font-size:10px;font-weight:650}.pinned-heading span{margin-left:auto;color:var(--agent-muted);font:8px var(--mono)}.runtime-footer{position:relative;padding:12px 15px 14px;border-top:1px solid var(--agent-border);background:color-mix(in srgb,var(--agent-bg) 68%,transparent)}.runtime-footer>div{display:flex;align-items:center;gap:7px;min-height:23px;color:var(--agent-secondary);font-size:9px}.runtime-footer i{width:6px;height:6px;border-radius:50%;background:#626b7b}.runtime-footer i.ready{background:#51d4a5;box-shadow:0 0 9px #4fd3a188}.runtime-footer small{margin-left:auto;color:var(--agent-muted);font-size:8px}.runtime-footer button{position:absolute;right:10px;top:-33px;display:grid;place-items:center;width:27px;height:27px;border:0;border-radius:7px;background:var(--agent-panel-strong);color:var(--agent-muted);cursor:pointer;transition:.16s ease}.runtime-footer button:hover{background:var(--agent-raised);color:#fff}.session-sidebar:deep(.el-empty){margin:auto;padding:30px 10px}.session-sidebar:deep(.el-empty__description p){color:var(--agent-muted);font-size:10px}@keyframes spin{to{transform:rotate(360deg)}}
.project-filter{display:flex;align-items:center;gap:7px;height:32px;margin:0 14px 5px;padding:0 9px;border:1px solid #2d3647;border-radius:8px;background:#111722;color:#737f92}.project-filter:focus-within{border-color:#5b5f99;color:#aaa4ff}.project-filter select{min-width:0;height:100%;flex:1;appearance:none;border:0;outline:0;background:transparent;color:#dce1ea;font-size:10px;cursor:pointer}.project-filter option{background:#1d2330;color:#dce1ea}.project-filter>svg:last-child{pointer-events:none}.project-group{margin-bottom:9px}.project-heading{display:flex;align-items:center;gap:7px;width:100%;height:29px;padding:0 7px;border:0;border-radius:6px;background:transparent;color:#9ba7b9;text-align:left;cursor:pointer}.project-heading:hover{background:#1d2330;color:#c8d0dd}.project-heading svg{flex:0 0 auto;color:#8895a8;transition:transform .16s ease}.project-heading svg.collapsed{transform:rotate(-90deg)}.project-heading strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;font-weight:600}.project-heading span{margin-left:auto;color:#667287;font:8px var(--mono)}.project-more{display:block;margin:2px 8px 0;padding:3px 0;border:0;background:transparent;color:#707c8f;font-size:9px;cursor:pointer}.project-more:hover{color:#b7c0ce}
</style>
