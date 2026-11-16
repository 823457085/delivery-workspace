<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue';
import type { AgentRun } from '../../../shared/agent-runtime';
import { agentRunActivity, groupRunExecutionEvents, previewRunExecution } from './execution-summary';
import { readableToolEvents } from './tool-activity';

const props = defineProps<{
  run: AgentRun;
  state?: string;
  fallbackProgress?: string;
}>();
const emit = defineEmits<{ inspect: [run: AgentRun] }>();

const stepStatusLabels = { running: '进行中', finished: '已完成', failed: '未通过', recorded: '已记录' } as const;
const footprintOpen = shallowRef(false);
watch(() => props.run.id, () => { footprintOpen.value = false; });

const effectiveState = computed(() => props.state || (props.run.status === 'completed' && props.run.resultReady === false ? 'saving' : props.run.status));
const isActive = computed(() => ['queued', 'running', 'saving'].includes(effectiveState.value));

const info = computed(() => {
  const grouped = groupRunExecutionEvents(props.run.events);
  const allSteps = readableToolEvents(grouped.routine);
  const preview = previewRunExecution(props.run);
  const activity = agentRunActivity(props.run);
  const latest = [...props.run.events].reverse().find(event => event.type !== 'session');
  const lastStep = allSteps.at(-1);
  const activityStep = activity && latest && lastStep?.events.some(event => event.id === latest.id) ? lastStep : undefined;
  return {
    allSteps,
    recentSteps: allSteps.slice(-4),
    toolCount: grouped.routine.length,
    activity,
    activityStep,
    activityAt: latest?.createdAt || props.run.updatedAt,
    progressText: preview.progress,
  };
});

function formatClock(value?: string) {
  if (!value) return '';
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleTimeString('zh-CN', { hour12: false }) : '';
}
</script>

<template>
  <div v-if="isActive || info.allSteps.length" class="live-run-activity" :class="{ 'is-active': isActive }" aria-label="实时执行动态">
    <template v-if="isActive">
      <div class="live-pulse-banner">
        <span class="live-pulse-dot" aria-hidden="true"></span>
        <div class="live-pulse-main">
          <template v-if="info.activityStep">
            <span class="live-pulse-prefix">{{ info.activityStep.status === 'running' ? '正在执行' : '最近动作' }}</span>
            <strong class="live-pulse-title">{{ info.activityStep.title }}</strong>
            <code v-if="info.activityStep.target" class="live-pulse-target" :title="info.activityStep.target">{{ info.activityStep.target }}</code>
          </template>
          <template v-else>
            <strong class="live-pulse-title">{{ info.activity || fallbackProgress || (effectiveState === 'saving' ? '正在保存本轮结果…' : effectiveState === 'queued' ? '已进入队列，正在启动执行器…' : '正在分析与执行本轮任务…') }}</strong>
          </template>
        </div>
        <time v-if="info.activityAt" class="live-pulse-time" :datetime="info.activityAt">{{ formatClock(info.activityAt) }}</time>
        <button type="button" class="live-inspect-btn" @click="emit('inspect', run)">实时日志</button>
      </div>

      <ol v-if="info.recentSteps.length > 1 || (info.recentSteps.length === 1 && !info.activityStep)" class="live-step-stream">
        <li v-for="step in info.recentSteps" :key="step.id" class="live-step-pill" :data-step-status="step.status">
          <i class="live-step-indicator" aria-hidden="true"></i>
          <span class="live-step-name">{{ step.title }}</span>
          <code v-if="step.target" class="live-step-target" :title="step.target">{{ step.target }}</code>
          <small class="live-step-badge">{{ stepStatusLabels[step.status] }}</small>
        </li>
      </ol>
    </template>

    <details v-else-if="info.allSteps.length" class="live-footprint" @toggle="footprintOpen = ($event.target as HTMLDetailsElement).open">
      <summary class="live-footprint-summary">
        <i class="live-footprint-dot" :class="{ 'is-failed': info.allSteps.some(step => step.status === 'failed') }" aria-hidden="true"></i>
        <span class="live-footprint-badge">{{ info.allSteps.length }} 步动作</span>
        <span class="live-footprint-last">
          {{ info.allSteps.at(-1)!.title }}
          <code v-if="info.allSteps.at(-1)!.target" class="live-footprint-cmd">{{ info.allSteps.at(-1)!.target }}</code>
        </span>
        <time class="live-footprint-time">{{ formatClock(info.allSteps.at(-1)!.createdAt) }}</time>
        <span class="live-footprint-chevron" aria-hidden="true">›</span>
      </summary>
      <div v-if="footprintOpen" class="live-footprint-panel">
        <div class="live-footprint-scroll">
          <ol class="live-footprint-list">
            <li v-for="step in info.allSteps" :key="step.id" :data-step-status="step.status">
              <time :datetime="step.createdAt">{{ formatClock(step.createdAt) }}</time>
              <div class="live-footprint-body">
                <div>
                  <strong>{{ step.title }}</strong>
                  <span class="live-footprint-state" :data-step-status="step.status">{{ stepStatusLabels[step.status] }}</span>
                </div>
                <code v-if="step.target">{{ step.target }}</code>
              </div>
            </li>
          </ol>
        </div>
        <div class="live-footprint-foot">
          <button type="button" class="live-footprint-log-btn" @click="emit('inspect', run)">查看完整执行日志 ↗</button>
        </div>
      </div>
    </details>
  </div>
</template>

<style scoped>
.live-run-activity {
  margin: 4px 0 6px;
  min-width: 0;
}

.live-pulse-banner {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 8px;
  padding: 5px 10px;
  border: 1px solid color-mix(in srgb, var(--ui-accent, var(--agent-accent)) 26%, var(--ui-border, var(--agent-border)));
  border-radius: 8px;
  background: color-mix(in srgb, var(--ui-accent-soft, color-mix(in srgb, var(--agent-accent) 10%, transparent)) 55%, var(--ui-surface, var(--agent-panel-strong)));
  font-size: 12px;
  line-height: 17px;
}

.live-pulse-dot {
  position: relative;
  width: 8px;
  height: 8px;
  flex-shrink: 0;
  border-radius: 999px;
  background: var(--ui-accent, var(--agent-accent));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ui-accent, var(--agent-accent)) 22%, transparent);
  animation: livePulse 1.6s ease-in-out infinite;
}

@keyframes livePulse {
  0%, 100% { transform: scale(0.95); opacity: 0.85; }
  50% { transform: scale(1.15); opacity: 1; }
}

.live-pulse-main {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 8px;
  flex: 1 1 200px;
  min-width: 0;
}

.live-pulse-prefix {
  color: var(--ui-accent, var(--agent-accent));
  font-weight: 600;
  white-space: nowrap;
}

.live-pulse-title {
  color: var(--ui-text, var(--agent-text));
  font-weight: 500;
  overflow-wrap: anywhere;
}

.live-pulse-target {
  max-width: min(100%, 340px);
  padding: 1px 6px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--ui-text, var(--agent-text)) 7%, transparent);
  color: var(--ui-secondary, var(--agent-secondary));
  font: 11px/16px var(--mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.live-pulse-time {
  margin-left: auto;
  color: var(--ui-muted, var(--agent-muted));
  font: 11px/16px var(--mono);
  font-variant-numeric: tabular-nums;
}

.live-inspect-btn {
  padding: 2px 8px;
  border: 1px solid color-mix(in srgb, var(--ui-accent, var(--agent-accent)) 28%, var(--ui-border, var(--agent-border)));
  border-radius: 6px;
  background: var(--ui-surface, var(--agent-panel));
  color: var(--ui-accent, var(--agent-accent));
  font: 500 11px/16px var(--sans);
  cursor: pointer;
  white-space: nowrap;
}

.live-inspect-btn:hover {
  border-color: var(--ui-accent, var(--agent-accent));
}

.live-step-stream {
  display: grid;
  gap: 4px;
  margin: 6px 0 0;
  padding: 6px 10px;
  border: 1px solid var(--ui-border, var(--agent-border));
  border-radius: 8px;
  background: color-mix(in srgb, var(--ui-raised, var(--agent-panel-strong)) 65%, transparent);
  list-style: none;
}

.live-step-pill {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 12px;
  line-height: 18px;
}

.live-step-indicator {
  width: 6px;
  height: 6px;
  flex-shrink: 0;
  border-radius: 999px;
  background: var(--ui-success, #16a34a);
}

.live-step-pill[data-step-status='running'] .live-step-indicator {
  background: var(--ui-accent, var(--agent-accent));
}

.live-step-pill[data-step-status='failed'] .live-step-indicator {
  background: var(--ui-danger, #dc2626);
}

.live-step-name {
  color: var(--ui-text, var(--agent-text));
  white-space: nowrap;
}

.live-step-target {
  min-width: 0;
  flex: 1;
  color: var(--ui-muted, var(--agent-muted));
  font: 11px/16px var(--mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.live-step-badge {
  flex-shrink: 0;
  color: var(--ui-muted, var(--agent-muted));
  font-size: 11px;
}

.live-step-pill[data-step-status='running'] .live-step-badge {
  color: var(--ui-accent, var(--agent-accent));
  font-weight: 500;
}

.live-step-pill[data-step-status='failed'] .live-step-badge {
  color: var(--ui-danger, #dc2626);
}

.live-footprint {
  margin-top: 2px;
  font-size: 12px;
  line-height: 18px;
}

.live-footprint-summary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  min-height: 25px;
  padding: 2px 9px;
  border: 1px solid color-mix(in srgb, var(--ui-border, var(--agent-border)) 82%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--ui-raised, var(--agent-panel-strong)) 64%, transparent);
  color: var(--ui-secondary, var(--agent-secondary));
  cursor: pointer;
  list-style: none;
  user-select: none;
  transition: border-color 140ms ease, background-color 140ms ease, color 140ms ease;
}

.live-footprint-summary:hover {
  border-color: color-mix(in srgb, var(--ui-text, var(--agent-text)) 22%, var(--ui-border, var(--agent-border)));
  background: var(--ui-raised, var(--agent-panel-strong));
  color: var(--ui-text, var(--agent-text));
}

.live-footprint-summary::-webkit-details-marker { display: none; }

.live-footprint-dot {
  width: 6px;
  height: 6px;
  flex-shrink: 0;
  border-radius: 999px;
  background: var(--ui-success, #16a34a);
}

.live-footprint-dot.is-failed {
  background: var(--ui-danger, #dc2626);
}

.live-footprint-badge {
  flex-shrink: 0;
  color: var(--ui-text, var(--agent-text));
  font: 600 11px/16px var(--mono);
  font-variant-numeric: tabular-nums;
}

.live-footprint-last {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  flex: 0 1 auto;
  max-width: min(54ch, 58vw);
  color: var(--ui-muted, var(--agent-muted));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.live-footprint-cmd {
  max-width: 24ch;
  padding: 0 5px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--ui-text, var(--agent-text)) 6%, transparent);
  color: var(--ui-secondary, var(--agent-secondary));
  font: 10.5px/15px var(--mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.live-footprint-summary:hover .live-footprint-last {
  color: var(--ui-secondary, var(--agent-secondary));
}

.live-footprint-time {
  flex-shrink: 0;
  color: var(--ui-muted, var(--agent-muted));
  font: 10.5px/16px var(--mono);
  font-variant-numeric: tabular-nums;
  opacity: 0.85;
}

.live-footprint-chevron {
  flex-shrink: 0;
  font-size: 13px;
  line-height: 1;
  color: var(--ui-muted, var(--agent-muted));
  transition: transform 160ms ease;
}

.live-footprint[open] .live-footprint-chevron {
  transform: rotate(90deg);
}

.live-footprint-panel {
  margin-top: 6px;
  padding: 8px 10px 7px;
  border: 1px solid color-mix(in srgb, var(--ui-border, var(--agent-border)) 82%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--ui-raised, var(--agent-panel-strong)) 52%, transparent);
}

.live-footprint-scroll {
  max-height: 210px;
  overflow-y: auto;
  padding-left: 6px;
}

.live-footprint-list {
  display: grid;
  gap: 5px;
  margin: 0;
  padding: 2px 0 2px 12px;
  border-left: 1px solid var(--ui-border, var(--agent-border));
  list-style: none;
}

.live-footprint-list li {
  position: relative;
  display: grid;
  grid-template-columns: 58px minmax(0, 1fr);
  gap: 8px;
  align-items: baseline;
}

.live-footprint-list li::before {
  content: '';
  position: absolute;
  left: -15.5px;
  top: 6px;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--ui-success, #16a34a);
  box-shadow: 0 0 0 2px var(--ui-surface, #fff);
}

.live-footprint-list li[data-step-status='failed']::before {
  background: var(--ui-danger, #dc2626);
}

.live-footprint-foot {
  display: flex;
  justify-content: flex-end;
  margin-top: 6px;
  padding-top: 5px;
  border-top: 1px solid color-mix(in srgb, var(--ui-border, var(--agent-border)) 65%, transparent);
}

.live-footprint-log-btn {
  padding: 1px 6px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--ui-secondary, var(--agent-secondary));
  font: 500 11px/16px var(--sans);
  cursor: pointer;
  transition: color 140ms ease, background-color 140ms ease;
}

.live-footprint-log-btn:hover {
  background: var(--ui-surface, transparent);
  color: var(--ui-text, var(--agent-text));
}

.live-footprint-list time {
  color: var(--ui-muted, var(--agent-muted));
  font: 11px/16px var(--mono);
  font-variant-numeric: tabular-nums;
}

.live-footprint-body {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.live-footprint-body > div {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}

.live-footprint-body strong {
  color: var(--ui-text, var(--agent-text));
  font-size: 12px;
  font-weight: 500;
}

.live-footprint-body code {
  color: var(--ui-muted, var(--agent-muted));
  font: 11px/16px var(--mono);
  overflow-wrap: anywhere;
}

.live-footprint-state {
  color: var(--ui-muted, var(--agent-muted));
  font-size: 11px;
}

.live-footprint-state[data-step-status='failed'] {
  color: var(--ui-danger, #dc2626);
}
</style>
