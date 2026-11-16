<script setup lang="ts">
import { RefreshCw } from '@lucide/vue';
import StatusPill from '../../src/shared/ui/StatusPill.vue';
import type { JiraIssue } from '../../shared/hub';
defineProps<{today: string; todayIssues: JiraIssue[]; loading: boolean; error?: Error | null; jiraSyncStatus?: {schedule: string; lastRunAt: string; nextRunAt: string; updatedCount: number; blockedCount: number}}>();
const emit = defineEmits<{openIssue: [key: string]}>();
</script>
<template>        <section id="workbench-today" class="wb-card">
          <div class="wb-card-head compact"><div><h2>今天要做</h2><p>{{ today }} · 以 Jira 计划日期为准</p></div><RouterLink to="/tasks/list" class="wb-link">全部任务</RouterLink></div>
          <el-skeleton v-if="loading" class="wb-pad" :rows="3" animated />
          <ul v-else-if="todayIssues.length" class="wb-today">
            <li v-for="issue in todayIssues.slice(0, 6)" :key="issue.key"><button type="button" @click="emit('openIssue', issue.key)"><span><small>{{ issue.key }}</small><strong>{{ issue.summary }}</strong></span><StatusPill :value="issue.status" :label="issue.status" /></button></li>
            <li v-if="todayIssues.length > 6" class="wb-more"><RouterLink to="/tasks/calendar">还有 {{ todayIssues.length - 6 }} 项，查看任务日历</RouterLink></li>
          </ul>
          <p v-else class="wb-empty">{{ error ? '任务来源读取失败' : '今天没有已排期的未完成任务 🎉' }}</p>
        </section>


        <section v-if="jiraSyncStatus" class="wb-card wb-sync">
          <div class="wb-card-head compact"><div><h2><RefreshCw :size="14" /> Jira 自动状态同步</h2><p>每日 {{ jiraSyncStatus.schedule }}</p></div><RouterLink to="/settings" class="wb-link">设置</RouterLink></div>
          <dl>
            <div><dt>上次</dt><dd>{{ jiraSyncStatus.lastRunAt }}</dd></div>
            <div><dt>下次</dt><dd>{{ jiraSyncStatus.nextRunAt }}</dd></div>
            <div><dt>更新</dt><dd>{{ jiraSyncStatus.updatedCount }} 项</dd></div>
            <div><dt>阻塞</dt><dd :class="{ warn: jiraSyncStatus.blockedCount }">{{ jiraSyncStatus.blockedCount }} 项</dd></div>
          </dl>
          <p class="wb-note">开始日期到达更新为“开发中”，结束日期到达且完成证据齐全更新为“已完成”。只处理分配给当前用户的 Jira，不创建会话、子任务或合并请求。</p>
        </section>
</template>
<style scoped>
.wb-card{border:1px solid var(--ui-border);border-radius:var(--ds-radius,12px);background:var(--ui-surface);margin-bottom:16px;padding:16px}
.wb-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:8px}
h2{display:flex;align-items:center;gap:6px;margin:0;font-size:14px;font-weight:600;line-height:20px;color:var(--ui-text)}
.wb-card-head p{margin:3px 0 0;color:var(--ui-muted);font-size:12px;line-height:16px}
.wb-link{flex-shrink:0;color:var(--ui-accent);font-size:12px;font-weight:500;text-decoration:none}
.wb-link:hover{text-decoration:underline;text-underline-offset:3px}
p,small,dt{color:var(--ui-muted);font-size:12px}
.wb-today{list-style:none;margin:0;padding:4px 0}
.wb-today button{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;text-align:left;border:0;border-radius:var(--ds-radius-xs,8px);background:transparent;color:var(--ui-text);padding:8px 10px;cursor:pointer;transition:background-color 160ms ease}
.wb-today button:hover{background:var(--ui-hover)}
.wb-today button>span:first-child{min-width:0;flex:1}
.wb-today small{display:block;font:500 11px/15px var(--mono);color:var(--ui-muted)}
.wb-today strong{display:block;margin-top:2px;font-size:12.5px;font-weight:500;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wb-more{padding:6px 10px 2px;font-size:12px}
.wb-empty{margin:0;padding:16px 12px;text-align:center;font-size:12.5px;color:var(--ui-muted)}
dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:10px 0}
dl>div{min-width:0;padding:9px 11px;border:1px solid var(--ui-divider);border-radius:var(--ds-radius-xs,8px);background:var(--ui-raised)}
dt{font-size:11.5px;line-height:16px;color:var(--ui-muted)}
dd{margin:3px 0 0;font:600 13.5px/18px var(--mono);font-variant-numeric:tabular-nums;color:var(--ui-text)}
dd.warn{color:var(--ui-warning)}
.wb-note{margin:10px 0 0;font-size:12px;line-height:1.65;color:var(--ui-muted)}
a{color:var(--ui-accent);text-decoration:none}
</style>
