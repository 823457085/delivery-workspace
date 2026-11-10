<script setup lang="ts">
import { reloadWorkspacePage, useWorkspaceVersion } from './useWorkspaceVersion';
import WorkspaceRestartButton from './WorkspaceRestartButton.vue';

const { query, state, loaded } = useWorkspaceVersion();
function dateTime(value?: string) { return value ? new Date(value).toLocaleString() : '未取得'; }
</script>

<template>
  <el-popover trigger="click" :width="360" placement="bottom-end">
    <template #reference><el-button text size="small" :type="state.refreshRequired || state.restartRequired || state.buildRequired ? 'warning' : 'info'" aria-label="查看工作台版本">{{ state.label }}</el-button></template>
    <el-descriptions title="工作台版本" :column="1" size="small">
      <el-descriptions-item label="当前页面">{{ loaded.id.slice(0, 8) }} · {{ dateTime(loaded.builtAt) }}</el-descriptions-item>
      <el-descriptions-item label="最新构建">{{ query.data.value?.frontend?.id.slice(0, 8) || '未取得' }} · {{ dateTime(query.data.value?.frontend?.builtAt) }}</el-descriptions-item>
      <el-descriptions-item label="运行后端">{{ query.data.value?.backend.sourceHash.slice(0, 12) || '未取得' }}</el-descriptions-item>
      <el-descriptions-item label="后端启动">{{ dateTime(query.data.value?.backend.startedAt) }}</el-descriptions-item>
      <el-descriptions-item label="核验状态">{{ query.error.value?.message || state.label }}</el-descriptions-item>
    </el-descriptions>
    <el-button size="small" :loading="query.isFetching.value" @click="query.refetch()">检查版本</el-button>
    <WorkspaceRestartButton v-if="state.restartRequired || state.buildRequired" />
    <p v-if="state.buildRequired && query.data.value?.buildError">{{ query.data.value.buildError }}</p>
    <el-button v-if="state.status === 'refresh-required'" size="small" type="primary" @click="reloadWorkspacePage">保存草稿后刷新</el-button>
  </el-popover>
</template>
