<script setup lang="ts">
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
    <header><div><strong>{{ record.source }}</strong><small>{{ record.issueKeys.join(' · ') || record.title }}</small></div><span>历史执行 <StatusPill :value="record.sourceKind === 'agent' && record.status === 'completed' ? 'ended' : record.status" :label="deliveryStatusLabel(record)" /></span></header>
    <p v-for="issue in record.jiraStatuses" :key="issue.key" class="row-secondary">{{ issue.key }} · 当前 Jira：{{ issue.status }}</p>
    <p class="row-secondary">Agent：<StatusPill v-if="record.agentStatus" :value="record.agentStatus === 'completed' ? 'ended' : record.agentStatus" :label="agentStatusLabel(record.agentStatus)" /><span v-else>{{ record.agentStateKnown === false ? '运行状态尚未就绪' : '未检测到关联运行' }}</span></p>
    <div class="inline-links">
      <RouterLink v-if="record.runId" :to="agentRunPath(record.runId)" class="hub-link">打开 Agent 会话</RouterLink>
      <a v-if="threadUrl(record.threadId)" :href="threadUrl(record.threadId)" class="hub-link">打开原会话</a>
      <span v-else class="row-secondary">{{ record.clientThreadId ? '会话创建中，尚未返回正式 ID' : record.threadId ? '会话 ID 无效' : '尚未关联会话' }}</span>
      <RouterLink :to="record.detailPath" class="hub-link">进入来源页面</RouterLink>
      <template v-for="link in record.links" :key="link.url"><a v-if="artifactUrl(link.url)" :href="artifactUrl(link.url)" target="_blank" rel="noreferrer">{{ link.label }}</a></template>
    </div>
    <dl class="detail-facts"><div v-if="record.project"><dt>项目</dt><dd>{{ record.project }}</dd></div><div><dt>工作目录</dt><dd>{{ record.workspacePath || '未记录' }}</dd></div><div><dt>分支</dt><dd>{{ record.branch || '未记录' }}</dd></div></dl>
    <details v-if="record.requirementProgress"><summary>需求阶段 · {{ record.requirementProgress.source === 'agent-result' ? '会话报告' : '人工记录' }}<template v-if="record.requirementProgress.sourceRunId !== record.runId"> · 记录来自之前轮次</template></summary><p v-for="stage in requirementStages" :key="stage" class="row-secondary">{{ requirementStageLabels[stage] }}：{{ requirementStageStatusLabels[record.requirementProgress.stages[stage].status] }} · {{ record.requirementProgress.stages[stage].evidence || '尚未记录证据' }}</p></details>
    <DeliveryAcceptanceEditor :record="record" />
    <el-alert v-if="record.error" :title="record.error" type="error" :closable="false" />
    <details v-if="record.result" open><summary>执行结果</summary><pre class="detail-text">{{ record.result }}</pre></details>
    <p v-else-if="!record.agentRuns?.some(run => run.result)" class="row-secondary">尚未回传执行结果</p>
    <details v-if="record.agentRuns?.length" :open="record.agentRuns.length === 1"><summary>Agent 执行历史 · {{ record.agentRuns.length }} 轮</summary>
      <section v-for="run in record.agentRuns" :key="run.id" class="run-history">
        <p><StatusPill :value="run.status === 'completed' ? 'ended' : run.status" :label="agentStatusLabel(run.status)" /> <span class="row-secondary">{{ dateTime(run.updatedAt) }}</span></p>
        <div class="inline-links"><RouterLink :to="agentRunPath(run.id)" class="hub-link">打开所属会话</RouterLink><a v-if="run.provider === 'codex' && threadUrl(run.sessionId)" :href="threadUrl(run.sessionId)" class="hub-link">打开本轮原会话</a></div>
        <p class="row-secondary">{{ run.branch || '未记录分支' }} · {{ run.workspacePath || '未记录工作区' }}</p>
        <pre v-if="run.error" class="detail-text">{{ run.error }}</pre><pre v-if="run.result" class="detail-text">{{ run.result }}</pre>
        <code>{{ run.id }}</code>
      </section>
    </details>
    <footer><span>{{ dateTime(record.updatedAt) }}</span><code v-if="record.threadId">{{ record.threadId }}</code></footer>
  </article>
</template>
<style scoped>
.delivery-record{padding:20px 0;border-bottom:1px solid var(--ui-border)}.delivery-record:first-of-type{padding-top:10px}.delivery-record header{display:flex;justify-content:space-between;gap:15px;align-items:center}.delivery-record header strong{font-size:14px}.delivery-record header small{display:block;margin-top:6px;color:var(--ui-muted);font-size:11px}.delivery-record .inline-links{flex-wrap:wrap}.delivery-record dd{overflow-wrap:anywhere}.delivery-record summary{font-size:12px;cursor:pointer;margin:14px 0}.delivery-record .detail-text{max-height:320px;overflow:auto}.delivery-record footer{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;color:var(--ui-muted);font-size:11px;margin-top:14px}.delivery-record footer code{overflow-wrap:anywhere;font-size:10px}
.run-history{padding:8px 0;overflow-wrap:anywhere}.run-history+.run-history{border-top:1px solid var(--ui-border)}.run-history code{font-size:10px;color:var(--ui-muted)}
</style>
