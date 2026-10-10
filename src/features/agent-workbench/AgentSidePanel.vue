<script setup lang="ts">
/**
 * 设计说明：右栏承接当前会话的记录、知识、进度与交付，任务页另列项目重构入口；全局自动化进入宽面板。
 * 该容器只切换视图，具体查询继续由独立组件负责，避免在窄侧栏复制全局管理页。
 */
import { computed } from 'vue';
import { Activity, BookOpen, BriefcaseBusiness, GitFork, PackageCheck } from '@lucide/vue';
import StatusPill from '../../shared/ui/StatusPill.vue';
import type { AgentProvider, AgentRun, SpawnAgentTaskInput } from '../../../shared/agent-runtime';
import type { AgentConversation } from './conversation';
import type { AgentBusinessContext } from './agent-business-context';
import AgentContextPanel from './AgentContextPanel.vue';
import AgentDeliveryPanel from './AgentDeliveryPanel.vue';
import AgentExecutionPanel from './AgentExecutionPanel.vue';
import AgentKnowledgePanel from './AgentKnowledgePanel.vue';
import AgentWorkflowPanel from './AgentWorkflowPanel.vue';
import { useAgentSidePanelTab } from './side-panel-state';

const props = defineProps<{
  conversation?: AgentConversation;
  conversations: AgentConversation[];
  context: AgentBusinessContext;
  loading: boolean;
  workspacePath: string;
  provider: AgentProvider;
  streamStatus: 'connecting' | 'connected' | 'reconnecting';
  spawning?: boolean;
  changing?: boolean;
}>();
const emit = defineEmits<{ inspect: [run?: AgentRun]; focus: []; stop: [run: AgentRun]; retry: [run: AgentRun]; compose: [prompt: string]; selectConversation: [conversationId: string]; spawnAgent: [input: SpawnAgentTaskInput] }>();
const active = useAgentSidePanelTab(() => props.conversation?.id);
const deliveryCount = computed(() => props.context.jobs.length + props.context.catchup.length + props.context.merges.length);
const taskCount = computed(() => new Set([...props.context.jiraIssues, ...(props.context.refactorIssues || [])]
  .flatMap(issue => [issue.key, ...issue.subtasks.map(subtask => subtask.key)])).size);
</script>

<template>
  <aside class="side-panel" aria-label="Agent 会话侧栏">
    <header class="side-heading">
      <nav>
        <button type="button" :class="{ active: active === 'execution' }" @click="active = 'execution'"><Activity :size="13" />记录</button>
        <button type="button" :class="{ active: active === 'workflow' }" @click="active = 'workflow'"><GitFork :size="13" />进度</button>
        <button type="button" :class="{ active: active === 'context' }" @click="active = 'context'"><BriefcaseBusiness :size="13" />任务<span v-if="taskCount">{{ taskCount }}</span></button>
        <button type="button" :class="{ active: active === 'knowledge' }" @click="active = 'knowledge'"><BookOpen :size="13" />知识</button>
        <button type="button" :class="{ active: active === 'delivery' }" @click="active = 'delivery'"><PackageCheck :size="13" />交付<span v-if="deliveryCount">{{ deliveryCount }}</span></button>
      </nav>
      <small class="stream-state" :class="streamStatus">{{ streamStatus === 'connected' ? '实时' : streamStatus === 'connecting' ? '连接中' : '重连中' }}</small>
      <StatusPill v-if="conversation" :value="conversation.runs.some(run => run.pausedForEdit) ? 'paused' : conversation.latest.status" />
    </header>
    <AgentExecutionPanel v-if="active === 'execution'" :conversation="conversation" @inspect="emit('inspect', $event)" />
    <AgentContextPanel v-else-if="active === 'context'" :context="context" :loading="loading" @compose="emit('compose', $event)" />
    <AgentKnowledgePanel v-else-if="active === 'knowledge'" :workspace-path="workspacePath" :provider="provider" @compose="emit('compose', $event)" />
    <AgentWorkflowPanel v-else-if="active === 'workflow'" :conversation="conversation" :conversations="conversations" :spawning="spawning" :changing="changing"
      @inspect="emit('inspect')" @focus="emit('focus')" @stop="emit('stop', $event)" @retry="emit('retry', $event)" @select-agent="emit('selectConversation', $event)" @spawn-agent="emit('spawnAgent', $event)" />
    <AgentDeliveryPanel v-else :context="context" :loading="loading" @compose="emit('compose', $event)" />
  </aside>
</template>

<style scoped>
/* 右栏阅读密度独立于聊天区，保留现有主题与功能。 */
.side-panel{display:flex;flex-direction:column;min-width:0;min-height:0;height:100%;overflow:hidden;border-left:1px solid var(--agent-border);background:linear-gradient(180deg,var(--agent-panel-strong),var(--agent-panel));color:var(--agent-text);box-shadow:-8px 0 28px #0002}.side-heading{display:flex;align-items:center;justify-content:space-between;gap:6px;min-height:58px;padding:0 8px;border-bottom:1px solid var(--agent-border);background:var(--agent-panel-strong)}.side-heading nav{display:flex;align-items:center;min-width:0;gap:1px;overflow-x:auto;scrollbar-width:none}.side-heading nav::-webkit-scrollbar{display:none}.side-heading button{display:flex;align-items:center;gap:3px;height:30px;flex-shrink:0;padding:0 5px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--agent-muted);font-size:12px;cursor:pointer}.side-heading button:hover{background:var(--agent-raised);color:var(--agent-secondary)}.side-heading button.active{border-color:color-mix(in srgb,var(--agent-accent) 38%,var(--agent-border));background:color-mix(in srgb,var(--agent-accent) 12%,var(--agent-raised));color:color-mix(in srgb,var(--agent-accent) 45%,#fff)}.side-heading button span{min-width:13px;padding:1px 3px;border-radius:6px;background:var(--agent-raised);font:12px var(--mono);text-align:center}.side-heading:deep(.status-pill){padding:2px 6px;flex-shrink:0;background:#1d342d;color:#69ddb2;font-size:12px}
.stream-state{position:relative;padding-left:8px;flex-shrink:0;color:var(--agent-muted);font-size:12px}.stream-state::before{position:absolute;left:0;top:50%;width:5px;height:5px;border-radius:50%;background:#d9a64f;content:'';transform:translateY(-50%)}.stream-state.connected::before{background:#44c698}.stream-state.reconnecting::before{animation:stream-pulse 1.1s ease-in-out infinite}@keyframes stream-pulse{50%{opacity:.25}}
.side-panel{font-size:13px;line-height:1.6}
.side-heading{flex-wrap:wrap;justify-content:flex-end;gap:8px;flex-shrink:0;padding:12px}
.side-heading nav{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));width:100%;gap:4px}
.side-heading button{justify-content:center;gap:5px;height:34px;min-width:0;padding:0 6px}
.side-panel :deep(.workflow-panel .task-heading){font-size:14px}
.side-panel :deep(.workflow-panel .task-objective),
.side-panel :deep(.workflow-panel .task-summary strong),
.side-panel :deep(.workflow-panel .collaboration>summary){font-size:13px}
.side-panel :deep(.workflow-panel .task-summary p),
.side-panel :deep(.workflow-panel .lab-link),
.side-panel :deep(.workflow-panel .collaboration>summary span),
.side-panel :deep(.changed-files header),
.side-panel :deep(.changed-files small),
.side-panel :deep(.changed-files code),
.side-panel :deep(.changed-file-open span),
.side-panel :deep(.status-pill){font-size:12px;line-height:1.6}
.side-panel :deep(.changed-file-open code){white-space:normal;overflow-wrap:anywhere}
</style>
