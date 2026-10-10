<script setup lang="ts">
/** Page 仅承接需求开发入口，运行详情回到 Agent，不挂载旧版方案流程。 */
import { useRouter } from 'vue-router';
import RequirementDevelopment from '../../features/requirement-development/RequirementDevelopment.vue';
const router = useRouter();
</script>
<template><RequirementDevelopment @open-run="id => router.push({ path: '/agent', query: { run: id } })" /></template>
