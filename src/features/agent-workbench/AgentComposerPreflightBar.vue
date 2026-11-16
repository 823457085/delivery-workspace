<script setup lang="ts">
/**
 * 发送前安全护栏与上下文预算水位条（借鉴 Zed Agent Panel + Cursor Composer + Gitleaks）。
 * 独立子组件：保持父组件 AgentComposer.vue 的脚本依赖契约纯净，仅在检测到风险或达到多轮水位时挂载渲染。
 */
import { computed } from 'vue';
import { ElMessage } from 'element-plus';
import { ShieldAlert, Sparkles, TriangleAlert } from '@lucide/vue';
import type { AgentAccessMode, AgentRunMode } from '../../../shared/agent-runtime';
import {
  estimateConversationContextMeter,
  redactPromptSecrets,
  scanPromptPreflight,
} from '../../../shared/agent-composer-preflight';
import { formatCompactTokens } from '../../../shared/agent-session-telemetry';
import type { AgentConversation } from './conversation';

const props = defineProps<{
  conversation: AgentConversation;
  mode: AgentRunMode;
  accessMode: AgentAccessMode;
}>();

const draft = defineModel<string>('draft', { default: '' });

const preflight = computed(() =>
  scanPromptPreflight(draft.value, {
    mode: props.mode,
    accessMode: props.accessMode,
  }),
);

const contextMeter = computed(() =>
  estimateConversationContextMeter(props.conversation.runs, draft.value),
);

const showContextMeter = computed(() =>
  contextMeter.value.turnCount >= 2 || contextMeter.value.estimatedTokens >= 2400,
);

const visible = computed(() =>
  preflight.value.issues.length > 0 || showContextMeter.value,
);

const meterBarWidth = computed(() => `${Math.max(4, Math.min(100, contextMeter.value.usagePercent))}%`);

function applySecretRedaction() {
  if (!preflight.value.hasSecrets) return;
  draft.value = redactPromptSecrets(draft.value);
  ElMessage.success('已将草稿中的明文密钥原地替换为安全占位符');
}
</script>

<template>
  <div v-if="visible" class="composer-preflight" aria-live="polite">
    <div
      v-if="preflight.issues.length"
      class="preflight-alert-strip"
      :data-tone="preflight.hasSecrets ? 'danger' : 'warning'"
    >
      <div class="preflight-alert-main">
        <ShieldAlert v-if="preflight.hasSecrets" :size="14" class="preflight-icon" />
        <TriangleAlert v-else :size="14" class="preflight-icon" />
        <span class="preflight-title">
          {{ preflight.hasSecrets ? '检测到敏感凭据' : '高爆炸半径指令提醒' }}：
        </span>
        <span
          v-for="issue in preflight.issues"
          :key="issue.code"
          class="preflight-issue-pill"
          :title="issue.advice"
        >
          {{ issue.label }}<template v-if="issue.matchCount > 1"> ×{{ issue.matchCount }}</template>
        </span>
        <span class="preflight-advice">{{ preflight.issues[0]?.advice }}</span>
      </div>
      <button
        v-if="preflight.hasSecrets"
        type="button"
        class="preflight-redact-btn"
        @click="applySecretRedaction"
      >
        <Sparkles :size="12" />
        <span>一键脱敏草稿</span>
      </button>
    </div>

    <div
      v-if="showContextMeter"
      class="context-meter-strip"
      :data-level="contextMeter.level"
      :title="contextMeter.advice"
    >
      <div class="context-meter-left">
        <span class="context-meter-label">上下文水位</span>
        <span class="context-meter-track" aria-hidden="true">
          <span class="context-meter-fill" :style="{ width: meterBarWidth }" />
        </span>
        <span class="context-meter-stat">
          ~{{ formatCompactTokens(contextMeter.estimatedTokens) }} / {{ formatCompactTokens(contextMeter.budgetTokens) }} tok
          ({{ contextMeter.usagePercent }}%) · {{ contextMeter.turnCount }} 轮
        </span>
      </div>
      <span v-if="contextMeter.level === 'compaction_needed'" class="context-meter-badge is-danger">
        超出专注窗口 · 建议导出交接简报或分叉新会话
      </span>
      <span v-else-if="contextMeter.level === 'heavy'" class="context-meter-badge is-warning">
        高负载 (&gt;=80%) · 复杂改动建议分叉新会话
      </span>
    </div>
  </div>
</template>

<style scoped>
.composer-preflight {
  grid-column: 1 / -1;
  grid-area: preflight;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.preflight-alert-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  flex-wrap: wrap;
  padding: 6px 10px;
  border-radius: var(--ds-radius-xs, 8px);
  border: 1px solid color-mix(in srgb, var(--ui-warning) 36%, var(--ui-border));
  background: color-mix(in srgb, var(--ui-warning) 10%, var(--ui-surface));
  color: var(--ui-text);
  font-size: 11.5px;
  line-height: 1.45;
}

.preflight-alert-strip[data-tone='danger'] {
  border-color: color-mix(in srgb, var(--ui-danger) 40%, var(--ui-border));
  background: var(--ui-danger-bg);
}

.preflight-alert-main {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
  flex: 1;
}

.preflight-icon {
  flex-shrink: 0;
  color: var(--ui-warning);
}

.preflight-alert-strip[data-tone='danger'] .preflight-icon {
  color: var(--ui-danger);
}

.preflight-title {
  font-weight: 600;
  white-space: nowrap;
}

.preflight-issue-pill {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 5px;
  border: 1px solid color-mix(in srgb, var(--ui-text) 16%, var(--ui-border));
  background: var(--ui-surface);
  font: 600 11px/1.4 var(--mono);
  white-space: nowrap;
}

.preflight-advice {
  color: var(--ui-secondary);
  min-width: 0;
}

.preflight-redact-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 9px;
  border-radius: 6px;
  border: 1px solid color-mix(in srgb, var(--ui-danger) 42%, var(--ui-border));
  background: var(--ui-surface);
  color: var(--ui-danger);
  font: 600 11.5px/1 var(--sans);
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 140ms ease, border-color 140ms ease;
}

.preflight-redact-btn:hover {
  border-color: var(--ui-danger);
  background: color-mix(in srgb, var(--ui-danger) 12%, var(--ui-surface));
}

.context-meter-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px 12px;
  flex-wrap: wrap;
  padding: 3px 8px;
  border-radius: 6px;
  border: 1px solid color-mix(in srgb, var(--ui-border) 72%, transparent);
  background: color-mix(in srgb, var(--ui-raised) 62%, var(--ui-surface));
  font-size: 11px;
  line-height: 1.4;
  color: var(--ui-secondary);
}

.context-meter-strip[data-level='heavy'] {
  border-color: color-mix(in srgb, var(--ui-warning) 35%, var(--ui-border));
  background: color-mix(in srgb, var(--ui-warning) 8%, var(--ui-surface));
}

.context-meter-strip[data-level='compaction_needed'] {
  border-color: color-mix(in srgb, var(--ui-danger) 38%, var(--ui-border));
  background: var(--ui-danger-bg);
}

.context-meter-left {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  min-width: 0;
}

.context-meter-label {
  font-weight: 600;
  color: var(--ui-muted);
}

.context-meter-track {
  display: inline-block;
  width: 64px;
  height: 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ui-border) 85%, var(--ui-text) 8%);
  overflow: hidden;
  flex-shrink: 0;
}

.context-meter-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--ui-accent);
  transition: width 180ms ease;
}

.context-meter-strip[data-level='heavy'] .context-meter-fill {
  background: var(--ui-warning);
}

.context-meter-strip[data-level='compaction_needed'] .context-meter-fill {
  background: var(--ui-danger);
}

.context-meter-stat {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  color: var(--ui-secondary);
}

.context-meter-badge {
  font-weight: 600;
  font-size: 11px;
}

.context-meter-badge.is-warning {
  color: var(--ui-warning);
}

.context-meter-badge.is-danger {
  color: var(--ui-danger);
}
</style>
