<script setup lang="ts">
import { computed, inject } from 'vue';
import { agentWorkspaceContext } from '../../shared/agent-workspace-context';
import { forIssue, workbenchPath } from './domain';
import { useWorkbench } from './useWorkbench';
import DeliveryRecords from './DeliveryRecords.vue';
const props = defineProps<{ issueKey: string }>();
const agentWorkspace = inject(agentWorkspaceContext, undefined);
const { records, errors, loading } = useWorkbench();
const linked = computed(() => forIssue(records.value, props.issueKey));
</script>
<template><section class="detail-section"><div class="inline-links"><h3>关联会话与交付结果</h3><RouterLink v-if="!agentWorkspace" :to="workbenchPath(issueKey)" class="hub-link">在工作台查看</RouterLink><el-button v-if="agentWorkspace" link type="primary" @click="agentWorkspace.compose(`@Jira:${issueKey} 请检查该需求的当前实现范围、风险和下一步，先只读分析。`)">带入会话</el-button></div><DeliveryRecords :records="linked" :errors="errors" :loading="loading" /></section></template>
