<script setup lang="ts">
/** 全局入口随页头移动，复用当前执行器快照，不额外请求或估算额度。 */
import { computed, shallowRef, useTemplateRef } from 'vue';
import { Gauge, RotateCw, Users } from '@lucide/vue';
import type { AgentApiProvider, AgentRuntimeHealth, AgentUsageLimits, AntigravityUsageLimits } from '../../../shared/agent-runtime';
import AgentUsageQuota from './AgentUsageQuota.vue';
import AgentAntigravityQuota from './AgentAntigravityQuota.vue';
import CursorAccountsDialog from './CursorAccountsDialog.vue';

interface UsageCard { key: string; label: string; usage?: AgentUsageLimits }

const props = defineProps<{ runtimes: AgentRuntimeHealth[]; usageCards: UsageCard[]; antigravityUsage?: AntigravityUsageLimits; refreshing: boolean }>();
const emit = defineEmits<{ refresh: []; configureModels: [provider: AgentApiProvider] }>();
const visible = shallowRef(false);
const trigger = useTemplateRef<HTMLButtonElement>('trigger');
let accountTrigger: HTMLButtonElement | undefined;
const checkedAt = computed(() => {
  const latest = [...props.usageCards.map(item => item.usage?.checkedAt), props.antigravityUsage?.checkedAt].filter((value): value is string => !!value)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
  const date = latest ? new Date(latest) : undefined;
  return date && !Number.isNaN(date.getTime())
    ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date) : '';
});
function closeWithKeyboard() { visible.value = false; trigger.value?.focus(); }
function openAccounts(event: MouseEvent, open: () => void) {
  accountTrigger = event.currentTarget as HTMLButtonElement;
  visible.value = false;
  open();
}
function restoreAccountFocus() {
  (accountTrigger?.checkVisibility() ? accountTrigger : trigger.value)?.focus();
  accountTrigger = undefined;
}
</script>

<template>
  <CursorAccountsDialog :runtimes="runtimes" :usage-cards="usageCards" :antigravity-usage="antigravityUsage" :refreshing="refreshing" @opened="visible = false" @closed="restoreAccountFocus" @changed="emit('refresh')" @refresh="emit('refresh')" @configure-models="emit('configureModels', $event)">
    <template #trigger="{ open }">
      <div class="connection-controls">
        <el-popover v-model:visible="visible" trigger="click" placement="bottom-end" :width="820" :show-arrow="false" popper-class="agent-connection-popper" persistent>
          <template #reference>
            <button ref="trigger" type="button" class="connection-trigger" aria-label="连接与额度" title="连接与额度" :aria-expanded="visible" @keydown.esc.stop="closeWithKeyboard">
              <Gauge :size="16" /><span>连接与额度</span>
            </button>
          </template>
          <section class="connection-content" aria-label="连接与额度详情" @keydown.esc.stop="closeWithKeyboard">
            <header class="connection-heading">
              <div>
                <h2>连接与额度</h2>
                <p v-if="checkedAt" class="connection-updated">更新于 {{ checkedAt }}</p>
              </div>
              <div class="connection-actions">
                <button type="button" class="connection-account-entry" aria-label="多账号管理" title="多账号管理" @click="openAccounts($event, open)"><Users :size="14" /><span>多账号管理</span></button>
                <button type="button" :disabled="refreshing" aria-label="刷新执行器状态" title="刷新执行器状态" @click="emit('refresh')"><RotateCw :size="14" :class="{ spinning: refreshing }" /></button>
              </div>
            </header>
            <div class="connection-scroll" tabindex="0" role="region" aria-label="执行器状态与额度">
              <section class="connection-runtimes" aria-label="执行器状态">
                <h3>执行器状态</h3>
                <ul class="connection-runtime-list">
                  <li v-for="item in runtimes" :key="item.provider" class="connection-runtime" :class="{ ready: item.ready }">
                    <i aria-hidden="true"></i><span>{{ item.label }}</span><small>{{ item.ready ? '可用' : '不可用' }}</small>
                  </li>
                </ul>
              </section>
              <section class="connection-quotas" aria-label="额度详情">
                <h3>额度详情</h3>
                <div class="connection-usage">
                  <AgentUsageQuota v-for="item in usageCards" :key="item.key" :usage="item.usage" :label="item.label" />
                  <AgentAntigravityQuota v-if="antigravityUsage" :usage="antigravityUsage" />
                </div>
              </section>
            </div>
          </section>
        </el-popover>
        <button type="button" class="connection-accounts-trigger" aria-label="多账号管理" title="多账号管理" @click="openAccounts($event, open)"><Users :size="15" /><span>多账号管理</span></button>
      </div>
    </template>
  </CursorAccountsDialog>
</template>

<style scoped>
.connection-controls{display:inline-flex;align-items:center;gap:4px;flex-shrink:0}
.connection-trigger,.connection-accounts-trigger{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 8px;flex-shrink:0;white-space:nowrap;border:0;border-radius:6px;background:transparent;color:var(--ui-muted);font:inherit;font-size:12px;cursor:pointer}
.connection-trigger:hover,.connection-trigger[aria-expanded=true],.connection-accounts-trigger:hover{background:var(--ui-hover);color:var(--ui-text)}
.connection-accounts-trigger{color:var(--ui-secondary);border:1px solid var(--ui-border)}
.connection-trigger:focus-visible,.connection-accounts-trigger:focus-visible,.connection-actions button:focus-visible{outline:2px solid var(--ui-accent);outline-offset:2px}
.connection-content {
  --agent-border: var(--ui-border);
  --agent-secondary: var(--ui-secondary);
  --agent-muted: var(--ui-muted);
  --agent-text: var(--ui-text);
  --agent-raised: var(--ui-hover);
  --agent-cyan: var(--ui-accent);
  --agent-accent: var(--ui-accent);
  display: flex;
  flex-direction: column;
  max-height: min(720px, calc(100dvh - 128px));
  color: var(--ui-text);
}
.connection-heading {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--ui-divider);
}
.connection-heading h2 { margin: 0; font-size: 15px; font-weight: 650; }
.connection-updated { margin: 3px 0 0; color: var(--ui-muted); font-size: 11px; }
.connection-actions { display: flex; flex-shrink: 0; gap: 6px; }
.connection-actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 32px;
  min-height: 32px;
  padding: 4px 8px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius-sm);
  background: var(--ui-surface);
  color: var(--ui-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.connection-actions button:hover { background: var(--ui-hover); color: var(--ui-text); }
.connection-actions button:disabled { cursor: wait; opacity: .6; }
.connection-scroll {
  display: grid;
  grid-template-columns: 184px minmax(0, 1fr);
  align-items: start;
  gap: 14px;
  min-height: 0;
  padding: 14px;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}
.connection-scroll:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: -2px; }
.connection-runtime-list,
.connection-usage :deep(:is(.usage-quota, .antigravity-quota)) {
  min-width: 0;
  margin: 0;
  padding: 10px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius);
}
.connection-runtimes h3,.connection-quotas > h3 { margin: 0 0 8px; padding: 0 2px; font-size: 12px; font-weight: 650; }
.connection-runtime-list { display: grid; list-style: none; }
.connection-runtime {
  display: grid;
  grid-template-columns: 6px minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px;
  padding: 5px 0;
  font-size: 12px;
}
.connection-runtime + .connection-runtime { border-top: 1px solid var(--ui-divider); }
.connection-runtime i { width: 6px; height: 6px; border-radius: 50%; background: var(--ui-muted); }
.connection-runtime span { overflow-wrap: anywhere; }
.connection-runtime small { color: var(--ui-muted); font-size: 11px; white-space: nowrap; }
.connection-runtime.ready i { background: var(--ui-success); }
.connection-usage { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.connection-usage :deep(.usage-heading) { flex-wrap: wrap; gap: 4px 8px; }
.connection-usage :deep(.usage-heading strong) { font-size: 12px; }
.connection-usage :deep(.usage-heading span) { font-size: 10px; overflow-wrap: anywhere; }
.connection-usage :deep(.usage-track) { height: 4px; margin-block: 7px; }
.connection-usage :deep(.usage-unavailable) { overflow-wrap: anywhere; line-height: 1.6; }
.connection-usage :deep(.antigravity-quota) {
  display: grid;
  grid-column: 1 / -1;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  gap: 8px 16px;
}
.connection-usage :deep(.antigravity-quota > :is(h3, .quota-unavailable, .quota-original)) { grid-column: 1 / -1; }
.connection-usage :deep(.antigravity-quota .quota-group) { min-width: 0; margin: 0; overflow-wrap: anywhere; }
@media (max-width: 760px) {
  .connection-scroll { grid-template-columns: 164px minmax(0, 1fr); }
  .connection-usage { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 620px) {
  .connection-scroll { grid-template-columns: minmax(0, 1fr); padding: 10px; }
  .connection-runtime-list { grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 12px; }
  .connection-runtime + .connection-runtime { border-top: 0; }
}
@media (max-width: 450px) {
  .connection-usage,.connection-usage :deep(.antigravity-quota) { grid-template-columns: minmax(0, 1fr); }
}
.connection-heading .connection-account-entry { white-space: nowrap; }
.spinning{animation:connection-spin .8s linear infinite}@keyframes connection-spin{to{transform:rotate(360deg)}}
@container studio-conversation (max-width:850px){.connection-trigger{width:30px;padding:0}.connection-trigger>span{display:none}}
@media(max-width:1079px){.connection-trigger{width:36px;padding:0}.connection-trigger>span{display:none}}
</style>

<style>
.el-popover.agent-connection-popper {
  box-sizing: border-box;
  max-width: calc(100vw - 24px);
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius-lg);
  background: var(--ui-surface);
  box-shadow: var(--ui-shadow);
}
</style>
