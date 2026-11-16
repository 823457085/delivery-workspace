<script setup lang="ts">
/**
 * 交互式计划执行清单卡片（借鉴 OpenCode Plan→Build、Claude Code TodoWrite 与 taskmd）。
 * 自动识别已完成运行中的多步计划或任务清单，支持勾选完成进度、单步/分批受控推进实施与导出 TODO.md。
 */
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Check, ChevronRight, Copy, Layers, Play, Sparkles } from '@lucide/vue';
import type { AgentRun } from '../../../shared/agent-runtime';
import {
  buildPlanStepExecutionPrompt,
  extractMarkdownPlanChecklist,
  formatPlanChecklistTaskMarkdown,
} from '../../../shared/agent-plan-checklist';

const props = withDefaults(
  defineProps<{
    run: AgentRun;
    replyText: string;
    canApplyPrompt?: boolean;
  }>(),
  {
    canApplyPrompt: false,
  },
);

const emit = defineEmits<{
  applyPrompt: [prompt: string];
}>();

const extracted = computed(() =>
  extractMarkdownPlanChecklist(props.replyText, { mode: props.run.mode }),
);

const expanded = ref(true);
const completedIds = ref<string[]>([]);
const targetIds = ref<string[]>([]);
const copiedTodo = ref(false);

function storageKey(runId: string): string {
  return `agent-plan-checklist:v1:${runId}`;
}

function loadCompletedState() {
  const defaultChecked = extracted.value.items
    .filter(item => item.checkedByModel)
    .map(item => item.id);
  try {
    const raw = window.localStorage.getItem(storageKey(props.run.id));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const validIds = new Set(extracted.value.items.map(i => i.id));
        completedIds.value = parsed.map(String).filter(id => validIds.has(id));
        return;
      }
    }
  } catch {
    /* localStorage 不可用时退回内存状态 */
  }
  completedIds.value = defaultChecked;
}

function persistCompletedState() {
  try {
    window.localStorage.setItem(storageKey(props.run.id), JSON.stringify(completedIds.value));
  } catch {
    /* 忽略配额异常 */
  }
}

watch(
  () => [props.run.id, extracted.value.items.length] as const,
  () => {
    loadCompletedState();
    targetIds.value = [];
    expanded.value = props.run.mode === 'plan' || completedIds.value.length < extracted.value.items.length;
  },
  { immediate: true },
);

const completedSet = computed(() => new Set(completedIds.value));
const targetSet = computed(() => new Set(targetIds.value));
const completedCount = computed(() =>
  extracted.value.items.filter(item => completedSet.value.has(item.id)).length,
);
const progressPercent = computed(() =>
  extracted.value.items.length
    ? Math.round((completedCount.value / extracted.value.items.length) * 100)
    : 0,
);
const nextPendingItem = computed(() =>
  extracted.value.items.find(item => !completedSet.value.has(item.id)),
);
const activeTargetItems = computed(() =>
  extracted.value.items.filter(item => targetSet.value.has(item.id) && !completedSet.value.has(item.id)),
);

function toggleCompleted(stepId: string) {
  const next = new Set(completedIds.value);
  if (next.has(stepId)) {
    next.delete(stepId);
  } else {
    next.add(stepId);
    targetIds.value = targetIds.value.filter(id => id !== stepId);
  }
  completedIds.value = Array.from(next);
  persistCompletedState();
}

function toggleTarget(stepId: string) {
  if (completedSet.value.has(stepId)) return;
  const next = new Set(targetIds.value);
  if (next.has(stepId)) next.delete(stepId);
  else next.add(stepId);
  targetIds.value = Array.from(next);
}

function applyNextSingleStep() {
  if (!nextPendingItem.value) return;
  const prompt = buildPlanStepExecutionPrompt({
    items: extracted.value.items,
    targetIds: [nextPendingItem.value.id],
    completedIds: completedIds.value,
    originalObjective: props.run.objective,
  });
  emit('applyPrompt', prompt);
}

function applySelectedSteps() {
  if (!activeTargetItems.value.length) return;
  const prompt = buildPlanStepExecutionPrompt({
    items: extracted.value.items,
    targetIds: activeTargetItems.value.map(i => i.id),
    completedIds: completedIds.value,
    originalObjective: props.run.objective,
  });
  emit('applyPrompt', prompt);
}

async function copyTaskMarkdown() {
  const md = formatPlanChecklistTaskMarkdown({
    title: props.run.objective || '执行计划清单',
    runId: props.run.id,
    items: extracted.value.items,
    completedIds: completedIds.value,
  });
  try {
    await navigator.clipboard.writeText(md);
    copiedTodo.value = true;
    setTimeout(() => { copiedTodo.value = false; }, 1600);
    ElMessage.success('已复制 TODO.md 执行清单（含 YAML Frontmatter）');
  } catch {
    ElMessage.error('浏览器未允许复制');
  }
}
</script>

<template>
  <section v-if="extracted.actionable" class="plan-checklist-card" aria-label="交互式执行计划清单">
    <header class="plan-checklist-head" @click="expanded = !expanded">
      <div class="plan-checklist-title">
        <ChevronRight :size="13" class="plan-chevron" :class="{ 'is-open': expanded }" />
        <Layers :size="13" class="plan-icon" />
        <strong>执行计划追踪</strong>
        <span class="plan-progress-pill" :class="{ 'is-done': completedCount === extracted.items.length }">
          {{ completedCount }}/{{ extracted.items.length }} 已完成 ({{ progressPercent }}%)
        </span>
        <span class="plan-progress-track" aria-hidden="true">
          <span class="plan-progress-fill" :style="{ width: `${progressPercent}%` }" />
        </span>
      </div>
      <div class="plan-checklist-actions" @click.stop>
        <button
          v-if="canApplyPrompt && activeTargetItems.length > 0"
          type="button"
          class="plan-action-btn is-primary"
          @click="applySelectedSteps"
        >
          <Sparkles :size="12" />
          <span>推进所选 ({{ activeTargetItems.length }} 步)</span>
        </button>
        <button
          v-else-if="canApplyPrompt && nextPendingItem"
          type="button"
          class="plan-action-btn is-primary"
          :title="`填入步骤 ${nextPendingItem.index} 的聚焦执行指令`"
          @click="applyNextSingleStep"
        >
          <Play :size="11" />
          <span>推进步骤 {{ nextPendingItem.index }}</span>
        </button>
        <button type="button" class="plan-action-btn" title="复制标准 taskmd / TODO.md 格式清单" @click="copyTaskMarkdown">
          <Check v-if="copiedTodo" :size="12" />
          <Copy v-else :size="12" />
          <span>{{ copiedTodo ? '已复制' : '导出 TODO.md' }}</span>
        </button>
      </div>
    </header>

    <ul v-if="expanded" class="plan-step-list">
      <li
        v-for="item in extracted.items"
        :key="item.id"
        class="plan-step-row"
        :class="{
          'is-completed': completedSet.has(item.id),
          'is-targeted': targetSet.has(item.id) && !completedSet.has(item.id),
        }"
      >
        <input
          type="checkbox"
          class="plan-step-check"
          :checked="completedSet.has(item.id)"
          :aria-label="`标记步骤 ${item.index} 已完成`"
          @change="toggleCompleted(item.id)"
        />
        <div class="plan-step-body" @click="toggleCompleted(item.id)">
          <span class="plan-step-num">#{{ item.index }}</span>
          <span v-if="item.phase" class="plan-step-phase">{{ item.phase }}</span>
          <span class="plan-step-text">{{ item.cleanTitle }}</span>
          <code v-for="refPath in item.fileRefs" :key="refPath" class="plan-step-file">{{ refPath }}</code>
        </div>
        <button
          v-if="canApplyPrompt && !completedSet.has(item.id)"
          type="button"
          class="plan-target-chip"
          :class="{ 'is-selected': targetSet.has(item.id) }"
          @click="toggleTarget(item.id)"
        >
          {{ targetSet.has(item.id) ? '已选本轮' : '+ 选入本轮' }}
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.plan-checklist-card {
  margin-top: 10px;
  border: 1px solid color-mix(in srgb, var(--ui-accent) 26%, var(--ui-border));
  border-radius: var(--ds-radius-sm, 9px);
  background: color-mix(in srgb, var(--ui-raised) 68%, var(--ui-surface));
  overflow: hidden;
}

.plan-checklist-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  flex-wrap: wrap;
  padding: 8px 11px;
  cursor: pointer;
  user-select: none;
}

.plan-checklist-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--ui-text);
}

.plan-chevron {
  color: var(--ui-muted);
  transition: transform 150ms ease;
}

.plan-chevron.is-open {
  transform: rotate(90deg);
}

.plan-icon {
  color: var(--ui-accent);
}

.plan-progress-pill {
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--ui-border);
  background: var(--ui-surface);
  color: var(--ui-secondary);
  font: 600 10.5px/1.4 var(--mono);
  font-variant-numeric: tabular-nums;
}

.plan-progress-pill.is-done {
  border-color: color-mix(in srgb, var(--ui-success) 38%, var(--ui-border));
  background: var(--ui-success-bg);
  color: var(--ui-success);
}

.plan-progress-track {
  display: inline-block;
  width: 56px;
  height: 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ui-border) 88%, var(--ui-text) 8%);
  overflow: hidden;
}

.plan-progress-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--ui-accent);
  transition: width 180ms ease;
}

.plan-checklist-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.plan-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 9px;
  border-radius: 6px;
  border: 1px solid var(--ui-border);
  background: var(--ui-surface);
  color: var(--ui-secondary);
  font: 500 11px/1 var(--sans);
  cursor: pointer;
  white-space: nowrap;
}

.plan-action-btn:hover {
  color: var(--ui-text);
  border-color: color-mix(in srgb, var(--ui-text) 24%, var(--ui-border));
}

.plan-action-btn.is-primary {
  border-color: color-mix(in srgb, var(--ui-accent) 42%, var(--ui-border));
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
  font-weight: 600;
}

.plan-step-list {
  list-style: none;
  margin: 0;
  padding: 6px 10px 10px;
  border-top: 1px solid color-mix(in srgb, var(--ui-border) 75%, transparent);
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.plan-step-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: var(--ui-surface);
  font-size: 12px;
  line-height: 1.5;
}

.plan-step-row.is-targeted {
  border-color: color-mix(in srgb, var(--ui-accent) 42%, var(--ui-border));
  background: color-mix(in srgb, var(--ui-accent-soft) 55%, var(--ui-surface));
}

.plan-step-row.is-completed {
  opacity: 0.68;
}

.plan-step-row.is-completed .plan-step-text {
  text-decoration: line-through;
  color: var(--ui-muted);
}

.plan-step-check {
  margin-top: 3px;
  cursor: pointer;
  accent-color: var(--ui-accent);
  flex-shrink: 0;
}

.plan-step-body {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
  cursor: pointer;
}

.plan-step-num {
  font: 600 10.5px/1.4 var(--mono);
  color: var(--ui-muted);
}

.plan-step-phase {
  padding: 0 5px;
  border-radius: 4px;
  background: var(--ui-raised);
  color: var(--ui-secondary);
  font-size: 10.5px;
  font-weight: 600;
}

.plan-step-text {
  color: var(--ui-text);
  overflow-wrap: anywhere;
}

.plan-step-file {
  padding: 0 5px;
  border-radius: 4px;
  border: 1px solid var(--ui-border);
  background: var(--ui-raised);
  font: 500 10.5px/1.4 var(--mono);
  color: var(--ui-accent);
}

.plan-target-chip {
  flex-shrink: 0;
  height: 21px;
  padding: 0 7px;
  border-radius: 5px;
  border: 1px solid var(--ui-border);
  background: var(--ui-raised);
  color: var(--ui-muted);
  font: 500 10.5px/1 var(--sans);
  cursor: pointer;
  white-space: nowrap;
}

.plan-target-chip:hover {
  color: var(--ui-text);
}

.plan-target-chip.is-selected {
  border-color: var(--ui-accent);
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
  font-weight: 600;
}
</style>
