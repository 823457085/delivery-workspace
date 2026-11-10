<script setup lang="ts">
/** 一条用户消息对应一份团队汇总；成员原始记录与文件身份保留在各自运行中。 */
import { computed } from 'vue';
import type { AgentRun } from '../../../shared/agent-runtime';
import type { GroupRoom } from '../../../shared/agent-group-chat';
import { dateTime } from '../../shared/format';
import StatusPill from '../../shared/ui/StatusPill.vue';
import AgentChangedFiles from './AgentChangedFiles.vue';
import AgentGroupSummary from './AgentGroupSummary.vue';
import AgentRemoteDelivery from './AgentRemoteDelivery.vue';
import AgentWorkspaceCodeArtifacts from './AgentWorkspaceCodeArtifacts.vue';
import { groupChatSummaries } from './group-chat-summary';
import type { AdvancedTeamTask } from './team-api';

const props = defineProps<{ room?: GroupRoom; runs: AgentRun[]; tasks: AdvancedTeamTask[]; active?: boolean }>();
const emit = defineEmits<{ inspect: [run: AgentRun] }>();
const codePaths = computed(() => props.room?.workspacePaths?.length ? props.room.workspacePaths
  : props.room?.workspacePath ? [props.room.workspacePath] : []);
const labels = {
  running: { value: 'running', label: '执行中' },
  blocked: { value: 'blocked', label: '待处理' },
  returned: { value: 'review', label: '记录已返回' },
  cancelled: { value: 'cancelled', label: '已停止' },
};
const rounds = computed(() => groupChatSummaries(props.room, props.runs, props.tasks).map((item, index) => {
  const task = props.tasks.find(task => task.id === item.round.automatic?.taskId);
  const delivery = task && ['completed', 'awaiting_acceptance', 'accepted'].includes(task.state)
    ? task.chat?.messages.filter(message => message.role === 'assistant' && message.kind === 'delivery'
      && message.id.startsWith(`delivery:${task.id}:${task.round}:`)).at(-1) : undefined;
  const files = item.members.flatMap(member => member.run && member.run.changedFiles?.length
    ? [{ member: member.turn.member, run: member.run, files: member.run.changedFiles }] : []);
  return { ...item, number: index + 1, task, delivery, files,
    fileCount: files.reduce((count, item) => count + item.files.length, 0) };
}).reverse());
</script>

<template>
  <section class="group-delivery-panel" aria-label="团队交付产物">
    <AgentRemoteDelivery v-if="room?.source" :key="room.id" :room="room" :active="active" />
    <AgentWorkspaceCodeArtifacts v-else-if="codePaths.length" :paths="codePaths" :active="active" :run-state="room?.rounds.at(-1)?.state" />
    <details :key="room?.id" class="group-delivery-history" :open="!room?.source">
    <summary>团队汇总 · {{ rounds.length }} 轮</summary>
    <div :key="room?.id || 'empty'" class="group-delivery-rounds">
      <details v-for="(item, index) in rounds" :key="item.round.id" class="group-delivery-round" :open="index === 0">
        <summary><strong>第 {{ item.number }} 轮</strong><StatusPill v-bind="labels[item.status]" /><time>{{ dateTime(item.updatedAt) }}</time></summary>
        <div class="group-delivery-body">
          <p class="group-delivery-count">成员汇报 · {{ item.completed }} / {{ item.total }}</p>
          <AgentGroupSummary :summary="item" :delivery-text="item.delivery?.text" @inspect="emit('inspect', $event)" />
          <details v-if="item.files.length" class="group-delivery-files">
            <summary>文件记录 · {{ item.fileCount }}</summary>
            <section v-for="source in item.files" :key="source.run.id" class="member-file-record">
              <header><strong>{{ source.member.name }}</strong><button type="button" @click="emit('inspect', source.run)">执行记录</button></header>
              <AgentChangedFiles :files="source.files" :run-id="source.run.id" />
            </section>
          </details>
        </div>
      </details>
      <el-empty v-if="!rounds.length" description="发送需求后查看团队汇总" :image-size="45" />
    </div>
    </details>
  </section>
</template>

<style scoped>
.group-delivery-panel{flex:1;min-width:0;min-height:0;overflow:auto;padding:0 12px 12px;background:var(--agent-panel);color:var(--agent-text);overscroll-behavior:contain;overflow-wrap:anywhere}
.group-delivery-history{margin-top:16px}.group-delivery-history>summary{margin-bottom:12px;font-size:12px;color:var(--agent-muted);cursor:pointer}
.group-delivery-heading{position:sticky;z-index:2;top:0;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 0 10px;background:var(--agent-panel);font-size:13px}.group-delivery-heading>span{color:var(--agent-muted);font-size:11px}
.group-delivery-rounds,.group-delivery-round,.group-delivery-body{min-width:0;max-width:100%}
.group-delivery-round{margin-bottom:12px;border:1px solid var(--agent-border);border-radius:8px;background:var(--agent-panel-strong)}
.group-delivery-round>summary{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:12px;cursor:pointer;list-style:none;font-size:13px}.group-delivery-round>summary::-webkit-details-marker{display:none}.group-delivery-round>summary::before{content:'›';font-size:18px;line-height:1;transition:transform .15s}.group-delivery-round[open]>summary::before{transform:rotate(90deg)}.group-delivery-round>summary time{margin-left:auto;color:var(--agent-muted);font-size:11px}.group-delivery-round>summary :deep(.status-pill){padding:3px 6px;font-size:11px}
.group-delivery-body{padding:0 12px 12px;color:var(--agent-secondary);font-size:12px;line-height:1.8}.group-delivery-headline{margin:0 0 4px;font-weight:600;color:var(--agent-text)}.group-delivery-count{margin:0 0 14px;color:var(--agent-muted);font-size:11px}
.coordinator-delivery>header,.record-delivery>header{display:grid;gap:3px;margin-bottom:10px}.coordinator-delivery>header strong,.record-delivery>header strong{color:var(--agent-text);font-size:12px}.coordinator-delivery>header small,.record-delivery>header small{color:var(--agent-muted);font-size:11px}
.group-delivery-original>summary,.group-delivery-files>summary{color:var(--agent-accent);font-size:12px;cursor:pointer}.group-delivery-original[open]>summary{margin-bottom:10px}.group-delivery-files{margin-top:14px;padding-top:12px;border-top:1px solid var(--agent-border)}
.group-delivery-blockers{margin-top:14px}.group-delivery-blockers h3{margin:0 0 8px;color:var(--agent-text);font-size:12px;font-weight:600}.group-delivery-blockers ul{margin:0;padding:0;list-style:none}.group-delivery-blockers li{margin:10px 0}.group-delivery-blockers li header,.member-file-record>header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px}.group-delivery-blockers li p{margin:5px 0 0;white-space:pre-wrap}
.group-delivery-blockers li summary{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:baseline;gap:7px;cursor:pointer}.group-delivery-blockers li summary span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--agent-muted)}
.group-delivery-body button{padding:0;border:0;background:none;color:var(--agent-accent);font:inherit;font-size:11px;cursor:pointer}.member-file-record{margin-top:12px}.member-file-record>header{font-size:12px}
.group-delivery-panel :deep(.agent-markdown){min-width:0;max-width:100%;font-size:12px}.group-delivery-panel :deep(.markdown-heading){color:var(--agent-text)}.group-delivery-panel :deep(.markdown-code){box-sizing:border-box;max-width:100%;color:var(--agent-text);background:var(--agent-bg);border-color:var(--agent-border)}.group-delivery-panel :deep(.markdown-table-wrap){max-width:100%;border-color:var(--agent-border)}.group-delivery-panel :deep(a){color:var(--agent-accent)}.group-delivery-panel :deep(code){color:var(--agent-accent);background:var(--agent-panel)}.group-delivery-panel :deep(.markdown-code code){color:inherit;background:transparent}
.member-file-record :deep(.changed-files){margin-top:6px;padding:8px 0;border:0;border-radius:0;background:transparent}.member-file-record :deep(.changed-files header strong),.member-file-record :deep(.changed-files header span),.member-file-record :deep(.changed-file-open>span){font-size:11px}.member-file-record :deep(.changed-file-open){min-width:0;grid-template-columns:32px minmax(0,1fr) 12px;gap:4px}.member-file-record :deep(.changed-file-open code){white-space:normal;overflow-wrap:anywhere;font-size:11px}
</style>
