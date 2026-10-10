<script setup lang="ts">
/**
 * 设计说明：置顶区和项目分组共用同一会话行，因此抽出无状态展示组件。
 * 它只接收会话和选中/置顶状态，仅选择通过事件交还父层；置顶与删除统一放在会话顶部。
 */
import type { AgentConversation } from './conversation';
import StatusPill from '../../shared/ui/StatusPill.vue';

const props = defineProps<{ conversation: AgentConversation; selected: boolean }>();
const emit = defineEmits<{ select: [id: string] }>();
</script>

<template>
  <div class="session-row">
    <button type="button" class="session-item" :class="{ selected }" @click="emit('select', conversation.id)">
      <span class="session-provider"><StatusPill :value="conversation.runs.some(run => run.pausedForEdit) ? 'paused' : conversation.latest.status" /><span v-if="conversation.latest.provider === 'cursor'">Cursor</span></span>
      <strong class="session-title" :title="conversation.title">{{ conversation.title }}</strong>
    </button>
  </div>
</template>

<style scoped>
.session-row{position:relative;margin:0 0 4px}.session-item{position:relative;display:flex;align-items:center;gap:8px;width:100%;min-height:36px;padding:7px 10px;overflow:hidden;border:1px solid transparent;border-radius:8px;text-align:left;background:transparent;color:var(--agent-secondary);cursor:pointer;transition:.16s ease}.session-item::before{position:absolute;content:"";left:0;top:9px;bottom:9px;width:3px;border-radius:0 3px 3px 0;background:transparent}.session-item:hover{border-color:var(--agent-border);background:var(--agent-panel-strong)}.session-item.selected{border-color:color-mix(in srgb,var(--agent-accent) 42%,var(--agent-border));background:linear-gradient(135deg,var(--agent-raised),var(--agent-panel-strong));color:#fff;box-shadow:0 6px 18px #0002}.session-item.selected::before{background:linear-gradient(var(--agent-cyan),var(--agent-accent));box-shadow:0 0 12px color-mix(in srgb,var(--agent-accent) 58%,transparent)}.session-provider{display:flex;flex-shrink:0;white-space:nowrap;align-items:center;gap:6px;color:color-mix(in srgb,var(--agent-accent) 54%,#d7e8ff);font-size:9px;font-weight:650}.session-title{display:block;min-width:0;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:1.45;font-weight:580}
.session-row:deep(.status-pill){padding:2px 6px;background:#1d342d;color:#69ddb2;font-size:8px}
</style>
