/**
 * StyleKit Immersive Photo（沉浸摄影）共享胶片帧与呼吸镜头偏好。
 * 纯前端展示状态：包含双格式 AVIF/WebP 路径、24x14 WebP 内联模糊占位（LQIP）及摄影参数元数据。
 */
import { computed, readonly, shallowRef } from 'vue';
import { resolveDaylightWallpaperSlot } from './wallpaperEngine';

export interface ImmersivePhotoFrame {
  id: 'dawn-ridge' | 'fog-forest' | 'dusk-coast';
  code: string;
  kicker: string;
  title: string;
  subtitle: string;
  meta: string;
  avif: string;
  webp: string;
  lqip: string;
}

export const IMMERSIVE_PHOTO_FRAMES: readonly ImmersivePhotoFrame[] = [
  {
    id: 'dawn-ridge',
    code: '01',
    kicker: 'SERIES 01 · DAWN RIDGE',
    title: '破晓山脊',
    subtitle: '远山云海与第一束暖金晨光',
    meta: '36°14′N · 50mm f/2.8 · ISO 100',
    avif: '/themes/immersive-photo/dawn-ridge.avif',
    webp: '/themes/immersive-photo/dawn-ridge.webp',
    lqip: 'data:image/webp;base64,UklGRoAAAABXRUJQVlA4IHQAAABwBACdASoYAA4APt1cqE0opSQiMAgBEBuJZQCdMoS9CF/wGz2m486y1AlwAAD+5CGp05S5/fAEumlqFH+nnlxzJ+aHopOfLoMZHFXoWJhFpNEzixArSxB1SHr2uRv5qfGriVtwV8KeCTdF9NTNUVg5MEgAAA==',
  },
  {
    id: 'fog-forest',
    code: '02',
    kicker: 'SERIES 02 · MIST FOREST',
    title: '雾林晨光',
    subtitle: '冷杉山谷薄雾与柔和侧逆光',
    meta: '47°36′N · 85mm f/4.0 · ISO 200',
    avif: '/themes/immersive-photo/fog-forest.avif',
    webp: '/themes/immersive-photo/fog-forest.webp',
    lqip: 'data:image/webp;base64,UklGRoIAAABXRUJQVlA4IHYAAABQBACdASoYAA4APt1cp0yopSOiMAgBEBuJZwC/c/7AwMSR5VdcaLj8988AAP7VFFDW+1iPRkRz+QA07bZa/F3v+MEGog6g5IAUQX/tY92exrtPWpOIRaufHz6j6ztYypyvZja73Nxh6DtEnezusaIa5K3WgoAA',
  },
  {
    id: 'dusk-coast',
    code: '03',
    kicker: 'SERIES 03 · DUSK COAST',
    title: '暮色海岸',
    subtitle: '蓝调时刻长曝光礁石与天际余晖',
    meta: '63°25′N · 24mm f/8.0 · 30s',
    avif: '/themes/immersive-photo/dusk-coast.avif',
    webp: '/themes/immersive-photo/dusk-coast.webp',
    lqip: 'data:image/webp;base64,UklGRnQAAABXRUJQVlA4IGgAAAAQBACdASoYAA4APt1cp0yopSOiMAgBEBuJYwCdMoADTMTeepbdojYJgAD+8MyQq1WSk0ayvcVA9G6TsOIM2/6DOmB+t2ThPSCePNb9uzeowIVMfc4rXjYNSk9bw+R+T6J07FLtR00AAA==',
  },
] as const;

const FRAME_STORAGE_KEY = 'delivery-workspace.immersive-frame.v1';
const MOTION_STORAGE_KEY = 'delivery-workspace.immersive-motion.v1';
const DAYLIGHT_STORAGE_KEY = 'delivery-workspace.immersive-daylight.v1';

function readStoredFrame(): ImmersivePhotoFrame['id'] {
  try {
    const raw = window.localStorage.getItem(FRAME_STORAGE_KEY);
    if (IMMERSIVE_PHOTO_FRAMES.some(item => item.id === raw)) return raw as ImmersivePhotoFrame['id'];
  } catch { /* ignore */ }
  return 'dawn-ridge';
}

function readStoredMotion(): boolean {
  try {
    return window.localStorage.getItem(MOTION_STORAGE_KEY) !== '0';
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

const activeFrameId = shallowRef<ImmersivePhotoFrame['id']>(typeof window !== 'undefined' ? readStoredFrame() : 'dawn-ridge');
const kenBurnsEnabled = shallowRef<boolean>(typeof window !== 'undefined' ? readStoredMotion() : true);
const daylightEnabled = shallowRef<boolean>(typeof window !== 'undefined' ? readStoredDaylight() : false);
const daylightSlot = shallowRef(resolveDaylightWallpaperSlot());
let daylightTimer: number | null = null;

function syncDaylightFrame() {
  const slot = resolveDaylightWallpaperSlot();
  daylightSlot.value = slot;
  if (!daylightEnabled.value) return slot;
  if (activeFrameId.value !== slot.photoFrameId) {
    activeFrameId.value = slot.photoFrameId;
    try { window.localStorage.setItem(FRAME_STORAGE_KEY, slot.photoFrameId); } catch { /* ignore */ }
  }
  return slot;
}

function ensureDaylightWatcher() {
  if (typeof window === 'undefined') return;
  if (daylightEnabled.value) {
    syncDaylightFrame();
    if (daylightTimer === null) {
      daylightTimer = window.setInterval(syncDaylightFrame, 5 * 60_000);
      window.addEventListener('visibilitychange', syncDaylightFrame);
    }
  } else if (daylightTimer !== null) {
    window.clearInterval(daylightTimer);
    daylightTimer = null;
    window.removeEventListener('visibilitychange', syncDaylightFrame);
  }
}

if (typeof window !== 'undefined' && daylightEnabled.value) {
  ensureDaylightWatcher();
}

export function useImmersivePhoto() {
  const activeFrame = computed(() => IMMERSIVE_PHOTO_FRAMES.find(item => item.id === activeFrameId.value) || IMMERSIVE_PHOTO_FRAMES[0]);

  function setFrame(id: ImmersivePhotoFrame['id']) {
    if (!IMMERSIVE_PHOTO_FRAMES.some(item => item.id === id)) return;
    if (daylightEnabled.value) {
      daylightEnabled.value = false;
      try { window.localStorage.setItem(DAYLIGHT_STORAGE_KEY, '0'); } catch { /* ignore */ }
      ensureDaylightWatcher();
    }
    activeFrameId.value = id;
    try { window.localStorage.setItem(FRAME_STORAGE_KEY, id); } catch { /* ignore */ }
  }

  function cycleFrame() {
    const idx = IMMERSIVE_PHOTO_FRAMES.findIndex(item => item.id === activeFrameId.value);
    const next = IMMERSIVE_PHOTO_FRAMES[(idx + 1) % IMMERSIVE_PHOTO_FRAMES.length];
    setFrame(next.id);
  }

  function toggleKenBurns() {
    kenBurnsEnabled.value = !kenBurnsEnabled.value;
    try { window.localStorage.setItem(MOTION_STORAGE_KEY, kenBurnsEnabled.value ? '1' : '0'); } catch { /* ignore */ }
  }

  function toggleDaylight(force?: boolean) {
    daylightEnabled.value = typeof force === 'boolean' ? force : !daylightEnabled.value;
    try { window.localStorage.setItem(DAYLIGHT_STORAGE_KEY, daylightEnabled.value ? '1' : '0'); } catch { /* ignore */ }
    ensureDaylightWatcher();
  }

  return {
    frames: IMMERSIVE_PHOTO_FRAMES,
    activeFrameId: readonly(activeFrameId),
    activeFrame,
    kenBurnsEnabled: readonly(kenBurnsEnabled),
    daylightEnabled: readonly(daylightEnabled),
    daylightSlot: readonly(daylightSlot),
    setFrame,
    cycleFrame,
    toggleKenBurns,
    toggleDaylight,
    syncDaylightFrame,
  };
}
