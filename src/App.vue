<script setup lang="ts">
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import { useWorkspaceVersionNotice } from './shared/version/useWorkspaceVersion';
useWorkspaceVersionNotice();
</script>
<template><el-config-provider :locale="zhCn"><RouterView /></el-config-provider></template>
