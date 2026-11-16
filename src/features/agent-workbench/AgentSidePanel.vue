<script setup lang="ts">
/**
 * 设计说明：普通会话与团队群聊共用动态、进度与交付导航，执行记录按需展开。
 * 项目操作固定在导航下方，不随页签内容滚动。
 * 该容器只切换视图，具体查询继续由独立组件负责，避免在窄侧栏复制全局管理页。
 */
import { computed, defineAsyncComponent, nextTick } from 'vue';
import { Activity, ChevronsRight, Cpu, FolderGit2, GitFork, PackageCheck, PanelRight, Radio } from '@lucide/vue';
import { agentProviderLabels, type AgentProvider, type AgentRun, type AgentWorkflowAction, type AgentWorkflowSummary, type SpawnAgentTaskInput } from '../../../shared/agent-runtime';
import type { DeliveryAcceptanceRecord } from '../../../shared/delivery-acceptance';
import type { JiraDevTaskView } from '../../../shared/jira-dev';
import type { agentConversationStatus, AgentConversation } from './conversation';
import type { AgentBusinessContext } from './agent-business-context';
import { useAgentSidePanelTab, type AgentSidePanelTab } from './side-panel-state';
import { conversationDeliveries } from './conversation-deliveries';
import type { DeliveryRecord } from '../workbench/domain';
import type { TeamRoom } from './team-api';

const AgentContextPanel = defineAsyncComponent(() => import('./AgentContextPanel.vue'));
const AgentDeliveryPanel = defineAsyncComponent(() => import('./AgentDeliveryPanel.vue'));
const AgentExecutionPanel = defineAsyncComponent(() => import('./AgentExecutionPanel.vue'));
const AgentKnowledgePanel = defineAsyncComponent(() => import('./AgentKnowledgePanel.vue'));
const AgentWorkflowPanel = defineAsyncComponent(() => import('./AgentWorkflowPanel.vue'));

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
  queueLabel?: string;
}>();
const emit = defineEmits<{ inspect: [run?: AgentRun]; focus: []; stop: [run: AgentRun]; retry: [run: AgentRun]; compose: [prompt: string]; selectConversation: [conversationId: string]; spawnAgent: [input: SpawnAgentTaskInput]; decideWorkflow: [workflowId: string, action: AgentWorkflowAction]; collapse: []; openGroup: [roomId: string] }>();
const active = useAgentSidePanelTab(() => props.conversation?.id, () => props.defaultTab || 'execution');
const confluenceRelatedText = computed(() => [
  ...props.context.jiraIssues.map(issue => issue.description || ''),
  ...(props.conversation?.runs.slice(-10).map(run => run.objective) || []),
].join('\n').slice(0, 100000));
const deliveryCount = computed(() => props.deliveryCountOverride ?? new Set(conversationDeliveries(props.conversation).map(item => item.round)).size);
const workspaceLeaf = computed(() => {
  const parts = props.workspacePath.replaceAll('\\', '/').split('/').filter(Boolean);
  return parts.slice(-2).join('/') || '独立会话目录';
});
const activeRunsCount = computed(() => props.conversations.filter(item => ['running', 'queued'].includes(item.latest.status)).length);
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
  <aside class="side-panel" :class="{ 'side-panel-compact': compact, 'is-external-collapse': externalCollapse }" aria-label="Agent 会话侧栏">
    <header class="side-heading">
      <div class="side-panel-title">
        <strong><PanelRight :size="15" />会话详情</strong>
        <span class="side-stream-badge" :class="{ 'is-live': streamStatus === 'connected' }">
          <i aria-hidden="true" />
          {{ streamStatus === 'connected' ? '已连接' : '同步中' }}
        </span>
        <button v-if="!externalCollapse" type="button" aria-label="收起会话详情" title="收起会话详情" @click="emit('collapse')"><ChevronsRight :size="16" /></button>
      </div>
      <nav>
        <button type="button" :class="{ active: active === 'execution' }" @click="selectTab('execution')"><Activity :size="13" />动态</button>
        <button type="button" :class="{ active: active === 'workflow' }" @click="selectTab('workflow')"><GitFork :size="13" />进度</button>
        <button type="button" :class="{ active: active === 'delivery' }" :title="deliveryLabel || '有成果的会话轮次'" @click="selectTab('delivery')"><PackageCheck :size="13" />{{ deliveryLabel || '交付' }}<span v-if="deliveryCount" :aria-label="`${deliveryCount} 轮`">{{ deliveryCount }}</span></button>
      </nav>
    </header>
    <div v-if="$slots['project-launch']" class="side-project-launch"><slot name="project-launch" /></div>
    <slot v-if="active === 'execution'" name="execution">
      <AgentExecutionPanel v-if="conversation || teamRoom" compact collapsible-runs :conversation="conversation" :team-room="teamRoom" @inspect="emit('inspect', $event)" />
      <section v-else class="side-ready-deck" aria-label="会话详情待命状态">
        <div class="side-ready-card">
          <small>当前状态</small>
          <div class="side-ready-grid">
            <div><span class="side-stat-label"><Radio :size="12" />连接状态</span><strong>{{ streamStatus === 'connected' ? '实时同步正常' : '正在重新连接' }}</strong></div>
            <div><span class="side-stat-label"><Cpu :size="12" />默认工具</span><strong>{{ agentProviderLabels[provider] || provider }}</strong></div>
            <div><span class="side-stat-label"><FolderGit2 :size="12" />当前目录</span><strong :title="workspacePath || '独立会话目录'">{{ workspaceLeaf }}</strong></div>
            <div><span class="side-stat-label"><Activity :size="12" />会话列表</span><strong>{{ queueLabel || (activeRunsCount ? `${activeRunsCount} 个进行中` : `共 ${conversations.length} 个对话`) }}</strong></div>
          </div>
        </div>
        <div class="side-ready-guide">
          <small>右侧栏说明</small>
          <ol>
            <li><span>01</span><div><strong>运行动态</strong><p>查看 AI 正在执行的操作与实时进展。</p></div></li>
            <li><span>02</span><div><strong>协作进度</strong><p>查看多角色分工进度与验收结果。</p></div></li>
            <li><span>03</span><div><strong>本轮交付</strong><p>查看修改了哪些代码文件，一键提交与发布。</p></div></li>
          </ol>
        </div>
      </section>
    </slot>
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
.side-panel{display:flex;flex-direction:column;min-width:0;min-height:0;height:100%;overflow:hidden;border-left:1px solid var(--ui-border);background:var(--ui-surface);color:var(--ui-text);box-shadow:none;font-size:13px;line-height:19px}
.side-heading{display:flex;flex-direction:column;align-items:stretch;gap:7px;flex-shrink:0;padding:10px 12px;border-bottom:1px solid var(--ui-border);background:var(--ui-surface)}
.side-panel.is-external-collapse .side-panel-micro,
.side-panel.is-external-collapse .side-panel-title{padding-right:34px}
.side-panel-micro{display:flex;align-items:center;justify-content:space-between;gap:8px}
.side-zone-tag{font:700 10px/1 var(--mono);letter-spacing:0.14em;text-transform:uppercase;color:var(--ui-muted)}
.side-stream-badge{display:inline-flex;align-items:center;gap:5px;height:18px;padding:0 7px;border:1px solid var(--ui-border);border-radius:var(--ds-radius-xs,999px);background:var(--ui-raised);color:var(--ui-muted);font:600 10px/1 var(--mono)}
.side-stream-badge i{width:5px;height:5px;border-radius:999px;background:var(--ui-muted)}
.side-stream-badge.is-live{border-color:color-mix(in srgb,var(--ui-success) 38%,var(--ui-border));color:var(--ui-success)}
.side-stream-badge.is-live i{background:var(--ui-success)}
.side-panel-title{display:flex;align-items:center;justify-content:space-between;gap:8px}
.side-panel-title strong{display:inline-flex;align-items:center;gap:6px;font-size:13px;line-height:18px;font-weight:600}
.side-panel-title>button{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:1px solid var(--ui-border);border-radius:var(--ds-radius-xs,6px);background:var(--ui-raised);color:var(--ui-muted);cursor:pointer;transition:background 180ms ease,color 180ms ease,border-color 180ms ease}
.side-panel-title>button:hover{background:var(--ui-hover);border-color:var(--ui-accent);color:var(--ui-text)}
.side-panel .side-heading nav{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));width:100%;gap:3px;overflow:visible;padding:2px;border:1px solid var(--ui-border);border-radius:var(--ds-radius-sm,8px);background:var(--ui-raised)}
.side-heading nav button{display:flex;align-items:center;justify-content:center;gap:4px;height:27px;min-width:0;flex-shrink:0;padding:0 5px;border:1px solid transparent;border-radius:var(--ds-radius-xs,6px);background:transparent;color:var(--ui-muted);font:500 12px/16px var(--sans);cursor:pointer;transition:background 220ms cubic-bezier(0.22,1,0.36,1),border-color 220ms cubic-bezier(0.22,1,0.36,1),color 220ms cubic-bezier(0.22,1,0.36,1)}
.side-heading nav button:hover{background:var(--ui-hover);color:var(--ui-text)}
.side-heading nav button.active{border-color:var(--ui-border);background:var(--ui-surface);color:var(--ui-text);font-weight:600;box-shadow:var(--ds-shadow)}
.side-heading nav button span{min-width:16px;padding:1px 5px;border-radius:var(--ds-radius-xs,6px);background:var(--ui-accent-soft);color:var(--ui-accent);font:600 11px/15px var(--mono);font-variant-numeric:tabular-nums;text-align:center}
.side-heading:deep(.status-pill){padding:2px 8px;flex-shrink:0;font-size:12px}
.side-project-launch{flex-shrink:0;min-width:0;padding:8px 12px;border-bottom:1px solid var(--ui-border)}
.side-ready-deck{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding:12px}
.side-ready-card,.side-ready-guide{display:grid;gap:8px;padding:11px 12px;border:1px solid var(--ui-border);border-radius:var(--ds-radius,8px);background:var(--ui-raised)}
.side-ready-card>small,.side-ready-guide>small{font:600 11px/1.2 var(--sans);letter-spacing:0.03em;color:var(--ui-muted)}
.side-ready-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}
.side-ready-grid>div{display:grid;gap:3px;min-width:0;padding:7px 8px;border:1px solid var(--ui-border);border-radius:var(--ds-radius-xs,6px);background:var(--ui-surface)}
.side-stat-label{display:inline-flex;align-items:center;gap:4px;font:500 10.5px/1.2 var(--sans);color:var(--ui-muted)}
.side-ready-grid strong{overflow-wrap:anywhere;white-space:normal;font:600 11.5px/1.38 var(--mono);color:var(--ui-text)}
.side-ready-guide ol{display:grid;gap:7px;margin:0;padding:0;list-style:none}
.side-ready-guide li{display:grid;grid-template-columns:20px minmax(0,1fr);align-items:start;gap:7px;padding-top:7px;border-top:1px solid var(--ui-divider)}
.side-ready-guide li:first-child{padding-top:0;border-top:0}
.side-ready-guide li>span{display:inline-grid;place-items:center;height:18px;border:1px solid var(--ui-border);border-radius:var(--ds-radius-xs,4px);background:var(--ui-surface);color:var(--ui-secondary);font:600 10px/1 var(--mono)}
.side-ready-guide li strong{display:block;font-size:12px;line-height:17px;font-weight:600;color:var(--ui-text)}
.side-ready-guide li p{margin:1px 0 0;font-size:11.5px;line-height:16px;color:var(--ui-muted)}
.side-panel :deep(.workflow-panel .task-heading){font-size:13px;line-height:19px}
.side-panel :deep(.workflow-panel .task-objective),
.side-panel :deep(.workflow-panel .task-summary strong),
.side-panel :deep(.workflow-panel .collaboration>summary){font-size:13px;line-height:19px}
.side-panel :deep(.workflow-panel .task-summary p),
.side-panel :deep(.workflow-panel .lab-link),
.side-panel :deep(.workflow-panel .collaboration>summary span),
.side-panel :deep(.changed-files header),
.side-panel :deep(.changed-files small),
.side-panel :deep(.changed-files code),
.side-panel :deep(.changed-file-open>span:first-child),
.side-panel :deep(.status-pill){font-size:12px;line-height:18px}
</style>
