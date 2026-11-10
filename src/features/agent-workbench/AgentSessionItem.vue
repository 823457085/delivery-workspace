<script setup lang="ts">
/**
 * 设计说明：置顶区和项目分组共用同一会话行，因此抽出无状态展示组件。
 * 它只接收会话和选中/置顶状态，仅选择通过事件交还父层；置顶与删除统一放在会话顶部。
 */
import { computed } from 'vue';
import { agentConversationRoundCount, agentConversationStatus, type AgentConversation } from './conversation';
import StatusPill from '../../shared/ui/StatusPill.vue';
import { dateTime } from '../../shared/format';
import { agentProviderLabels } from '../../../shared/agent-runtime';

const props = defineProps<{ conversation: AgentConversation; selected: boolean; selecting?: boolean; checked?: boolean; disabled?: boolean }>();
const status = computed(() => agentConversationStatus(props.conversation));
const emit = defineEmits<{ select: [id: string]; toggle: [id: string] }>();
</script>

<template>
  <div class="session-row" :class="{ 'session-row-selecting': selecting }">
    <input v-if="selecting" type="checkbox" class="session-checkbox" :aria-label="`选择会话：${conversation.title}`" :checked="checked" :disabled="disabled" @change="emit('toggle', conversation.id)" />
    <button type="button" class="session-item" :class="{ selected: selecting ? checked : selected }" :disabled="selecting && disabled" :aria-pressed="selecting ? checked : selected" @click="selecting ? emit('toggle', conversation.id) : emit('select', conversation.id)">
      <span class="session-provider"><StatusPill :value="status.value" :label="status.label" :title="status.title" :class="{ 'session-running': status.value === 'running' }" /><span v-if="conversation.latest.provider !== 'codex'">{{ agentProviderLabels[conversation.latest.provider].replace(/ CLI$/, '') }}</span></span>
      <strong class="session-title" :title="conversation.title">{{ conversation.title }}</strong>
      <small class="session-updated">{{ dateTime(conversation.updatedAt) }}<template v-if="conversation.loaded"> · {{ agentConversationRoundCount(conversation) }} 轮</template></small>
    </button>
  </div>
</template>

<style scoped>
.session-row-selecting{display:flex;align-items:center;gap:4px}.session-checkbox{flex:0 0 auto;margin:0 0 0 6px;accent-color:var(--agent-accent)}.session-row-selecting .session-item{flex:1;min-width:0}.session-row-selecting .session-item:disabled{cursor:wait}
.session-row{position:relative;margin:0 0 4px}.session-item{position:relative;display:flex;align-items:center;gap:8px;width:100%;min-height:36px;padding:7px 10px;overflow:hidden;border:1px solid transparent;border-radius:8px;text-align:left;background:transparent;color:var(--agent-secondary);cursor:pointer;transition:.16s ease}.session-item::before{position:absolute;content:"";left:0;top:9px;bottom:9px;width:3px;border-radius:0 3px 3px 0;background:transparent}.session-item:hover{border-color:var(--agent-border);background:var(--agent-panel-strong)}.session-item.selected{border-color:color-mix(in srgb,var(--agent-accent) 42%,var(--agent-border));background:linear-gradient(135deg,var(--agent-raised),var(--agent-panel-strong));color:#fff;box-shadow:0 6px 18px #0002}.session-item.selected::before{background:linear-gradient(var(--agent-cyan),var(--agent-accent));box-shadow:0 0 12px color-mix(in srgb,var(--agent-accent) 58%,transparent)}.session-provider{display:flex;flex-shrink:0;white-space:nowrap;align-items:center;gap:6px;color:color-mix(in srgb,var(--agent-accent) 54%,#d7e8ff);font-size:9px;font-weight:650}.session-title{display:block;min-width:0;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:1.45;font-weight:580}
.session-row:deep(.status-pill){padding:2px 6px;font-size:8px}
.session-row:deep(.status-pill.session-running i){box-sizing:border-box;flex-shrink:0;width:12px;height:12px;border:1.5px solid color-mix(in srgb,currentColor 24%,transparent);border-top-color:currentColor;background:transparent;animation:session-running-spin .8s linear infinite}
@keyframes session-running-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.session-row:deep(.status-pill.session-running i){animation:none}}
</style>
