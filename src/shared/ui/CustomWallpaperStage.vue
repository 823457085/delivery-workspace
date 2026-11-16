<script setup lang="ts">
/**
 * 随心配色（Custom Wallpaper）全视口底幕舞台组件：
 * 直接通过响应式 <img> 渲染本地上传 / 剪贴板 / 拖拽 / 流光极光壁纸，
 * 避免跨样式表 CSS 变量 url("blob:...") 在 WebKit / Chromium 中的解析与重绘异常，
 * 并通过 @error 即时捕获浏览器不支持的图片编码（例如部分浏览器的原始 HEIC）。
 */
import { ElMessage } from 'element-plus';
import { computed, shallowRef, watch } from 'vue';
import { useTheme } from '../theme/useTheme';

const { current, customTheme, wallpaperUrl } = useTheme();
const loadFailedUrl = shallowRef('');

watch(wallpaperUrl, () => {
  loadFailedUrl.value = '';
});

const active = computed(() =>
  current.value.id === 'custom'
  && Boolean(wallpaperUrl.value)
  && loadFailedUrl.value !== wallpaperUrl.value,
);

const mediaStyle = computed(() => {
  const blurPx = Math.max(0, customTheme.value.blur || 0);
  const brightnessPct = customTheme.value.brightness || 100;
  const scale = blurPx > 0 ? (1 + Math.min(0.14, blurPx * 0.005)).toFixed(3) : '1';
  return {
    objectPosition: `center ${customTheme.value.position || 'center'}`,
    filter: `blur(${blurPx}px) brightness(${brightnessPct}%)`,
    transform: `scale(${scale})`,
  };
});

const scrimStyle = computed(() => {
  const topShade = Math.min(0.88, Math.max(0.10, (customTheme.value.overlay || 42) / 100));
  const bottomShade = Math.min(0.92, topShade + 0.10);
  return {
    background: `linear-gradient(180deg, rgb(0 0 0 / ${topShade.toFixed(2)}) 0%, rgb(0 0 0 / ${bottomShade.toFixed(2)}) 100%)`,
  };
});

function onImageError() {
  if (!wallpaperUrl.value || loadFailedUrl.value === wallpaperUrl.value) return;
  loadFailedUrl.value = wallpaperUrl.value;
  ElMessage.warning('当前浏览器无法直接解码该图片格式（如 HEIC），请改用 PNG / JPG / WebP 图片');
}
</script>

<template>
  <div v-if="active" class="cw-backdrop" aria-hidden="true">
    <img
      :key="wallpaperUrl"
      class="cw-photo"
      :src="wallpaperUrl"
      alt=""
      decoding="async"
      :style="mediaStyle"
      @error="onImageError"
    />
    <div class="cw-backdrop-scrim" :style="scrimStyle"></div>
  </div>
</template>

<style scoped>
.cw-backdrop {
  position: fixed;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
  background-color: var(--ui-bg, #101521);
}

.cw-photo {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  will-change: transform, filter;
}

.cw-backdrop-scrim {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
</style>
