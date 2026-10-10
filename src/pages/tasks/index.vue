<script setup lang="ts">import TaskWorkspace from '../../features/task-calendar/TaskWorkspace.vue'; defineProps<{ mode: string }>();</script>
<template><TaskWorkspace :mode="mode" /></template>
