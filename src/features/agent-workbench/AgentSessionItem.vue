<script setup lang="ts">
/**
 * 设计说明：置顶区和项目分组共用同一会话行，因此抽出无状态展示组件。
 * 它只接收会话和选中/置顶状态，仅选择通过事件交还父层；置顶与删除统一放在会话顶部。
 */
import { computed, nextTick, ref, shallowRef, useTemplateRef } from 'vue';
import { GitBranch } from '@lucide/vue';
import { agentConversationBranch, agentConversationRoundCount, agentConversationStatus, type AgentConversation } from './conversation';
import StatusPill from '../../shared/ui/StatusPill.vue';
import { dateTime } from '../../shared/format';
import { agentProviderLabels } from '../../../shared/agent-runtime';

const props = defineProps<{ conversation: AgentConversation; selected: boolean; selecting?: boolean; checked?: boolean; disabled?: boolean; searchQuery?: string; searchSnippet?: string; unread?: boolean }>();
const status = computed(() => agentConversationStatus(props.conversation));
const matchedSnippet = computed(() => {
  const term = props.searchQuery?.trim().toLowerCase();
  if (!term || props.conversation.title.toLowerCase().includes(term)) return '';
  const candidates = props.conversation.runs.flatMap((run) => [run.objective, run.result, run.error]);
  for (const raw of candidates) {
    if (!raw) continue;
    const flat = raw.replace(/\s+/g, ' ').trim();
    const index = flat.toLowerCase().indexOf(term);
    if (index >= 0) {
      const start = Math.max(0, index - 16);
      const end = Math.min(flat.length, index + term.length + 34);
      return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
    }
  }
  return props.searchSnippet || '';
});
const providerShort = computed(() => {
  const raw = agentProviderLabels[props.conversation.latest.provider] || props.conversation.latest.provider;
  return raw.replace(/ CLI$/, '').replace('GPT / Codex', 'Codex');
});
const compactStatusLabel = computed(() => {
  const map: Record<string, string> = { 本轮完成: '完成', 执行失败: '失败', 排队中: '排队' };
  return map[status.value.label] || status.value.label;
});
const compactUpdated = computed(() => {
  const parsed = new Date(props.conversation.updatedAt);
  if (Number.isNaN(parsed.getTime())) return dateTime(props.conversation.updatedAt);
  const now = new Date();
  const sameDay = parsed.getFullYear() === now.getFullYear()
    && parsed.getMonth() === now.getMonth()
    && parsed.getDate() === now.getDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  return sameDay
    ? `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
    : `${pad(parsed.getMonth() + 1)}/${pad(parsed.getDate())}`;
});
const branchName = computed(() => agentConversationBranch(props.conversation));
const emit = defineEmits<{ select: [id: string]; toggle: [id: string]; rename: [id: string, title: string] }>();
const editing = shallowRef(false);
const titleDraft = ref('');
const titleInput = useTemplateRef<HTMLInputElement>('titleInput');

async function startRename() {
  if (props.selecting || props.disabled) return;
  titleDraft.value = props.conversation.title;
  editing.value = true;
  await nextTick();
  titleInput.value?.focus();
  titleInput.value?.select();
}
function commitRename() {
  if (!editing.value) return;
  const trimmed = titleDraft.value.trim().slice(0, 120);
  editing.value = false;
  if (trimmed && trimmed !== props.conversation.title) emit('rename', props.conversation.id, trimmed);
}
function cancelRename() {
  editing.value = false;
  titleDraft.value = props.conversation.title;
}
</script>

<template>
  <div class="session-row" :class="{ 'session-row-selecting': selecting }">
    <input
      v-if="selecting"
      type="checkbox"
      class="session-checkbox"
      :aria-label="`选择会话：${conversation.title}`"
      :checked="checked"
      :disabled="disabled"
      @change="emit('toggle', conversation.id)"
    />
    <button
      type="button"
      class="session-item"
      :class="{ selected: selecting ? checked : selected, unread }"
      :disabled="selecting && disabled"
      :aria-pressed="selecting ? checked : selected"
      :aria-label="unread ? `${conversation.title}，完成未读` : undefined"
      @click="editing ? undefined : (selecting ? emit('toggle', conversation.id) : emit('select', conversation.id))"
    >
      <input
        v-if="editing"
        ref="titleInput"
        v-model="titleDraft"
        class="session-title-input"
        maxlength="120"
        aria-label="修改会话标题"
        @click.stop
        @dblclick.stop
        @keydown.enter.prevent="commitRename"
        @keydown.esc.stop.prevent="cancelRename"
        @blur="commitRename"
      />
      <strong v-else class="session-title" :title="`${conversation.title}（双击可改名）`" @dblclick.stop.prevent="startRename">{{ conversation.title }}</strong>
      <i v-if="unread && !editing" class="session-unread-dot" title="完成未读" aria-hidden="true" />
      <small v-if="matchedSnippet" class="session-match-snippet" :title="matchedSnippet">{{ matchedSnippet }}</small>

      <div class="session-card-meta">
        <span class="session-provider">
          <StatusPill :value="status.value" :label="compactStatusLabel" :title="status.title" :class="{ 'session-running': status.value === 'running' }" />
          <span class="session-provider-chip">{{ providerShort }}</span>
          <span v-if="conversation.loaded" class="session-provider-chip">{{ agentConversationRoundCount(conversation) }}轮</span>
        </span>
        <small v-if="branchName" class="session-branch" :title="branchName">
          <GitBranch :size="10" />
          <span>{{ branchName }}</span>
        </small>
        <small class="session-updated" :title="dateTime(conversation.updatedAt)">{{ compactUpdated }}</small>
      </div>
    </button>
  </div>
</template>

<style scoped>
.session-row-selecting { display: flex; align-items: center; gap: 4px; }
.session-checkbox { flex: 0 0 auto; margin: 0 0 0 6px; accent-color: var(--ui-accent); }
.session-row-selecting .session-item { flex: 1; min-width: 0; }
.session-row-selecting .session-item:disabled { cursor: wait; }
.session-unread-dot { position: absolute; top: 12px; right: 9px; width: 6px; height: 6px; border-radius: 50%; background: var(--ui-accent); }
.session-item.unread .session-title { padding-right: 12px; }

.session-row {
  position: relative;
  margin: 0 0 2px;
}
.session-match-snippet {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ui-accent);
  font: 400 11px/15px var(--sans);
  opacity: 0.9;
}

.session-item {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  width: 100%;
  min-height: 0;
  padding: 6px 9px;
  overflow: hidden;
  border: 1px solid transparent;
  border-radius: var(--ds-radius-xs, 7px);
  text-align: left;
  background: transparent;
  color: var(--ui-secondary);
  cursor: pointer;
  transition:
    background-color 140ms ease,
    border-color 140ms ease,
    color 140ms ease;
}

.session-item:hover {
  border-color: transparent;
  background: var(--ui-hover);
  color: var(--ui-text);
}

.session-item.selected {
  border-color: color-mix(in srgb, var(--ui-border) 88%, transparent);
  background: var(--ui-surface);
  color: var(--ui-text);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
}

:root:not([data-theme='acid']) .session-item.selected::before {
  content: '';
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 2.5px;
  border-radius: 0 2px 2px 0;
  background: var(--ui-text);
}

.session-card-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  min-width: 0;
  opacity: 0.78;
}

.session-item.selected .session-card-meta,
.session-item:hover .session-card-meta {
  opacity: 0.96;
}

.session-provider {
  display: inline-flex;
  align-items: center;
  flex: 0 1 auto;
  gap: 3px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}

.session-provider-chip {
  padding: 0 3px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--ui-muted);
  font: 500 10.5px/14px var(--ds-code, var(--mono));
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-title {
  display: block;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: 500 12.5px/18px var(--ds-display, var(--sans));
  letter-spacing: -0.008em;
  color: var(--ui-text);
}

.session-item.selected .session-title {
  font-weight: 600;
}

.session-title-input {
  width: 100%;
  min-width: 0;
  padding: 0 4px;
  border: 1px solid var(--ui-accent);
  border-radius: 4px;
  outline: none;
  background: var(--ui-bg);
  color: var(--ui-text);
  font: 500 12.5px/18px var(--ds-display, var(--sans));
}

.session-updated {
  margin-left: auto;
  flex-shrink: 0;
  color: var(--ui-muted);
  font: 400 10.5px/14px var(--ds-code, var(--mono));
  font-variant-numeric: tabular-nums;
}

.session-branch {
  display: inline-flex;
  align-items: center;
  flex: 0 1 auto;
  gap: 2px;
  min-width: 0;
  max-width: 96px;
  color: var(--ui-muted);
  font: 500 10px/14px var(--ds-code, var(--mono));
}
.session-branch svg { flex-shrink: 0; }
.session-branch span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-row:deep(.status-pill) { padding: 0 4px 0 0; font-size: 10.5px; line-height: 14px; background: transparent; }
.session-row:deep(.status-pill.session-running i) {
  box-sizing: border-box;
  flex-shrink: 0;
  width: 11px;
  height: 11px;
  border: 1.5px solid color-mix(in srgb, currentColor 24%, transparent);
  border-top-color: currentColor;
  background: transparent;
  animation: session-running-spin .8s linear infinite;
}
@keyframes session-running-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .session-row:deep(.status-pill.session-running i) { animation: none; } }
</style>
