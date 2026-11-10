<script setup lang="ts">
/** 共用顶部避免两套按钮样式在模式切换时跳动；只上报操作，路由及会话状态仍由父组件管理。 */
import { MessageSquare, MessageSquarePlus, Users } from '@lucide/vue';
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
      <strong>Agent Studio</strong>
      <div class="sidebar-tools">
        <ThemePicker />
      </div>
    </header>
    <nav class="sidebar-modes" aria-label="会话类型">
      <button type="button" :aria-pressed="mode === 'session'" @click="selectMode('session')"><MessageSquare :size="14" /><span>普通会话</span></button>
      <button type="button" :aria-pressed="mode === 'group'" @click="selectMode('group')"><Users :size="14" /><span>团队群聊</span></button>
    </nav>
    <button class="sidebar-create" type="button" :aria-label="mode === 'session' ? '新建 Agent 会话' : '新建团队群聊'" :disabled="!!changing" @click="emit('create')"><MessageSquarePlus :size="16" /><span>{{ mode === 'session' ? '新对话' : '新建群聊' }}</span></button>
  </div>
</template>

<style scoped>
.sidebar-header { flex-shrink: 0; min-width: 0; padding: 0 12px 12px; }
.sidebar-brand { display: flex; align-items: center; justify-content: space-between; gap: 8px; height: 46px; min-width: 0; }
.sidebar-brand > strong { overflow: hidden; color: var(--agent-text); font-size: 15px; font-weight: 650; letter-spacing: -.02em; white-space: nowrap; text-overflow: ellipsis; }
.sidebar-tools { display: flex; align-items: center; flex-shrink: 0; min-width: 34px; }
.sidebar-tools :deep(.theme-trigger) { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; width: 28px; height: 28px; min-height: 28px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--agent-muted); cursor: pointer; }
.sidebar-tools :deep(.theme-trigger span) { display: none; }
.sidebar-tools :deep(.theme-trigger:hover) { background: var(--agent-raised); color: var(--agent-text); }
.sidebar-modes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 3px; margin-bottom: 10px; padding: 3px; border: 1px solid var(--agent-border); border-radius: 9px; background: var(--agent-panel-strong); }
.sidebar-modes button { display: flex; align-items: center; justify-content: center; gap: 6px; min-width: 0; min-height: 30px; padding: 0 3px; border: 0; border-radius: 6px; background: transparent; color: var(--agent-muted); font: inherit; font-size: 12px; white-space: nowrap; cursor: pointer; transition: background .15s ease, color .15s ease; }
.sidebar-modes button:hover { color: var(--agent-text); background: var(--agent-raised); }
.sidebar-modes button[aria-pressed='true'] { color: var(--agent-accent); background: var(--agent-panel); box-shadow: 0 1px 3px #00000012; font-weight: 600; }
.sidebar-create { display: flex; align-items: center; justify-content: flex-start; gap: 8px; width: 100%; min-height: 36px; padding: 0 11px; border: 0; border-radius: 8px; background: var(--ui-primary); color: var(--ui-on-primary); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; transition: background .15s ease; }
.sidebar-create:hover:not(:disabled) { background: var(--ui-primary-hover); }
.sidebar-create:disabled { opacity: .6; cursor: not-allowed; }
.sidebar-modes button:focus-visible, .sidebar-create:focus-visible, .sidebar-tools :deep(.theme-trigger:focus-visible) { outline: 2px solid var(--agent-accent); outline-offset: 2px; }
@media (max-width: 720px) {
  .sidebar-header { padding-inline: 8px; }
  .sidebar-brand { gap: 4px; }
  .sidebar-brand > strong { font-size: 13px; }
  .sidebar-tools { min-width: 28px; }
  .sidebar-modes button { gap: 4px; font-size: 11px; }
}
@media (max-width: 480px) {
  .sidebar-modes button { flex-direction: column; gap: 3px; min-height: 44px; }
  .sidebar-create { gap: 6px; padding-inline: 8px; font-size: 11px; }
}
</style>
