<script setup lang="ts">
import AgentMarkdown from '../agent-workbench/AgentMarkdown.vue';
import type { DeliveryRecord } from './domain';
import { agentRunPath, agentStatusLabel, deliveryStatusLabel, threadUrl } from './domain';
import { safeUrl, dateTime } from '../../shared/format';
import StatusPill from '../../shared/ui/StatusPill.vue';
import DeliveryAcceptanceEditor from './DeliveryAcceptanceEditor.vue';
import { requirementStages, requirementStageLabels, requirementStageStatusLabels } from '../../../shared/requirement-development';
defineProps<{ records: DeliveryRecord[]; loading?: boolean; errors?: string[]; incomplete?: boolean }>();
function artifactUrl(url: string) { return url.startsWith('/api/source/artifact?') ? url : safeUrl(url); }
</script>
<template>
  <el-alert v-for="error in errors" :key="error" :title="error" type="error" :closable="false" class="section-alert" />
  <el-skeleton v-if="loading && !records.length" :rows="4" animated />
  <el-empty v-else-if="!records.length" :description="errors?.length || incomplete ? '部分来源尚未就绪，暂时无法确认关联记录' : '尚无关联的交付记录'" :image-size="50" />
  <article v-for="record in records" :key="record.id" class="delivery-record">
    <header>
      <div class="record-heading"><span class="record-source">{{ record.source }}</span><strong>{{ record.title || record.issueKeys.join(' · ') }}</strong><small v-if="record.issueKeys.length">{{ record.issueKeys.join(' · ') }}</small></div>
      <div class="record-states">
        <span>Agent <StatusPill v-if="record.agentStatus" :value="record.agentStatus === 'completed' ? 'ended' : record.agentStatus" :label="agentStatusLabel(record.agentStatus)" /><em v-else>{{ record.agentStateKnown === false ? '运行状态尚未就绪' : '未检测到关联运行' }}</em></span>
        <span>历史执行 <StatusPill :value="record.sourceKind === 'agent' && record.status === 'completed' ? 'ended' : record.status" :label="deliveryStatusLabel(record)" /></span>
        <span v-for="issue in record.jiraStatuses" :key="issue.key">{{ issue.key }} <StatusPill :value="issue.status" :label="issue.status" /></span>
      </div>
    </header>
    <div class="record-actions">
      <RouterLink v-if="record.runId" :to="agentRunPath(record.runId)" class="record-action primary">打开 Agent 会话</RouterLink>
      <a v-if="threadUrl(record.threadId)" :href="threadUrl(record.threadId)" class="record-action">打开原会话</a>
      <span v-else-if="!record.runId" class="row-secondary">{{ record.clientThreadId ? '会话创建中，尚未返回正式 ID' : record.threadId ? '会话 ID 无效' : '尚未关联会话' }}</span>
      <RouterLink :to="record.detailPath" class="record-action">进入来源页面</RouterLink>
      <template v-for="link in record.links" :key="link.url"><a v-if="artifactUrl(link.url)" :href="artifactUrl(link.url)" target="_blank" rel="noreferrer" class="record-action">{{ link.label }}</a></template>
    </div>
    <dl class="record-facts"><div v-if="record.project"><dt>项目</dt><dd>{{ record.project }}</dd></div><div><dt>工作目录</dt><dd>{{ record.workspacePath || '未记录' }}</dd></div><div><dt>分支</dt><dd class="mono">{{ record.branch || '未记录' }}</dd></div><div><dt>更新时间</dt><dd>{{ dateTime(record.updatedAt) }}</dd></div></dl>
    <div class="record-acceptance"><DeliveryAcceptanceEditor :record="record" /></div>
    <details v-if="record.requirementProgress" class="record-section"><summary>需求阶段 · {{ record.requirementProgress.source === 'agent-result' ? '会话报告' : '人工记录' }}<template v-if="record.requirementProgress.sourceRunId !== record.runId"> · 记录来自之前轮次</template></summary><ol class="stage-list"><li v-for="stage in requirementStages" :key="stage" :class="record.requirementProgress.stages[stage].status"><strong>{{ requirementStageLabels[stage] }}</strong><span>{{ requirementStageStatusLabels[record.requirementProgress.stages[stage].status] }}</span><p>{{ record.requirementProgress.stages[stage].evidence || '尚未记录证据' }}</p></li></ol></details>
    <el-alert v-if="record.error" :title="record.error" type="error" :closable="false" class="record-error" />
    <details v-if="record.result" open class="record-section"><summary>执行结果</summary><AgentMarkdown class="detail-text" :source="record.result" /></details>
    <p v-else-if="!record.agentRuns?.some(run => run.result)" class="row-secondary record-empty">尚未回传执行结果</p>
    <details v-if="record.agentRuns?.length" :open="record.agentRuns.length === 1" class="record-section"><summary>Agent 执行历史 · {{ record.agentRuns.length }} 轮</summary>
      <section v-for="run in record.agentRuns" :key="run.id" class="run-history">
        <p><StatusPill :value="run.status === 'completed' ? 'ended' : run.status" :label="agentStatusLabel(run.status)" /> <span class="row-secondary">{{ dateTime(run.updatedAt) }}</span></p>
        <div class="inline-links"><RouterLink :to="agentRunPath(run.id)" class="hub-link">打开所属会话</RouterLink><a v-if="run.provider === 'codex' && threadUrl(run.sessionId)" :href="threadUrl(run.sessionId)" class="hub-link">打开本轮原会话</a></div>
        <p class="row-secondary">{{ run.branch || '未记录分支' }} · {{ run.workspacePath || '未记录工作区' }}</p>
        <pre v-if="run.error" class="detail-text">{{ run.error }}</pre><AgentMarkdown v-if="run.result" class="detail-text" :source="run.result" />
        <code>{{ run.id }}</code>
      </section>
    </details>
    <footer v-if="record.threadId"><code>{{ record.threadId }}</code></footer>
  </article>
</template>
<style scoped>
.delivery-record{margin:0 0 14px;padding:16px 18px;border:1px solid var(--ui-border);border-radius:12px;background:var(--ui-surface)}
.delivery-record header{display:flex;flex-direction:column;gap:10px}
.record-heading{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 10px}
.record-heading strong{font-size:14px;font-weight:600;line-height:1.5}
.record-heading small{font:11px var(--mono);color:var(--ui-muted)}
.record-source{padding:1px 7px;border-radius:5px;background:var(--ui-raised);color:var(--ui-secondary);font-size:11px}
.record-states{display:flex;flex-wrap:wrap;gap:8px 16px;font-size:11px;color:var(--ui-muted)}
.record-states>span{display:inline-flex;align-items:center;gap:6px}.record-states em{font-style:normal;color:var(--ui-muted)}
.record-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:12px}
.record-action{display:inline-flex;align-items:center;padding:5px 10px;border:1px solid var(--ui-border);border-radius:7px;font-size:12px;color:var(--ui-secondary);background:var(--ui-surface)}
.record-action:hover{border-color:var(--ui-accent);color:var(--ui-accent)}
.record-action.primary{border-color:var(--ui-accent);background:var(--ui-accent-soft);color:var(--ui-accent);font-weight:550}
.record-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin:14px 0 0;padding:12px;border-radius:9px;background:var(--ui-raised)}
.record-facts dt{font-size:11px;color:var(--ui-muted)}.record-facts dd{margin:3px 0 0;font-size:12px;color:var(--ui-secondary);overflow-wrap:anywhere}.record-facts dd.mono{font-family:var(--mono)}
.record-acceptance{margin-top:4px}
.record-error{margin-top:12px}
.record-empty{margin-top:12px}
.record-section{margin-top:12px;border-top:1px solid var(--ui-divider)}
.record-section summary{padding:12px 0 4px;font-size:12px;font-weight:550;cursor:pointer;color:var(--ui-secondary)}
.record-section summary:hover{color:var(--ui-accent)}
.delivery-record .detail-text{max-height:320px;overflow:auto}
.stage-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px;margin:8px 0 0;padding:0;list-style:none}
.stage-list li{padding:9px 11px;border:1px solid var(--ui-divider);border-left:3px solid var(--ui-divider);border-radius:8px;font-size:12px}
.stage-list li.completed,.stage-list li.passed,.stage-list li.done{border-left-color:var(--ui-success)}.stage-list li.blocked,.stage-list li.failed{border-left-color:var(--ui-danger)}.stage-list li.in_progress,.stage-list li.running{border-left-color:var(--ui-accent)}
.stage-list strong{font-weight:550}.stage-list span{margin-left:8px;color:var(--ui-muted)}.stage-list p{margin:4px 0 0;color:var(--ui-muted);font-size:11px;overflow-wrap:anywhere}
.delivery-record footer{margin-top:12px;color:var(--ui-muted);font-size:10px}.delivery-record footer code{overflow-wrap:anywhere}
.run-history{padding:8px 0;overflow-wrap:anywhere}.run-history+.run-history{border-top:1px solid var(--ui-border)}.run-history code{font-size:10px;color:var(--ui-muted)}
</style>
