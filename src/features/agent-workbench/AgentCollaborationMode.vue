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
.collaboration-mode { position: relative; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); width: 226px; max-width: 100%; flex: none; padding: 3px; border: 1px solid var(--agent-border); border-radius: 10px; background: var(--agent-panel); isolation: isolate; }
.mode-indicator { position: absolute; z-index: -1; inset: 3px auto 3px 3px; width: calc(50% - 3px); border: 1px solid color-mix(in srgb, var(--agent-accent) 45%, transparent); border-radius: 7px; background: color-mix(in srgb, var(--agent-accent) 12%, var(--agent-panel-strong)); box-shadow: 0 1px 3px #00000008; transition: transform 180ms cubic-bezier(.2,.8,.2,1); }
.manual .mode-indicator { transform: translateX(100%); }
.collaboration-mode > button { display: flex; align-items: center; justify-content: center; gap: 7px; min-width: 0; height: 30px; padding: 0 8px; border: 0; border-radius: 7px; background: transparent; color: var(--agent-secondary); font: inherit; font-size: 12px; white-space: nowrap; cursor: pointer; transition: color 120ms ease; }
.collaboration-mode > button[aria-pressed='true'] { color: var(--agent-accent); font-weight: 600; }
.collaboration-mode > button:hover { color: var(--agent-accent); }
.collaboration-mode > button:focus-visible { outline: 2px solid var(--agent-accent); outline-offset: -2px; }
.collaboration-mode > button:disabled { opacity: .5; cursor: default; }
@media (prefers-reduced-motion: reduce) { .mode-indicator, .collaboration-mode > button { transition: none; } }
</style>
