<script setup lang="ts">
/**
 * 设计说明：团队流程卡片只投影服务端推导的流程摘要（阶段、下一步、每步岗位与模型），
 * 操作只发出用户决定；是否允许由服务端按当前状态校验，验收仍在实现会话的“交付”中完成。
 */
import { computed } from 'vue';
import { ElMessageBox } from 'element-plus';
import type { AgentWorkflowAction, AgentWorkflowState, AgentWorkflowSummary } from '../../../shared/agent-runtime';
import { agentRoleProfiles, agentTeamTemplates } from '../../../shared/agent-roles';
import { workflowStageLabels, workflowStateLabels } from '../../../shared/agent-workflow';
import StatusPill from '../../shared/ui/StatusPill.vue';

const props = defineProps<{ workflow: AgentWorkflowSummary; changing?: boolean; currentConversationId?: string }>();
const emit = defineEmits<{ decide: [workflowId: string, action: AgentWorkflowAction]; select: [conversationId: string]; accept: [conversationId: string] }>();
const stateTone: Record<AgentWorkflowState, string> = {
  implementing: 'running', verifying: 'running', reviewing: 'running', reworking: 'running', awaiting_acceptance: 'pending',
  needs_decision: 'waiting', blocked: 'blocked', cancelled: 'cancelled', taken_over: 'cancelled',
};
const actionLabels: Record<AgentWorkflowAction, string> = {
  extend: '继续执行', escalate: '升级模型再试', retry: '重试', takeover: '我来接手', cancel: '取消流程',
};
const outcomeLabels = { pending: '进行中', passed: '通过', failed: '退回', blocked: '阻塞' } as const;
const providerLabels = { codex: 'Codex', claude: 'Claude', cursor: 'Cursor', kiro: 'Kiro', antigravity: 'Antigravity', api: '模型 API', deepseek: 'DeepSeek', workbuddy: 'WorkBuddy', grok: 'Grok' } as const;
const actions = computed(() => props.workflow.actions.filter(action => action !== 'extend'));
const escalation = computed(() => agentRoleProfiles[agentTeamTemplates[props.workflow.templateId].implementer].escalation);

async function decide(action: AgentWorkflowAction) {
  if (action === 'cancel' || action === 'takeover') {
    try {
      await ElMessageBox.confirm(action === 'cancel' ? '将停止流程中正在运行的岗位，已有改动保留，不会回滚。'
        : '流程将不再自动推进，你可以在实现会话中继续处理；正在运行的岗位会被停止。', actionLabels[action],
      { type: 'warning', confirmButtonText: actionLabels[action], cancelButtonText: '返回', closeOnClickModal: false });
    } catch { return; }
  }
  emit('decide', props.workflow.id, action);
}
</script>

<template>
  <section class="team-workflow" :aria-label="`团队流程：${agentTeamTemplates[workflow.templateId].label}`">
    <header>
      <strong>团队流程 · {{ agentTeamTemplates[workflow.templateId].label }}</strong>
      <StatusPill :value="stateTone[workflow.state]" :label="workflowStateLabels[workflow.state]" />
    </header>
    <p class="team-objective" :title="workflow.objective">{{ workflow.objective }}</p>
    <dl>
      <div><dt>当前</dt><dd>{{ workflow.reason }}</dd></div>
      <div><dt>下一步</dt><dd>{{ workflow.nextStep }}</dd></div>
      <div><dt>轮次</dt><dd>第 {{ workflow.round }} 轮<template v-if="workflow.escalated"> · 已升级模型</template></dd></div>
      <div><dt>验收标准</dt><dd>{{ workflow.acceptanceCriteria.length ? `${workflow.acceptanceCriteria.length} 条` : '未提供验收标准' }}</dd></div>
      <div><dt>允许修改</dt><dd :title="workflow.allowedPaths.join('\n')">{{ workflow.allowedPaths.length ? workflow.allowedPaths.join('、') : '未限制（只记录改动）' }}</dd></div>
      <div v-if="workflow.providerFallback" class="team-fallback"><dt>执行器切换</dt><dd :title="workflow.providerFallback.reason">Claude → Codex · {{ workflow.providerFallback.reason }}</dd></div>
      <div v-if="workflow.snapshot"><dt>代码版本</dt><dd :title="workflow.snapshot.value">{{ workflow.snapshot.kind === 'git-tree' ? 'Git' : '非 Git 快照' }} · {{ workflow.snapshot.value.slice(0, 12) }}</dd></div>
    </dl>
    <ol class="team-steps">
      <li v-for="step in workflow.steps" :key="step.step">
        <button type="button" :class="{ current: step.conversationId === currentConversationId }" @click="emit('select', step.conversationId)">
          <span class="step-title">{{ step.step }}. {{ workflowStageLabels[step.stage] }}<template v-if="step.round"> · 第 {{ step.round }} 轮</template></span>
          <span class="step-outcome" :class="step.outcome">{{ outcomeLabels[step.outcome] }}</span>
          <small>{{ providerLabels[step.provider] }} · {{ step.model }}<template v-if="step.reasoningEffort"> · {{ step.reasoningEffort }}</template></small>
          <small class="step-reason" :title="step.reason">{{ step.reason }}</small>
        </button>
      </li>
    </ol>
    <div v-if="actions.length || workflow.state === 'awaiting_acceptance'" class="team-actions">
      <el-button v-if="workflow.state === 'awaiting_acceptance' && workflow.implementationConversationId" size="small" type="primary"
        @click="emit('accept', workflow.implementationConversationId)">打开实现会话验收</el-button>
      <el-button v-for="action in actions" :key="action" size="small" :disabled="changing"
        :title="action === 'escalate' && escalation ? `改用 ${escalation.model} · ${escalation.reasoningEffort}` : undefined"
        @click="decide(action)">{{ actionLabels[action] }}</el-button>
    </div>
  </section>
</template>

<style scoped>
.team-workflow{margin:0 0 14px;padding:10px 11px;border:1px solid color-mix(in srgb,var(--agent-accent) 36%,var(--agent-border));border-radius:9px;background:color-mix(in srgb,var(--agent-bg) 58%,transparent)}
.team-workflow>header{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--agent-secondary);font-size:12px}
.team-objective{margin:8px 0;max-height:60px;overflow:hidden;color:var(--agent-text);font-size:12px;line-height:1.55;overflow-wrap:anywhere}
.team-workflow dl{display:grid;gap:5px;margin:0}.team-workflow dl div{display:flex;justify-content:space-between;gap:8px}
.team-workflow dt,.team-workflow dd{margin:0;font-size:11px;line-height:1.45}.team-workflow dt{flex-shrink:0;color:var(--agent-muted)}
.team-workflow dd{min-width:0;overflow:hidden;color:var(--agent-secondary);text-align:right;text-overflow:ellipsis;white-space:nowrap}
.team-fallback dd{color:#f1c36f}
.team-steps{display:grid;gap:5px;margin:10px 0 0;padding:0;list-style:none}
.team-steps button{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 8px;width:100%;padding:7px 8px;border:1px solid var(--agent-border);border-radius:7px;background:var(--agent-panel);color:var(--agent-muted);text-align:left;cursor:pointer}
.team-steps button:hover,.team-steps button.current{border-color:color-mix(in srgb,var(--agent-accent) 48%,var(--agent-border))}
.step-title{color:var(--agent-secondary);font-size:11px}.step-outcome{font-size:10px}.step-outcome.passed{color:#69ddb2}.step-outcome.failed{color:#f1c36f}.step-outcome.blocked{color:#ff9aac}
.team-steps small{grid-column:1 / -1;overflow:hidden;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.step-reason{color:var(--agent-muted)}
.team-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.team-actions :deep(.el-button){margin:0}
</style>
