<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { isMenuIconUrl } from '../../shared/workspace-navigation';
import { workspaceMenuIcons, menuIcons } from './menu-icons';
const props = withDefaults(defineProps<{ name?: string; size?: number }>(), { name: 'grid', size: 16 });
const failed = ref(false);
const external = computed(() => isMenuIconUrl(props.name));
watch(() => props.name, () => { failed.value = false; });
</script>
<template>
  <img v-if="external && !failed" :key="name" :src="name" :width="size" :height="size" class="workspace-menu-image" alt="" aria-hidden="true" referrerpolicy="no-referrer" decoding="async" draggable="false" @error="failed = true">
  <component :is="workspaceMenuIcons[name] || menuIcons.grid" v-else :size="size" aria-hidden="true" />
</template>
<style scoped>
.workspace-menu-image{display:inline-block;flex:none;object-fit:contain;border-radius:3px;vertical-align:middle}
</style>
