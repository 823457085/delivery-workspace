<script setup lang="ts">
/**
 * 设计说明：右栏只投影当前任务的真实状态、改动和操作，不再重复收集需求。
 * 协作关系按需展开；演示门禁保留在独立实验页，避免混淆真实执行与演示状态。
 */
import { computed } from 'vue';
import { ArrowRight } from '@lucide/vue';
import type { AgentRun, SpawnAgentTaskInput } from '../../../shared/agent-runtime';
import StatusPill from '../../shared/ui/StatusPill.vue';
import AgentChangedFiles from './AgentChangedFiles.vue';
import AgentWorkflowAgents from './AgentWorkflowAgents.vue';
import { buildAgentTaskGraph } from './agent-task-graph';
import { summarizeRunExecution } from './execution-summary';
import { isRestartableAgentRun, type AgentConversation } from './conversation';

const props = defineProps<{ conversation?: AgentConversation; conversations: AgentConversation[]; spawning?: boolean; changing?: boolean }>();
const emit = defineEmits<{ inspect: []; focus: []; stop: [run: AgentRun]; retry: [run: AgentRun];
  selectAgent: [conversationId: string]; spawnAgent: [input: SpawnAgentTaskInput] }>();
const latest = computed(() => props.conversation?.latest);
const paused = computed(() => props.conversation?.runs.find(run => run.pausedForEdit));
const active = computed(() => props.conversation?.runs.find((run) => run.status === 'running')
  || [...(props.conversation?.runs || [])].reverse().find((run) => run.status === 'queued'));
const current = computed(() => paused.value || active.value || latest.value);
const summary = computed(() => current.value ? summarizeRunExecution(current.value).filter((item) => item.key !== 'status').slice(0, 2) : []);
const nodes = computed(() => buildAgentTaskGraph(props.conversation, props.conversations));
</script>

<template>
  <section class="workflow-panel" aria-label="当前任务进度">
    <template v-if="current">
      <header class="task-heading"><strong>当前任务</strong><StatusPill :value="paused ? 'paused' : current.status" /></header>
      <p class="task-objective">{{ current.objective }}</p>
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
        <AgentWorkflowAgents :conversation="conversation" :conversations="conversations" :spawning="spawning"
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
.task-objective{margin:12px 0;overflow-wrap:anywhere;white-space:pre-wrap;font-size:12px;line-height:1.65;max-height:130px;overflow-y:auto}
.task-summary{display:grid;gap:12px;margin:16px 0}
.task-summary strong{font-size:12px}.task-summary p{margin:4px 0 0;color:var(--agent-muted);font-size:11px;line-height:1.6;overflow-wrap:anywhere}
.task-actions{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}.task-actions :deep(.el-button){margin:0}
.collaboration{margin-top:20px;border-top:1px solid var(--agent-border)}.collaboration>summary{display:flex;align-items:center;gap:8px;padding:14px 0;cursor:pointer;font-size:12px;list-style:none}
.collaboration>summary::before{content:'›';transition:transform .15s}.collaboration[open]>summary::before{transform:rotate(90deg)}
.collaboration>summary span{margin-left:auto;color:var(--agent-muted);font:10px var(--mono)}
.lab-link{display:flex;align-items:center;justify-content:space-between;margin-top:20px;padding-top:14px;border-top:1px solid var(--agent-border);color:var(--agent-muted);font-size:11px;text-decoration:none}
</style>
