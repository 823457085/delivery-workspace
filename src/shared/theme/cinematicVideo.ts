/**
 * StyleKit Cinematic Video Hero（电影感视频首屏）共享预告片幕次与播放偏好。
 * 遵循海报先行（AVIF/WebP LCP）、双编码静音循环源（WebM VP9 + MP4 H.264）、
 * prefers-reduced-motion 与 Save-Data 省流静态降级契约。
 */
import { computed, readonly, shallowRef } from 'vue';
import { resolveDaylightWallpaperSlot } from './wallpaperEngine';

export interface CinematicVideoScene {
  id: 'aurora-fjord' | 'neon-rain' | 'orbital-horizon';
  code: string;
  kicker: string;
  title: string;
  subtitle: string;
  specs: string;
  duration: string;
  posterAvif: string;
  posterWebp: string;
  webm: string;
  mp4: string;
  lqip: string;
}

export const CINEMATIC_VIDEO_SCENES: readonly CinematicVideoScene[] = [
  {
    id: 'aurora-fjord',
    code: '01',
    kicker: 'SCENE 01 · AURORA FJORD',
    title: '极光峡湾',
    subtitle: '暗夜玄武岩雪峰与暖金极光静谧倒影',
    specs: '2.39:1 ANAMORPHIC · 24FPS · MUTED LOOP',
    duration: '00:06',
    posterAvif: '/themes/cinematic-video-hero/aurora-fjord.avif',
    posterWebp: '/themes/cinematic-video-hero/aurora-fjord.webp',
    webm: '/themes/cinematic-video-hero/aurora-fjord.webm',
    mp4: '/themes/cinematic-video-hero/aurora-fjord.mp4',
    lqip: 'data:image/webp;base64,UklGRqACAABXRUJQVlA4WAoAAAAgAAAAFwAADQAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDggsgAAALAEAJ0BKhgADgA+oUCaSKYjoqEwCADAFAljAJ0ygANQXQGwBaj/fnrNGF5GuQAA/var/qKGNXsBzgdyN5RuQO8YTig5qU+M2Zoe30oeOwky7G4rhCC30c9t2WFoigMnH6D2eH94p3iQbREWoBNsDbbwQYPqMqQSdPlE6hSyOMNTnVmTPFHGyi45Eqkfm94HDDemsK7IO2vR7QMN0HJzi7IcIX4MDUVfHqIPV+KHaUQAAAA=',
  },
  {
    id: 'neon-rain',
    code: '02',
    kicker: 'SCENE 02 · NOCTURNE RAIN',
    title: '暗夜雨幕',
    subtitle: '高层雨滴玻璃幕墙与午夜暖金车流散景',
    specs: '35MM T1.4 · LOW-KEY NOIR · MUTED LOOP',
    duration: '00:06',
    posterAvif: '/themes/cinematic-video-hero/neon-rain.avif',
    posterWebp: '/themes/cinematic-video-hero/neon-rain.webp',
    webm: '/themes/cinematic-video-hero/neon-rain.webm',
    mp4: '/themes/cinematic-video-hero/neon-rain.mp4',
    lqip: 'data:image/webp;base64,UklGRrQCAABXRUJQVlA4WAoAAAAgAAAAFwAADQAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDggxgAAALAEAJ0BKhgADgA+oUCaSKYjoqEwCADAFAljAJ0gcCC+3QAuhN6O6I6FeFTpbEAA/vfHLRH/MBwnWVmkP9clxxppuS8imyGh+SE7bbTPujcagilUS+tCfdQdYLT4g+DK7IC+MaC97DUNQjzi0XXzPfhfRISKKOj7GE1Mhtp+56orA1YH+6bo/GHzrn67RVVfkkCAH0/1+bJ+NGLn2THUc0Tdi4dhX1eD7pZxBFf/RLeO76Bctt0dKCKJ+gr6kakRxGITUiAAAA==',
  },
  {
    id: 'orbital-horizon',
    code: '03',
    kicker: 'SCENE 03 · ORBITAL DAWN',
    title: '星轨晨昏',
    subtitle: '近地轨道深空星海与金色晨昏线弧光',
    specs: '65MM IMAX · ORBITAL TELEMETRY · MUTED LOOP',
    duration: '00:06',
    posterAvif: '/themes/cinematic-video-hero/orbital-horizon.avif',
    posterWebp: '/themes/cinematic-video-hero/orbital-horizon.webp',
    webm: '/themes/cinematic-video-hero/orbital-horizon.webm',
    mp4: '/themes/cinematic-video-hero/orbital-horizon.mp4',
    lqip: 'data:image/webp;base64,UklGRoICAABXRUJQVlA4WAoAAAAgAAAAFwAADQAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDgglAAAAJAEAJ0BKhgADgA+oUCbSKYjoqEwCADAFAljAC7/7IAAx0JkC/9zAf3fJWFfAAD++mRYHFNVT5mpzlQh2pC0IEupjOlzRqbLMUOdGM4yyz3yBdrDhcSaviMwI9aZSJyqTQyvs29J7ZTzp/6PUCiv8QXSWcr6PQ2uUenk/zWJAKHJ3L4Xse29vurcnosd19eDmG/gAAA=',
  },
] as const;

const SCENE_STORAGE_KEY = 'delivery-workspace.cinematic-scene.v1';
const LOOP_STORAGE_KEY = 'delivery-workspace.cinematic-loop.v1';
const DAYLIGHT_STORAGE_KEY = 'delivery-workspace.cinematic-daylight.v1';

function detectAutoplayBlockedByEnv(): boolean {
  if (typeof window === 'undefined') return false;
  const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const nav = navigator as Navigator & { connection?: { saveData?: boolean } };
  const saveData = Boolean(nav.connection?.saveData);
  return reduced || saveData;
}

function readStoredScene(): CinematicVideoScene['id'] {
  try {
    const raw = window.localStorage.getItem(SCENE_STORAGE_KEY);
    if (CINEMATIC_VIDEO_SCENES.some(item => item.id === raw)) return raw as CinematicVideoScene['id'];
  } catch { /* ignore */ }
  return 'aurora-fjord';
}

function readStoredLoop(): boolean {
  if (detectAutoplayBlockedByEnv()) return false;
  try {
    return window.localStorage.getItem(LOOP_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

function readStoredDaylight(): boolean {
  try {
    return window.localStorage.getItem(DAYLIGHT_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

const activeSceneId = shallowRef<CinematicVideoScene['id']>(typeof window !== 'undefined' ? readStoredScene() : 'aurora-fjord');
const loopEnabled = shallowRef<boolean>(typeof window !== 'undefined' ? readStoredLoop() : true);
const manualPlayOverride = shallowRef<boolean>(false);
const daylightEnabled = shallowRef<boolean>(typeof window !== 'undefined' ? readStoredDaylight() : false);
const daylightSlot = shallowRef(resolveDaylightWallpaperSlot());
let daylightTimer: number | null = null;

function syncDaylightScene() {
  const slot = resolveDaylightWallpaperSlot();
  daylightSlot.value = slot;
  if (!daylightEnabled.value) return slot;
  if (activeSceneId.value !== slot.videoSceneId) {
    activeSceneId.value = slot.videoSceneId;
    try { window.localStorage.setItem(SCENE_STORAGE_KEY, slot.videoSceneId); } catch { /* ignore */ }
  }
  return slot;
}

function ensureDaylightWatcher() {
  if (typeof window === 'undefined') return;
  if (daylightEnabled.value) {
    syncDaylightScene();
    if (daylightTimer === null) {
      daylightTimer = window.setInterval(syncDaylightScene, 5 * 60_000);
      window.addEventListener('visibilitychange', syncDaylightScene);
    }
  } else if (daylightTimer !== null) {
    window.clearInterval(daylightTimer);
    daylightTimer = null;
    window.removeEventListener('visibilitychange', syncDaylightScene);
  }
}

if (typeof window !== 'undefined' && daylightEnabled.value) {
  ensureDaylightWatcher();
}

export function useCinematicVideo() {
  const activeScene = computed(() => CINEMATIC_VIDEO_SCENES.find(item => item.id === activeSceneId.value) || CINEMATIC_VIDEO_SCENES[0]);

  function setScene(id: CinematicVideoScene['id']) {
    if (!CINEMATIC_VIDEO_SCENES.some(item => item.id === id)) return;
    if (daylightEnabled.value) {
      daylightEnabled.value = false;
      try { window.localStorage.setItem(DAYLIGHT_STORAGE_KEY, '0'); } catch { /* ignore */ }
      ensureDaylightWatcher();
    }
    activeSceneId.value = id;
    try { window.localStorage.setItem(SCENE_STORAGE_KEY, id); } catch { /* ignore */ }
  }

  function cycleScene() {
    const idx = CINEMATIC_VIDEO_SCENES.findIndex(item => item.id === activeSceneId.value);
    const next = CINEMATIC_VIDEO_SCENES[(idx + 1) % CINEMATIC_VIDEO_SCENES.length];
    setScene(next.id);
  }

  function toggleLoop() {
    const next = !loopEnabled.value;
    loopEnabled.value = next;
    manualPlayOverride.value = next;
    try { window.localStorage.setItem(LOOP_STORAGE_KEY, next ? '1' : '0'); } catch { /* ignore */ }
  }

  function toggleDaylight(force?: boolean) {
    daylightEnabled.value = typeof force === 'boolean' ? force : !daylightEnabled.value;
    try { window.localStorage.setItem(DAYLIGHT_STORAGE_KEY, daylightEnabled.value ? '1' : '0'); } catch { /* ignore */ }
    ensureDaylightWatcher();
  }

  return {
    scenes: CINEMATIC_VIDEO_SCENES,
    activeSceneId: readonly(activeSceneId),
    activeScene,
    loopEnabled: readonly(loopEnabled),
    manualPlayOverride: readonly(manualPlayOverride),
    daylightEnabled: readonly(daylightEnabled),
    daylightSlot: readonly(daylightSlot),
    detectAutoplayBlockedByEnv,
    setScene,
    cycleScene,
    toggleLoop,
    toggleDaylight,
    syncDaylightScene,
  };
}
