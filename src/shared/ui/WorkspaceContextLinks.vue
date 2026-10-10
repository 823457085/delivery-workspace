<script setup lang="ts">
/** 业务详情共享导航契约；只带入明确的 Jira、路径和会话 ID，不推断关联、不自动执行。 */
import { computed, inject } from 'vue';
import { agentWorkspaceContext } from '../agent-workspace-context';
const props = defineProps<{ issueKey?: string; workspacePath?: string; threadId?: string; prompt?: string }>();
const workspace = inject(agentWorkspaceContext, undefined);
const threadUrl = computed(() => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(props.threadId || '') ? `codex://threads/${props.threadId}` : undefined);
</script>
<template><div class="inline-links">
  <RouterLink v-if="issueKey" :to="{ path: '/tasks/list', query: { q: issueKey } }" class="hub-link">查看任务</RouterLink>
  <RouterLink v-if="workspacePath" :to="{ path: '/projects', query: { q: workspacePath } }" class="hub-link">查看项目</RouterLink>
  <a v-if="threadUrl" :href="threadUrl" class="hub-link">打开原会话</a>
  <el-button v-if="workspace && prompt" link type="primary" @click="workspace.compose(prompt)">带入会话</el-button>
</div></template>
