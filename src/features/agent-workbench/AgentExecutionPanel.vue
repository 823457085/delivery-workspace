<script setup lang="ts">
import AgentAvatar from './AgentAvatar.vue';
/**
 * 执行记录集中展示协作进展；团队任务的逐条运行动态按需展开，避免重复铺开岗位摘要。
 * 详情入口传递对应运行记录，在统一抽屉中查看完整诊断信息。
 */
import { CheckCircle2, ChevronRight, CircleAlert, Clock3, LoaderCircle, Wrench, XCircle } from '@lucide/vue';
import { computed, shallowRef, useTemplateRef, watch } from 'vue';
import type { Component } from 'vue';
import { agentProviderLabels, type AgentRun } from '../../../shared/agent-runtime';
import { dateTime } from '../../shared/format';
import type { AgentConversation } from './conversation';
import AgentTranslatedText from './AgentTranslatedText.vue';
import AgentMarkdown from './AgentMarkdown.vue';
import AgentTeamProgress from './AgentTeamProgress.vue';
import { conversationExecutionRuns, executionEventText, previewRunExecution, summarizeRunExecution, type AgentExecutionSummary } from './execution-summary';
import type { AdvancedTeamTask, TeamRoom } from './team-api';
import type { TeamProfileId } from '../../../shared/agent-team';
import { teamRoleLabels } from './team-chat';
import { useExecutionRunDisclosure } from './execution-run-disclosure';
import { teamRoundFeedback } from './team-result-status';

const props = defineProps<{ conversation?: AgentConversation; visible?: boolean; teamRoom?: TeamRoom; teamTask?: AdvancedTeamTask; teamTasks?: AdvancedTeamTask[]; runLabel?: (run: AgentRun) => string; compact?: boolean; collapsibleRuns?: boolean }>();
const emit = defineEmits<{ inspect: [run: AgentRun] }>();
const executionScroll = useTemplateRef<HTMLElement>('executionScroll');
const scrollPositions = new Map<string, number>();
const executionRuns = computed(() => conversationExecutionRuns(props.conversation, props.teamRoom));
const disclosure = useExecutionRunDisclosure(() => props.conversation?.id, () => executionRuns.value);
const progressTask = computed(() => props.teamTask?.parentConversationId === props.conversation?.id && props.teamTask?.nodes.length ? props.teamTask : undefined);
const roundFeedback = computed(() => props.teamTask && teamRoundFeedback(props.teamTask, props.teamTask.round, executionRuns.value));
const now = shallowRef(Date.now());
watch(() => props.visible !== false && executionRuns.value.some(run => run.status === 'running'), (active, _, onCleanup) => {
  if (!active) return;
  now.value = Date.now();
  const timer = setInterval(() => { now.value = Date.now(); }, 15_000);
  onCleanup(() => clearInterval(timer));
}, { immediate: true });
const executionRounds = computed(() => [...executionRuns.value]
  .sort((left, right) => Number(['running', 'queued'].includes(right.status)) - Number(['running', 'queued'].includes(left.status))
    || Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
  .map(run => ({ run, preview: previewRunExecution(run) })));
const executionLatest = computed(() => executionRounds.value[0]?.run || props.conversation?.latest);
const executionState = computed(() => executionRuns.value.some(run => run.status === 'running') ? '正在运行'
  : executionRuns.value.some(run => run.status === 'queued') ? '排队中' : '最近记录');

function runSummaries(round: typeof executionRounds.value[number]) {
  const task = props.teamTasks?.find(task => task.id === round.run.team?.taskId)
    || (props.teamTask?.id === round.run.team?.taskId ? props.teamTask : undefined);
  return summarizeRunExecution(round.run, now.value, task).filter(item => item.key !== 'commands').map(item => ({
    ...item, detail: item.key === 'status' && !['verifier', 'reviewer'].includes(round.run.team?.profileId || '')
      && round.run.status === 'completed' && round.run.resultReady !== false ? round.preview.summary || round.preview.progress || item.detail : item.detail,
  }));
}

watch([() => props.conversation?.id, () => props.visible], (_value, [previousId, previousVisible]) => {
  if (previousId && previousVisible !== false && executionScroll.value?.clientHeight) scrollPositions.set(previousId, executionScroll.value.scrollTop);
});
// 实时更新不移动阅读位置；只在切换会话、重新显示或挂载滚动容器后恢复。
watch([() => props.conversation?.id, () => props.visible, executionScroll], ([id, visible, viewport]) => {
  if (id && visible !== false && viewport?.clientHeight) viewport.scrollTop = scrollPositions.get(id) ?? 0;
}, { immediate: true, flush: 'post' });

function rememberScroll() {
  if (props.conversation?.id && executionScroll.value?.clientHeight) scrollPositions.set(props.conversation.id, executionScroll.value.scrollTop);
}

function roundNumber(run: AgentRun) {
  return executionRuns.value.findIndex(item => item.id === run.id) + 1;
}

function toggleRun(event: Event, run: AgentRun) {
  if (!props.collapsibleRuns || event.target !== event.currentTarget) return;
  disclosure.setExpanded(run.id, (event.currentTarget as HTMLDetailsElement).open);
}

function memberLabel(run: AgentRun) {
  return props.runLabel?.(run) || (run.team ? teamRoleLabels[run.team.profileId as TeamProfileId] || run.team.profileId : agentProviderLabels[run.provider]);
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
  <section class="execution-panel" :class="{ 'execution-panel-compact': compact, 'execution-panel-collapsible': collapsibleRuns }" aria-label="Agent 执行过程">
    <template v-if="conversation">
      <div class="execution-summary"><strong>{{ progressTask ? '执行记录' : '运行动态' }}</strong><span>{{ executionState }}</span></div>
      <div :key="conversation.id" ref="executionScroll" class="execution-scroll" @scroll.passive="rememberScroll">
        <div v-if="teamTask && roundFeedback && !progressTask" class="execution-round-feedback"><strong>第 {{ teamTask.round + 1 }} 轮 · {{ roundFeedback.label }}</strong><p>{{ roundFeedback.text }}</p></div>
        <AgentTeamProgress v-if="progressTask" class="execution-team-progress" :task="progressTask" :runs="executionRuns" @inspect="emit('inspect', $event)" />
        <component :is="progressTask ? 'details' : 'div'" :key="progressTask?.id || conversation.id" class="execution-run-history">
          <summary v-if="progressTask">运行动态 · {{ executionRounds.length }} 条记录</summary>
        <component :is="collapsibleRuns ? 'details' : 'section'" v-for="round in executionRounds" :key="round.run.id" class="execution-round"
          :open="collapsibleRuns && disclosure.isExpanded(round.run.id)" :data-run-id="round.run.id" @toggle="toggleRun($event, round.run)">
          <summary v-if="collapsibleRuns" class="run-disclosure-heading">
            <ChevronRight class="run-disclosure-chevron" :size="14" /><AgentAvatar :provider="round.run.provider" :model="round.run.model" :size="26" />
            <span class="run-disclosure-copy"><strong>{{ memberLabel(round.run) }}</strong><small>运行 #{{ roundNumber(round.run) }} · <time :datetime="round.run.updatedAt">更新 {{ dateTime(round.run.updatedAt) }}</time></small></span>
            <span class="run-disclosure-status" :class="runSummaries(round)[0]?.tone">{{ runSummaries(round)[0]?.title }}</span>
            <button type="button" :aria-label="`查看运行 ${roundNumber(round.run)} 的日志`" @click.stop.prevent="emit('inspect', round.run)">日志</button>
          </summary>
          <template v-if="!collapsibleRuns || disclosure.isExpanded(round.run.id)">
          <header class="run-heading"><AgentAvatar v-if="!collapsibleRuns" :provider="round.run.provider" :model="round.run.model" :size="26" /><div><strong v-if="!collapsibleRuns">{{ memberLabel(round.run) }}</strong><small>{{ round.run.model || 'CLI 默认' }}</small></div><button v-if="!collapsibleRuns" type="button" :aria-label="`查看运行 ${roundNumber(round.run)} 的日志`" @click="emit('inspect', round.run)">日志</button></header>
          <div v-if="!collapsibleRuns" class="run-time"><span>运行 #{{ roundNumber(round.run) }}</span><time>{{ dateTime(round.run.updatedAt) }}</time></div>
          <p v-if="conversation.source === 'codex'" class="history-round">{{ round.run.objective }}</p><AgentTranslatedText v-if="conversation.source === 'codex'" :source="round.run.objective" compact />
          <div v-else class="summary-list">
            <div v-for="item in runSummaries(round)" :key="item.key" class="summary-item" :class="[item.tone, item.key]">
              <span><component :is="summaryIcon(item)" :size="13" /></span>
              <div>
                <strong>{{ item.title }}</strong>
                <template v-if="item.detail"><AgentMarkdown v-if="collapsibleRuns" :source="item.detail" /><p v-else>{{ item.detail }}</p><AgentTranslatedText v-if="!collapsibleRuns" :source="item.detail" compact /></template>
                <div v-if="item.activity" class="run-activity">
                  <time :datetime="item.activity.at">最近活动 {{ dateTime(item.activity.at) }}</time>
                  <p v-if="item.activity.text" :title="item.activity.text">{{ item.activity.text }}</p>
                </div>
              </div>
            </div>
          </div>
          <ol v-if="round.preview.updates.length && (!compact || ['running', 'queued'].includes(round.run.status))" class="run-updates" aria-label="最近进展">
              <li v-for="event in compact ? round.preview.updates.slice(-1) : round.preview.updates" :key="event.id">
                <AgentMarkdown v-if="collapsibleRuns" :source="event.message" /><template v-else><span>{{ event.message }}</span><AgentTranslatedText :source="event.message" compact /></template><time>{{ dateTime(event.createdAt) }}</time>
              </li>
          </ol>
          <div v-if="!compact && round.preview.tools.length" class="round-tools"><strong>最近动作</strong><details><summary>{{ executionEventText(round.preview.tools.at(-1)!).preview }}</summary><pre>{{ round.preview.tools.at(-1)?.message }}</pre></details></div>
          </template>
        </component>
        </component>
      </div>
      <footer class="execution-footer"><span>运行记录</span><strong>{{ executionRuns.length }}</strong><button type="button" @click="executionLatest && emit('inspect', executionLatest)">完整日志</button></footer>
    </template>
    <el-empty v-else description="选择会话查看执行过程" :image-size="45" />
  </section>
</template>

<style scoped>
.execution-panel{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0;overflow:hidden;background:var(--agent-panel);color:var(--agent-text)}
.execution-panel-compact .summary-item:not(.danger) p,.execution-panel-compact .run-updates li>span{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:4;overflow:hidden}
.execution-team-progress{margin-top:8px}.execution-run-history>summary{padding:16px 0;color:var(--agent-muted);font-size:12px;cursor:pointer}.execution-run-history>summary:hover{color:var(--agent-text)}.execution-run-history>summary:focus-visible{outline:2px solid var(--agent-accent);outline-offset:2px}.execution-run-history[open]>summary{margin-bottom:8px}
.execution-round-feedback{margin-bottom:18px;font-size:12px;line-height:1.8}.execution-round-feedback strong{font-weight:500}.execution-round-feedback p{margin:6px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--agent-secondary)}
.execution-summary{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:15px 16px;border-bottom:1px solid var(--agent-border)}.execution-summary strong{font-size:13px;font-weight:600}.execution-summary>span{font-size:11px;color:var(--agent-muted)}
.execution-scroll{flex:1;min-height:0;overflow-y:auto;padding:16px}.execution-round{margin:0;padding:0 0 24px 14px;border-left:1px solid var(--agent-border)}
.execution-panel-collapsible .execution-round{padding:0 0 12px;border-left:0;border-bottom:1px solid var(--agent-border)}.execution-panel-collapsible .execution-round+.execution-round{padding-top:12px}.run-disclosure-heading{display:flex;align-items:center;flex-wrap:wrap;gap:7px;cursor:pointer;list-style:none}.run-disclosure-heading::-webkit-details-marker{display:none}.run-disclosure-heading::marker{content:''}.run-disclosure-heading:focus-visible{outline:2px solid var(--agent-accent);outline-offset:4px}.run-disclosure-chevron{flex-shrink:0;transition:transform .15s}.execution-round[open]>.run-disclosure-heading>.run-disclosure-chevron{transform:rotate(90deg)}.run-disclosure-copy{flex:1;min-width:110px}.run-disclosure-copy strong{display:block;font-size:12px;font-weight:600;overflow-wrap:anywhere}.run-disclosure-copy small{display:block;margin-top:4px;color:var(--agent-muted);font-size:10px}.run-disclosure-status{font-size:11px;color:var(--agent-muted)}.run-disclosure-status.progress{color:var(--agent-accent)}.run-disclosure-status.success{color:var(--ui-success)}.run-disclosure-status.warning{color:var(--ui-warning)}.run-disclosure-status.danger{color:var(--ui-danger)}.run-disclosure-heading button{padding:0;border:0;background:none;color:var(--agent-accent);font:inherit;font-size:11px;cursor:pointer}.execution-panel-collapsible .run-heading{margin-top:8px}.execution-panel-collapsible .summary-item :deep(.agent-markdown){margin-top:4px;font-size:12px}
.run-heading{display:flex;align-items:center;gap:8px}.run-heading>div{flex:1;min-width:0}.run-heading strong{display:block;font-size:13px;font-weight:600}.run-heading small{display:block;margin-top:3px;font-size:11px;color:var(--agent-muted);overflow-wrap:anywhere}.run-heading button{border:0;background:none;color:var(--agent-muted);font:inherit;font-size:11px;cursor:pointer}.run-heading button:hover{color:var(--agent-accent)}.run-time{display:flex;justify-content:space-between;gap:8px;margin:12px 0 6px;color:var(--agent-muted);font-size:10px}
.summary-list{display:grid;gap:7px}.summary-item{display:flex;align-items:flex-start;gap:7px;text-align:left}.summary-item>span{display:grid;place-items:center;width:19px;height:19px;flex:0 0 auto;color:var(--agent-muted)}.summary-item>div{min-width:0}.summary-item strong{display:block;font-size:12px;line-height:1.6;font-weight:500}.summary-item p{display:block;margin:4px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--agent-secondary);font-size:12px;line-height:1.8}.summary-item.progress>span{color:var(--agent-accent)}.summary-item.success>span{color:var(--ui-success)}.summary-item.warning>span{color:var(--ui-warning)}.summary-item.danger>span{color:var(--ui-danger)}.summary-item.status.progress svg{animation:summary-spin 1.4s linear infinite}@keyframes summary-spin{to{transform:rotate(360deg)}}
.run-updates{margin:8px 0;padding:0;list-style:none}.run-updates li{display:grid;gap:4px;margin-top:10px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--agent-secondary);font-size:12px;line-height:1.75}.run-updates time{color:var(--agent-muted);font-size:10px}.round-tools{margin:12px 0 0;color:var(--agent-muted);font-size:11px}.round-tools strong{font-weight:500}.round-tools pre{max-height:70px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0;font:11px/1.6 var(--mono)}
.run-activity{margin-top:4px}.run-activity time{color:var(--agent-muted);font-size:11px}.run-activity p{margin-top:2px}
.history-round{margin:6px 0;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--agent-secondary);font-size:12px;line-height:1.8}.execution-footer{display:flex;align-items:center;gap:7px;min-height:47px;padding:0 16px;border-top:1px solid var(--agent-border);font-size:11px;color:var(--agent-muted)}.execution-footer strong{font-weight:500;color:var(--agent-text)}.execution-footer button{margin-left:auto;padding:5px 8px;border:0;background:none;color:var(--agent-accent);font:inherit;cursor:pointer}.execution-panel:deep(.el-empty){margin:auto;padding:20px 10px}
</style>

<style scoped>
.round-tools summary{margin-top:6px;color:var(--agent-muted);font:11px/1.7 var(--mono);cursor:pointer;overflow-wrap:anywhere}
</style>
