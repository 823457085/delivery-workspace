<script setup lang="ts">
/** 用户消息保持原有段落布局，只把安全链接交给行内渲染器；不承担会话状态。 */
import { computed } from 'vue';
import AgentMarkdownInline from './AgentMarkdownInline.vue';
import { parseMarkdownInline } from './markdown';

const props = defineProps<{ source: string }>();
const nodes = computed(() => parseMarkdownInline(props.source));
</script>

<template>
  <AgentMarkdownInline :nodes="nodes" />
</template>
