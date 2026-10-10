<script setup lang="ts">
import AgentAvatar from './AgentAvatar.vue';
/**
 * 设计说明：右栏只把当前会话已保存的运行事件压缩为关键摘要，不生成新状态，也不把 Agent 文本当作工具证据。
 * 只默认展开最新一轮关键过程，历史轮次可手动展开；详情入口传递对应运行记录，在统一抽屉中查看完整诊断信息。
 */
import { CheckCircle2, CircleAlert, Clock3, LoaderCircle, Wrench, XCircle } from '@lucide/vue';
import { computed, nextTick, useTemplateRef, watch } from 'vue';
import type { Component } from 'vue';
import type { AgentRun } from '../../../shared/agent-runtime';
import { dateTime } from '../../shared/format';
import type { AgentConversation } from './conversation';
import { groupRunExecutionEvents, summarizeRunExecution, type AgentExecutionSummary } from './execution-summary';

const props = defineProps<{ conversation?: AgentConversation }>();
const emit = defineEmits<{ inspect: [run: AgentRun] }>();
const executionScroll = useTemplateRef<HTMLElement>('executionScroll');
const executionRounds = computed(() => [...(props.conversation?.runs || [])]
  .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
  .map((run) => ({ run, summaries: summarizeRunExecution(run),
    events: groupRunExecutionEvents(run.events) })));

watch(() => [props.conversation?.id, props.conversation?.latest.updatedAt, props.conversation?.latest.events.length], async () => {
  await nextTick();
  if (executionScroll.value) executionScroll.value.scrollTop = 0;
}, { flush: 'post' });

function roundNumber(run: AgentRun) {
  return (props.conversation?.runs.findIndex((item) => item.id === run.id) ?? -1) + 1;
}

function summaryIcon(item: AgentExecutionSummary): Component {
  if (item.key === 'commands') return Wrench;
  if (item.key === 'diagnostic') return CircleAlert;
  if (item.tone === 'progress') return LoaderCircle;
  if (item.tone === 'success') return CheckCircle2;
  if (item.tone === 'danger') return XCircle;
  return Clock3;
}
</script>

<template>
  <section class="execution-panel" aria-label="Agent 执行过程">
    <template v-if="conversation">
      <div class="execution-summary"><span class="execution-agent"><AgentAvatar :size="20" />{{ conversation.latest.provider === 'codex' ? '启元' : 'Cursor Agent' }}</span><small>{{ conversation.latest.sessionId || '正在创建 Session' }}</small></div>
      <div :key="conversation.latest.id" ref="executionScroll" class="execution-scroll">
        <section v-for="round in executionRounds" :key="round.run.id" class="execution-round">
          <button type="button" class="round-heading" @click="emit('inspect', round.run)"><span>第 {{ roundNumber(round.run) }} 轮</span><time>{{ dateTime(round.run.updatedAt) }}</time></button>
          <p v-if="conversation.source === 'codex'" class="history-round">{{ round.run.objective }}</p>
          <div v-else class="summary-list">
            <button v-for="item in round.summaries" :key="item.key" type="button" class="summary-item" :class="[item.tone, item.key]" @click="emit('inspect', round.run)">
              <span><component :is="summaryIcon(item)" :size="13" /></span><div><strong>{{ item.title }}</strong><p>{{ item.detail }}</p></div>
            </button>
          </div>
          <details v-if="round.run.events.length" class="round-events" :open="round.run.id === conversation.latest.id">
            <summary>运行过程（{{ round.run.events.length }}）<button type="button" class="round-event-detail" @click.stop.prevent="emit('inspect', round.run)">详情</button></summary>
            <p v-if="round.events.routine.length" class="round-command-summary">工作区命令：{{ round.events.routineSummary }}</p>
            <ol>
              <li v-for="event in [...round.events.visible].reverse()" :key="event.id">
                <span>{{ event.message }}</span><time>{{ dateTime(event.createdAt) }}</time>
              </li>
            </ol>
          </details>
        </section>
      </div>
      <footer class="execution-footer"><span>{{ conversation.source === 'codex' ? '历史轮次' : '执行轮次' }}</span><strong>{{ conversation.runs.length }}</strong><button type="button" @click="emit('inspect', conversation.latest)">完整信息</button></footer>
    </template>
    <el-empty v-else description="选择会话查看执行过程" :image-size="45" />
  </section>
</template>

<style scoped>
.execution-panel{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0;overflow:hidden;background:linear-gradient(180deg,var(--agent-panel-strong),var(--agent-panel));color:var(--agent-text)}.execution-summary{padding:15px 16px;border-bottom:1px solid var(--agent-border);background:var(--agent-panel)}.execution-agent{display:flex;align-items:center;gap:7px;color:color-mix(in srgb,var(--agent-accent) 45%,#fff);font-size:13px;font-weight:650}.execution-summary small{display:block;margin-top:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12px var(--mono);color:var(--agent-muted)}
.execution-scroll{flex:1;min-height:0;overflow-y:auto;padding:12px}.execution-round{margin:0 0 10px;padding:11px 11px 13px;border:1px solid #2d3545;border-radius:11px;background:#171c26}.round-heading{display:flex;align-items:center;justify-content:space-between;width:100%;padding:1px 1px 10px;border:0;background:transparent;color:var(--agent-text);cursor:pointer}.round-heading span{font-size:13px;font-weight:650}.round-heading time{font:12px var(--mono);color:var(--agent-muted)}.summary-list{display:grid;gap:7px}.summary-item{display:flex;align-items:flex-start;gap:9px;padding:8px;border:1px solid #30394a;border-radius:8px;background:#1d2330}.summary-item>span{display:grid;place-items:center;width:23px;height:23px;flex:0 0 auto;border-radius:6px;background:#272f3d;color:#98a4b6}.summary-item>div{min-width:0}.summary-item strong{display:block;color:#d4dae4;font-size:13px;line-height:1.4}.summary-item p{display:-webkit-box;margin:2px 0 0;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:3;color:#8e9aad;font-size:12px;line-height:1.55}.summary-item.progress>span{color:#8ecbff}.summary-item.status.progress svg{animation:summary-spin 1.4s linear infinite}.summary-item.success>span{color:#69ddb2}.summary-item.warning>span{color:#f1c36f}.summary-item.danger{border-color:#5f3745}.summary-item.danger>span{color:#ff91a5}.execution-footer{display:flex;align-items:center;gap:7px;min-height:56px;padding:0 16px;border-top:1px solid var(--agent-border);background:#171c26;font-size:13px;color:var(--agent-muted)}.execution-footer strong{font:14px var(--mono);color:var(--agent-text)}.execution-footer button{margin-left:auto;padding:5px 8px;border:1px solid #423d65;border-radius:6px;background:#24213a;color:#b4adff;font-size:13px;cursor:pointer}.execution-footer button:hover{border-color:#665e9e;color:#fff}.execution-panel:deep(.status-pill){padding:2px 7px;background:#1d342d;color:#69ddb2;font-size:12px}.execution-panel:deep(.el-empty){margin:auto;padding:20px 10px}.execution-panel:deep(.el-empty__description p){color:var(--agent-muted);font-size:13px}@keyframes summary-spin{to{transform:rotate(360deg)}}
.history-round{display:-webkit-box;margin:0;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:3;color:#aeb8c7;font-size:13px;line-height:1.6}
.round-events{width:100%;margin-top:7px;padding:8px;border:1px solid var(--agent-border);border-radius:8px;background:var(--agent-panel-strong);color:var(--agent-secondary);font-size:12px;text-align:left}.round-events>summary{cursor:pointer;line-height:24px}.round-event-detail{float:right;padding:0 5px;border:0;border-radius:4px;background:transparent;color:var(--agent-accent);font:inherit;line-height:24px;cursor:pointer}.round-event-detail:hover{background:var(--agent-raised)}.round-events>ol{margin:8px 0 0;padding:0 0 0 12px;list-style:none;border-left:1px solid var(--agent-border)}.round-events li{position:relative;display:grid;gap:4px;padding:8px 0;overflow-wrap:anywhere;white-space:pre-wrap;line-height:1.65}.round-events li::before{position:absolute;left:-15px;top:15px;width:5px;height:5px;border-radius:50%;background:var(--agent-muted);content:''}.round-events time{color:var(--agent-muted);font:10px var(--mono)}.round-command-summary{margin:8px 0 0;color:var(--agent-muted);line-height:1.6}
.execution-round{padding:14px;margin-bottom:12px}.summary-item{padding:10px;gap:10px}.summary-item p{line-height:1.65}.round-heading{gap:8px}.round-heading time{flex-shrink:0}.summary-item{width:100%;font:inherit;text-align:left;cursor:pointer}.summary-item:hover{border-color:var(--agent-accent)}
</style>
