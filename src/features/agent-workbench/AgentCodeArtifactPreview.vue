<script setup lang="ts">
/**
 * 设计说明：沙盒化渲染 AI 输出的 HTML 网页原型或 SVG 图形。
 * 按需异步挂载；iframe 仅开放 `allow-scripts`（SVG 甚至无需脚本），严禁 `allow-same-origin`。
 */
import { computed, shallowRef } from 'vue';
import { Download, Maximize2, Minimize2, RotateCw } from '@lucide/vue';
import { buildArtifactSandboxSrcdoc, type PreviewableArtifactKind } from './markdown-artifact-preview';

const props = defineProps<{
  kind: PreviewableArtifactKind;
  source: string;
}>();

const tall = shallowRef(false);
const reloadSeed = shallowRef(0);

const srcdoc = computed(() => buildArtifactSandboxSrcdoc(props.kind, props.source));
const sandboxPolicy = computed(() => (props.kind === 'html' ? 'allow-scripts' : ''));

function reloadPreview() {
  reloadSeed.value += 1;
}

function downloadArtifact() {
  const ext = props.kind === 'svg' ? 'svg' : 'html';
  const mime = props.kind === 'svg' ? 'image/svg+xml;charset=utf-8' : 'text/html;charset=utf-8';
  const blob = new Blob([props.source], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `ai-preview-${Date.now().toString(36)}.${ext}`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
</script>

<template>
  <div class="artifact-preview" :class="{ 'is-tall': tall }">
    <div class="artifact-preview-toolbar">
      <span class="artifact-preview-hint">
        {{ kind === 'svg' ? 'SVG 图形实时预览（安全隔离沙盒）' : 'HTML 页面实时预览（安全隔离沙盒）' }}
      </span>
      <div class="artifact-preview-actions">
        <button type="button" class="artifact-btn" title="重新加载预览" @click="reloadPreview">
          <RotateCw :size="11" /><span>刷新</span>
        </button>
        <button type="button" class="artifact-btn" :title="tall ? '收起预览高度' : '加高预览区域'" @click="tall = !tall">
          <Minimize2 v-if="tall" :size="11" /><Maximize2 v-else :size="11" />
          <span>{{ tall ? '紧凑' : '加高' }}</span>
        </button>
        <button type="button" class="artifact-btn" :title="`下载 .${kind} 文件`" @click="downloadArtifact">
          <Download :size="11" /><span>下载</span>
        </button>
      </div>
    </div>
    <iframe
      :key="reloadSeed"
      class="artifact-preview-frame"
      :title="kind === 'svg' ? 'SVG 图形预览' : 'HTML 页面预览'"
      :sandbox="sandboxPolicy"
      referrerpolicy="no-referrer"
      :srcdoc="srcdoc"
    />
  </div>
</template>

<style scoped>
.artifact-preview{display:flex;flex-direction:column;background:#fff}
.artifact-preview-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 10px;border-bottom:1px solid var(--ui-border);background:color-mix(in srgb,var(--ui-raised) 82%,var(--ui-surface));color:var(--ui-muted);font-size:11px}
.artifact-preview-hint{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.artifact-preview-actions{display:inline-flex;align-items:center;gap:4px;flex-shrink:0}
.artifact-btn{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 7px;border:1px solid var(--ui-border);border-radius:4px;background:var(--ui-surface);color:var(--ui-secondary);font:500 11px/1 var(--sans);cursor:pointer;transition:border-color 140ms ease,color 140ms ease}
.artifact-btn:hover{border-color:var(--ui-accent);color:var(--ui-accent)}
.artifact-preview-frame{display:block;width:100%;height:280px;border:0;background:#fff;transition:height 180ms ease}
.artifact-preview.is-tall .artifact-preview-frame{height:520px}
</style>
