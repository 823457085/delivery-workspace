<script setup lang="ts">
/** 仅把已解析的行内 Markdown 节点映射为 Vue 节点，不接收或注入 HTML。 */
import type { MarkdownInline } from './markdown';

defineProps<{ nodes: MarkdownInline[] }>();
</script>

<template>
  <template v-for="(node, index) in nodes" :key="`${index}-${node.type}-${node.text}`">
    <strong v-if="node.type === 'strong'">{{ node.text }}</strong>
    <em v-else-if="node.type === 'emphasis'">{{ node.text }}</em>
    <code v-else-if="node.type === 'code'">{{ node.text }}</code>
    <a v-else-if="node.type === 'link'" :href="node.href" target="_blank" rel="noopener noreferrer">{{ node.text }}</a>
    <template v-else>{{ node.text }}</template>
  </template>
</template>
