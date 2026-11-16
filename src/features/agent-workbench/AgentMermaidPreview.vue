<script setup lang="ts">
/**
 * 设计说明：安全渲染零依赖 Mermaid-Lite 流程图与时序图。
 * 产出的 SVG 通过 `data:image/svg+xml;charset=utf-8,...` 传入 `<img>` 展示，
 * 浏览器原生禁止 `<img>` 内任何脚本或外部网络请求执行，且完全不使用 `v-html`。
 */
import { computed, shallowRef } from 'vue';
import { Download, RotateCcw, ZoomIn, ZoomOut } from '@lucide/vue';
import { renderMermaidLiteSvg, svgToDataUri } from './mermaid-lite-svg';

const props = defineProps<{
  source: string;
}>();

const zoom = shallowRef(100);
const rendered = computed(() => renderMermaidLiteSvg(props.source));
const dataUri = computed(() => (rendered.value ? svgToDataUri(rendered.value.svg) : ''));

const kindLabel = computed(() => {
  if (!rendered.value) return '图表';
  return rendered.value.kind === 'sequence'
    ? `时序图 · ${rendered.value.nodeCount} 个角色 · ${rendered.value.edgeCount} 步交互`
    : `流程图 · ${rendered.value.nodeCount} 个节点 · ${rendered.value.edgeCount} 条连线`;
});

const scaledWidth = computed(() => {
  if (!rendered.value) return undefined;
  return `${Math.round((rendered.value.width * zoom.value) / 100)}px`;
});

function zoomOut() {
  zoom.value = Math.max(60, zoom.value - 20);
}

function zoomIn() {
  zoom.value = Math.min(200, zoom.value + 20);
}

function resetZoom() {
  zoom.value = 100;
}

function downloadSvg() {
  if (!rendered.value) return;
  const blob = new Blob([rendered.value.svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `ai-${rendered.value.kind}-${Date.now().toString(36)}.svg`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
</script>

<template>
  <div v-if="rendered" class="mermaid-preview-shell">
    <div class="mermaid-preview-toolbar">
      <span class="mermaid-meta">{{ kindLabel }}</span>
      <div class="mermaid-actions">
        <button type="button" class="mermaid-btn" :disabled="zoom <= 60" title="缩小图表" @click="zoomOut">
          <ZoomOut :size="11" />
        </button>
        <button type="button" class="mermaid-btn mermaid-zoom-label" title="点击恢复 100% 比例" @click="resetZoom">
          <span>{{ zoom }}%</span>
          <RotateCcw v-if="zoom !== 100" :size="10" />
        </button>
        <button type="button" class="mermaid-btn" :disabled="zoom >= 200" title="放大图表" @click="zoomIn">
          <ZoomIn :size="11" />
        </button>
        <button type="button" class="mermaid-btn" title="下载高清矢量 SVG 图表" @click="downloadSvg">
          <Download :size="11" />
          <span>保存 SVG</span>
        </button>
      </div>
    </div>
    <div class="mermaid-canvas">
      <img
        class="mermaid-image"
        :src="dataUri"
        :style="{ width: scaledWidth }"
        :alt="kindLabel"
      />
    </div>
  </div>
</template>

<style scoped>
.mermaid-preview-shell {
  border-top: 1px solid color-mix(in srgb, var(--ui-border) 72%, transparent);
  background: #f8fafc;
}

.mermaid-preview-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--ui-border) 68%, transparent);
  background: var(--ui-surface);
}

.mermaid-meta {
  color: var(--ui-muted);
  font: 500 11px/1.2 var(--sans);
}

.mermaid-actions {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.mermaid-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 21px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--ui-secondary);
  font: 500 11px/1 var(--sans);
  cursor: pointer;
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
}

.mermaid-btn:hover:not(:disabled) {
  border-color: var(--ui-border);
  background: var(--ui-raised);
  color: var(--ui-text);
}

.mermaid-btn:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}

.mermaid-zoom-label {
  font-family: var(--mono);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}

.mermaid-canvas {
  max-height: 440px;
  padding: 10px;
  overflow: auto;
  text-align: center;
  background: #f8fafc;
}

.mermaid-image {
  display: inline-block;
  max-width: none;
  height: auto;
  vertical-align: middle;
}
</style>
