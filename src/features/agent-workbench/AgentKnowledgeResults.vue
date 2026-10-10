<script setup lang="ts">
/** 统一紧凑结果行，仅展示与选择；详情按需展开，避免三种来源重复维护卡片。 */
import type { KnowledgeEntry } from './useKnowledgeCatalog';
defineProps<{ entries: KnowledgeEntry[] }>();
const emit = defineEmits<{ compose: [prompt: string] }>();
</script>
<template>
  <div class="knowledge-results">
    <div v-for="entry in entries" :key="entry.id" class="result-row">
      <details class="result-detail">
        <summary :title="entry.title"><span><strong>{{ entry.title }}</strong><small>{{ entry.subtitle }}</small></span></summary>
        <p>{{ entry.detail }}</p>
      </details>
      <button type="button" class="use-result" :aria-label="`带入会话：${entry.title}`" @click="emit('compose', entry.prompt)">带入会话</button>
    </div>
  </div>
</template>
<style scoped>
.result-row{display:flex;align-items:flex-start;gap:8px;padding:10px 0;border-bottom:1px solid var(--agent-border)}
.result-detail{min-width:0;flex:1}.result-detail summary{display:flex;align-items:center;gap:6px;cursor:pointer;list-style:none}.result-detail summary::-webkit-details-marker{display:none}.result-detail summary::before{content:'›';color:var(--agent-muted)}.result-detail[open] summary::before{transform:rotate(90deg)}
.result-detail summary>span{min-width:0;flex:1}.result-detail strong,.result-detail small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.6}.result-detail strong{font-size:13px;font-weight:500;color:var(--agent-text)}.result-detail small{font-size:11px;color:var(--agent-muted)}.result-detail p{margin:8px 0 0 12px;font-size:12px;color:var(--agent-secondary);white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6}
.use-result{flex-shrink:0;padding:4px 0;border:0;background:transparent;color:color-mix(in srgb,var(--agent-accent) 55%,#fff);font-size:12px;cursor:pointer}.use-result:hover{text-decoration:underline}
</style>
