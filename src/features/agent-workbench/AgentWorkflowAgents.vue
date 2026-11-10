<script setup lang="ts">
/**
 * 设计说明：协作区展示服务端持久化的主 Agent、子 Agent 和依赖关系，并提供最小的新建入口。
 * 子 Agent 继承主会话的执行器、模型和项目基线；这里不重复暴露运行参数，避免同一任务树配置漂移。
 */
import { computed, reactive, shallowRef } from 'vue';
import { Bot, FlaskConical, GitBranch, GitMerge, Plus, ShieldCheck, Wrench } from '@lucide/vue';
import StatusPill from '../../shared/ui/StatusPill.vue';
import type { SpawnAgentTaskInput, AgentWorkflowSummary } from '../../../shared/agent-runtime';
import { deliveryAcceptanceLabels, type DeliveryAcceptanceRecord } from '../../../shared/delivery-acceptance';
import type { AgentConversation } from './conversation';
import { agentTaskBoardColumn, buildAgentTaskGraph } from './agent-task-graph';

const props = defineProps<{ conversation?: AgentConversation; conversations: AgentConversation[]; spawning?: boolean;
  acceptances?: Map<string, DeliveryAcceptanceRecord>; acceptanceKnown?: boolean; workflows?: AgentWorkflowSummary[] }>();
const emit = defineEmits<{ select: [conversationId: string]; spawn: [input: SpawnAgentTaskInput] }>();
const open = shallowRef(false);
const viewMode = shallowRef<'board' | 'list'>('board');
const form = reactive<SpawnAgentTaskInput>({ title: '', objective: '', role: 'worker', dependsOnConversationIds: [] });
const nodes = computed(() => buildAgentTaskGraph(props.conversation, props.conversations, props.acceptances, props.acceptanceKnown !== false, props.workflows));
const dependencyOptions = computed(() => nodes.value.filter((node) => node.role !== 'main' && node.id !== props.conversation?.id));
const canSubmit = computed(() => !!form.title.trim() && !!form.objective.trim() && !props.spawning);
const roleLabels = { main: '主 Agent', worker: '执行 Agent', verifier: '验证 Agent', reviewer: '复核 Agent' } as const;
const recoveryLabels = { pending: '待核对', active: '原进程仍在', 'needs-review': '待确认继续', completed: '原轮次已结束', resumed: '已继续' } as const;
const columnDefinitions = [
  { id: 'queued', label: '待处理', description: '等待领取或前置任务', tone: 'warning' },
  { id: 'running', label: '执行中', description: '正在运行', tone: 'primary' },
  { id: 'review', label: '待复核', description: '复核 Agent 工作中', tone: 'review' },
  { id: 'completed', label: '已完成', description: '已有可读结果', tone: 'success' },
  { id: 'blocked', label: '阻塞', description: '失败、中断或取消', tone: 'danger' },
] as const;
type BoardColumnId = typeof columnDefinitions[number]['id'];

const boardColumns = computed(() => columnDefinitions.map((column) => ({
  ...column,
  nodes: nodes.value.filter((node) => agentTaskBoardColumn(node.status, node.role) === column.id),
})));
const runningCount = computed(() => boardColumns.value.find((column) => column.id === 'running')?.nodes.length || 0);
const blockedCount = computed(() => boardColumns.value.find((column) => column.id === 'blocked')?.nodes.length || 0);

function dependencyLabel(node: (typeof nodes.value)[number]) {
  return node.dependsOnConversationIds.map((id) => nodes.value.find((item) => item.id === id)?.title || id.slice(0, 8)).join('、');
}
function recoveryLabel(state: (typeof nodes.value)[number]['recoveryState']) {
  return state ? recoveryLabels[state] : '';
}

function openCreate() {
  form.title = '';
  form.objective = '';
  form.role = 'worker';
  form.dependsOnConversationIds = [];
  open.value = true;
}

function submit() {
  if (!canSubmit.value) return;
  emit('spawn', { title: form.title.trim(), objective: form.objective.trim(), role: form.role,
    dependsOnConversationIds: [...form.dependsOnConversationIds] });
  open.value = false;
}
</script>

<template>
  <section v-if="nodes.length" class="workflow-agents" aria-label="Agent 任务关系">
    <header>
      <div><span>协作任务板</span><small>{{ nodes.length }} 个 Agent · {{ runningCount }} 个执行中<template v-if="blockedCount"> · {{ blockedCount }} 个阻塞</template></small></div>
      <div class="workflow-actions">
        <button type="button" @click="viewMode = viewMode === 'board' ? 'list' : 'board'">{{ viewMode === 'board' ? '关系明细' : '任务板' }}</button>
        <button type="button" :disabled="spawning" @click="openCreate"><Plus :size="11" />新增 Agent</button>
      </div>
    </header>
    <div v-if="viewMode === 'board'" class="task-board">
      <section v-for="column in boardColumns" :key="column.id" class="board-column" :class="`tone-${column.tone}`" :data-column="column.id">
        <header><div><strong>{{ column.label }}</strong><small>{{ column.description }}</small></div><span>{{ column.nodes.length }}</span></header>
        <button v-for="node in column.nodes" :key="node.id" type="button" class="board-card"
          :class="{ current: node.id === conversation?.id }" @click="emit('select', node.id)">
          <div class="board-card-heading">
            <span class="board-role"><component :is="node.role === 'reviewer' ? ShieldCheck : node.role === 'verifier' ? FlaskConical : node.role === 'worker' ? Wrench : Bot" :size="11" />{{ roleLabels[node.role] }}</span>
            <StatusPill :value="node.status" />
          </div>
          <strong class="board-title">{{ node.title }}</strong>
          <small class="board-meta"><GitBranch :size="10" />{{ node.branch || '普通文件夹' }}<template v-if="node.changedFiles"> · {{ node.changedFiles }} 个改动</template></small>
          <small class="board-meta board-result" :class="{ ready: node.resultReady, error: node.hasError }">{{ node.resultReady ? '结果已落盘' : node.hasResult ? '结果已回传' : node.hasError ? '有执行异常' : '结果未就绪' }} · {{ node.events }} 条事件</small>
          <small class="board-meta board-acceptance" :class="{ accepted: node.acceptanceStatus === 'accepted', rejected: node.acceptanceStatus === 'rejected', stale: node.acceptanceStatus === 'stale' }">人工验收：{{ node.acceptanceStatus ? deliveryAcceptanceLabels[node.acceptanceStatus] : '未就绪' }}</small>
          <small v-if="node.recoveryState || node.parentRunId" class="board-meta board-recovery">链路：{{ node.parentRunId ? '有前置运行' : '根运行' }}<template v-if="node.recoveryState"> · 恢复：{{ recoveryLabel(node.recoveryState) }}</template></small>
          <small v-if="node.dependsOnConversationIds.length" class="board-dependency"><GitMerge :size="10" />前置：{{ dependencyLabel(node) }}</small>
        </button>
        <p v-if="!column.nodes.length" class="board-empty">暂无任务</p>
      </section>
    </div>
    <div v-else class="agent-node-list">
      <button v-for="node in nodes" :key="node.id" type="button" class="agent-node"
        :class="{ current: node.id === conversation?.id }" @click="emit('select', node.id)">
        <component :is="node.role === 'reviewer' ? ShieldCheck : node.role === 'verifier' ? FlaskConical : node.role === 'worker' ? Wrench : Bot" :size="12" />
        <span>
          <strong>{{ roleLabels[node.role] }} · {{ node.title }}</strong>
          <small><GitBranch :size="10" />{{ node.branch || '普通文件夹' }} · {{ node.model || 'CLI 默认' }}<template v-if="node.pid"> · PID {{ node.pid }}</template><template v-if="node.changedFiles"> · {{ node.changedFiles }} 个改动文件</template></small>
          <small>人工验收：{{ node.acceptanceStatus ? deliveryAcceptanceLabels[node.acceptanceStatus] : '未就绪' }}</small>
          <small v-if="node.recoveryState || node.parentRunId">链路：{{ node.parentRunId ? '有前置运行' : '根运行' }}<template v-if="node.recoveryState"> · 恢复：{{ recoveryLabel(node.recoveryState) }}</template></small>
          <small v-if="node.dependsOnConversationIds.length"><GitMerge :size="10" />等待 {{ dependencyLabel(node) }}</small>
        </span>
        <StatusPill :value="node.status" />
      </button>
    </div>
  </section>

  <el-dialog v-model="open" title="新增协作 Agent" width="min(520px, 92vw)" append-to-body>
    <el-form label-position="top" @submit.prevent="submit">
      <el-form-item label="任务名称"><el-input v-model="form.title" maxlength="80" placeholder="例如：检查接口调用与边界" /></el-form-item>
      <el-form-item label="职责"><el-radio-group v-model="form.role"><el-radio-button value="worker">执行</el-radio-button><el-radio-button value="reviewer">复核</el-radio-button></el-radio-group></el-form-item>
      <el-form-item label="前置 Agent">
        <el-select v-model="form.dependsOnConversationIds" multiple clearable placeholder="无前置依赖，创建后立即执行" style="width:100%">
          <el-option v-for="node in dependencyOptions" :key="node.id" :label="node.title" :value="node.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="任务目标"><el-input v-model="form.objective" type="textarea" :rows="5" maxlength="12000" show-word-limit placeholder="说明要完成的结果、范围和验收条件" /></el-form-item>
    </el-form>
    <template #footer><el-button @click="open = false">取消</el-button><el-button type="primary" :loading="spawning" :disabled="!canSubmit" @click="submit">创建并执行</el-button></template>
  </el-dialog>
</template>

<style scoped>
.workflow-agents{margin:0 0 14px}.workflow-agents>header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 2px 7px}.workflow-agents>header>div:first-child{display:grid;gap:2px;color:var(--agent-secondary);font-size:13px}.workflow-agents>header small{color:var(--agent-muted);font:12px var(--mono)}.workflow-actions{display:flex;align-items:center;gap:4px}.workflow-actions button{display:flex;align-items:center;gap:3px;padding:4px 7px;border:1px solid color-mix(in srgb,var(--agent-accent) 38%,var(--agent-border));border-radius:6px;background:color-mix(in srgb,var(--agent-accent) 10%,var(--agent-panel-strong));color:color-mix(in srgb,var(--agent-accent) 48%,#fff);font-size:12px;cursor:pointer}.workflow-actions button:disabled{opacity:.45;cursor:default}.task-board{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.board-column{min-width:0;padding:8px;border:1px solid var(--agent-border);border-radius:8px;background:color-mix(in srgb,var(--agent-bg) 72%,transparent)}.board-column[data-column="blocked"]{grid-column:1 / -1}.board-column>header{display:flex;align-items:flex-start;justify-content:space-between;gap:6px;margin-bottom:7px}.board-column>header>div{display:grid;gap:1px;min-width:0}.board-column>header strong{color:var(--agent-secondary);font-size:12px}.board-column>header small{overflow:hidden;color:var(--agent-muted);font-size:10px;text-overflow:ellipsis;white-space:nowrap}.board-column>header>span{min-width:18px;padding:1px 4px;border-radius:5px;background:var(--agent-raised);color:var(--agent-secondary);font:11px var(--mono);text-align:center}.board-column.tone-primary{border-color:color-mix(in srgb,#5cc8ff 42%,var(--agent-border))}.board-column.tone-review{border-color:color-mix(in srgb,#c7a7ff 42%,var(--agent-border))}.board-column.tone-success{border-color:color-mix(in srgb,#54d49a 38%,var(--agent-border))}.board-column.tone-danger{border-color:color-mix(in srgb,#ff8b9b 42%,var(--agent-border))}.board-card{display:grid;width:100%;gap:4px;margin-top:5px;padding:8px;border:1px solid color-mix(in srgb,var(--agent-border) 90%,transparent);border-radius:7px;background:var(--agent-panel);color:var(--agent-muted);text-align:left;cursor:pointer}.board-card:hover,.board-card.current{border-color:color-mix(in srgb,var(--agent-accent) 48%,var(--agent-border));background:color-mix(in srgb,var(--agent-accent) 8%,var(--agent-panel-strong))}.board-card-heading{display:flex;align-items:center;justify-content:space-between;gap:5px}.board-role{display:flex;align-items:center;gap:4px;color:var(--agent-muted);font-size:10px}.board-card:deep(.status-pill){padding:1px 4px;font-size:9px}.board-title{overflow:hidden;color:var(--agent-secondary);font-size:11px;line-height:1.4;text-overflow:ellipsis;white-space:nowrap}.board-meta,.board-dependency{display:flex;align-items:center;gap:3px;overflow:hidden;color:var(--agent-muted);font-size:10px;line-height:1.4;text-overflow:ellipsis;white-space:nowrap}.board-dependency{color:#dcb9ff}.board-empty{margin:8px 0 2px;color:var(--agent-muted);font-size:10px;text-align:center}.agent-node-list{display:grid}.agent-node{display:flex;align-items:flex-start;width:100%;gap:7px;margin-bottom:6px;padding:8px;border:1px solid var(--agent-border);border-radius:8px;background:var(--agent-bg);color:var(--agent-muted);text-align:left;cursor:pointer}.agent-node.current{border-color:color-mix(in srgb,var(--agent-accent) 42%,var(--agent-border));background:color-mix(in srgb,var(--agent-accent) 9%,var(--agent-panel-strong))}.agent-node>span{display:grid;min-width:0;flex:1;gap:4px}.agent-node strong{overflow:hidden;color:var(--agent-secondary);font-size:12px;text-overflow:ellipsis;white-space:nowrap}.agent-node small{display:flex;align-items:center;gap:3px;overflow:hidden;color:var(--agent-muted);font-size:12px;text-overflow:ellipsis;white-space:nowrap}.agent-node:deep(.status-pill){padding:2px 5px;font-size:12px}
.agent-node strong{white-space:normal;line-height:1.6}.agent-node small{flex-wrap:wrap;white-space:normal;overflow-wrap:anywhere}.agent-node{padding:12px;gap:8px}
</style>
