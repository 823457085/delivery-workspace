<script setup lang="ts">
// 两个版本提示入口复用同一按钮与查询缓存，避免重复点击和各自维护重启进度。
import { useWorkspaceRestart } from './useWorkspaceRestart';

const { busy, label, progress, restart } = useWorkspaceRestart();
</script>

<template>
  <p v-if="progress" role="status">{{ progress }}</p>
  <el-button size="small" type="primary" :loading="busy && !progress" :disabled="busy" @click="restart">{{ label }}</el-button>
</template>
