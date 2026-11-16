<script setup lang="ts">
/** 执行记录正文供抽屉和会话侧栏共用，只读取传入的真实运行快照。 */
import { computed, shallowRef, watch } from 'vue';
import type { AgentRun, AgentRunMode, AgentRuntimeHealth } from '../../../shared/agent-runtime';
import { dateTime } from '../../shared/format';
import StatusPill from '../../shared/ui/StatusPill.vue';
import AgentMarkdown from './AgentMarkdown.vue';
import AgentFailureRcaCard from './AgentFailureRcaCard.vue';
import { formatCompactTokens, formatUsdCost, summarizeRunTelemetry } from '../../../shared/agent-session-telemetry';
import { agentReplyText, executionEventText, groupRunExecutionEvents, readableRunTask, summarizeRunExecution } from './execution-summary';
import { agentRunStatus } from './conversation';
import type { TeamResultContext } from './team-result-status';

const props = defineProps<{ run: AgentRun; runtimes?: AgentRuntimeHealth[]; compact?: boolean; teamTask?: TeamResultContext }>();
const resultOpen = shallowRef(false);
const promptOpen = shallowRef(false);
const timelineOpen = shallowRef(false);
const factsOpen = shallowRef(false);
watch(() => props.run.id, () => {
  resultOpen.value = false;
  promptOpen.value = false;
  timelineOpen.value = false;
  factsOpen.value = false;
});
const task = computed(() => readableRunTask(props.run.objective));
const summary = computed(() => summarizeRunExecution(props.run, Date.now(), props.teamTask));
const telemetry = computed(() => summarizeRunTelemetry(props.run));
const costText = computed(() => formatUsdCost(telemetry.value.costUsd));
const events = computed(() => groupRunExecutionEvents(props.run.events));
const keyEvents = computed(() => events.value.visible.filter(event => event.type !== 'session').slice(-8).reverse());
const model = computed(() => props.runtimes?.find(runtime => runtime.provider === props.run.provider)?.models
  .find(item => item.id === props.run.model)?.label || props.run.model || 'CLI 默认');
function modeLabel(mode: AgentRunMode) { return mode === 'agent' ? 'Agent 执行' : mode === 'plan' ? '方案分析' : '只读问答'; }
</script>

<template>
  <div class="run-details">
    <div class="execution-overview"><StatusPill v-bind="agentRunStatus(run, teamTask)" /><span>{{ modeLabel(run.mode) }} · {{ model }}</span><span>{{ run.mode !== 'agent' ? '只读访问' : run.accessMode === 'full' ? '完全访问' : '工作区访问' }}</span></div>
    <component :is="compact ? 'details' : 'section'" class="detail-section execution-task" aria-label="本轮任务概览">
      <summary v-if="compact">任务与工作区</summary><h3 v-else>本轮任务</h3><p class="execution-task-title">{{ task.title }}</p>
      <p v-if="task.responsibility"><strong>当前职责：</strong>{{ task.responsibility }}</p>
      <p v-if="task.text" class="execution-task-text">{{ task.text }}</p>
      <dl class="detail-facts"><div><dt>工作区</dt><dd>{{ run.workspacePath }}</dd></div><div v-if="run.branch"><dt>工作分支</dt><dd>{{ run.branch }}</dd></div></dl>
    </component>
    <section class="detail-section">
      <h3>当前进展</h3>
      <div class="drawer-summary">
        <article v-for="item in summary" :key="item.key" :class="item.tone">
          <strong>{{ item.title }}</strong>
          <p v-if="item.detail">{{ item.detail }}</p>
          <template v-if="item.activity">
            <time :datetime="item.activity.at">最近活动 {{ dateTime(item.activity.at) }}</time>
            <p v-if="item.activity.text">{{ item.activity.text }}</p>
          </template>
        </article>
      </div>
    </section>
    <el-alert v-if="run.error" :title="run.error" type="error" :closable="false" />
    <AgentFailureRcaCard v-if="run.status === 'failed' || run.status === 'interrupted' || run.error" :run="run" />
    <section v-if="telemetry.usageKnown || telemetry.tools.totalActions > 0 || telemetry.durationMs > 0" class="detail-section telemetry-section" aria-label="本轮遥测与缓存效率">
      <h3>遥测与缓存效率</h3>
      <div class="telemetry-grid">
        <div class="telemetry-kpi">
          <small>活跃耗时</small>
          <strong>{{ telemetry.durationLabel }}</strong>
          <span>改动 {{ telemetry.changedFileCount }} 个文件</span>
        </div>
        <div class="telemetry-kpi">
          <small>Token 用量</small>
          <strong>{{ telemetry.usageKnown ? formatCompactTokens(telemetry.totalTokens) : '未上报' }}</strong>
          <span v-if="telemetry.usageKnown">输入 {{ formatCompactTokens(telemetry.inputTokens) }} · 输出 {{ formatCompactTokens(telemetry.outputTokens) }}<template v-if="telemetry.reasoningTokens"> · 思考 {{ formatCompactTokens(telemetry.reasoningTokens) }}</template></span>
          <span v-else>当前 CLI 未回传本轮 Token 明细</span>
        </div>
        <div class="telemetry-kpi">
          <small>Prompt 缓存命中</small>
          <strong :class="`grade-${telemetry.cacheGrade}`">{{ telemetry.cacheHitPercent !== null ? `${telemetry.cacheHitPercent}%` : '—' }}</strong>
          <div v-if="telemetry.cacheHitPercent !== null" class="cache-bar" role="progressbar" :aria-valuenow="telemetry.cacheHitPercent" aria-valuemin="0" aria-valuemax="100">
            <span :style="{ width: `${telemetry.cacheHitPercent}%` }" :class="`grade-${telemetry.cacheGrade}`"></span>
          </div>
          <span v-if="telemetry.cachedInputTokens !== null">复用 {{ formatCompactTokens(telemetry.cachedInputTokens) }}{{ costText ? ` · ${costText}` : '' }}</span>
          <span v-else>{{ costText || '无缓存分段数据' }}</span>
        </div>
        <div class="telemetry-kpi">
          <small>工具调用画像</small>
          <strong>{{ telemetry.tools.totalActions }} 次动作</strong>
          <span>读 {{ telemetry.tools.fileReads }} · 改 {{ telemetry.tools.fileEdits }} · 命令 {{ telemetry.tools.shellCommands }} · 搜索 {{ telemetry.tools.searches }}<template v-if="telemetry.tools.failedActions"> · 失败 {{ telemetry.tools.failedActions }}</template></span>
        </div>
      </div>
    </section>
    <component :is="compact ? 'details' : 'section'" v-if="run.result" :key="`result:${run.id}`" class="detail-section" @toggle="compact && (resultOpen = ($event.target as HTMLDetailsElement).open)"><summary v-if="compact">本轮完整回复</summary><h3 v-else>本轮结果</h3><AgentMarkdown v-if="!compact || resultOpen" :source="agentReplyText(run.result)" /></component>
    <section v-if="keyEvents.length" class="detail-section" aria-label="最近执行记录">
      <h3>最近执行记录</h3><ol class="readable-events"><li v-for="event in keyEvents" :key="event.id"><time>{{ dateTime(event.createdAt) }}</time><details><summary><small>{{ executionEventText(event).label }}</small><span>{{ executionEventText(event).preview }}</span></summary><pre>{{ event.message }}</pre></details></li></ol>
    </section>
    <details :key="`prompt:${run.id}`" class="execution-original" @toggle="promptOpen = ($event.target as HTMLDetailsElement).open"><summary>完整提示词（{{ task.length.toLocaleString() }} 字）</summary><pre v-if="promptOpen">{{ run.objective }}</pre></details>
    <details v-if="run.events.length" :key="run.id" class="execution-original" @toggle="timelineOpen = ($event.target as HTMLDetailsElement).open"><summary>原始运行记录（已保存 {{ run.events.length }} 条）</summary><el-timeline v-if="timelineOpen"><el-timeline-item v-for="event in [...run.events].reverse()" :key="event.id" :timestamp="dateTime(event.createdAt)"><pre>{{ event.message }}</pre></el-timeline-item></el-timeline></details>
    <details :key="`facts:${run.id}`" class="execution-original" @toggle="factsOpen = ($event.target as HTMLDetailsElement).open"><summary>运行信息</summary><dl v-if="factsOpen" class="detail-facts"><div v-if="run.isolatedWorkspace"><dt>源项目 / 基线</dt><dd>{{ run.sourceWorkspacePath }}<br />{{ run.baseBranch }}</dd></div><div><dt>代码提交</dt><dd>{{ run.headSha || '未记录' }}</dd></div><div><dt>会话编号</dt><dd>{{ run.sessionId || '尚未取得' }}</dd></div><div><dt>本机进程号</dt><dd>{{ run.pid || '已结束' }}</dd></div></dl></details>
  </div>
</template>

<style scoped>
.run-details{container-type:inline-size;min-width:0;max-width:100%;color:var(--agent-text,var(--ui-text));overflow-wrap:anywhere}
.execution-overview{display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:var(--agent-secondary,var(--ui-secondary));font-size:12.5px}
.detail-section{min-width:0;margin:18px 0 24px}.detail-section h3{margin:0 0 12px;color:var(--agent-text,var(--ui-text));font-size:14px;font-weight:600}.detail-section p{font-size:13.5px;line-height:1.85;white-space:pre-line;color:var(--agent-secondary,var(--ui-secondary));overflow-wrap:anywhere}
.execution-task-title{font-weight:600;font-size:14.5px;color:var(--agent-text,var(--ui-text))}.execution-task p{margin:8px 0;line-height:1.75;overflow-wrap:anywhere}.execution-task .execution-task-text{white-space:pre-wrap}
.detail-section>summary{color:var(--agent-secondary,var(--ui-secondary));font-size:12.5px;font-weight:500;cursor:pointer}.detail-section[open]>summary{margin-bottom:12px}
.detail-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;min-width:0;margin:16px 0;padding:16px;border:1px solid var(--agent-border,var(--ui-border));border-radius:var(--ds-radius-sm,10px);background:var(--agent-raised,var(--ui-raised))}.detail-facts>div{min-width:0}.detail-facts dt{margin-bottom:5px;color:var(--agent-muted,var(--ui-muted));font-size:11px}.detail-facts dd{margin:0;color:var(--agent-text,var(--ui-text));font-size:12.5px;line-height:1.75;overflow-wrap:anywhere;word-break:break-all}
.drawer-summary{display:grid;gap:10px;min-width:0}.drawer-summary article{min-width:0;padding:12px 14px;border:1px solid var(--agent-border,var(--ui-border));border-radius:var(--ds-radius-sm,10px);background:var(--agent-raised,var(--ui-raised))}.drawer-summary strong{font-size:13px;font-weight:600;color:var(--agent-text,var(--ui-text))}.drawer-summary p{margin:4px 0 0;color:var(--agent-secondary,var(--ui-secondary));font-size:12.5px;line-height:1.65}.drawer-summary article.warning{border-color:color-mix(in srgb,var(--ui-warning) 42%,var(--ui-border));background:var(--ui-warning-bg)}.drawer-summary article.danger{border-color:color-mix(in srgb,var(--ui-danger) 42%,var(--ui-border));background:var(--ui-danger-bg)}
.execution-original{min-width:0;margin-top:16px;padding-top:12px;border-top:1px solid var(--agent-border,var(--ui-divider,var(--ui-border)))}.execution-original>summary{cursor:pointer;color:var(--agent-secondary,var(--ui-secondary));font-size:12.5px;font-weight:500;overflow-wrap:anywhere;transition:color 160ms ease}.execution-original>summary:hover{color:var(--ui-accent)}.execution-original>pre,.execution-original :deep(.el-timeline),.readable-events pre{max-height:420px;overflow:auto}.execution-original pre,.readable-events pre{max-width:100%;margin-top:10px;padding:12px;border:1px solid var(--ui-border);border-radius:var(--ds-radius-xs,8px);background:var(--ui-raised);white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.75 var(--mono);color:var(--agent-secondary,var(--ui-secondary))}.execution-original :deep(.el-timeline){margin:14px 0 0;padding-left:16px}
.drawer-summary time{display:block;margin-top:5px;color:var(--agent-muted,var(--ui-muted));font:11px/16px var(--mono)}
.readable-events{list-style:none;margin:0;padding:0}.readable-events>li{min-width:0;padding:10px 0;border-top:1px solid var(--agent-border,var(--ui-divider,var(--ui-border)))}.readable-events time{color:var(--agent-muted,var(--ui-muted));font:11px/16px var(--mono)}.readable-events summary{cursor:pointer;line-height:1.75;overflow-wrap:anywhere}.readable-events summary small{margin-right:8px;color:var(--agent-muted,var(--ui-muted));font-size:11px}.readable-events summary span{font-size:12.5px;color:var(--agent-text,var(--ui-text))}
.run-details :deep(.agent-markdown){max-width:100%;font-size:13.5px;line-height:22px}.run-details :deep(.markdown-code),.run-details :deep(.markdown-table-wrap){max-width:100%;overflow:auto}
.telemetry-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.telemetry-kpi{display:grid;gap:4px;padding:10px 12px;border:1px solid var(--agent-border,var(--ui-border));border-radius:var(--ds-radius-sm,9px);background:var(--agent-raised,var(--ui-raised))}.telemetry-kpi small{color:var(--agent-muted,var(--ui-muted));font-size:11px}.telemetry-kpi strong{font:600 14px/1.3 var(--mono);color:var(--agent-text,var(--ui-text))}.telemetry-kpi strong.grade-high{color:var(--ui-success,#16a34a)}.telemetry-kpi strong.grade-moderate{color:var(--ui-accent)}.telemetry-kpi strong.grade-low{color:var(--ui-warning,#d97706)}.telemetry-kpi>span{color:var(--agent-secondary,var(--ui-secondary));font-size:11.5px;line-height:1.45}.cache-bar{height:5px;border-radius:999px;background:color-mix(in srgb,var(--ui-border) 75%,transparent);overflow:hidden}.cache-bar>span{display:block;height:100%;border-radius:999px;background:var(--ui-accent)}.cache-bar>span.grade-high{background:var(--ui-success,#16a34a)}.cache-bar>span.grade-low{background:var(--ui-warning,#d97706)}
@container(max-width:420px){.detail-facts,.telemetry-grid{grid-template-columns:1fr;padding:12px}}
</style>
