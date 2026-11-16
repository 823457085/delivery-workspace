<script setup lang="ts">
/**
 * 壁纸时钟屏保预览层（Ambient Wallpaper Showcase）
 * 借鉴 GitHub 开源新标签工作台 joelshepherd/tabliss 与 victrme/Bonjourr：
 * 一键隐去五区业务面板，全屏呈现当前摄影画幅 / 电影动态视频 / 自定义极光壁纸，叠加磨砂玻璃数字时钟与本机 Agent 运行脉搏。
 */
import { computed, defineAsyncComponent, onBeforeUnmount, shallowRef, watch } from 'vue';
import { RefreshCw, Sparkles, Sun, X } from '@lucide/vue';
import { workspaceAttentionCount, workspaceRunningCount } from '../../features/agent-workbench/useAgentCompletionNotify';
import { useCinematicVideo } from '../theme/cinematicVideo';
import { useImmersivePhoto } from '../theme/immersivePhoto';
import { useTheme } from '../theme/useTheme';
import { formatAmbientClock, useZenFocus } from './zenFocus';

const ImmersivePhotoStage = defineAsyncComponent(() => import('./ImmersivePhotoStage.vue'));
const CinematicVideoStage = defineAsyncComponent(() => import('./CinematicVideoStage.vue'));

const props = defineProps<{
  localPort: string;
}>();

const { ambientShowcaseOpen, closeAmbientShowcase } = useZenFocus();
const { current: currentTheme, customTheme, wallpaperUrl, cycleActiveWallpaper, applyRandomAuroraWallpaper } = useTheme();
const { activeFrame, daylightEnabled: photoDaylight, toggleDaylight: togglePhotoDaylight } = useImmersivePhoto();
const { activeScene, daylightEnabled: videoDaylight, toggleDaylight: toggleVideoDaylight } = useCinematicVideo();

const clock = shallowRef(formatAmbientClock(new Date()));
let clockTimer: number | null = null;

function refreshClock() {
  clock.value = formatAmbientClock(new Date());
}

function onKeydown(event: KeyboardEvent) {
  if (!ambientShowcaseOpen.value) return;
  if (event.key === 'Escape' || event.key === ' ') {
    event.preventDefault();
    closeAmbientShowcase();
  }
}

watch(ambientShowcaseOpen, (isOpen) => {
  if (isOpen) {
    refreshClock();
    clockTimer = window.setInterval(refreshClock, 1000);
    window.addEventListener('keydown', onKeydown);
  } else {
    if (clockTimer !== null) {
      window.clearInterval(clockTimer);
      clockTimer = null;
    }
    window.removeEventListener('keydown', onKeydown);
  }
}, { immediate: true });

onBeforeUnmount(() => {
  if (clockTimer !== null) window.clearInterval(clockTimer);
  window.removeEventListener('keydown', onKeydown);
});

const captionLabel = computed(() => {
  if (currentTheme.value.id === 'cinematic-video-hero') {
    return `${activeScene.value.title} · ${activeScene.value.subtitle}`;
  }
  if (currentTheme.value.id === 'custom' && wallpaperUrl.value) {
    return customTheme.value.wallpaperName || '随心配色自定义壁纸';
  }
  return `${activeFrame.value.title} · ${activeFrame.value.subtitle}`;
});

const daylightActive = computed(() =>
  currentTheme.value.id === 'cinematic-video-hero' ? videoDaylight.value : photoDaylight.value,
);

function toggleShowcaseDaylight() {
  if (currentTheme.value.id === 'cinematic-video-hero') toggleVideoDaylight();
  else togglePhotoDaylight();
}
</script>

<template>
  <Teleport to="body">
    <Transition name="ambient-fade">
      <div
        v-if="ambientShowcaseOpen"
        class="ambient-showcase"
        role="dialog"
        aria-modal="true"
        aria-label="壁纸时钟屏保预览"
        @click.self="closeAmbientShowcase"
      >
        <CinematicVideoStage v-if="currentTheme.id === 'cinematic-video-hero'" mode="backdrop" />
        <div
          v-else-if="currentTheme.id === 'custom' && wallpaperUrl"
          class="ambient-custom-backdrop"
          aria-hidden="true"
          :style="{
            backgroundImage: `linear-gradient(180deg, rgb(6 8 14 / 0.28), rgb(6 8 14 / 0.62)), url('${wallpaperUrl}')`,
            backgroundPosition: `center, ${customTheme.position}`,
            filter: `blur(${customTheme.blur}px) brightness(${customTheme.brightness}%)`,
          }"
        />
        <ImmersivePhotoStage v-else mode="backdrop" />

        <div class="ambient-center" @click.self="closeAmbientShowcase">
          <p class="ambient-greeting">{{ clock.greeting }} · {{ clock.dateLine }}</p>
          <div class="ambient-time" aria-live="off">
            <strong>{{ clock.time }}</strong>
            <small>{{ clock.seconds }}</small>
          </div>
          <div class="ambient-status-pill">
            <span class="ambient-dot" :class="{ busy: workspaceRunningCount > 0 }" />
            <span>研发交付工作台 :{{ props.localPort }}</span>
            <template v-if="workspaceRunningCount > 0">
              <i aria-hidden="true">·</i>
              <em>{{ workspaceRunningCount }} 个任务执行中</em>
            </template>
            <template v-if="workspaceAttentionCount > 0">
              <i aria-hidden="true">·</i>
              <em class="warn">{{ workspaceAttentionCount }} 项待确认</em>
            </template>
          </div>
        </div>

        <footer class="ambient-dock">
          <span class="ambient-caption">{{ captionLabel }}</span>
          <div class="ambient-actions">
            <button type="button" class="ambient-btn" title="切换下一张壁纸或画幅" @click="cycleActiveWallpaper()">
              <RefreshCw :size="13" />
              <span>换一张壁纸</span>
            </button>
            <button type="button" class="ambient-btn" title="随机生成高清流光极光壁纸" @click="applyRandomAuroraWallpaper()">
              <Sparkles :size="13" />
              <span>随机流光</span>
            </button>
            <button
              v-if="currentTheme.id === 'immersive-photo' || currentTheme.id === 'cinematic-video-hero'"
              type="button"
              class="ambient-btn"
              :class="{ active: daylightActive }"
              @click="toggleShowcaseDaylight"
            >
              <Sun :size="13" />
              <span>{{ daylightActive ? '昼夜流转已开' : '昼夜流转' }}</span>
            </button>
            <button type="button" class="ambient-btn close" aria-label="退出壁纸屏保" @click="closeAmbientShowcase">
              <X :size="13" />
              <span>退出屏保 (ESC)</span>
            </button>
          </div>
        </footer>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.ambient-showcase {
  position: fixed;
  inset: 0;
  z-index: 3400;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: clamp(24px, 4vw, 48px);
  background: #07090e;
  color: #f6f7fb;
  user-select: none;
  overflow: hidden;
}

.ambient-custom-backdrop {
  position: absolute;
  inset: -36px;
  z-index: 0;
  background-size: auto, cover;
  background-repeat: no-repeat;
  pointer-events: none;
}

.ambient-center {
  position: relative;
  z-index: 2;
  margin: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 10px;
}

.ambient-greeting {
  margin: 0;
  font: 500 15px/22px var(--sans);
  letter-spacing: 0.06em;
  color: rgb(246 247 251 / 0.84);
  text-shadow: 0 2px 16px rgb(0 0 0 / 0.45);
}

.ambient-time {
  display: inline-flex;
  align-items: baseline;
  gap: 10px;
  text-shadow: 0 8px 36px rgb(0 0 0 / 0.52);
}

.ambient-time strong {
  font: 600 clamp(68px, 11vw, 124px)/1 var(--mono);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.04em;
  color: #fff;
}

.ambient-time small {
  font: 500 clamp(22px, 3vw, 34px)/1 var(--mono);
  font-variant-numeric: tabular-nums;
  color: rgb(255 255 255 / 0.68);
}

.ambient-status-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 6px 14px;
  border: 1px solid rgb(255 255 255 / 0.18);
  border-radius: 999px;
  background: rgb(12 15 22 / 0.52);
  backdrop-filter: blur(18px) saturate(130%);
  -webkit-backdrop-filter: blur(18px) saturate(130%);
  font: 500 12.5px/18px var(--sans);
  color: rgb(246 247 251 / 0.9);
}

.ambient-status-pill i {
  opacity: 0.45;
  font-style: normal;
}

.ambient-status-pill em {
  font-style: normal;
  color: #4fd898;
}

.ambient-status-pill em.warn {
  color: #f2b45a;
}

.ambient-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #4fd898;
  box-shadow: 0 0 10px rgb(79 216 152 / 0.7);
}

.ambient-dot.busy {
  background: #60a5fa;
  box-shadow: 0 0 12px rgb(96 165 250 / 0.9);
}

.ambient-dock {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
  padding: 10px 16px;
  border: 1px solid rgb(255 255 255 / 0.16);
  border-radius: 14px;
  background: rgb(10 13 20 / 0.56);
  backdrop-filter: blur(20px) saturate(130%);
  -webkit-backdrop-filter: blur(20px) saturate(130%);
}

.ambient-caption {
  font: 450 12.5px/18px var(--sans);
  color: rgb(246 247 251 / 0.82);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ambient-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.ambient-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  border: 1px solid rgb(255 255 255 / 0.18);
  border-radius: 999px;
  background: rgb(255 255 255 / 0.08);
  color: #fff;
  font: 500 12px/1 var(--sans);
  cursor: pointer;
  transition: background 160ms ease, border-color 160ms ease;
}

.ambient-btn:hover {
  background: rgb(255 255 255 / 0.16);
  border-color: rgb(255 255 255 / 0.34);
}

.ambient-btn.active {
  border-color: #f2b45a;
  color: #f2b45a;
}

.ambient-btn.close {
  background: rgb(255 255 255 / 0.14);
}

.ambient-fade-enter-active,
.ambient-fade-leave-active {
  transition: opacity 220ms cubic-bezier(0.22, 1, 0.36, 1);
}

.ambient-fade-enter-from,
.ambient-fade-leave-to {
  opacity: 0;
}
</style>
