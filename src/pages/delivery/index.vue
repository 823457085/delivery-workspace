<script setup lang="ts">import AutoDelivery from '../../features/auto-delivery/AutoDelivery.vue'; defineProps<{ mode: string }>();</script>
<template><AutoDelivery :mode="mode" /></template>
