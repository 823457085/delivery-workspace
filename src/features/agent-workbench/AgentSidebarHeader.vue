<script setup lang="ts">
/** 共用顶部避免两套按钮样式在模式切换时跳动；只上报操作，路由及会话状态仍由父组件管理。 */
import { MessageSquare, MessageSquarePlus, Sparkles, Users } from '@lucide/vue';
import ThemePicker from '../../shared/theme/ThemePicker.vue';

const props = defineProps<{ mode: 'session' | 'group'; changing?: boolean }>();
const emit = defineEmits<{ select: [mode: 'session' | 'group']; create: [] }>();

function selectMode(mode: 'session' | 'group') {
  if (mode !== props.mode) emit('select', mode);
}
</script>

<template>
  <div class="sidebar-header">
    <header class="sidebar-brand">
      <span class="sidebar-brand-mark" aria-hidden="true"><Sparkles :size="12" /></span>
      <strong>AI 对话</strong>
      <div class="sidebar-tools">
        <ThemePicker />
      </div>
    </header>
    <nav class="sidebar-modes" aria-label="会话类型">
      <button type="button" :aria-pressed="mode === 'session'" @click="selectMode('session')">
        <MessageSquare :size="12" />
        <span>普通会话</span>
      </button>
      <button type="button" :aria-pressed="mode === 'group'" @click="selectMode('group')">
        <Users :size="12" />
        <span>团队群聊</span>
      </button>
    </nav>
    <button
      class="sidebar-create"
      type="button"
      :aria-label="mode === 'session' ? '新建 Agent 会话' : '新建团队群聊'"
      :disabled="!!changing"
      @click="emit('create')"
    >
      <MessageSquarePlus :size="14" />
      <span>{{ mode === 'session' ? '发起新对话' : '新建协作群聊' }}</span>
    </button>
  </div>
</template>

<style scoped>
.sidebar-header {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
  min-width: 0;
  padding: 8px 10px;
  border-bottom: 1px solid var(--ui-divider, var(--ui-border));
}
.sidebar-brand {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 26px;
  min-width: 0;
}
.sidebar-brand-mark {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius-xs, 5px);
  background: var(--ui-raised);
  color: var(--ui-secondary);
}
:global(:root[data-theme='acid'] .sidebar-brand-mark) {
  background: var(--ui-surface);
  color: var(--ui-accent);
}
.sidebar-brand > strong {
  overflow: hidden;
  color: var(--ui-text);
  font: 600 13.5px/18px var(--ds-display, var(--sans));
  letter-spacing: -0.02em;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.sidebar-brand-badge {
  padding: 0 5px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius-xs, 5px);
  background: var(--ui-surface);
  color: var(--ui-accent);
  font: 700 9.5px/14px var(--ds-code, var(--mono));
  letter-spacing: 0.06em;
}
.sidebar-tools {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  margin-left: auto;
}
.sidebar-tools :deep(.theme-trigger) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  min-height: 26px;
  padding: 0;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius-xs, 6px);
  background: var(--ui-surface);
  color: var(--ui-secondary);
  cursor: pointer;
}
.sidebar-tools :deep(.theme-trigger span) { display: none; }
.sidebar-tools :deep(.theme-trigger:hover) { background: var(--ui-hover); color: var(--ui-text); }

.sidebar-modes {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius-sm, 7px);
  background: var(--ui-raised);
}
.sidebar-modes button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-width: 0;
  min-height: 26px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: var(--ds-radius-xs, 5px);
  background: transparent;
  color: var(--ui-muted);
  font: 500 11.5px/16px var(--ds-display, var(--sans));
  white-space: nowrap;
  cursor: pointer;
  transition: background 160ms ease, color 160ms ease, border-color 160ms ease;
}
.sidebar-modes button:hover {
  color: var(--ui-text);
  background: var(--ui-hover);
}
.sidebar-modes button[aria-pressed='true'] {
  color: var(--ui-text);
  background: var(--ui-surface);
  border-color: var(--ui-border);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
  font-weight: 600;
}
:global(:root[data-theme='acid'] .sidebar-modes button[aria-pressed='true']) {
  background: var(--acid-green, #39ff14);
  border-color: var(--acid-green, #39ff14);
  color: #0a0a0a;
}

.sidebar-create {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  min-height: 30px;
  padding: 4px 10px;
  border: 1px solid var(--ui-primary);
  border-radius: var(--ds-radius-sm, 7px);
  background: var(--ui-primary);
  color: var(--ui-on-primary);
  font: 600 12px/16px var(--ds-display, var(--sans));
  letter-spacing: 0.01em;
  cursor: pointer;
  transition: background 160ms ease, box-shadow 160ms ease, transform 140ms ease;
}
.sidebar-create:hover:not(:disabled) {
  background: var(--ui-primary-hover);
  border-color: var(--ui-primary-hover);
}
:global(:root[data-theme='acid'] .sidebar-create) {
  box-shadow: 3px 3px 0 var(--acid-violet, #a020f0);
}
:global(:root[data-theme='acid'] .sidebar-create:hover:not(:disabled)) {
  box-shadow: 4px 4px 0 var(--acid-pink, #ff6ec7);
}
.sidebar-create:active:not(:disabled) { transform: scale(0.98); }
.sidebar-create:disabled { opacity: 0.6; cursor: not-allowed; }
.sidebar-modes button:focus-visible,
.sidebar-create:focus-visible,
.sidebar-tools :deep(.theme-trigger:focus-visible) {
  outline: 2px solid var(--ui-accent);
  outline-offset: 2px;
}

@media (max-width: 720px) {
  .sidebar-header { padding-inline: 8px; }
  .sidebar-zone-row { display: none; }
  .sidebar-brand > strong { font-size: 14px; }
}
@media (max-width: 480px) {
  .sidebar-modes button { flex-direction: column; gap: 3px; min-height: 42px; }
  .sidebar-create { gap: 6px; padding-inline: 8px; font-size: 12px; }
}
</style>
