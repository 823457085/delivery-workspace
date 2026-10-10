<script setup lang="ts">
/** 只管理面板滚动恢复。异步数据撑开内容后恢复位置，不缓存业务组件及其轮询。 */
import { onBeforeUnmount, onMounted, useTemplateRef } from 'vue';
import { useWorkspacePanelState } from '../useWorkspacePanelState';
const props = defineProps<{ viewId: string }>();
const { scrollTop } = useWorkspacePanelState(`scroll:${props.viewId}`, () => ({ scrollTop: 0 }));
const viewport = useTemplateRef<HTMLElement>('viewport');
const content = useTemplateRef<HTMLElement>('content');
let observer: ResizeObserver | undefined;
let restoring = true;
function restore() {
  const element = viewport.value;
  if (!element || !restoring) return;
  element.scrollTop = scrollTop.value;
  if (Math.abs(element.scrollTop - scrollTop.value) < 1) { restoring = false; observer?.disconnect(); }
}
function record() { if (!restoring && viewport.value) scrollTop.value = viewport.value.scrollTop; }
function interact() { restoring = false; observer?.disconnect(); record(); }
onMounted(() => {
  observer = new ResizeObserver(restore);
  if (content.value) observer.observe(content.value);
  restore();
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template><div ref="viewport" class="workspace-panel-content" @scroll="record" @wheel.passive="interact" @pointerdown="interact" @keydown="interact"><div ref="content"><slot /></div></div></template>

<style scoped>
.workspace-panel-content{flex:1;min-height:0;overflow:auto;padding:20px}
.workspace-panel-content:deep(.automation-panel){height:auto;max-width:960px;margin:0 auto;padding:20px;border-radius:10px}
</style>
