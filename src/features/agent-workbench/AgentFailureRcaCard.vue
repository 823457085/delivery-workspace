<script setup lang="ts">
/**
 * 失败根因分析（RCA）与智能纠偏卡片。
 * 供会话流失败气泡（紧凑模式）与运行详情抽屉共用，只消费当前运行的确定性快照。
 */
import { computed, shallowRef } from 'vue';
import { Check, Copy, ShieldAlert, Sparkles, TriangleAlert } from '@lucide/vue';
import { ElMessage } from 'element-plus';
import type { AgentRun } from '../../../shared/agent-runtime';
import { analyzeAgentRunFailure } from '../../../shared/agent-failure-rca';

const props = withDefaults(defineProps<{
  run: AgentRun;
  compact?: boolean;
  canApplyPrompt?: boolean;
}>(), {
  compact: false,
  canApplyPrompt: false,
});

const emit = defineEmits<{
  applyPrompt: [prompt: string];
}>();

const rca = computed(() => analyzeAgentRunFailure(props.run));
const copied = shallowRef(false);
let copyTimer: ReturnType<typeof setTimeout> | undefined;

async function copySmartPrompt(prompt: string) {
  try {
    await navigator.clipboard.writeText(prompt);
    copied.value = true;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copied.value = false; }, 1600);
  } catch {
    ElMessage.error('复制修复提示词失败');
  }
}
</script>

<template>
  <section v-if="rca" class="failure-rca-card" :class="[`is-${rca.severity}`, { 'is-compact': compact }]" aria-label="失败根因诊断与恢复建议">
    <header class="rca-header">
      <span class="rca-badge">
        <ShieldAlert v-if="rca.severity === 'danger'" :size="13" />
        <TriangleAlert v-else :size="13" />
        <strong>{{ rca.categoryLabel }}</strong>
      </span>
      <span class="rca-retry-tag" :class="rca.blindRetryAdvisable ? 'is-ok' : 'is-caution'" :title="rca.blindRetryHint">
        {{ rca.blindRetryAdvisable ? '瞬态异常 · 可直接重试' : '建议先纠偏 · 勿原样盲跑' }}
      </span>
    </header>

    <p class="rca-summary">{{ rca.summary }}</p>

    <p v-if="rca.causalTrigger" class="rca-trigger">
      <span>中断前动作：</span><code>{{ rca.causalTrigger }}</code>
    </p>

    <ul v-if="rca.diagnostics.length" class="rca-diagnostics" aria-label="提炼的关键编译或验证报错">
      <li v-for="(diag, index) in rca.diagnostics.slice(0, compact ? 3 : 5)" :key="`${diag.fingerprint}:${index}`">
        <code>{{ diag.line ? `${diag.file}:${diag.line}` : diag.file }}</code>
        <span>{{ diag.code ? `[${diag.code}] ` : '' }}{{ diag.message }}</span>
      </li>
    </ul>

    <ol class="rca-steps">
      <li v-for="(step, idx) in (compact ? rca.recoverySteps.slice(0, 2) : rca.recoverySteps)" :key="idx">{{ step }}</li>
    </ol>

    <footer v-if="rca.smartRetryPrompt" class="rca-actions">
      <button
        v-if="canApplyPrompt"
        type="button"
        class="rca-btn is-primary"
        title="将脱敏后的精确报错定位与纠偏要求填入下方输入框"
        @click="emit('applyPrompt', rca.smartRetryPrompt)"
      >
        <Sparkles :size="12" /> 填入带诊断修复指令
      </button>
      <button
        type="button"
        class="rca-btn"
        title="复制针对本次失败提炼的修复提示词"
        @click="copySmartPrompt(rca.smartRetryPrompt)"
      >
        <Check v-if="copied" :size="12" />
        <Copy v-else :size="12" />
        {{ copied ? '已复制提示词' : '复制修复提示词' }}
      </button>
    </footer>
  </section>
</template>

<style scoped>
.failure-rca-card {
  display: grid;
  gap: 8px;
  margin: 10px 0;
  padding: 11px 13px;
  border: 1px solid color-mix(in srgb, var(--ui-warning, #d97706) 38%, var(--ui-border));
  border-radius: var(--ds-radius-sm, 10px);
  background: color-mix(in srgb, var(--ui-warning-bg, rgb(245 158 11 / 0.08)) 65%, var(--ui-surface));
  color: var(--ui-text);
  font-size: 12.5px;
  line-height: 1.6;
}
.failure-rca-card.is-danger {
  border-color: color-mix(in srgb, var(--ui-danger, #dc2626) 38%, var(--ui-border));
  background: color-mix(in srgb, var(--ui-danger-bg, rgb(220 38 38 / 0.07)) 65%, var(--ui-surface));
}
.failure-rca-card.is-compact {
  padding: 9px 11px;
  gap: 6px;
  font-size: 12px;
}
.rca-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px 10px;
}
.rca-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--ui-warning, #d97706);
  font-weight: 600;
}
.failure-rca-card.is-danger .rca-badge {
  color: var(--ui-danger, #dc2626);
}
.rca-retry-tag {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  border-radius: 999px;
  font: 500 11px/16px var(--sans);
  border: 1px solid var(--ui-border);
  background: var(--ui-surface);
  color: var(--ui-secondary);
}
.rca-retry-tag.is-ok {
  border-color: color-mix(in srgb, var(--ui-success, #16a34a) 35%, var(--ui-border));
  color: var(--ui-success, #16a34a);
}
.rca-retry-tag.is-caution {
  border-color: color-mix(in srgb, var(--ui-warning, #d97706) 38%, var(--ui-border));
  color: var(--ui-warning, #d97706);
}
.rca-summary {
  margin: 0;
  color: var(--ui-text);
  overflow-wrap: anywhere;
}
.rca-trigger {
  margin: 0;
  color: var(--ui-secondary);
  font-size: 11.5px;
  overflow-wrap: anywhere;
}
.rca-trigger code,
.rca-diagnostics code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--ui-raised);
  border: 1px solid var(--ui-border);
  font: 500 11px/1.45 var(--mono);
  color: var(--ui-accent);
}
.rca-diagnostics {
  list-style: none;
  margin: 2px 0;
  padding: 7px 9px;
  border-radius: 7px;
  border: 1px solid var(--ui-border);
  background: var(--ui-surface);
  display: grid;
  gap: 5px;
}
.rca-diagnostics li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  font-size: 11.5px;
  color: var(--ui-secondary);
  overflow-wrap: anywhere;
}
.rca-steps {
  margin: 0;
  padding-left: 18px;
  color: var(--ui-secondary);
  display: grid;
  gap: 3px;
}
.rca-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 2px;
}
.rca-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  background: var(--ui-surface);
  color: var(--ui-secondary);
  font: 500 11.5px/16px var(--sans);
  cursor: pointer;
  transition: border-color 140ms ease, color 140ms ease, background 140ms ease;
}
.rca-btn:hover {
  border-color: var(--ui-accent);
  color: var(--ui-accent);
  background: var(--ui-accent-soft);
}
.rca-btn.is-primary {
  border-color: color-mix(in srgb, var(--ui-accent) 42%, var(--ui-border));
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
  font-weight: 600;
}
.rca-btn.is-primary:hover {
  background: color-mix(in srgb, var(--ui-accent) 20%, var(--ui-surface));
}
</style>
