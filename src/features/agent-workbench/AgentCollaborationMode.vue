<script setup lang="ts">
import { Bot, UsersRound } from '@lucide/vue';

defineProps<{ disabled?: boolean; automaticLabel?: string }>();
const automatic = defineModel<boolean>({ required: true });
</script>

<template>
  <div class="collaboration-mode" :class="{ manual: !automatic }" role="group" aria-label="执行方式">
    <span class="mode-indicator" aria-hidden="true"></span>
    <button type="button" :aria-pressed="automatic" :disabled="disabled" @click="automatic = true"><UsersRound :size="14" /><span>{{ automaticLabel || '自动协作' }}</span></button>
    <button type="button" :aria-pressed="!automatic" :disabled="disabled" @click="automatic = false"><Bot :size="14" /><span>单个 Agent</span></button>
  </div>
</template>

<style scoped>
.collaboration-mode { position: relative; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); width: 226px; max-width: 100%; flex: none; padding: 2px; border: 1px solid var(--ui-border, var(--agent-border)); border-radius: var(--ds-radius-sm, 8px); background: var(--ui-raised, var(--agent-panel)); isolation: isolate; }
.mode-indicator { position: absolute; z-index: -1; inset: 2px auto 2px 2px; width: calc(50% - 2px); border: 1px solid var(--ui-border, var(--agent-border)); border-radius: var(--ds-radius-xs, 6px); background: var(--ui-surface, var(--agent-panel-strong)); box-shadow: 0 1px 2px #0000000d; transition: transform 180ms cubic-bezier(.2,.8,.2,1); }
.manual .mode-indicator { transform: translateX(100%); }
.collaboration-mode > button { display: flex; align-items: center; justify-content: center; gap: 6px; min-width: 0; height: 28px; padding: 0 8px; border: 0; border-radius: var(--ds-radius-xs, 6px); background: transparent; color: var(--ui-muted, var(--agent-secondary)); font: inherit; font-size: 12px; font-weight: 500; white-space: nowrap; cursor: pointer; transition: color 120ms ease; }
.collaboration-mode > button[aria-pressed='true'] { color: var(--ui-text, var(--agent-text)); font-weight: 600; }
.collaboration-mode > button:hover { color: var(--ui-text, var(--agent-text)); }
.collaboration-mode > button:focus-visible { outline: 2px solid var(--agent-accent); outline-offset: -2px; }
.collaboration-mode > button:disabled { opacity: .5; cursor: default; }
@media (prefers-reduced-motion: reduce) { .mode-indicator, .collaboration-mode > button { transition: none; } }
</style>
