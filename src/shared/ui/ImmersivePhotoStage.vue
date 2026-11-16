<script setup lang="ts">
/**
 * StyleKit Immersive Photo（摄影即界面）核心视口与画幅组件：
 * 1. 显式 aspect-ratio 容器防止 CLS；
 * 2. <picture> 双格式 AVIF + WebP 分发；
 * 3. 24px LQIP 模糊占位先行，真图解码后柔和渐显；
 * 4. 仅使用 transform 的 18s Ken Burns 缓慢推拉，严格遵守 prefers-reduced-motion；
 * 5. 墨黑渐变可读遮罩（Scrim）保障文字 >= 4.5:1 对比度。
 */
import { Camera, Pause, Play } from '@lucide/vue';
import { shallowRef, watch } from 'vue';
import { useImmersivePhoto } from '../theme/immersivePhoto';
import { useTheme } from '../theme/useTheme';

const props = withDefaults(defineProps<{
  mode?: 'backdrop' | 'hero';
  compact?: boolean;
}>(), {
  mode: 'hero',
  compact: false,
});

const { current } = useTheme();
const { frames, activeFrame, kenBurnsEnabled, setFrame, toggleKenBurns } = useImmersivePhoto();
const decoded = shallowRef(false);

watch(() => activeFrame.value.id, () => {
  decoded.value = false;
});

function onImageReady(event: Event) {
  const img = event.target as HTMLImageElement | null;
  if (!img) { decoded.value = true; return; }
  if (typeof img.decode === 'function') {
    img.decode().catch(() => {}).finally(() => { decoded.value = true; });
  } else {
    decoded.value = true;
  }
}
</script>

<template>
  <!-- 全幅视口摄影底幕（仅在沉浸摄影主题挂载） -->
  <div v-if="mode === 'backdrop' && current.id === 'immersive-photo'" class="ip-backdrop" aria-hidden="true">
    <div class="ip-media-frame" :class="{ 'is-kenburns': kenBurnsEnabled }">
      <img class="ip-lqip" :class="{ 'is-hidden': decoded }" :src="activeFrame.lqip" alt="" aria-hidden="true" />
      <picture>
        <source :srcset="activeFrame.avif" type="image/avif" />
        <source :srcset="activeFrame.webp" type="image/webp" />
        <img
          :key="activeFrame.id"
          class="ip-photo"
          :class="{ 'is-decoded': decoded }"
          :src="activeFrame.webp"
          alt=""
          decoding="async"
          fetchpriority="high"
          @load="onImageReady"
        />
      </picture>
    </div>
    <div class="ip-backdrop-scrim"></div>
  </div>

  <!-- 显式画幅摄影主舞台（图是主角，文字压在可读遮罩上浮起） -->
  <section
    v-else-if="mode === 'hero' && current.id === 'immersive-photo'"
    class="ip-hero-stage"
    :class="{ 'is-compact': compact }"
    aria-label="沉浸摄影主画幅"
  >
    <div class="ip-media-frame" :class="{ 'is-kenburns': kenBurnsEnabled }">
      <img class="ip-lqip" :class="{ 'is-hidden': decoded }" :src="activeFrame.lqip" alt="" aria-hidden="true" />
      <picture>
        <source :srcset="activeFrame.avif" type="image/avif" />
        <source :srcset="activeFrame.webp" type="image/webp" />
        <img
          :key="activeFrame.id"
          class="ip-photo"
          :class="{ 'is-decoded': decoded }"
          :src="activeFrame.webp"
          :alt="`${activeFrame.title} — ${activeFrame.subtitle}`"
          decoding="async"
          fetchpriority="high"
          @load="onImageReady"
        />
      </picture>
    </div>
    <div class="ip-hero-scrim" aria-hidden="true"></div>

    <div class="ip-hero-overlay">
      <div class="ip-hero-top">
        <span class="ip-series-kicker">{{ activeFrame.kicker }}</span>
        <div class="ip-frame-controls" role="group" aria-label="切换摄影胶片与镜头动效">
          <button
            v-for="item in frames"
            :key="item.id"
            type="button"
            class="ip-pill-btn"
            :class="{ active: item.id === activeFrame.id }"
            :aria-pressed="item.id === activeFrame.id"
            @click="setFrame(item.id)"
          >
            <em>{{ item.code }}</em>
            <span>{{ item.title }}</span>
          </button>
          <button
            type="button"
            class="ip-pill-btn ip-motion-btn"
            :class="{ active: kenBurnsEnabled }"
            :aria-pressed="kenBurnsEnabled"
            :title="kenBurnsEnabled ? '暂停 Ken Burns 缓慢推拉' : '开启 Ken Burns 缓慢推拉'"
            @click="toggleKenBurns"
          >
            <Pause v-if="kenBurnsEnabled" :size="11" />
            <Play v-else :size="11" />
            <span>呼吸镜头</span>
          </button>
        </div>
      </div>

      <div class="ip-hero-bottom">
        <div class="ip-hero-copy">
          <slot>
            <h2>{{ activeFrame.title }} · {{ activeFrame.subtitle }}</h2>
          </slot>
        </div>
        <div class="ip-hero-exif">
          <Camera :size="13" />
          <span>{{ activeFrame.title }} · {{ activeFrame.meta }}</span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.ip-backdrop {
  position: fixed;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
  background: #0c0d10;
}

.ip-media-frame {
  position: absolute;
  inset: 0;
  overflow: hidden;
  transform-origin: center center;
}

.ip-lqip,
.ip-photo {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center 42%;
}

.ip-lqip {
  filter: blur(18px);
  transform: scale(1.08);
  opacity: 1;
  transition: opacity 650ms cubic-bezier(0.22, 1, 0.36, 1);
}
.ip-lqip.is-hidden {
  opacity: 0;
}

.ip-photo {
  opacity: 0;
  transition: opacity 620ms cubic-bezier(0.22, 1, 0.36, 1);
}
.ip-photo.is-decoded {
  opacity: 1;
}

@keyframes ip-kenburns-drift {
  0% { transform: scale(1) translate3d(0, 0, 0); }
  100% { transform: scale(1.09) translate3d(-1.6%, -1.1%, 0); }
}

.ip-media-frame.is-kenburns {
  will-change: transform;
  animation: ip-kenburns-drift 18s ease-in-out infinite alternate;
}

.ip-backdrop-scrim {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(125% 95% at 50% 24%, rgb(12 13 16 / 0.08) 0%, rgb(12 13 16 / 0.38) 78%, rgb(12 13 16 / 0.58) 100%),
    linear-gradient(180deg, rgb(12 13 16 / 0.24) 0%, rgb(12 13 16 / 0.14) 42%, rgb(12 13 16 / 0.52) 100%);
}

/* 显式画幅主舞台：16px 圆角卡片、严控 aspect-ratio 防布局抖动 */
.ip-hero-stage {
  position: relative;
  width: 100%;
  aspect-ratio: 21 / 8;
  min-height: 204px;
  max-height: 276px;
  border-radius: 16px;
  border: 1px solid rgb(255 255 255 / 0.16);
  background: #0c0d10;
  overflow: hidden;
  box-shadow: 0 22px 48px -18px rgb(0 0 0 / 0.72);
}
.ip-hero-stage.is-compact {
  aspect-ratio: 24 / 7;
  min-height: 176px;
  max-height: 232px;
}

.ip-hero-scrim {
  position: absolute;
  inset: 0;
  background:
    linear-gradient(180deg, rgb(12 13 16 / 0.52) 0%, rgb(12 13 16 / 0.14) 44%, rgb(12 13 16 / 0.86) 100%),
    linear-gradient(90deg, rgb(12 13 16 / 0.58) 0%, transparent 65%);
  pointer-events: none;
}

.ip-hero-overlay {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  box-sizing: border-box;
  height: 100%;
  padding: 16px 22px 18px;
  color: #f4f1ea;
}

.ip-hero-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 12px;
}

.ip-series-kicker {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font: 600 11px/16px 'Inter', -apple-system, sans-serif;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: #e8b04b;
  text-shadow: 0 1px 8px rgb(12 13 16 / 0.75);
}

.ip-frame-controls {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.ip-pill-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 11px;
  border: 1px solid rgb(255 255 255 / 0.18);
  border-radius: 999px;
  background: rgb(12 13 16 / 0.52);
  backdrop-filter: blur(12px);
  color: #f4f1ea;
  font: 500 11.5px/16px 'Inter', -apple-system, sans-serif;
  cursor: pointer;
  transition: background-color 180ms ease, border-color 180ms ease, color 180ms ease, box-shadow 180ms ease;
}
.ip-pill-btn em {
  font: 600 10.5px/1 var(--ds-code, monospace);
  font-style: normal;
  color: #b8bcc4;
}
.ip-pill-btn:hover {
  background: rgb(26 28 34 / 0.74);
  border-color: rgb(232 176 75 / 0.55);
}
.ip-pill-btn.active {
  background: #e8b04b;
  border-color: #e8b04b;
  color: #0c0d10;
  font-weight: 600;
  box-shadow: 0 6px 18px rgb(232 176 75 / 0.32);
}
.ip-pill-btn.active em {
  color: #0c0d10;
}

.ip-hero-bottom {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px 20px;
}

.ip-hero-copy {
  min-width: 0;
  max-width: 680px;
}
.ip-hero-copy :deep(h1),
.ip-hero-copy :deep(h2) {
  margin: 0;
  font: 600 clamp(24px, 2.5vw, 34px)/1.16 'Inter', -apple-system, 'PingFang SC', sans-serif;
  letter-spacing: -0.022em;
  color: #f4f1ea !important;
  background: none !important;
  -webkit-text-fill-color: #f4f1ea !important;
  text-shadow: 0 2px 18px rgb(12 13 16 / 0.72);
  transform: none !important;
}
.ip-hero-copy :deep(em) {
  color: #e8b04b !important;
  -webkit-text-fill-color: #e8b04b !important;
  font-style: normal;
}
.ip-hero-copy :deep(p) {
  margin: 6px 0 0;
  font: 400 13px/19px 'Inter', -apple-system, 'PingFang SC', sans-serif;
  color: #dcdfe6;
  text-shadow: 0 1px 10px rgb(12 13 16 / 0.8);
}

.ip-hero-exif {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid rgb(255 255 255 / 0.14);
  background: rgb(12 13 16 / 0.48);
  backdrop-filter: blur(10px);
  color: #b8bcc4;
  font: 500 11px/15px var(--ds-code, monospace);
  letter-spacing: 0.03em;
  white-space: nowrap;
}
.ip-hero-exif svg {
  color: #e8b04b;
  flex-shrink: 0;
}

@media (prefers-reduced-motion: reduce) {
  .ip-media-frame.is-kenburns {
    animation: none !important;
    will-change: auto;
  }
  .ip-lqip,
  .ip-photo {
    transition: none;
  }
}

@media (max-width: 760px) {
  .ip-hero-stage {
    aspect-ratio: 16 / 9;
    min-height: 190px;
  }
  .ip-hero-overlay {
    padding: 12px 14px;
  }
  .ip-motion-btn > span,
  .ip-hero-exif {
    display: none;
  }
}
</style>
