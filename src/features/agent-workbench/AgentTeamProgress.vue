<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue';
import { agentProviderLabels, type AgentRun } from '../../../shared/agent-runtime';
import type { TeamNode } from '../../../shared/agent-team';
import { dateTime } from '../../shared/format';
import StatusPill from '../../shared/ui/StatusPill.vue';
import AgentAvatar from './AgentAvatar.vue';
import { teamChatNodeProgress, teamRoleLabels } from './team-chat';
import type { AdvancedTeamTask } from './team-api';

/** 节点时间沿用已有取值优先级，并标注实际字段含义；不改排序，也不补造缺失时间。 */
function teamNodeTimestamp(node: TeamNode, run?: AgentRun) {
  if (run?.createdAt && ['running', 'queued', 'waiting_input'].includes(node.status))
    return `运行记录创建 ${dateTime(run.createdAt)}`;
  if (node.finishedAt) return `结束 ${dateTime(node.finishedAt)}`;
  if (node.startedAt) return `开始 ${dateTime(node.startedAt)}`;
  return node.updatedAt ? `更新 ${dateTime(node.updatedAt)}` : '';
}

const props = defineProps<{ task: AdvancedTeamTask; runs: AgentRun[] }>();
const emit = defineEmits<{ inspect: [run: AgentRun] }>();
const groups = computed(() => teamChatNodeProgress(props.task, props.runs));
const showHistory = shallowRef(false);
const current = computed(() => groups.value.find(group => group.current) || groups.value[0]);
const historicalCount = computed(() => groups.value.filter(group => group !== current.value).length);
const visibleGroups = computed(() => showHistory.value ? groups.value : current.value ? [current.value] : []);
const counts = computed(() => {
  const nodes = current.value?.nodes || [];
  return { total: nodes.length, completed: nodes.filter(item => item.node.status === 'completed').length,
    active: nodes.filter(item => ['running', 'queued'].includes(item.node.status)).length,
    blocked: nodes.filter(item => ['blocked', 'failed', 'needs_reconciliation'].includes(item.node.status) || ['failed', 'blocked'].includes(item.check?.value || '')).length };
});
watch(() => props.task.id, () => { showHistory.value = false; });
const labels: Record<string, string> = { pending: '待开始', queued: '排队中', running: '进行中', completed: '已完成', failed: '失败',
  blocked: '遇到阻碍', waiting_input: '等待回复', cancelled: '已停止', skipped: '已跳过', needs_reconciliation: '待核对' };
</script>

<template>
  <section class="team-node-progress" aria-label="协作进展">
    <header class="progress-heading"><h3>协作进展</h3><div class="progress-counts"><span>{{ counts.completed }} / {{ counts.total }} 个步骤已结束</span><span v-if="counts.active">{{ counts.active }} 项进行中</span><span v-if="counts.blocked">{{ counts.blocked }} 项遇到阻碍</span></div></header>
    <section v-for="group in visibleGroups" :key="group.round" class="progress-round">
      <h4>{{ group.current ? '本轮协作' : '历史协作' }} · 第 {{ group.round + 1 }} 轮</h4>
      <p v-if="group.feedback" class="round-feedback"><strong>{{ group.feedback.label }}</strong>{{ group.feedback.text }}</p>
      <ol>
        <li v-for="item in group.nodes" :key="item.node.id" :data-node-id="item.node.id">
          <AgentAvatar class="node-avatar" :provider="item.identity?.provider" :model="item.identity?.model" :size="30" />
          <div class="node-content"><header>
            <strong>{{ teamRoleLabels[item.node.profileId] || item.node.profileId }}</strong>
            <StatusPill :value="item.check?.value || (item.node.status === 'completed' ? 'ended' : item.node.status)" :label="item.check ? `运行已结束 · ${item.check.label}` : item.node.status === 'completed' ? item.node.profileId === 'leader' ? '已回复' : '运行已结束' : labels[item.node.status] || item.node.status" />
            <time v-if="teamNodeTimestamp(item.node, item.run)" class="node-time">{{ teamNodeTimestamp(item.node, item.run) }}</time>
            <el-button v-if="item.run" link @click="emit('inspect', item.run)">查看日志</el-button>
          </header>
          <small v-if="item.identity" class="node-model">{{ agentProviderLabels[item.identity.provider] }} · {{ item.identity.model || 'CLI 默认' }}</small>
          <p v-if="item.activity" class="node-activity">{{ item.activity }}</p>
          <p v-if="item.summary && item.summary !== item.activity">{{ item.summary }}</p>
          <p v-if="item.check?.detail && item.check.detail !== item.summary" class="node-check">{{ item.check.detail }}</p>
          <p v-if="item.error" class="node-error"><b>遇到的问题</b>{{ item.error }}</p>
          <p v-if="!item.error && !item.activity && !item.summary" class="node-empty">{{ item.node.status === 'pending' ? '等待前一步完成。' : item.node.status === 'skipped' ? '本轮无需执行。' : '尚未返回进展。' }}</p>
          </div>
        </li>
      </ol>
    </section>
    <el-button v-if="historicalCount" link class="history-toggle" :aria-expanded="showHistory" @click="showHistory = !showHistory">{{ showHistory ? '收起历史协作' : `历史协作 · ${historicalCount} 轮` }}</el-button>
  </section>
</template>

<style scoped>
.team-node-progress{margin-top:20px;color:var(--agent-text)}.progress-heading{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;padding-bottom:12px;border-bottom:1px solid var(--agent-border)}.progress-heading h3{margin:0;font-size:15px;font-weight:600}.progress-counts{display:flex;gap:14px;font-size:12px;color:var(--agent-muted)}.progress-round h4{margin:18px 0 0;color:var(--agent-muted);font-size:12px;font-weight:500}.progress-round ol{padding:0;margin:0;list-style:none}.progress-round li{display:grid;grid-template-columns:30px minmax(0,1fr);gap:12px;padding:16px 0;border-bottom:1px solid var(--agent-border)}.node-avatar{margin-top:1px}.node-content{min-width:0}.node-content header{display:flex;align-items:center;flex-wrap:wrap;gap:10px;min-height:24px}.node-content header strong{font-size:14px;font-weight:600}.node-content header :deep(.el-button){margin-left:auto;font-size:12px;color:var(--agent-muted)}.node-time{color:var(--agent-muted);font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}.node-model{display:block;margin-top:3px;color:var(--agent-muted);font-size:11px;overflow-wrap:anywhere}.node-content p{margin:9px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.8;font-size:13px}.node-error{color:var(--ui-danger)}.node-error b{display:block;margin-bottom:3px;font-size:12px;font-weight:500}.node-empty{color:var(--agent-muted)}.history-toggle{margin-top:14px}
</style>

<style scoped>
.round-feedback{margin:9px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.8;color:var(--agent-secondary)}.round-feedback strong{display:block;font-weight:500;color:var(--agent-text);margin-bottom:4px}.node-check{white-space:pre-wrap}
</style>
