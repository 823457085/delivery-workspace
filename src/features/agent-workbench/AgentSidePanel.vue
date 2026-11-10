<script setup lang="ts">
/**
 * 设计说明：普通会话与团队群聊共用动态、进度与交付导航，执行记录按需展开。
 * 项目操作固定在导航下方，不随页签内容滚动。
 * 该容器只切换视图，具体查询继续由独立组件负责，避免在窄侧栏复制全局管理页。
 */
import { computed, nextTick } from 'vue';
import { Activity, ChevronsRight, GitFork, PackageCheck, PanelRight } from '@lucide/vue';
import type { AgentProvider, AgentRun, AgentWorkflowAction, AgentWorkflowSummary, SpawnAgentTaskInput } from '../../../shared/agent-runtime';
import type { DeliveryAcceptanceRecord } from '../../../shared/delivery-acceptance';
import type { JiraDevTaskView } from '../../../shared/jira-dev';
import type { agentConversationStatus, AgentConversation } from './conversation';
import type { AgentBusinessContext } from './agent-business-context';
import AgentContextPanel from './AgentContextPanel.vue';
import AgentDeliveryPanel from './AgentDeliveryPanel.vue';
import AgentExecutionPanel from './AgentExecutionPanel.vue';
import AgentKnowledgePanel from './AgentKnowledgePanel.vue';
import AgentWorkflowPanel from './AgentWorkflowPanel.vue';
import { useAgentSidePanelTab, type AgentSidePanelTab } from './side-panel-state';
import { conversationDeliveries } from './conversation-deliveries';
import type { DeliveryRecord } from '../workbench/domain';
import type { TeamRoom } from './team-api';

const props = defineProps<{
  conversation?: AgentConversation;
  teamRoom?: TeamRoom;
  conversations: AgentConversation[];
  context: AgentBusinessContext;
  loading: boolean;
  workspacePath: string;
  provider: AgentProvider;
  streamStatus: 'connecting' | 'connected' | 'reconnecting';
  spawning?: boolean;
  changing?: boolean;
  acceptances?: Map<string, DeliveryAcceptanceRecord>;
  acceptanceKnown?: boolean;
  workflows?: AgentWorkflowSummary[];
  deliveryRecord?: DeliveryRecord;
  statusOverride?: ReturnType<typeof agentConversationStatus>;
  compact?: boolean;
  deliveryCountOverride?: number;
  defaultTab?: AgentSidePanelTab;
  deliveryLabel?: string;
  matchedJiraTask?: JiraDevTaskView;
  panelOpen?: boolean;
  externalCollapse?: boolean;
}>();
const emit = defineEmits<{ inspect: [run?: AgentRun]; focus: []; stop: [run: AgentRun]; retry: [run: AgentRun]; compose: [prompt: string]; selectConversation: [conversationId: string]; spawnAgent: [input: SpawnAgentTaskInput]; decideWorkflow: [workflowId: string, action: AgentWorkflowAction]; collapse: []; openGroup: [roomId: string] }>();
const active = useAgentSidePanelTab(() => props.conversation?.id, () => props.defaultTab || 'execution');
const confluenceRelatedText = computed(() => [
  ...props.context.jiraIssues.map(issue => issue.description || ''),
  ...(props.conversation?.runs.slice(-10).map(run => run.objective) || []),
].join('\n').slice(0, 100000));
const deliveryCount = computed(() => props.deliveryCountOverride ?? new Set(conversationDeliveries(props.conversation).map(item => item.round)).size);
async function openAcceptance(conversationId: string) {
  emit('selectConversation', conversationId);
  await nextTick();
  active.value = 'delivery';
}
function selectTab(tab: typeof active.value) {
  active.value = tab;
}
defineExpose({ selectTab });
</script>

<template>
  <aside class="side-panel" :class="{ 'side-panel-compact': compact }" aria-label="Agent 会话侧栏">
    <header class="side-heading">
      <div class="side-panel-title"><strong><PanelRight :size="15" />会话详情</strong><button v-if="!externalCollapse" type="button" aria-label="收起会话详情" title="收起会话详情" @click="emit('collapse')"><ChevronsRight :size="16" /></button></div>
      <nav>
        <button type="button" :class="{ active: active === 'execution' }" @click="selectTab('execution')"><Activity :size="13" />动态</button>
        <button type="button" :class="{ active: active === 'workflow' }" @click="selectTab('workflow')"><GitFork :size="13" />进度</button>
        <button type="button" :class="{ active: active === 'delivery' }" :title="deliveryLabel || '有成果的会话轮次'" @click="selectTab('delivery')"><PackageCheck :size="13" />{{ deliveryLabel || '交付' }}<span v-if="deliveryCount" :aria-label="`${deliveryCount} 轮`">{{ deliveryCount }}</span></button>
      </nav>
    </header>
    <div v-if="$slots['project-launch']" class="side-project-launch"><slot name="project-launch" /></div>
    <slot v-if="active === 'execution'" name="execution"><AgentExecutionPanel compact collapsible-runs :conversation="conversation" :team-room="teamRoom" @inspect="emit('inspect', $event)" /></slot>
    <AgentContextPanel v-else-if="active === 'context'" :context="context" :loading="loading" @compose="emit('compose', $event)" />
    <AgentKnowledgePanel v-else-if="active === 'knowledge'" :related-text="confluenceRelatedText" :workspace-path="workspacePath" :provider="provider" @compose="emit('compose', $event)" />
    <slot v-else-if="active === 'workflow'" name="workflow"><AgentWorkflowPanel :conversation="conversation" :conversations="conversations" :spawning="spawning" :changing="changing" :acceptances="acceptances" :acceptance-known="acceptanceKnown" :workflows="workflows"
      @decide-workflow="(id, action) => emit('decideWorkflow', id, action)"
      @accept="openAcceptance"
      @inspect="emit('inspect')" @focus="emit('focus')" @stop="emit('stop', $event)" @retry="emit('retry', $event)" @select-agent="emit('selectConversation', $event)" @spawn-agent="emit('spawnAgent', $event)" /></slot>
    <slot v-else name="delivery"><AgentDeliveryPanel :conversation="conversation" :context="context" :loading="loading" :record="deliveryRecord" :matched-jira-task="matchedJiraTask" :active="panelOpen !== false && active === 'delivery'" @compose="emit('compose', $event)" @open-group="emit('openGroup', $event)" /></slot>
  </aside>
</template>

<style scoped>
/* 右栏阅读密度独立于聊天区，保留现有主题与功能。 */
.side-panel{display:flex;flex-direction:column;min-width:0;min-height:0;height:100%;overflow:hidden;border-left:1px solid var(--agent-border);background:linear-gradient(180deg,var(--agent-panel-strong),var(--agent-panel));color:var(--agent-text);box-shadow:-8px 0 28px #0002}.side-heading{display:flex;align-items:center;justify-content:space-between;gap:6px;min-height:58px;padding:0 8px;border-bottom:1px solid var(--agent-border);background:var(--agent-panel-strong)}.side-heading nav{display:flex;align-items:center;min-width:0;gap:1px;overflow-x:auto;scrollbar-width:none}.side-heading nav::-webkit-scrollbar{display:none}.side-heading button{display:flex;align-items:center;gap:3px;height:30px;flex-shrink:0;padding:0 5px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--agent-muted);font-size:12px;cursor:pointer}.side-heading button:hover{background:var(--agent-raised);color:var(--agent-secondary)}.side-heading button.active{border-color:color-mix(in srgb,var(--agent-accent) 38%,var(--agent-border));background:color-mix(in srgb,var(--agent-accent) 12%,var(--agent-raised));color:color-mix(in srgb,var(--agent-accent) 45%,#fff)}.side-heading button span{min-width:13px;padding:1px 3px;border-radius:6px;background:var(--agent-raised);font:12px var(--mono);text-align:center}.side-heading:deep(.status-pill){padding:2px 6px;flex-shrink:0;font-size:12px}
.side-panel{font-size:13px;line-height:1.6}
.side-heading{flex-wrap:wrap;justify-content:flex-end;gap:8px;flex-shrink:0;padding:12px}
.side-panel .side-heading nav{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));width:100%;gap:4px;overflow:visible}
.side-heading button{justify-content:center;gap:5px;height:34px;min-width:0;padding:0 6px}
.side-project-launch{flex-shrink:0;min-width:0;padding:12px 16px;border-bottom:1px solid var(--agent-border)}
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
