<script setup lang="ts">
/**
 * 面板共用的拖动边界：只调整宽度并保存本机偏好，不参与会话状态。
 * 使用原生指针捕获而非全局鼠标监听，拖出边界或松手后也能正确结束。
 */
import { nextTick, onMounted, shallowRef } from 'vue';

const props = defineProps<{ side: 'left' | 'right'; variant?: string }>();
const width = defineModel<number>({ required: true });
const active = shallowRef(false);
const chatSplit = props.variant === 'side-chat';
const min = chatSplit ? 20 : props.variant === 'split' ? props.side === 'left' ? 200 : 320 : ['studio', 'project-studio'].includes(props.variant || '') ? props.side === 'left' ? 220 : 260 : props.side === 'left' ? 240 : 280;
const max = chatSplit ? 80 : props.variant === 'split' ? props.side === 'left' ? 280 : 680 : props.side === 'left' ? 480 : 560;
const storageKey = `delivery.agent.panel-width.${props.side}${props.variant ? `.${props.variant}` : ''}`;
let startX = 0;
let drag: ReturnType<typeof measure> | undefined;

onMounted(() => {
  try {
    const saved = Number(localStorage.getItem(storageKey));
    if (Number.isFinite(saved) && saved >= min && saved <= max) width.value = saved;
  } catch { /* 无法持久化时仍可拖动。 */ }
});

function measure(element: HTMLElement) {
  const style = getComputedStyle(element.parentElement!);
  const columns = style.gridTemplateColumns.split(' ').map(Number.parseFloat);
  const pixels = props.side === 'left' ? columns[0]! : columns.at(-1)!;
  if (chatSplit) {
    // 按两个会话实际占用的宽度换算比例，排除会话列表和列间距。
    const scale = 100 / (columns[1]! + columns[2]!);
    const paneMin = Number.parseFloat(style.getPropertyValue('--chat-pane-min-width'));
    const minimum = Math.min(50, Math.max(min, paneMin * scale));
    return { pixels, scale, minimum, maximum: 100 - minimum };
  }
  return { pixels, scale: 1, minimum: min,
    maximum: Math.min(max, window.innerWidth * (props.variant === 'split' && props.side === 'right' ? .4 : .28)) };
}

function resize(pixels: number, { scale, minimum, maximum }: ReturnType<typeof measure>) {
  const value = Math.max(minimum, Math.min(maximum, pixels * scale));
  if (Number.isFinite(value)) width.value = chatSplit ? Number(value.toFixed(2)) : Math.round(value);
}

function save() {
  try { localStorage.setItem(storageKey, String(width.value)); } catch { /* 保留当前宽度。 */ }
}

function start(event: PointerEvent) {
  if (event.button !== 0) return;
  const handle = event.currentTarget as HTMLElement;
  startX = event.clientX;
  drag = measure(handle);
  handle.setPointerCapture(event.pointerId);
  active.value = true;
  event.preventDefault();
}

function move(event: PointerEvent) {
  if (!active.value || !drag) return;
  resize(drag.pixels + (event.clientX - startX) * (props.side === 'left' ? 1 : -1), drag);
}

function finish() {
  if (!active.value) return;
  active.value = false;
  drag = undefined;
  save();
}

function keydown(event: KeyboardEvent) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const direction = (event.key === 'ArrowRight' ? 1 : -1) * (props.side === 'left' ? 1 : -1);
  const layout = measure(event.currentTarget as HTMLElement);
  resize(layout.pixels + direction * 16, layout);
  void nextTick(save);
}
</script>

<template>
  <div class="panel-resize" :class="[side, { active, 'chat-divider': chatSplit }]" role="separator" tabindex="0"
    aria-orientation="vertical" :aria-label="chatSplit ? '调整侧边会话宽度' : side === 'left' ? '调整会话列表宽度' : variant === 'split' ? '调整成果面板宽度' : '调整记录面板宽度'"
    :aria-valuemin="min" :aria-valuemax="max" :aria-valuenow="width"
    @pointerdown="start" @pointermove="move" @pointerup="finish" @pointercancel="finish" @lostpointercapture="finish" @keydown="keydown" />
</template>

<style scoped>
.panel-resize{grid-row:1;position:relative;z-index:5;width:8px;min-height:0;cursor:col-resize;touch-action:none;user-select:none;outline:none}
.panel-resize.left{grid-column:1;justify-self:end;margin-right:-4px}
.panel-resize.right{grid-column:3;justify-self:start;margin-left:0}
.panel-resize::after{position:absolute;content:"";inset:0 3px;background:transparent;transition:background .12s}
.panel-resize.chat-divider{width:14px;margin-left:-7px}
.panel-resize.chat-divider::after{inset-inline:6px}
.panel-resize.chat-divider:not(:hover):not(:focus-visible):not(.active)::after{inset-block:calc(50% - 16px);border-radius:2px;background:var(--agent-muted)}
.panel-resize:hover::after,.panel-resize:focus-visible::after,.panel-resize.active::after{background:var(--agent-accent)}
</style>
