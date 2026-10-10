<script setup lang="ts">
/**
 * 设计说明：统一呈现 Agent 结果与输入预览；只消费结构化 Markdown 块。
 * 不使用 v-html，所以模型输出中的 HTML 和脚本始终作为普通文本。
 */
import { computed } from 'vue';
import AgentMarkdownInline from './AgentMarkdownInline.vue';
import { parseAgentMarkdown } from './markdown';

const props = defineProps<{ source: string }>();
const blocks = computed(() => parseAgentMarkdown(props.source));
</script>

<template>
  <div class="agent-markdown">
    <template v-for="(block, index) in blocks" :key="index">
      <component :is="`h${block.level}`" v-if="block.type === 'heading'" class="markdown-heading"><AgentMarkdownInline :nodes="block.content" /></component>
      <p v-else-if="block.type === 'paragraph'" class="markdown-paragraph"><AgentMarkdownInline :nodes="block.content" /></p>
      <blockquote v-else-if="block.type === 'quote'" class="markdown-quote"><AgentMarkdownInline :nodes="block.content" /></blockquote>
      <pre v-else-if="block.type === 'code'" class="markdown-code"><span v-if="block.language" class="code-language">{{ block.language }}</span><code>{{ block.text }}</code></pre>
      <component :is="block.ordered ? 'ol' : 'ul'" v-else-if="block.type === 'list'" class="markdown-list"><li v-for="(item, itemIndex) in block.items" :key="itemIndex"><AgentMarkdownInline :nodes="item" /></li></component>
      <div v-else-if="block.type === 'table'" class="markdown-table-wrap"><table class="markdown-table"><thead><tr><th v-for="(cell, cellIndex) in block.headers" :key="cellIndex"><AgentMarkdownInline :nodes="cell" /></th></tr></thead><tbody><tr v-for="(row, rowIndex) in block.rows" :key="rowIndex"><td v-for="(cell, cellIndex) in row" :key="cellIndex"><AgentMarkdownInline :nodes="cell" /></td></tr></tbody></table></div>
      <hr v-else class="markdown-rule" />
    </template>
  </div>
</template>

<style scoped>
.agent-markdown{min-width:0;color:inherit;font-size:12px;line-height:1.76;overflow-wrap:anywhere}.markdown-heading{margin:15px 0 8px;color:#f8f9fc;line-height:1.35}.markdown-heading:first-child{margin-top:0}.agent-markdown h1{font-size:18px}.agent-markdown h2{font-size:16px}.agent-markdown h3{font-size:14px}.agent-markdown h4,.agent-markdown h5,.agent-markdown h6{font-size:12px}.markdown-paragraph{margin:0 0 10px}.markdown-paragraph:last-child{margin-bottom:0}.markdown-quote{margin:9px 0;padding:8px 12px;border-left:3px solid #776cf5;border-radius:0 6px 6px 0;background:#24283a;color:#d0d4df}.markdown-code{position:relative;margin:10px 0;padding:13px;overflow:auto;border:1px solid #354054;border-radius:8px;background:#10151d;color:#e8ebf2;font:11px/1.65 var(--mono);white-space:pre}.code-language{display:block;margin:0 0 7px;color:#8994a7;font:9px var(--mono);text-transform:uppercase}.markdown-list{margin:8px 0;padding-left:22px}.markdown-list li{margin:4px 0}.markdown-table-wrap{max-width:100%;margin:10px 0;overflow-x:auto;border:1px solid #384256;border-radius:8px}.markdown-table{width:100%;border-collapse:collapse;font-size:11px}.markdown-table th,.markdown-table td{padding:8px 10px;border-right:1px solid #384256;border-bottom:1px solid #384256;text-align:left}.markdown-table th:last-child,.markdown-table td:last-child{border-right:0}.markdown-table tr:last-child td{border-bottom:0}.markdown-table th{background:#252c3a;color:#f2f4f8}.markdown-rule{height:1px;margin:14px 0;border:0;background:#3a4354}.agent-markdown:deep(a){color:#86c8ff;text-underline-offset:3px}.agent-markdown:deep(code){padding:2px 5px;border-radius:4px;background:#171d27;color:#efc8ff;font-family:var(--mono)}.markdown-code code{padding:0;background:transparent;color:inherit}
</style>
