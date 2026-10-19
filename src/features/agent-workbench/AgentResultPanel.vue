<script setup lang="ts">
/** 并排展示当前轮的真实回复和已登记文件，不将项目级交付或历史轮次作为本轮成果。 */
import { computed } from 'vue';
import { FileText } from '@lucide/vue';
import { dateTime } from '../../shared/format';
import type { AgentConversation } from './conversation';
import AgentChangedFiles from './AgentChangedFiles.vue';
import AgentMarkdown from './AgentMarkdown.vue';

const props = defineProps<{ conversation?: AgentConversation }>();
const latest = computed(() => props.conversation?.latest);
const round = computed(() => props.conversation ? props.conversation.runs.findIndex(run => run.id === latest.value?.id) + 1 : 0);
const waiting = computed(() => !!latest.value && ['running', 'queued'].includes(latest.value.status));
</script>

<template>
  <section :key="latest?.id" class="agent-result-panel" aria-label="本轮成果">
    <template v-if="latest && (latest.result || latest.changedFiles?.length)">
      <header class="result-heading"><FileText :size="18" /><h2>第 {{ round }} 轮成果</h2></header>
      <AgentChangedFiles v-if="latest.changedFiles?.length" :files="latest.changedFiles" :run-id="latest.id" />
      <article v-if="latest.result" class="result-document">
        <header><strong>本轮回复</strong><time>{{ dateTime(latest.updatedAt) }}</time></header>
        <AgentMarkdown :source="latest.result" />
      </article>
    </template>
    <el-empty v-else :image-size="64" :description="waiting ? '本轮正在执行，等待成果返回' : '当前会话暂无成果'" />
  </section>
</template>

<style scoped>
.agent-result-panel{flex:1;min-width:0;min-height:0;overflow:auto;padding:24px;background:var(--agent-panel-strong);color:var(--agent-text)}
.result-heading{display:flex;align-items:center;gap:9px;margin-bottom:20px;color:var(--agent-secondary)}
.result-heading h2{margin:0;font-size:16px;line-height:1.5;font-weight:550;color:var(--agent-text)}
.result-document{min-width:0;margin-top:24px}
.result-document>header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin-bottom:18px;padding-bottom:12px;border-bottom:1px solid var(--agent-border);font-size:12px}
.result-document>header strong{font-weight:500;color:var(--agent-secondary)}
.result-document time{color:var(--agent-muted);font-size:11px}
.result-document:deep(.agent-markdown){font-size:14px;line-height:1.9}
.result-document:deep(.markdown-heading){color:var(--agent-text)}
.result-document:deep(.markdown-code){color:var(--agent-text);background:var(--agent-bg);border-color:var(--agent-border);font-size:12px}
.result-document:deep(.markdown-code code){background:transparent;color:inherit}
.result-document:deep(.markdown-quote){color:var(--agent-secondary);background:var(--agent-panel);border-left-color:var(--agent-accent)}
.result-document:deep(.markdown-table-wrap),.result-document:deep(.markdown-table th),.result-document:deep(.markdown-table td){border-color:var(--agent-border)}
.result-document:deep(.markdown-table th){background:var(--agent-panel);color:var(--agent-text)}
.result-document:deep(.markdown-rule){background:var(--agent-border)}
.result-document:deep(a){color:var(--agent-accent)}
.result-document:deep(code){color:var(--agent-accent);background:var(--agent-panel)}
.agent-result-panel:deep(.changed-files){margin:0;padding:0 0 20px;border:0;border-bottom:1px solid var(--agent-border);border-radius:0;background:transparent}
.agent-result-panel:deep(.changed-files header strong){font-size:12px;font-weight:500}
.agent-result-panel:deep(.changed-file-list){max-height:240px;gap:4px}
.agent-result-panel:deep(.changed-file-row){min-height:36px}
.agent-result-panel:deep(.changed-file-open){min-width:0;gap:7px}
.agent-result-panel:deep(.changed-file-open code){font-size:12px;white-space:normal;overflow-wrap:anywhere}
.agent-result-panel:deep(.changed-file-action){width:30px;height:32px}
@media(max-width:1079px){.agent-result-panel{padding:20px 16px}.agent-result-panel:deep(.changed-file-action){width:36px;height:40px}}
</style>
