<script setup lang="ts">
import PluginCenter from './PluginCenter.vue';
const emit = defineEmits<{ changed: [] }>();
</script>
<template><PluginCenter @changed="emit('changed')" /></template>
