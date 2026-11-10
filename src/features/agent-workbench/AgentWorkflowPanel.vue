<script setup lang="ts">
import AgentMarkdown from './AgentMarkdown.vue';
/**
 * 设计说明：右栏只投影当前任务的真实状态、改动和操作，不再重复收集需求。
 * 协作关系按需展开；演示门禁保留在独立实验页，避免混淆真实执行与演示状态。
 */
import { computed } from 'vue';
import { ArrowRight } from '@lucide/vue';
import type { AgentRun, AgentWorkflowAction, AgentWorkflowSummary, SpawnAgentTaskInput } from '../../../shared/agent-runtime';
import { deliveryAcceptanceLabels, type DeliveryAcceptanceRecord } from '../../../shared/delivery-acceptance';
import StatusPill from '../../shared/ui/StatusPill.vue';
import AgentChangedFiles from './AgentChangedFiles.vue';
import AgentWorkflowAgents from './AgentWorkflowAgents.vue';
import AgentTeamWorkflowCard from './AgentTeamWorkflowCard.vue';
import { agentTaskRootId, buildAgentTaskGraph } from './agent-task-graph';
import { summarizeRunExecution } from './execution-summary';
import { isRestartableAgentRun, type AgentConversation } from './conversation';

const props = defineProps<{ conversation?: AgentConversation; conversations: AgentConversation[]; spawning?: boolean; changing?: boolean;
  acceptances?: Map<string, DeliveryAcceptanceRecord>; acceptanceKnown?: boolean; workflows?: AgentWorkflowSummary[] }>();
const emit = defineEmits<{ inspect: []; focus: []; stop: [run: AgentRun]; retry: [run: AgentRun];
  selectAgent: [conversationId: string]; accept: [conversationId: string]; spawnAgent: [input: SpawnAgentTaskInput]; decideWorkflow: [workflowId: string, action: AgentWorkflowAction] }>();
// 与当前会话相关的团队流程：当前会话发起的，或当前会话就是其中一步。
const teamWorkflows = computed(() => {
  const conversation = props.conversation;
  if (!conversation) return [];
  const rootId = agentTaskRootId(conversation);
  return (props.workflows || []).filter(item => item.parentConversationId === rootId
    || item.steps.some(step => step.conversationId === conversation.id)).slice(0, 3);
});
const latest = computed(() => props.conversation?.latest);
const paused = computed(() => props.conversation?.runs.find(run => run.pausedForEdit));
const active = computed(() => props.conversation?.runs.find((run) => run.status === 'running')
  || [...(props.conversation?.runs || [])].reverse().find((run) => run.status === 'queued'));
const current = computed(() => paused.value || active.value || latest.value);
const summary = computed(() => current.value ? summarizeRunExecution(current.value).filter((item) => item.key !== 'status').slice(0, 2) : []);
const nodes = computed(() => buildAgentTaskGraph(props.conversation, props.conversations, props.acceptances, props.acceptanceKnown !== false, props.workflows));
const currentNode = computed(() => nodes.value.find(node => node.id === props.conversation?.id));
const acceptanceStatus = computed(() => nodes.value.find(node => node.id === props.conversation?.id)?.acceptanceStatus || 'pending');
const recoveryLabels = { pending: '待核对', active: '原进程仍在', 'needs-review': '待确认继续', completed: '原轮次已结束', resumed: '已继续' } as const;
const recoveryLabel = computed(() => currentNode.value?.recoveryState ? recoveryLabels[currentNode.value.recoveryState] : '无恢复记录');
const deliveryGate = computed(() => {
  const run = current.value;
  if (!run) return '';
  if (run.status === 'completed' && run.resultReady && acceptanceStatus.value === 'accepted') return '人工验收通过：记录已确认，但后续代码/运行变化会要求重新验收';
  if (run.status === 'completed' && run.resultReady && acceptanceStatus.value === 'rejected') return '人工验收未通过：请按结论修订后重新执行和核对';
  if (run.status === 'completed' && run.resultReady && acceptanceStatus.value === 'stale') return '验收记录已失效：本轮运行或结果变化后需要重新核对';
  if (run.status === 'completed' && run.resultReady) return '等待人工验收：本轮结果已落盘，但不代表交付通过';
  if (run.status === 'completed') return '结果已完成，正在等待最终落盘核对';
  if (['failed', 'interrupted', 'cancelled'].includes(run.status)) return '执行未通过：不得将本轮结束当作交付验收通过';
  return '未到人工验收阶段：先完成本轮执行并回读结果';
});
</script>

<template>
  <section class="workflow-panel" aria-label="当前任务进度">
    <template v-if="current">
      <header class="task-heading"><strong>当前任务</strong><StatusPill :value="paused ? 'paused' : current.status" /></header>
      <AgentMarkdown class="task-objective" :source="current.objective" />
      <AgentTeamWorkflowCard v-for="workflow in teamWorkflows" :key="workflow.id" :workflow="workflow" :changing="changing"
        :current-conversation-id="conversation?.id" @decide="(id, action) => emit('decideWorkflow', id, action)" @select="emit('selectAgent', $event)" @accept="emit('accept', $event)" />
      <section class="task-room" aria-label="任务房间事实">
        <header><strong>任务房间</strong><small>真实运行快照</small></header>
        <dl>
          <div><dt>执行器</dt><dd>{{ current.provider }} · {{ current.mode }}</dd></div>
          <div><dt>工作区</dt><dd :title="current.workspacePath">{{ current.branch || '普通文件夹' }}</dd></div>
          <div><dt>结果</dt><dd>{{ current.resultReady ? '已落盘' : current.result ? '已回传' : '未就绪' }}</dd></div>
          <div><dt>验收</dt><dd>{{ deliveryAcceptanceLabels[acceptanceStatus] }}</dd></div>
          <div><dt>链路</dt><dd>{{ currentNode?.parentRunId ? `前置运行 ${currentNode.parentRunId.slice(0, 8)}` : '根运行' }}</dd></div>
          <div v-if="currentNode?.recoveryState"><dt>恢复</dt><dd :title="currentNode.recoveryMessage">{{ recoveryLabel }}<template v-if="currentNode.recoveryOfRunId"> · {{ currentNode.recoveryOfRunId.slice(0, 8) }}</template></dd></div>
          <div><dt>证据</dt><dd>{{ current.events.length }} 条事件 · {{ current.changedFiles?.length || 0 }} 个改动文件</dd></div>
        </dl>
        <p class="task-gate" :class="{ ready: current.status === 'completed' && current.resultReady, danger: ['failed', 'interrupted', 'cancelled'].includes(current.status) }">{{ deliveryGate }}</p>
      </section>
      <div v-if="conversation?.source !== 'codex'" class="task-summary">
        <div v-for="item in summary" :key="item.key"><strong>{{ item.title }}</strong><p>{{ item.detail }}</p></div>
      </div>
      <div class="task-actions">
        <el-button v-if="active && !paused" size="small" :disabled="changing" @click="emit('stop', active)">停止执行</el-button>
        <el-button v-else-if="isRestartableAgentRun(current) && !paused" size="small" :disabled="changing" @click="emit('retry', current)">重新尝试</el-button>
        <el-button v-if="!paused" size="small" @click="emit('focus')">{{ active ? '补充要求' : '继续对话' }}</el-button>
        <el-button size="small" @click="emit('inspect')">查看详情</el-button>
      </div>
      <AgentChangedFiles :files="current.changedFiles || []" :run-id="current.id" />
      <details :key="conversation?.id" class="collaboration">
        <summary>多 Agent 协作 <span>{{ nodes.length }}</span></summary>
        <AgentWorkflowAgents :conversation="conversation" :conversations="conversations" :spawning="spawning" :acceptances="acceptances" :acceptance-known="acceptanceKnown" :workflows="workflows"
          @select="emit('selectAgent', $event)" @spawn="emit('spawnAgent', $event)" />
      </details>
    </template>
    <el-empty v-else description="发送需求后查看任务进度" :image-size="45" />
    <router-link class="lab-link" to="/lab">交付流程实验室 <ArrowRight :size="12" /></router-link>
  </section>
</template>

<style scoped>
.workflow-panel{height:100%;min-height:0;overflow-y:auto;padding:16px;background:var(--agent-panel);color:var(--agent-text)}
.task-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px}
.task-objective{margin:12px 0;overflow-wrap:anywhere;font-size:12px;line-height:1.65;max-height:130px;overflow-y:auto}
.task-room{margin:14px 0;padding:10px 11px;border:1px solid var(--agent-border);border-radius:9px;background:color-mix(in srgb,var(--agent-bg) 58%,transparent)}.task-room>header{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--agent-secondary);font-size:12px}.task-room>header small{color:var(--agent-muted);font:10px var(--mono)}.task-room dl{display:grid;gap:6px;margin:9px 0 0}.task-room dl div{display:flex;justify-content:space-between;gap:8px}.task-room dt,.task-room dd{margin:0;font-size:11px;line-height:1.45}.task-room dt{color:var(--agent-muted)}.task-room dd{max-width:70%;overflow:hidden;color:var(--agent-secondary);text-align:right;text-overflow:ellipsis;white-space:nowrap}.task-gate{margin:9px 0 0;padding-top:8px;border-top:1px solid var(--agent-border);color:#f1c36f;font-size:11px;line-height:1.5}.task-gate.ready{color:#69ddb2}.task-gate.danger{color:#ff9aac}
.task-summary{display:grid;gap:12px;margin:16px 0}
.task-summary strong{font-size:12px}.task-summary p{margin:4px 0 0;color:var(--agent-muted);font-size:11px;line-height:1.6;overflow-wrap:anywhere}
.task-actions{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}.task-actions :deep(.el-button){margin:0}
.collaboration{margin-top:20px;border-top:1px solid var(--agent-border)}.collaboration>summary{display:flex;align-items:center;gap:8px;padding:14px 0;cursor:pointer;font-size:12px;list-style:none}
.collaboration>summary::before{content:'›';transition:transform .15s}.collaboration[open]>summary::before{transform:rotate(90deg)}
.collaboration>summary span{margin-left:auto;color:var(--agent-muted);font:10px var(--mono)}
.lab-link{display:flex;align-items:center;justify-content:space-between;margin-top:20px;padding-top:14px;border-top:1px solid var(--agent-border);color:var(--agent-muted);font-size:11px;text-decoration:none}
</style>
