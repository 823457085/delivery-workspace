<script setup lang="ts">
/**
 * StyleKit Cinematic Video Hero（电影感视频首屏）核心画幅与背景舞台：
 * 1. 海报先行（Poster-First LCP）：AVIF/WebP 静帧立即绘制，零布局抖动；
 * 2. 严格视频契约：<video muted loop playsinline preload="none" aria-hidden="true">，提供 WebM + MP4 双编码源；
 * 3. IntersectionObserver(threshold: 0.25) 仅在 >= 25% 可见时懒加载 load() 并 play()，离开视口或标签页隐藏立即 pause()；
 * 4. prefers-reduced-motion: reduce 或 Save-Data 省流模式下绝不自动拉流播放，静态停留在海报帧；
 * 5. 影黑底幕 #05060a + 暖金单一强调色 #e4c063 + 12px 卡片圆角 + 999px 胶囊控件。
 */
import { Film, Pause, Play } from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useCinematicVideo } from '../theme/cinematicVideo';
import { useTheme } from '../theme/useTheme';

const props = withDefaults(defineProps<{
  mode?: 'backdrop' | 'hero';
  compact?: boolean;
}>(), {
  mode: 'hero',
  compact: false,
});

const { current } = useTheme();
const {
  scenes,
  activeScene,
  loopEnabled,
  manualPlayOverride,
  detectAutoplayBlockedByEnv,
  setScene,
  toggleLoop,
} = useCinematicVideo();

const stageEl = ref<HTMLElement | null>(null);
const videoEl = ref<HTMLVideoElement | null>(null);
const posterDecoded = shallowRef(false);
const videoPlaying = shallowRef(false);
const inViewport = shallowRef(props.mode === 'backdrop');
const loadedSceneKey = shallowRef('');

const active = computed(() => current.value.id === 'cinematic-video-hero');
const envBlocksAutoplay = shallowRef(detectAutoplayBlockedByEnv());
const effectiveCanPlay = computed(() =>
  active.value
  && loopEnabled.value
  && inViewport.value
  && (!envBlocksAutoplay.value || manualPlayOverride.value),
);

let observer: IntersectionObserver | null = null;
let motionMql: MediaQueryList | null = null;

function onPosterReady(event: Event) {
  const img = event.target as HTMLImageElement | null;
  if (!img) { posterDecoded.value = true; return; }
  if (typeof img.decode === 'function') {
    img.decode().catch(() => {}).finally(() => { posterDecoded.value = true; });
  } else {
    posterDecoded.value = true;
  }
}

function syncPlayback() {
  const video = videoEl.value;
  if (!video) return;
  if (!effectiveCanPlay.value || (typeof document !== 'undefined' && document.hidden)) {
    if (!video.paused) video.pause();
    videoPlaying.value = false;
    return;
  }
  const sceneKey = activeScene.value.id;
  if (loadedSceneKey.value !== sceneKey) {
    loadedSceneKey.value = sceneKey;
    video.load();
  }
  const playPromise = video.play();
  if (playPromise && typeof playPromise.then === 'function') {
    playPromise.then(() => { videoPlaying.value = true; }).catch(() => { videoPlaying.value = false; });
  }
}

function bindObserver() {
  observer?.disconnect();
  observer = null;
  const target = stageEl.value;
  if (!target || typeof IntersectionObserver === 'undefined') {
    inViewport.value = true;
    syncPlayback();
    return;
  }
  observer = new IntersectionObserver(
    (entries) => {
      const entry = entries[0];
      if (!entry) return;
      inViewport.value = entry.isIntersecting && entry.intersectionRatio >= 0.25;
      syncPlayback();
    },
    { threshold: [0, 0.25, 0.6] },
  );
  observer.observe(target);
}

function onVisibilityChange() {
  syncPlayback();
}

function onMotionPreferenceChange() {
  envBlocksAutoplay.value = detectAutoplayBlockedByEnv();
  syncPlayback();
}

watch(() => activeScene.value.id, async () => {
  posterDecoded.value = false;
  videoPlaying.value = false;
  loadedSceneKey.value = '';
  await nextTick();
  syncPlayback();
});

watch([active, effectiveCanPlay], async ([isThemeActive]) => {
  await nextTick();
  if (isThemeActive) {
    bindObserver();
    syncPlayback();
  } else {
    observer?.disconnect();
    videoPlaying.value = false;
  }
});

onMounted(() => {
  envBlocksAutoplay.value = detectAutoplayBlockedByEnv();
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    motionMql = window.matchMedia('(prefers-reduced-motion: reduce)');
    motionMql.addEventListener?.('change', onMotionPreferenceChange);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }
  if (active.value) {
    bindObserver();
    syncPlayback();
  }
});

onBeforeUnmount(() => {
  observer?.disconnect();
  motionMql?.removeEventListener?.('change', onMotionPreferenceChange);
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }
});
</script>

<template>
  <!-- 全幅视口电影底幕（仅在 cinematic-video-hero 主题挂载，海报先行 + 静音循环） -->
  <div v-if="mode === 'backdrop' && active" ref="stageEl" class="cv-backdrop" aria-hidden="true">
    <div class="cv-media-frame">
      <img class="cv-lqip" :class="{ 'is-hidden': posterDecoded }" :src="activeScene.lqip" alt="" aria-hidden="true" />
      <picture>
        <source :srcset="activeScene.posterAvif" type="image/avif" />
        <source :srcset="activeScene.posterWebp" type="image/webp" />
        <img
          :key="`poster-${activeScene.id}`"
          class="cv-poster"
          :class="{ 'is-decoded': posterDecoded }"
          :src="activeScene.posterWebp"
          alt=""
          decoding="async"
          fetchpriority="high"
          @load="onPosterReady"
        />
      </picture>
      <video
        ref="videoEl"
        :key="`video-${activeScene.id}`"
        class="cv-video"
        :class="{ 'is-playing': videoPlaying }"
        :poster="activeScene.posterAvif"
        muted
        loop
        playsinline
        preload="none"
        aria-hidden="true"
        @playing="videoPlaying = true"
        @pause="videoPlaying = false"
      >
        <source :src="activeScene.webm" type="video/webm" />
        <source :src="activeScene.mp4" type="video/mp4" />
      </video>
    </div>
    <div class="cv-backdrop-scrim"></div>
  </div>

  <!-- 电影感视频主首屏（12px 卡片圆角、999px 胶囊控制、暖金单一强调色 #e4c063） -->
  <section
    v-else-if="mode === 'hero' && active"
    ref="stageEl"
    class="cv-hero-stage"
    :class="{ 'is-compact': compact }"
    aria-label="电影感视频首屏画幅"
  >
    <div class="cv-media-frame">
      <img class="cv-lqip" :class="{ 'is-hidden': posterDecoded }" :src="activeScene.lqip" alt="" aria-hidden="true" />
      <picture>
        <source :srcset="activeScene.posterAvif" type="image/avif" />
        <source :srcset="activeScene.posterWebp" type="image/webp" />
        <img
          :key="`hero-poster-${activeScene.id}`"
          class="cv-poster"
          :class="{ 'is-decoded': posterDecoded }"
          :src="activeScene.posterWebp"
          :alt="`${activeScene.title} — ${activeScene.subtitle}`"
          decoding="async"
          fetchpriority="high"
          @load="onPosterReady"
        />
      </picture>
      <video
        ref="videoEl"
        :key="`hero-video-${activeScene.id}`"
        class="cv-video"
        :class="{ 'is-playing': videoPlaying }"
        :poster="activeScene.posterAvif"
        muted
        loop
        playsinline
        preload="none"
        aria-hidden="true"
        @playing="videoPlaying = true"
        @pause="videoPlaying = false"
      >
        <source :src="activeScene.webm" type="video/webm" />
        <source :src="activeScene.mp4" type="video/mp4" />
      </video>
    </div>
    <div class="cv-hero-scrim" aria-hidden="true"></div>

    <div class="cv-hero-overlay">
      <div class="cv-hero-top">
        <span class="cv-scene-kicker">
          <i class="cv-reel-dot" :class="{ 'is-live': videoPlaying }"></i>
          {{ activeScene.kicker }}
        </span>

        <div class="cv-scene-controls" role="group" aria-label="切换电影预告幕次与循环播放">
          <button
            v-for="item in scenes"
            :key="item.id"
            type="button"
            class="cv-pill-btn"
            :class="{ active: item.id === activeScene.id }"
            :aria-pressed="item.id === activeScene.id"
            @click="setScene(item.id)"
          >
            <em>{{ item.code }}</em>
            <span>{{ item.title }}</span>
          </button>
          <button
            type="button"
            class="cv-pill-btn cv-playback-btn"
            :class="{ active: loopEnabled && videoPlaying }"
            :aria-pressed="loopEnabled"
            :title="loopEnabled ? '暂停背景循环预告片（保留高清海报帧）' : '播放静音循环预告片'"
            @click="toggleLoop"
          >
            <Pause v-if="loopEnabled" :size="11" />
            <Play v-else :size="11" />
            <span>{{ loopEnabled ? '暂停循环' : '播放预告' }}</span>
          </button>
        </div>
      </div>

      <div class="cv-hero-bottom">
        <div class="cv-hero-copy">
          <slot>
            <h2>{{ activeScene.title }} · {{ activeScene.subtitle }}</h2>
          </slot>
        </div>
        <div class="cv-hero-specs">
          <Film :size="13" />
          <span>{{ activeScene.specs }} · {{ activeScene.duration }}</span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.cv-backdrop {
  position: fixed;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
  background: #05060a;
}

.cv-media-frame {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: #05060a;
}

.cv-lqip,
.cv-poster,
.cv-video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center 46%;
}

.cv-lqip {
  filter: blur(20px);
  transform: scale(1.08);
  opacity: 1;
  transition: opacity 520ms cubic-bezier(0.22, 1, 0.36, 1);
}
.cv-lqip.is-hidden {
  opacity: 0;
}

.cv-poster {
  opacity: 0;
  transition: opacity 520ms cubic-bezier(0.22, 1, 0.36, 1);
}
.cv-poster.is-decoded {
  opacity: 1;
}

/* 海报帧与第 0 帧像素级对齐，起播时柔和叠化无闪烁 */
.cv-video {
  opacity: 0;
  transition: opacity 420ms ease;
  pointer-events: none;
}
.cv-video.is-playing {
  opacity: 1;
}

.cv-backdrop-scrim {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(125% 92% at 50% 20%, rgb(5 6 10 / 0.10) 0%, rgb(5 6 10 / 0.42) 76%, rgb(5 6 10 / 0.62) 100%),
    linear-gradient(180deg, rgb(5 6 10 / 0.28) 0%, rgb(5 6 10 / 0.16) 42%, rgb(5 6 10 / 0.56) 100%);
}

/* StyleKit Cinematic Video Hero 几何契约：卡片 12px 圆角 + 0 20px 50px rgba(0,0,0,0.45) 阴影 */
.cv-hero-stage {
  position: relative;
  width: 100%;
  aspect-ratio: 21 / 8;
  min-height: 204px;
  max-height: 276px;
  border-radius: 12px;
  border: 1px solid rgb(255 255 255 / 0.16);
  background: #05060a;
  overflow: hidden;
  box-shadow: 0 20px 50px rgb(0 0 0 / 0.45);
}
.cv-hero-stage.is-compact {
  aspect-ratio: 24 / 7;
  min-height: 176px;
  max-height: 232px;
}

.cv-hero-scrim {
  position: absolute;
  inset: 0;
  background:
    linear-gradient(180deg, rgb(5 6 10 / 0.58) 0%, rgb(5 6 10 / 0.18) 42%, rgb(5 6 10 / 0.88) 100%),
    linear-gradient(90deg, rgb(5 6 10 / 0.68) 0%, transparent 68%);
  pointer-events: none;
}

.cv-hero-overlay {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  box-sizing: border-box;
  height: 100%;
  padding: 16px 22px 18px;
  color: #f3efe8;
}

.cv-hero-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 12px;
}

/* StyleKit 场景标签规范：11px / weight 500 / letter-spacing 0.16em / uppercase / #e4c063 */
.cv-scene-kicker {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font: 500 11px/16px 'Inter', -apple-system, 'Helvetica Neue', sans-serif;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: #e4c063;
  text-shadow: 0 1px 10px rgb(5 6 10 / 0.82);
}

.cv-reel-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: #9aa6b8;
  transition: background-color 200ms ease, box-shadow 200ms ease;
}
.cv-reel-dot.is-live {
  background: #e4c063;
  box-shadow: 0 0 10px rgb(228 192 99 / 0.72);
}

.cv-scene-controls {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

/* StyleKit 幽灵胶囊按钮规范：999px + rgba(255,255,255,0.10) + blur(12px) + 1px solid rgba(255,255,255,0.24) */
.cv-pill-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 12px;
  border: 1px solid rgb(255 255 255 / 0.24);
  border-radius: 999px;
  background: rgb(255 255 255 / 0.10);
  backdrop-filter: blur(12px);
  color: #f3efe8;
  font: 500 11.5px/16px 'Inter', -apple-system, sans-serif;
  cursor: pointer;
  transition: background-color 180ms ease, border-color 180ms ease, color 180ms ease, box-shadow 180ms ease, transform 140ms ease;
}
.cv-pill-btn em {
  font: 500 10.5px/1 var(--ds-code, monospace);
  font-style: normal;
  color: #9aa6b8;
}
.cv-pill-btn:hover {
  background: rgb(255 255 255 / 0.16);
  border-color: rgb(228 192 99 / 0.58);
}
.cv-pill-btn:active {
  transform: scale(0.98);
}
/* 主行动暖金胶囊：#e4c063 + 0 8px 24px rgba(228,192,99,0.28) */
.cv-pill-btn.active {
  background: #e4c063;
  border-color: #e4c063;
  color: #05060a;
  font-weight: 600;
  box-shadow: 0 8px 24px rgb(228 192 99 / 0.28);
}
.cv-pill-btn.active:hover {
  background: #efce78;
  border-color: #efce78;
}
.cv-pill-btn.active em {
  color: #05060a;
}

.cv-hero-bottom {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px 20px;
}

.cv-hero-copy {
  min-width: 0;
  max-width: 680px;
}
/* StyleKit Display 排版：weight 500, letter-spacing -0.02em, #f3efe8 */
.cv-hero-copy :deep(h1),
.cv-hero-copy :deep(h2) {
  margin: 0;
  font: 500 clamp(24px, 2.5vw, 34px)/1.12 'Inter', -apple-system, 'Helvetica Neue', 'PingFang SC', sans-serif;
  letter-spacing: -0.02em;
  color: #f3efe8 !important;
  background: none !important;
  -webkit-text-fill-color: #f3efe8 !important;
  text-shadow: 0 2px 20px rgb(5 6 10 / 0.82);
  transform: none !important;
}
.cv-hero-copy :deep(em) {
  color: #e4c063 !important;
  -webkit-text-fill-color: #e4c063 !important;
  font-style: normal;
}
.cv-hero-copy :deep(p) {
  margin: 6px 0 0;
  font: 400 13px/1.6 'Inter', -apple-system, 'PingFang SC', sans-serif;
  color: #d7dce5;
  text-shadow: 0 1px 12px rgb(5 6 10 / 0.86);
}

.cv-hero-specs {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 11px;
  border-radius: 999px;
  border: 1px solid rgb(255 255 255 / 0.18);
  background: rgb(5 6 10 / 0.56);
  backdrop-filter: blur(12px);
  color: #9aa6b8;
  font: 500 10.5px/15px var(--ds-code, monospace);
  letter-spacing: 0.06em;
  white-space: nowrap;
}
.cv-hero-specs svg {
  color: #e4c063;
  flex-shrink: 0;
}

@media (prefers-reduced-motion: reduce) {
  .cv-lqip,
  .cv-poster,
  .cv-video,
  .cv-pill-btn {
    transition: none;
  }
}

@media (max-width: 760px) {
  .cv-hero-stage {
    aspect-ratio: 16 / 9;
    min-height: 190px;
  }
  .cv-hero-overlay {
    padding: 12px 14px;
  }
  .cv-playback-btn > span,
  .cv-hero-specs {
    display: none;
  }
}
</style>
