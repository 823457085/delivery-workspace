<script setup lang="ts">
import { computed, nextTick, shallowRef, watch } from 'vue';
import { agentProviderLabels, type AgentRun, type AgentRuntimeHealth } from '../../../shared/agent-runtime';
import { groupExecutionProgress, type GroupRoom } from '../../../shared/agent-group-chat';
import type { AdvancedTeamTask } from './team-api';
import AgentAvatar from './AgentAvatar.vue';
import AgentExecutionPanel from './AgentExecutionPanel.vue';
import AgentGroupDeliveryPanel from './AgentGroupDeliveryPanel.vue';
import AgentRunDetails from './AgentRunDetails.vue';
import AgentSidePanel from './AgentSidePanel.vue';
import AgentTeamProgress from './AgentTeamProgress.vue';
import { buildGroupChatConversation } from './group-chat-conversation';
import { groupChatPresentation } from './group-chat-progress';
import { groupChatSummaries } from './group-chat-summary';
import { groupTaskMessage } from './message-text';
import { useAgentBusinessContext } from './useAgentBusinessContext';
import { teamRoleLabels } from './team-chat';
import type { TeamProfileId } from '../../../shared/agent-team';

const props = defineProps<{
  room?: GroupRoom;
  runs: AgentRun[];
  tasks: AdvancedTeamTask[];
  task?: AdvancedTeamTask;
  status: string;
  runtimes: AgentRuntimeHealth[];
  streamStatus: 'connecting' | 'connected' | 'reconnecting';
  visible?: boolean;
}>();
const emit = defineEmits<{ collapse: []; compose: [text: string] }>();
const sidePanel = shallowRef<InstanceType<typeof AgentSidePanel>>();
const conversation = computed(() => buildGroupChatConversation(props.room, props.runs));
const ownedRuns = computed(() => conversation.value?.runs || []);
const { context, loading } = useAgentBusinessContext(conversation);
const selectedRunId = shallowRef('');
const selectedRun = computed(() => ownedRuns.value.find(run => run.id === selectedRunId.value));
const selectedTask = computed(() => props.tasks.find(task => task.id === selectedRun.value?.team?.taskId)
  || (props.task?.id === selectedRun.value?.team?.taskId ? props.task : undefined));
const detailOpen = computed({ get: () => !!selectedRun.value, set: (open: boolean) => { if (!open) selectedRunId.value = ''; } });
const taskIds = computed(() => new Set(props.room?.rounds.flatMap(round => round.automatic?.taskId ? [round.automatic.taskId] : []) || []));
const currentTask = computed(() => props.task && taskIds.value.has(props.task.id) ? props.task : undefined);
const historicalTasks = computed(() => props.tasks.filter(task => taskIds.value.has(task.id) && task.id !== currentTask.value?.id));
const presentation = computed(() => groupChatPresentation(props.room, ownedRuns.value));
const summaries = computed(() => groupChatSummaries(props.room, ownedRuns.value, props.tasks));
const panelStatus = computed(() => props.room ? {
  value: summaries.value.at(-1)?.status === 'blocked' ? 'blocked' : currentTask.value?.state || groupExecutionProgress(props.room, ownedRuns.value).state,
  label: props.status,
  title: props.status,
} : undefined);

watch(() => props.room?.id, () => { selectedRunId.value = ''; });
watch(() => props.visible, visible => { if (visible === false) selectedRunId.value = ''; });
async function inspect(run: AgentRun) {
  if (!ownedRuns.value.some(item => item.id === run.id)) return;
  selectedRunId.value = run.id;
  await nextTick();
  sidePanel.value?.selectTab('execution');
}
function runLabel(run: AgentRun) {
  const turn = props.room?.rounds.flatMap(round => round.turns).find(turn => turn.runId === run.id || turn.fallbacks?.some(fallback => fallback.runId === run.id));
  const task = props.tasks.find(task => task.id === run.team?.taskId);
  return turn?.member.name || (run.team && task?.groupMembers?.[run.team.profileId as TeamProfileId]?.name)
    || (run.team && teamRoleLabels[run.team.profileId as TeamProfileId]) || agentProviderLabels[run.provider];
}
defineExpose({ inspect });
</script>

<template>
  <section class="group-details-panel">
  <AgentSidePanel :key="room?.id || 'empty'" ref="sidePanel" class="group-details-content" compact :delivery-count-override="0" delivery-label="产物" :default-tab="room?.source ? 'delivery' : 'execution'" :conversation="conversation" :conversations="conversation ? [conversation] : []"
    :context="context" :loading="loading" :workspace-path="room?.workspacePath || ''" :provider="conversation?.latest.provider || 'codex'"
    :stream-status="streamStatus" :status-override="panelStatus" @collapse="emit('collapse')" @compose="emit('compose', $event)">
    <template v-if="$slots['project-launch']" #project-launch><slot name="project-launch" /></template>
    <template #execution>
      <AgentExecutionPanel compact collapsible-runs :visible="visible" :conversation="conversation" :team-task="currentTask" :team-tasks="tasks" :run-label="runLabel" @inspect="inspect" />
    </template>
    <template #workflow>
      <section class="group-progress-panel" aria-label="团队执行进度">
        <header v-if="!currentTask" class="group-progress-heading"><strong>团队进度</strong></header>
        <AgentTeamProgress v-if="currentTask" :task="currentTask" :runs="ownedRuns" @inspect="inspect" />
        <template v-else>
          <section v-for="(round, index) in presentation.rounds" :key="round.round.id" class="group-progress-round">
            <h3>第 {{ index + 1 }} 轮</h3>
            <ol><li v-for="item in round.turns" :key="item.turn.id">
              <header><AgentAvatar :provider="(item.run || item.turn.executionBinding || item.turn.member.binding)?.provider" :model="(item.run || item.turn.executionBinding || item.turn.member.binding)?.model" :size="24" /><strong>{{ item.turn.member.name }}</strong><small>{{ item.label }}</small></header>
              <p v-if="item.reason">{{ item.reason }}</p><p v-if="item.run?.error || item.turn.error">{{ item.run?.error || item.turn.error }}</p>
              <button v-if="item.run" type="button" @click="inspect(item.run)">查看执行记录</button>
            </li></ol>
          </section>
          <el-empty v-if="!presentation.rounds.length" description="发送需求后查看任务进度" :image-size="45" />
        </template>
        <details v-for="task in historicalTasks" :key="task.id" class="group-progress-history"><summary>历史协作 · {{ groupTaskMessage({ text: task.objective }).text }}</summary><AgentTeamProgress :task="task" :runs="ownedRuns" @inspect="inspect" /></details>
      </section>
    </template>
    <template #delivery><AgentGroupDeliveryPanel :room="room" :runs="ownedRuns" :tasks="tasks" :active="visible" @inspect="inspect" /></template>
  </AgentSidePanel>
  <el-drawer v-model="detailOpen" :title="selectedRun ? `执行记录 · ${runLabel(selectedRun)}` : '执行记录'" size="min(760px, 94vw)" class="hub-drawer" destroy-on-close>
    <AgentRunDetails v-if="selectedRun" :run="selectedRun" :runtimes="runtimes" :team-task="selectedTask" />
    <template #footer><el-button @click="selectedRunId = ''">关闭</el-button></template>
  </el-drawer>
  </section>
</template>

<style scoped>
.group-details-panel{display:flex;min-width:0;min-height:0;height:100%;overflow:hidden}.group-details-content{flex:1;min-width:0;box-shadow:none}
.group-progress-round button{display:inline-flex;align-items:center;gap:5px;padding:0;border:0;background:transparent;color:var(--agent-accent);font:inherit;cursor:pointer}
.group-progress-panel{flex:1;min-height:0;overflow:auto;padding:16px;overscroll-behavior:contain;overflow-wrap:anywhere}
.group-progress-heading{display:flex;align-items:baseline;flex-wrap:wrap;gap:6px;justify-content:space-between;font-size:13px}.group-progress-heading span{color:var(--agent-muted);font-size:11px}
.group-progress-panel :deep(.team-node-progress){margin-top:16px}.group-progress-panel :deep(.progress-heading h3),.group-progress-panel :deep(.node-content header strong){font-size:13px}.group-progress-panel :deep(.progress-round li){grid-template-columns:24px minmax(0,1fr);gap:8px}.group-progress-panel :deep(.node-content p){font-size:12px}
.group-progress-panel :deep(.node-content p:not(.node-error)){display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:4;overflow:hidden}
.group-progress-round h3{margin:18px 0 8px;font-size:13px}.group-progress-round p{margin:8px 0;font-size:12px;line-height:1.7;white-space:pre-wrap}.group-progress-round ol{margin:0;padding:0;list-style:none}.group-progress-round li{padding:12px 0;border-bottom:1px solid var(--agent-border)}.group-progress-round header{display:flex;align-items:center;gap:7px;font-size:12px}.group-progress-round header small{margin-left:auto;color:var(--agent-muted);font-size:11px}.group-progress-round button{font-size:12px}
.group-progress-history{margin-top:18px;padding-top:12px;border-top:1px solid var(--agent-border)}.group-progress-history>summary{color:var(--agent-muted);font-size:12px;cursor:pointer}
</style>
