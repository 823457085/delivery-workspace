<script setup lang="ts">
/** 执行记录正文供抽屉和会话侧栏共用，只读取传入的真实运行快照。 */
import { computed } from 'vue';
import type { AgentRun, AgentRunMode, AgentRuntimeHealth } from '../../../shared/agent-runtime';
import { dateTime } from '../../shared/format';
import StatusPill from '../../shared/ui/StatusPill.vue';
import AgentMarkdown from './AgentMarkdown.vue';
import { agentReplyText, executionEventText, groupRunExecutionEvents, readableRunTask, summarizeRunExecution } from './execution-summary';
import { agentRunStatus } from './conversation';
import type { TeamResultContext } from './team-result-status';

const props = defineProps<{ run: AgentRun; runtimes?: AgentRuntimeHealth[]; compact?: boolean; teamTask?: TeamResultContext }>();
const task = computed(() => readableRunTask(props.run.objective));
const summary = computed(() => summarizeRunExecution(props.run, Date.now(), props.teamTask));
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
    <component :is="compact ? 'details' : 'section'" v-if="run.result" class="detail-section"><summary v-if="compact">本轮完整回复</summary><h3 v-else>本轮结果</h3><AgentMarkdown :source="agentReplyText(run.result)" /></component>
    <section v-if="keyEvents.length" class="detail-section" aria-label="最近执行记录">
      <h3>最近执行记录</h3><ol class="readable-events"><li v-for="event in keyEvents" :key="event.id"><time>{{ dateTime(event.createdAt) }}</time><details><summary><small>{{ executionEventText(event).label }}</small><span>{{ executionEventText(event).preview }}</span></summary><pre>{{ event.message }}</pre></details></li></ol>
    </section>
    <details class="execution-original"><summary>完整提示词（{{ task.length.toLocaleString() }} 字）</summary><pre>{{ run.objective }}</pre></details>
    <details v-if="run.events.length" :key="run.id" class="execution-original"><summary>原始运行记录（已保存 {{ run.events.length }} 条）</summary><el-timeline><el-timeline-item v-for="event in [...run.events].reverse()" :key="event.id" :timestamp="dateTime(event.createdAt)"><pre>{{ event.message }}</pre></el-timeline-item></el-timeline></details>
    <details class="execution-original"><summary>运行信息</summary><dl class="detail-facts"><div v-if="run.isolatedWorkspace"><dt>源项目 / 基线</dt><dd>{{ run.sourceWorkspacePath }}<br />{{ run.baseBranch }}</dd></div><div><dt>HEAD</dt><dd>{{ run.headSha || '未记录' }}</dd></div><div><dt>CLI Session ID</dt><dd>{{ run.sessionId || '尚未取得' }}</dd></div><div><dt>本机 PID</dt><dd>{{ run.pid || '已结束' }}</dd></div></dl></details>
  </div>
</template>

<style scoped>
.run-details{container-type:inline-size;min-width:0;max-width:100%;color:var(--agent-text,var(--ui-text));overflow-wrap:anywhere}
.execution-overview{display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:var(--agent-secondary,var(--ui-secondary));font-size:12px}
.detail-section{min-width:0;margin:16px 0 24px}.detail-section h3{margin:0 0 13px;color:var(--agent-text,var(--ui-text));font-size:14px;font-weight:550}.detail-section p{font-size:13px;line-height:1.9;white-space:pre-line;color:var(--agent-secondary,var(--ui-secondary));overflow-wrap:anywhere}
.execution-task-title{font-weight:600;font-size:14px}.execution-task p{margin:8px 0;line-height:1.75;overflow-wrap:anywhere}.execution-task .execution-task-text{white-space:pre-wrap}
.detail-section>summary{color:var(--agent-secondary,var(--ui-secondary));font-size:12px;cursor:pointer}.detail-section[open]>summary{margin-bottom:12px}
.detail-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;min-width:0;margin:15px 0;padding:16px;border:1px solid var(--agent-border,var(--ui-border));border-radius:7px;background:var(--agent-raised,var(--ui-accent-soft))}.detail-facts>div{min-width:0}.detail-facts dt{margin-bottom:6px;color:var(--agent-muted,var(--ui-muted));font-size:11px}.detail-facts dd{margin:0;color:var(--agent-secondary,var(--ui-secondary));font-size:12px;line-height:1.8;overflow-wrap:anywhere;word-break:break-all}
.drawer-summary{display:grid;gap:8px;min-width:0}.drawer-summary article{min-width:0;padding:11px 13px;border:1px solid var(--agent-border,var(--el-border-color-lighter));border-radius:8px;background:var(--agent-raised,var(--el-fill-color-light))}.drawer-summary strong{font-size:13px;color:var(--agent-text,var(--el-text-color-primary))}.drawer-summary p{margin:4px 0 0;color:var(--agent-secondary,var(--el-text-color-secondary));font-size:12px;line-height:1.6}.drawer-summary article.warning{border-color:var(--el-color-warning-light-7)}.drawer-summary article.danger{border-color:var(--el-color-danger-light-7)}
.execution-original{min-width:0;margin-top:16px;padding-top:10px;border-top:1px solid var(--agent-border,var(--ui-divider,var(--ui-border)))}.execution-original>summary{cursor:pointer;color:var(--agent-secondary,var(--ui-secondary));font-size:12px;overflow-wrap:anywhere}.execution-original>pre,.execution-original :deep(.el-timeline),.readable-events pre{max-height:420px;overflow:auto}.execution-original pre,.readable-events pre{max-width:100%;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.7 var(--mono);color:var(--agent-secondary,var(--ui-secondary))}.execution-original :deep(.el-timeline){margin:14px 0 0;padding-left:16px}
.drawer-summary time{display:block;margin-top:4px;color:var(--agent-muted,var(--ui-muted));font-size:11px}
.readable-events{list-style:none;margin:0;padding:0}.readable-events>li{min-width:0;padding:10px 0;border-top:1px solid var(--agent-border,var(--ui-divider,var(--ui-border)))}.readable-events time{color:var(--agent-muted,var(--ui-muted));font-size:11px}.readable-events summary{cursor:pointer;line-height:1.75;overflow-wrap:anywhere}.readable-events summary small{margin-right:8px;color:var(--agent-muted,var(--ui-muted));font-size:11px}.readable-events summary span{font-size:12px}
.run-details :deep(.agent-markdown){max-width:100%;font-size:13px}.run-details :deep(.markdown-code),.run-details :deep(.markdown-table-wrap){max-width:100%;overflow:auto}
@container(max-width:420px){.detail-facts{grid-template-columns:1fr;padding:12px}}
</style>
