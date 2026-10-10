<script setup lang="ts">import CatchupWorkspace from '../../features/catchup/CatchupWorkspace.vue'; defineProps<{ mode: string }>();</script>
<template><CatchupWorkspace :mode="mode" /></template>
