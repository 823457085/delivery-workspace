<script setup lang="ts">
import { onMounted, ref } from 'vue';
const props = defineProps<{ title: string; busy?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const panel = ref<HTMLDialogElement>();
function close() { if (!props.busy) emit('close'); }
onMounted(() => panel.value?.showModal());
function backdrop(event: MouseEvent) {
  if (event.target !== panel.value) return;
  const rect = panel.value.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
}
</script>
<template>
  <dialog ref="panel" class="plugin-panel" :aria-label="title" @cancel.prevent="close" @click="backdrop">
    <header class="panel-header"><h2>{{ title }}</h2><button :disabled="busy" aria-label="关闭面板" @click="close">关闭</button></header>
    <div class="panel-body"><slot /></div>
  </dialog>
</template>
