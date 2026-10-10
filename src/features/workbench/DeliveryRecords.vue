<script setup lang="ts">
import type { DeliveryRecord } from './domain';
import { threadUrl } from './domain';
import { safeUrl, dateTime } from '../../shared/format';
import StatusPill from '../../shared/ui/StatusPill.vue';
defineProps<{ records: DeliveryRecord[]; loading?: boolean; errors?: string[] }>();
function artifactUrl(url: string) { return url.startsWith('/api/source/artifact?') ? url : safeUrl(url); }
</script>
<template>
  <el-alert v-for="error in errors" :key="error" :title="error" type="error" :closable="false" class="section-alert" />
  <el-skeleton v-if="loading && !records.length" :rows="4" animated />
  <el-empty v-else-if="!records.length" :description="errors?.length ? '部分来源读取失败，暂时无法确认关联记录' : '尚无关联的交付记录'" :image-size="50" />
  <article v-for="record in records" :key="record.id" class="delivery-record">
    <header><div><strong>{{ record.source }}</strong><small>{{ record.issueKeys.join(' · ') || record.title }}</small></div><span>历史执行 <StatusPill :value="record.status" /></span></header>
    <p v-for="issue in record.jiraStatuses" :key="issue.key" class="row-secondary">{{ issue.key }} · 当前 Jira：{{ issue.status }}</p>
    <p class="row-secondary">Agent：<StatusPill v-if="record.agentStatus" :value="record.agentStatus" /><span v-else>未检测到关联运行</span></p>
    <div class="inline-links">
      <a v-if="threadUrl(record.threadId)" :href="threadUrl(record.threadId)" class="hub-link">打开原会话</a>
      <span v-else class="row-secondary">{{ record.clientThreadId ? '会话创建中，尚未返回正式 ID' : record.threadId ? '会话 ID 无效' : '尚未关联会话' }}</span>
      <RouterLink :to="record.detailPath" class="hub-link">进入来源页面</RouterLink>
      <template v-for="link in record.links" :key="link.url"><a v-if="artifactUrl(link.url)" :href="artifactUrl(link.url)" target="_blank" rel="noreferrer">{{ link.label }}</a></template>
    </div>
    <dl class="detail-facts"><div><dt>工作目录</dt><dd>{{ record.workspacePath || '未记录' }}</dd></div><div><dt>分支</dt><dd>{{ record.branch || '未记录' }}</dd></div></dl>
    <el-alert v-if="record.error" :title="record.error" type="error" :closable="false" />
    <details v-if="record.result" open><summary>执行结果</summary><pre class="detail-text">{{ record.result }}</pre></details>
    <p v-else class="row-secondary">尚未回传执行结果</p>
    <footer><span>{{ dateTime(record.updatedAt) }}</span><code v-if="record.threadId">{{ record.threadId }}</code></footer>
  </article>
</template>
<style scoped>
.delivery-record{padding:20px 0;border-bottom:1px solid var(--ui-border)}.delivery-record:first-of-type{padding-top:10px}.delivery-record header{display:flex;justify-content:space-between;gap:15px;align-items:center}.delivery-record header strong{font-size:14px}.delivery-record header small{display:block;margin-top:6px;color:var(--ui-muted);font-size:11px}.delivery-record .inline-links{flex-wrap:wrap}.delivery-record dd{overflow-wrap:anywhere}.delivery-record summary{font-size:12px;cursor:pointer;margin:14px 0}.delivery-record .detail-text{max-height:320px;overflow:auto}.delivery-record footer{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;color:var(--ui-muted);font-size:11px;margin-top:14px}.delivery-record footer code{overflow-wrap:anywhere;font-size:10px}
</style>
