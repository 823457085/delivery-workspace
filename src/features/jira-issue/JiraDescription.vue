<script setup lang="ts">
import {computed} from 'vue';
import AgentMarkdown from '../agent-workbench/AgentMarkdown.vue';
import {safeJiraHtml,jiraWikiMarkdown} from './jira-description';
const props=defineProps<{html?:string;text?:string;baseUrl?:string}>();
const rendered=computed(()=>props.html?safeJiraHtml(props.html,props.baseUrl):'');
const markdown=computed(()=>jiraWikiMarkdown(props.text||''));
</script>
<template><div class="jira-description"><div v-if="rendered" v-html="rendered"></div><AgentMarkdown v-else-if="text" :source="markdown"/><p v-else class="no-description">暂无描述</p></div></template>
<style scoped>
.jira-description { color:var(--ui-text);font-size:14px;line-height:1.85;overflow-wrap:anywhere;min-width:0; }
.jira-description :deep(p) { margin:0 0 12px;white-space:pre-wrap; }
.jira-description :deep(h1),.jira-description :deep(h2),.jira-description :deep(h3),.jira-description :deep(h4) { color:var(--ui-text);margin:24px 0 12px;line-height:1.5;font-weight:600; }
.jira-description :deep(h1) {font-size:21px}.jira-description :deep(h2){font-size:18px}.jira-description :deep(h3){font-size:16px}
.jira-description :deep(ul),.jira-description :deep(ol){padding-left:24px}.jira-description :deep(li){margin:5px 0}
.jira-description :deep(a){color:var(--ui-accent);text-decoration:underline;text-underline-offset:3px}
.jira-description :deep(table){width:100%;border-collapse:collapse;display:block;overflow-x:auto;margin:14px 0}
.jira-description :deep(th),.jira-description :deep(td){padding:9px 12px;border:1px solid var(--ui-border);text-align:left;min-width:100px}
.jira-description :deep(th){background:var(--ui-raised)}.jira-description :deep(pre){padding:14px;background:var(--ui-raised);border-radius:8px;overflow:auto;color:var(--ui-text);font-size:12px}
.jira-description :deep(code){background:var(--ui-raised);color:var(--ui-text)}.jira-description :deep(blockquote){margin:12px 0;padding:4px 14px;border-left:3px solid var(--ui-border);color:var(--ui-secondary)}
.jira-description :deep(.agent-markdown){font-size:14px;color:inherit}.no-description{color:var(--ui-muted)}
</style>
