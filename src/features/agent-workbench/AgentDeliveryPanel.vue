<script setup lang="ts">
/**
 * 设计说明：按原轮号展示当前会话已保存的回复与文件，关联业务交付独立列在下方。
 * 不合并不同轮次的文件身份，不把已有回复当作完成或验收依据。
 */
import { computed } from 'vue';
import { CheckCircle2, ExternalLink, GitMerge, PackageCheck } from '@lucide/vue';
import type { JiraDevTaskView } from '../../../shared/jira-dev';
import type { AgentBusinessContext } from './agent-business-context';
import { catchupQuickPrompt, deliveryJobQuickPrompt, mergeQuickPrompt } from './agent-quick-actions';
import { agentConversationCodePath, agentRunStatus, type AgentConversation } from './conversation';
import { conversationDeliveries } from './conversation-deliveries';
import { agentResultSummary, readableDeliveryReport } from './execution-summary';
import { jiraDevTaskDeliveryId, jiraDevTaskWorkspacePaths } from './jira-dev-context';
import { readAgentDeliveryReport } from '../../../shared/delivery-report';
import { dateTime } from '../../shared/format';
import StatusPill from '../../shared/ui/StatusPill.vue';
import AgentChangedFiles from './AgentChangedFiles.vue';
import AgentMarkdown from './AgentMarkdown.vue';
import AgentDeliveryReport from './AgentDeliveryReport.vue';
import AgentRemoteDelivery from './AgentRemoteDelivery.vue';
import AgentWorkspaceCodeArtifacts from './AgentWorkspaceCodeArtifacts.vue';
import DeliveryAcceptanceEditor from '../workbench/DeliveryAcceptanceEditor.vue';
import type { DeliveryRecord } from '../workbench/domain';
import type { AgentRun } from '../../../shared/agent-runtime';

const props = defineProps<{ conversation?: AgentConversation; context: AgentBusinessContext; loading: boolean; record?: DeliveryRecord; runLabel?: (run: AgentRun) => string; compact?: boolean; matchedJiraTask?: JiraDevTaskView; active?: boolean }>();
const emit = defineEmits<{ compose: [prompt: string]; openGroup: [roomId: string] }>();
// 会话详情只展示当前关联任务，不能借用全局研发任务作为默认交付。
const activeJiraTask = computed(() => props.matchedJiraTask);
const codePaths = computed(() => {
  const path = agentConversationCodePath(props.conversation);
  return path && !jiraDevTaskWorkspacePaths(activeJiraTask.value).includes(path) ? [path] : [];
});
const deliveries = computed(() => conversationDeliveries(props.conversation).map(item => ({ ...item,
  summary: props.compact ? agentResultSummary(item.run.result) : '',
  report: props.compact ? reportSource(item.run.result) : '',
})));
const currentCount = computed(() => props.context.jobs.length + props.context.catchup.length + props.context.merges.length);
const visibleJobs = computed(() => byUpdated(props.context.jobs, item => item.updatedAt));
const visibleCatchup = computed(() => byUpdated(props.context.catchup, item => item.session.updatedAt || item.execution.updatedAt));
const visibleMerges = computed(() => byUpdated(props.context.merges, item => item.pipeline.updatedAt));
const hasResults = computed(() => !!(visibleJobs.value.length || visibleCatchup.value.length || visibleMerges.value.length));

function reportSource(result: string) {
  try {
    const source = JSON.stringify(readAgentDeliveryReport(result));
    return readableDeliveryReport(source) ? source : '';
  } catch { return ''; }
}
function byUpdated<T>(items: T[], getUpdatedAt: (item: T) => string) {
  return [...items].sort((first, second) => Date.parse(getUpdatedAt(second)) - Date.parse(getUpdatedAt(first)));
}
</script>

<template>
  <section class="delivery-panel" aria-label="Agent 交付结果">
    <AgentWorkspaceCodeArtifacts v-if="codePaths.length" :paths="codePaths" :active="active" :run-state="conversation?.latest.status" />
    <section v-if="activeJiraTask" class="synced-jira-delivery" aria-label="需求开发交付产物">
      <div v-if="activeJiraTask.launch?.groupRoomId" class="jira-delivery-switcher">
        <span class="jira-delivery-badge">当前关联任务</span>
        <strong class="jira-delivery-title" :title="activeJiraTask.title">{{ activeJiraTask.title }}</strong>
        <button v-if="activeJiraTask.launch?.groupRoomId" type="button" class="jira-delivery-link" @click="emit('openGroup', activeJiraTask.launch.groupRoomId)">打开群聊</button>
      </div>
      <AgentRemoteDelivery :key="jiraDevTaskDeliveryId(activeJiraTask)" :target-id="jiraDevTaskDeliveryId(activeJiraTask)" :active="active !== false" />
    </section>
    <header class="delivery-toolbar">
      <strong>会话成果 · {{ deliveries.length }} 轮</strong>
    </header>
    <DeliveryAcceptanceEditor v-if="record" :key="record.id" :record="record" />
    <section :key="conversation?.id || 'empty'" class="conversation-deliveries" aria-label="会话成果">
      <details v-for="(item, index) in deliveries" :key="item.run.id" class="delivery-round" :open="index === 0">
        <summary><strong>第 {{ item.round }} 轮<template v-if="runLabel"> · {{ runLabel(item.run) }}</template></strong><StatusPill v-bind="agentRunStatus(item.run)" /><time>{{ dateTime(item.run.updatedAt) }}</time></summary>
        <div class="delivery-round-body">
          <AgentChangedFiles v-if="!item.run.syncedHistory && item.run.changedFiles?.length" :files="item.run.changedFiles" :run-id="item.run.id" />
          <template v-if="compact && item.run.result">
            <AgentDeliveryReport v-if="item.report" compact :source="item.report" />
            <AgentMarkdown v-else-if="item.summary" class="delivery-result-preview" :source="item.summary" />
            <details class="delivery-full-result"><summary>查看完整回复</summary><AgentMarkdown :source="item.run.result" /></details>
          </template>
          <AgentMarkdown v-else-if="item.run.result" :source="item.run.result" />
        </div>
      </details>
      <el-empty v-if="!deliveries.length" :image-size="48" :description="conversation ? '当前会话暂无成果' : '选择会话查看成果'" />
    </section>
    <template v-if="!compact || loading || hasResults">
    <header class="related-delivery-heading"><strong>关联交付 · {{ currentCount }}</strong></header>
    <el-skeleton v-if="loading && !hasResults" :rows="5" animated />
    <template v-else-if="hasResults">
      <section v-if="visibleJobs.length" class="delivery-section">
        <h3>自动执行 <span>{{ visibleJobs.length }}</span></h3>
      <article v-for="job in visibleJobs" :key="job.id" class="delivery-card">
        <header><span><PackageCheck :size="13" /> 执行记录</span><b>{{ job.status }}</b></header>
        <strong>{{ job.issueKey ? `${job.issueKey} · ` : '' }}{{ job.title }}</strong>
        <AgentMarkdown v-if="job.result" class="delivery-result" :source="job.result" /><p v-else-if="job.error" class="error-text">{{ job.error }}</p>
        <small>{{ job.branch || '未识别分支' }} · 尝试 {{ job.attempts }} 次</small>
        <nav><button type="button" @click="emit('compose', deliveryJobQuickPrompt(job))">带入会话</button><a v-if="job.mrUrl" :href="job.mrUrl" target="_blank" rel="noreferrer">MR <ExternalLink :size="11" /></a><router-link :to="{ path: '/delivery/runs', query: { job: job.id } }">查看运行</router-link></nav>
      </article>
      </section>
      <section v-if="visibleCatchup.length" class="delivery-section">
        <h3>需求追平 <span>{{ visibleCatchup.length }}</span></h3>
      <article v-for="item in visibleCatchup" :key="item.id" class="delivery-card">
        <header><span><CheckCircle2 :size="13" /> 追平记录</span><b>{{ item.execution.status || item.deliveryStatus }}</b></header>
        <strong>{{ item.id }} · {{ item.title }}</strong>
        <AgentMarkdown class="delivery-result" :source="item.session.result || item.session.error || item.nextAction" />
        <small>{{ item.session.branch || '未识别分支' }}</small>
        <nav><button type="button" @click="emit('compose', catchupQuickPrompt(item, item.session.jiraKey))">继续检查</button><router-link :to="{ path: '/catchup/execution', query: { requirement: item.id } }">查看执行</router-link></nav>
      </article>
      </section>
      <section v-if="visibleMerges.length" class="delivery-section">
        <h3>分支合入 <span>{{ visibleMerges.length }}</span></h3>
      <article v-for="item in visibleMerges" :key="item.requirementId" class="delivery-card">
        <header><span><GitMerge :size="13" /> 合入记录</span><b>{{ item.merged ? '已合入' : item.status }}</b></header>
        <strong>{{ item.requirementId }} · {{ item.title }}</strong>
        <AgentMarkdown class="delivery-result" :source="item.pipeline.result || item.pipeline.error || item.decisionNote" />
        <small>{{ item.sourceBranch }} · 证据 {{ item.reviewGate.screenshotCount }} 张</small>
        <nav><button type="button" @click="emit('compose', mergeQuickPrompt(item, item.jiraKey))">审核合入</button><a v-if="item.mrUrl" :href="item.mrUrl" target="_blank" rel="noreferrer">MR <ExternalLink :size="11" /></a><router-link :to="{ path: '/catchup/merge', query: { requirement: item.requirementId } }">查看合入</router-link></nav>
      </article>
      </section>
    </template>
    <el-empty v-else description="当前会话暂无关联交付" :image-size="40" />
    </template>
  </section>
</template>

<style scoped>
.delivery-panel{height:100%;min-height:0;padding:0 12px 12px;overflow-y:auto;background:var(--agent-panel)}.delivery-toolbar{position:sticky;z-index:2;top:0;padding:12px 0 10px;background:var(--agent-panel)}.delivery-section>h3{display:flex;align-items:center;gap:5px;margin:8px 2px;color:var(--agent-secondary);font-size:13px}.delivery-section>h3 span{color:var(--agent-muted);font:12px var(--mono)}.delivery-card{margin-bottom:10px;padding:13px;border:1px solid var(--agent-border);border-radius:11px;background:color-mix(in srgb,var(--agent-panel-strong) 82%,transparent)}.delivery-card header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:9px}.delivery-card header span{display:flex;align-items:center;gap:5px;color:var(--agent-muted);font-size:13px}.delivery-card header b{padding:2px 6px;border-radius:6px;background:color-mix(in srgb,var(--agent-accent) 14%,var(--agent-raised));color:color-mix(in srgb,var(--agent-accent) 48%,#fff);font-size:12px}.delivery-card>strong{display:block;color:var(--agent-text);font-size:14px;line-height:1.5}.delivery-card>p{display:-webkit-box;margin:8px 0;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:4;color:var(--agent-secondary);font-size:13px;line-height:1.6}.delivery-card>.error-text{color:#ff9aac}.delivery-card>small{display:block;overflow:hidden;color:var(--agent-muted);font:12px var(--mono);text-overflow:ellipsis;white-space:nowrap}.delivery-card nav{display:flex;gap:12px;margin-top:10px}.delivery-card nav a{display:inline-flex;align-items:center;gap:3px;color:color-mix(in srgb,var(--agent-accent) 55%,#fff);font-size:13px;text-decoration:none}.delivery-card nav a:hover{color:#fff}.delivery-panel:deep(.el-skeleton__item){background:var(--agent-panel-strong)}
.delivery-card nav button{display:inline-flex;align-items:center;gap:3px;padding:0;border:0;background:transparent;color:color-mix(in srgb,var(--agent-accent) 55%,#fff);font-size:13px;cursor:pointer}.delivery-card nav button:hover{color:#fff}
.delivery-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px}
.delivery-panel{min-width:0;overflow-x:hidden}.conversation-deliveries,.delivery-round,.delivery-round-body{min-width:0;max-width:100%}
.delivery-round{margin-bottom:12px;border:1px solid var(--agent-border);border-radius:8px;background:var(--agent-panel-strong);overflow:hidden}
.delivery-round>summary{display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:12px;cursor:pointer;list-style:none;color:var(--agent-text);font-size:13px}
.delivery-round>summary::-webkit-details-marker{display:none}.delivery-round>summary::before{content:'›';font-size:18px;line-height:1;transition:transform .15s}.delivery-round[open]>summary::before{transform:rotate(90deg)}
.delivery-round>summary strong{font-weight:600}.delivery-round time{margin-left:auto;font-size:11px;color:var(--agent-muted)}
.delivery-round-body{padding:0 12px 12px;color:var(--agent-secondary);overflow-wrap:anywhere}
.delivery-result-preview{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:6;overflow:hidden;margin:0 0 10px;white-space:pre-line;font-size:12px;line-height:1.8}
.delivery-full-result>summary{color:var(--agent-accent);font-size:12px;cursor:pointer}.delivery-full-result[open]>summary{margin-bottom:12px}
.related-delivery-heading{padding:16px 0 10px;margin-top:8px;border-top:1px solid var(--agent-border);font-size:13px;color:var(--agent-secondary)}
.delivery-round-body:deep(.changed-files){margin:0 0 12px;padding:0 0 12px;border:0;border-bottom:1px solid var(--agent-border);border-radius:0;background:transparent}
.delivery-round-body:deep(.changed-file-open){min-width:0}.delivery-round-body:deep(.changed-file-open code){white-space:normal;overflow-wrap:anywhere}
.delivery-round-body:deep(.agent-markdown){font-size:13px;max-width:100%}.delivery-round-body:deep(.markdown-heading){color:var(--agent-text)}
.delivery-round-body:deep(.markdown-code){max-width:100%;box-sizing:border-box;background:var(--agent-bg);color:var(--agent-text);border-color:var(--agent-border)}
.delivery-round-body:deep(.markdown-quote){color:var(--agent-secondary);background:var(--agent-panel);border-left-color:var(--agent-accent)}
.delivery-round-body:deep(.markdown-table-wrap),.delivery-round-body:deep(.markdown-table th),.delivery-round-body:deep(.markdown-table td){border-color:var(--agent-border)}
.delivery-round-body:deep(.markdown-table th){color:var(--agent-text);background:var(--agent-panel)}
.delivery-round-body:deep(a){color:var(--agent-accent)}.delivery-round-body:deep(code){color:var(--agent-accent);background:var(--agent-panel)}
.delivery-round-body:deep(.markdown-code code){color:inherit;background:transparent}
.delivery-result{margin:8px 0;max-height:180px;overflow:auto;color:var(--agent-secondary);font-size:13px;line-height:1.6}
.synced-jira-delivery{padding:4px 0 8px;border-bottom:1px solid var(--agent-border);margin-bottom:4px}
.jira-delivery-switcher{display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:8px 0 2px;font-size:12px}
.jira-delivery-badge{padding:2px 6px;border-radius:5px;background:color-mix(in srgb,var(--agent-accent) 14%,var(--agent-raised));color:color-mix(in srgb,var(--agent-accent) 55%,#fff);font-size:11px;flex-shrink:0}
.jira-delivery-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--agent-text);font-size:12px}
.jira-delivery-link{padding:0;border:0;background:transparent;color:var(--agent-accent);font-size:12px;cursor:pointer;flex-shrink:0}
.jira-delivery-link:hover{text-decoration:underline}
</style>
