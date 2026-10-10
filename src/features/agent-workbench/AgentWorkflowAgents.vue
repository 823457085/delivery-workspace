<script setup lang="ts">
/**
 * 设计说明：协作区展示服务端持久化的主 Agent、子 Agent 和依赖关系，并提供最小的新建入口。
 * 子 Agent 继承主会话的执行器、模型和项目基线；这里不重复暴露运行参数，避免同一任务树配置漂移。
 */
import { computed, reactive, shallowRef } from 'vue';
import { Bot, GitBranch, GitMerge, Plus, ShieldCheck, Wrench } from '@lucide/vue';
import StatusPill from '../../shared/ui/StatusPill.vue';
import type { SpawnAgentTaskInput } from '../../../shared/agent-runtime';
import type { AgentConversation } from './conversation';
import { buildAgentTaskGraph } from './agent-task-graph';

const props = defineProps<{ conversation?: AgentConversation; conversations: AgentConversation[]; spawning?: boolean }>();
const emit = defineEmits<{ select: [conversationId: string]; spawn: [input: SpawnAgentTaskInput] }>();
const open = shallowRef(false);
const form = reactive<SpawnAgentTaskInput>({ title: '', objective: '', role: 'worker', dependsOnConversationIds: [] });
const nodes = computed(() => buildAgentTaskGraph(props.conversation, props.conversations));
const dependencyOptions = computed(() => nodes.value.filter((node) => node.role !== 'main'));
const canSubmit = computed(() => !!form.title.trim() && !!form.objective.trim() && !props.spawning);
const roleLabels = { main: '主 Agent', worker: '执行 Agent', reviewer: '复核 Agent' } as const;

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
      <div><span>Agent 任务图</span><small>{{ nodes.length }} 个独立会话</small></div>
      <button type="button" :disabled="spawning" @click="openCreate"><Plus :size="11" />新增 Agent</button>
    </header>
    <button v-for="node in nodes" :key="node.id" type="button" class="agent-node"
      :class="{ current: node.id === conversation?.id }" @click="emit('select', node.id)">
      <component :is="node.role === 'reviewer' ? ShieldCheck : node.role === 'worker' ? Wrench : Bot" :size="12" />
      <span>
        <strong>{{ roleLabels[node.role] }} · {{ node.title }}</strong>
        <small><GitBranch :size="10" />{{ node.branch || '普通文件夹' }} · {{ node.model || 'CLI 默认' }}<template v-if="node.pid"> · PID {{ node.pid }}</template><template v-if="node.changedFiles"> · {{ node.changedFiles }} 个改动文件</template></small>
        <small v-if="node.dependsOnConversationIds.length"><GitMerge :size="10" />等待 {{ node.dependsOnConversationIds.map((id) => nodes.find((item) => item.id === id)?.title || id.slice(0, 8)).join('、') }}</small>
      </span>
      <StatusPill :value="node.status" />
    </button>
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
.workflow-agents{margin:0 0 14px}.workflow-agents>header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 2px 7px}.workflow-agents>header>div{display:grid;gap:2px;color:var(--agent-secondary);font-size:13px}.workflow-agents>header small{color:var(--agent-muted);font:12px var(--mono)}.workflow-agents>header button{display:flex;align-items:center;gap:3px;padding:4px 7px;border:1px solid color-mix(in srgb,var(--agent-accent) 38%,var(--agent-border));border-radius:6px;background:color-mix(in srgb,var(--agent-accent) 10%,var(--agent-panel-strong));color:color-mix(in srgb,var(--agent-accent) 48%,#fff);font-size:12px;cursor:pointer}.workflow-agents>header button:disabled{opacity:.45;cursor:default}.agent-node{display:flex;align-items:flex-start;width:100%;gap:7px;margin-bottom:6px;padding:8px;border:1px solid var(--agent-border);border-radius:8px;background:var(--agent-bg);color:var(--agent-muted);text-align:left;cursor:pointer}.agent-node.current{border-color:color-mix(in srgb,var(--agent-accent) 42%,var(--agent-border));background:color-mix(in srgb,var(--agent-accent) 9%,var(--agent-panel-strong))}.agent-node>span{display:grid;min-width:0;flex:1;gap:4px}.agent-node strong{overflow:hidden;color:var(--agent-secondary);font-size:12px;text-overflow:ellipsis;white-space:nowrap}.agent-node small{display:flex;align-items:center;gap:3px;overflow:hidden;color:var(--agent-muted);font-size:12px;text-overflow:ellipsis;white-space:nowrap}.agent-node:deep(.status-pill){padding:2px 5px;font-size:12px}
.agent-node strong{white-space:normal;line-height:1.6}.agent-node small{flex-wrap:wrap;white-space:normal;overflow-wrap:anywhere}.agent-node{padding:12px;gap:8px}
</style>
