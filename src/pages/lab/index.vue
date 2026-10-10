<script setup lang="ts">import DeliveryWorkspace from '../../features/delivery-workflow/DeliveryWorkspace.vue';</script>
<template><DeliveryWorkspace /><RouterLink class="return-to-hub" to="/overview">返回完整工作空间</RouterLink></template>
<style scoped>.return-to-hub{position:fixed;bottom:70px;left:18px;z-index:20;background:var(--ui-success-bg);color:var(--ui-success);border-radius:6px;padding:9px 12px;font-size:12px}</style>
