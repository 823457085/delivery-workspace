<script setup lang="ts">
/** 用户消息只在展示层折叠；长消息预览用纯文本、全文一次解析，避免截断链接。原生 details 不接管会话或复制状态。 */
import { computed, shallowRef, watch } from 'vue';
import AgentMarkdownInline from './AgentMarkdownInline.vue';
import { parseMarkdownInline } from './markdown';
import { splitUserMessage } from './message-text';
import PluginReferenceHistory from '../custom-plugins/PluginReferenceHistory.vue';

const props = defineProps<{ source: string; searchQuery?: string; knowledgeContext?: string }>();
const parts = computed(() => splitUserMessage(props.source));
const nodes = computed(() => ({ message: parseMarkdownInline(parts.value.handoff ? parts.value.before : props.source),
  after: parseMarkdownInline(parts.value.after) }));
const expanded = shallowRef(false);
watch([() => props.source, () => props.searchQuery], () => {
  const term = props.searchQuery?.trim().toLowerCase();
  expanded.value = !!term && props.source.toLowerCase().includes(term);
}, { immediate: true });
function rememberExpanded(event: Event) { expanded.value = (event.target as HTMLDetailsElement).open; }
</script>

<template>
  <p v-if="parts.before && (parts.handoff || !parts.hidden)" class="message-text"><AgentMarkdownInline :nodes="nodes.message" /></p>
  <p v-else-if="parts.before && !expanded" class="message-text">{{ parts.before }}</p>
  <details v-if="parts.hidden" class="message-overflow" :open="expanded" @toggle="rememberExpanded">
    <summary class="message-overflow-toggle">{{ parts.handoff ? '交接上下文' : expanded ? '收起长消息' : '展开完整消息' }}<span>（{{ parts.handoff ? parts.hidden.length : source.length }} 字）</span></summary>
    <p v-if="parts.handoff" class="message-text message-overflow-content">{{ parts.hidden }}</p>
    <p v-else class="message-text message-overflow-content"><AgentMarkdownInline :nodes="nodes.message" /></p>
  </details>
  <p v-if="parts.after" class="message-text"><AgentMarkdownInline :nodes="nodes.after" /></p>
  <PluginReferenceHistory :source="source" :snapshot="knowledgeContext" />
</template>

<style scoped>
.message-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.message-overflow { margin-top: 8px; }
.message-overflow-toggle { width: fit-content; color: var(--agent-muted); font-size: 12px; line-height: 1.6; cursor: pointer; }
.message-overflow-toggle:hover, .message-overflow-toggle:focus-visible { color: var(--agent-text); }
.message-overflow-toggle:focus-visible { outline: 1px solid var(--agent-accent); outline-offset: 3px; border-radius: 2px; }
.message-overflow-content { padding-top: 8px; }
</style>
