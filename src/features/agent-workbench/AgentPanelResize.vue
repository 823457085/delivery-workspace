<script setup lang="ts">
/**
 * 左右侧栏共用的拖动边界：只调整宽度并保存本机偏好，不参与会话状态。
 * 使用原生指针捕获而非全局鼠标监听，拖出边界或松手后也能正确结束。
 */
import { onMounted, shallowRef } from 'vue';

const props = defineProps<{ side: 'left' | 'right' }>();
const width = defineModel<number>({ required: true });
const active = shallowRef(false);
const min = props.side === 'left' ? 240 : 280;
const max = props.side === 'left' ? 480 : 560;
const storageKey = `delivery.agent.panel-width.${props.side}`;
let startX = 0;
let startWidth = 0;

onMounted(() => {
  try {
    const saved = Number(localStorage.getItem(storageKey));
    if (Number.isFinite(saved) && saved >= min && saved <= max) width.value = saved;
  } catch { /* 无法持久化时仍可拖动。 */ }
});

function measuredWidth(element: HTMLElement) {
  const columns = getComputedStyle(element.parentElement!).gridTemplateColumns.split(' ');
  return Number.parseFloat(props.side === 'left' ? columns[0]! : columns.at(-1)!);
}

function resize(value: number) {
  width.value = Math.round(Math.max(min, Math.min(max, window.innerWidth * .28, value)));
}

function save() {
  try { localStorage.setItem(storageKey, String(width.value)); } catch { /* 保留当前宽度。 */ }
}

function start(event: PointerEvent) {
  if (event.button !== 0) return;
  const handle = event.currentTarget as HTMLElement;
  startX = event.clientX;
  startWidth = measuredWidth(handle);
  handle.setPointerCapture(event.pointerId);
  active.value = true;
  event.preventDefault();
}

function move(event: PointerEvent) {
  if (!active.value) return;
  resize(startWidth + (event.clientX - startX) * (props.side === 'left' ? 1 : -1));
}

function finish() {
  if (!active.value) return;
  active.value = false;
  save();
}

function keydown(event: KeyboardEvent) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const direction = (event.key === 'ArrowRight' ? 1 : -1) * (props.side === 'left' ? 1 : -1);
  resize(measuredWidth(event.currentTarget as HTMLElement) + direction * 16);
  save();
}
</script>

<template>
  <div class="panel-resize" :class="[side, { active }]" role="separator" tabindex="0"
    aria-orientation="vertical" :aria-label="side === 'left' ? '调整会话列表宽度' : '调整记录面板宽度'"
    :aria-valuemin="min" :aria-valuemax="max" :aria-valuenow="width"
    @pointerdown="start" @pointermove="move" @pointerup="finish" @pointercancel="finish" @lostpointercapture="finish" @keydown="keydown" />
</template>

<style scoped>
.panel-resize{grid-row:1;position:relative;z-index:5;width:8px;min-height:0;cursor:col-resize;touch-action:none;user-select:none;outline:none}
.panel-resize.left{grid-column:1;justify-self:end;margin-right:-4px}
.panel-resize.right{grid-column:3;justify-self:start;margin-left:-4px}
.panel-resize::after{position:absolute;content:"";inset:0 3px;background:transparent;transition:background .12s}
.panel-resize:hover::after,.panel-resize:focus-visible::after,.panel-resize.active::after{background:var(--agent-accent)}
</style>
