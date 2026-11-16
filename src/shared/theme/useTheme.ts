/** 根节点统一驱动 CSS 和传送到 body 的弹层；自定义主题仍只影响浏览器本地外观，不进入业务状态。 */
import { computed, readonly, shallowRef } from 'vue';
import { useCinematicVideo } from './cinematicVideo';
import {
  CUSTOM_THEME_STORAGE_KEY,
  CUSTOM_WALLPAPER_FALLBACK_KEY,
  CUSTOM_WALLPAPER_GALLERY_KEY,
  DEFAULT_CUSTOM_THEME,
  deleteCustomWallpaper,
  deleteGalleryWallpaperBlob,
  inferWallpaperMimeType,
  normalizeCustomTheme,
  readCustomTheme,
  readCustomWallpaper,
  readGalleryWallpaperBlob,
  readWallpaperGallery,
  saveCustomTheme,
  saveCustomWallpaper,
  saveGalleryWallpaperBlob,
  saveWallpaperGallery,
  type CustomThemeSettings,
} from './customTheme';
import { useImmersivePhoto } from './immersivePhoto';
import {
  DEFAULT_THEME,
  normalizeTheme,
  readTheme,
  resolveTheme,
  saveTheme,
  THEME_STORAGE_KEY,
  themeOptions,
  type ThemePreference,
} from './theme';
import {
  analyzeWallpaperBlobInBrowser,
  computeWallpaperFingerprint,
  generateAuroraWallpaperSvg,
  upsertWallpaperGallery,
  type WallpaperGalleryItem,
  type WallpaperPaletteAnalysis,
} from './wallpaperEngine';

const preference = shallowRef<ThemePreference>(DEFAULT_THEME);
const storageAvailable = shallowRef(true);
const systemDark = shallowRef(false);
const customTheme = shallowRef<CustomThemeSettings>({ ...DEFAULT_CUSTOM_THEME });
const wallpaperUrl = shallowRef('');
const currentWallpaperBlob = shallowRef<Blob | null>(null);
const recentWallpapers = shallowRef<WallpaperGalleryItem[]>([]);
const extractedSwatches = shallowRef<string[]>([]);
const activeGalleryId = shallowRef('');
let wallpaperRevision = 0;

const resolved = computed(() => resolveTheme(preference.value, systemDark.value));
const current = computed(() => themeOptions.find((option) => option.id === preference.value)!);

function replaceWallpaperUrl(blob: Blob | null) {
  if (wallpaperUrl.value) URL.revokeObjectURL(wallpaperUrl.value);
  currentWallpaperBlob.value = blob;
  wallpaperUrl.value = blob ? URL.createObjectURL(blob) : '';
}

function applyCustomVariables() {
  const root = document.documentElement;
  const shade = customTheme.value.overlay / 100;
  root.dataset.customWallpaper = wallpaperUrl.value ? '1' : '0';
  root.style.setProperty('--custom-accent', customTheme.value.accent);
  root.style.setProperty('--custom-background', customTheme.value.background);
  root.style.setProperty('--custom-wallpaper', wallpaperUrl.value ? `url("${wallpaperUrl.value}")` : 'none');
  root.style.setProperty('--custom-wallpaper-position', customTheme.value.position);
  root.style.setProperty('--custom-wallpaper-blur', `${customTheme.value.blur}px`);
  root.style.setProperty('--custom-wallpaper-brightness', `${customTheme.value.brightness}%`);
  root.style.setProperty('--custom-wallpaper-empty-shade', `rgb(0 0 0 / ${shade})`);
  root.style.setProperty('--custom-wallpaper-chat-shade', `rgb(0 0 0 / ${Math.min(0.94, shade + 0.2)})`);
  root.style.setProperty('--custom-message-opacity', `${customTheme.value.messageOpacity}%`);
}

function applyTheme() {
  applyCustomVariables();
  document.documentElement.dataset.theme = resolved.value;
  document.documentElement.classList.toggle('theme-acid', resolved.value === 'acid');
  document.body?.setAttribute('data-theme', resolved.value);
  const theme = themeOptions.find((option) => option.id === resolved.value)!;
  document.documentElement.classList.toggle('dark', theme.dark);
  document.documentElement.style.colorScheme = theme.dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.colors[0]);
}

function setTheme(value: ThemePreference) {
  preference.value = normalizeTheme(value);
  applyTheme();
  try { storageAvailable.value = saveTheme(window.localStorage, preference.value); }
  catch { storageAvailable.value = false; }
}

function updateCustomTheme(patch: Partial<CustomThemeSettings>) {
  customTheme.value = normalizeCustomTheme({ ...customTheme.value, ...patch });
  storageAvailable.value = saveCustomTheme(window.localStorage, customTheme.value);
  setTheme('custom');
}

async function materializeWallpaperBlob(file: File): Promise<{ blob: Blob; bytes: ArrayBuffer | null }> {
  try {
    const bytes = await file.arrayBuffer();
    const mime = inferWallpaperMimeType(file.name, file.type) || file.type || 'image/png';
    return { blob: new Blob([bytes], { type: mime }), bytes };
  } catch {
    return { blob: file, bytes: null };
  }
}

export interface UpdateWallpaperOptions {
  precomputedPalette?: Pick<WallpaperPaletteAnalysis, 'recommendedAccent' | 'recommendedBackground' | 'recommendedOverlay' | 'swatches'>;
  precomputedThumbnail?: string;
}

async function updateCustomWallpaper(file: File | null, options?: UpdateWallpaperOptions) {
  const revision = ++wallpaperRevision;
  if (!file) {
    activeGalleryId.value = '';
    extractedSwatches.value = [];
    replaceWallpaperUrl(null);
    updateCustomTheme({ wallpaperName: '' });
    const cleared = await deleteCustomWallpaper();
    if (revision !== wallpaperRevision) return cleared;
    if (!cleared) storageAvailable.value = false;
    return cleared;
  }

  const { blob: normalizedBlob, bytes } = await materializeWallpaperBlob(file);
  if (revision !== wallpaperRevision) return false;

  // 1. Optimistic immediate switch: render wallpaper & switch to 'custom' right away without waiting for IDB / decode
  replaceWallpaperUrl(normalizedBlob);
  const initialPatch: Partial<CustomThemeSettings> = { wallpaperName: file.name };
  if (customTheme.value.autoPalette && options?.precomputedPalette) {
    initialPatch.accent = options.precomputedPalette.recommendedAccent;
    initialPatch.background = options.precomputedPalette.recommendedBackground;
    initialPatch.overlay = options.precomputedPalette.recommendedOverlay;
    extractedSwatches.value = options.precomputedPalette.swatches;
  }
  updateCustomTheme(initialPatch);

  // 2. Run palette extraction & persistent storage in parallel with bounded timeouts
  const [browserAnalysis, saved] = await Promise.all([
    options?.precomputedPalette ? Promise.resolve(null) : analyzeWallpaperBlobInBrowser(normalizedBlob),
    saveCustomWallpaper(normalizedBlob),
  ]);
  const palette = options?.precomputedPalette ?? browserAnalysis?.analysis ?? null;
  const thumbnailDataUrl = options?.precomputedThumbnail ?? browserAnalysis?.thumbnailDataUrl ?? '';

  let nextGallery = recentWallpapers.value;
  let nextActiveId = '';

  if (bytes) {
    const fingerprint = computeWallpaperFingerprint(bytes);
    const galleryItem: WallpaperGalleryItem = {
      id: `wp-${fingerprint}`,
      fingerprint,
      name: file.name || '自定义壁纸',
      mime: normalizedBlob.type || 'image/png',
      createdAt: new Date().toISOString(),
      thumbnailDataUrl,
      accent: palette?.recommendedAccent ?? customTheme.value.accent,
      background: palette?.recommendedBackground ?? customTheme.value.background,
      overlay: palette?.recommendedOverlay ?? customTheme.value.overlay,
      swatches: palette?.swatches ?? [],
    };
    const upserted = upsertWallpaperGallery(recentWallpapers.value, galleryItem);
    nextGallery = upserted.items;
    nextActiveId = upserted.activeItem.id;
    await saveGalleryWallpaperBlob(nextActiveId, normalizedBlob);
    saveWallpaperGallery(window.localStorage, nextGallery);
    if (upserted.evictedIds.length) {
      void Promise.all(upserted.evictedIds.map((id) => deleteGalleryWallpaperBlob(id)));
    }
  }

  if (revision !== wallpaperRevision) return saved;
  recentWallpapers.value = nextGallery;
  activeGalleryId.value = nextActiveId;
  extractedSwatches.value = palette?.swatches ?? [];

  if (customTheme.value.autoPalette && palette && !options?.precomputedPalette) {
    updateCustomTheme({
      wallpaperName: file.name,
      accent: palette.recommendedAccent,
      background: palette.recommendedBackground,
      overlay: palette.recommendedOverlay,
    });
  }
  if (!saved) storageAvailable.value = false;
  return saved;
}

async function selectGalleryWallpaper(id: string): Promise<boolean> {
  const target = recentWallpapers.value.find((item) => item.id === id);
  if (!target) return false;
  const revision = ++wallpaperRevision;
  const blob = (id === activeGalleryId.value && currentWallpaperBlob.value)
    ? currentWallpaperBlob.value
    : await readGalleryWallpaperBlob(id);
  if (!blob) return false;

  const saved = await saveCustomWallpaper(blob);
  const upserted = upsertWallpaperGallery(recentWallpapers.value, {
    ...target,
    createdAt: new Date().toISOString(),
  });
  saveWallpaperGallery(window.localStorage, upserted.items);
  if (revision !== wallpaperRevision) return saved;

  recentWallpapers.value = upserted.items;
  activeGalleryId.value = upserted.activeItem.id;
  extractedSwatches.value = upserted.activeItem.swatches;
  replaceWallpaperUrl(blob);

  const patch: Partial<CustomThemeSettings> = { wallpaperName: upserted.activeItem.name };
  if (customTheme.value.autoPalette) {
    patch.accent = upserted.activeItem.accent;
    patch.background = upserted.activeItem.background;
    patch.overlay = upserted.activeItem.overlay;
  }
  updateCustomTheme(patch);
  return true;
}

async function removeGalleryWallpaper(id: string): Promise<void> {
  const next = recentWallpapers.value.filter((item) => item.id !== id);
  recentWallpapers.value = next;
  saveWallpaperGallery(window.localStorage, next);
  await deleteGalleryWallpaperBlob(id);
  if (activeGalleryId.value === id) {
    activeGalleryId.value = '';
  }
}

async function reextractCurrentPalette(): Promise<boolean> {
  if (!currentWallpaperBlob.value) return false;
  const result = await analyzeWallpaperBlobInBrowser(currentWallpaperBlob.value);
  if (!result) return false;
  extractedSwatches.value = result.analysis.swatches;
  updateCustomTheme({
    accent: result.analysis.recommendedAccent,
    background: result.analysis.recommendedBackground,
    overlay: result.analysis.recommendedOverlay,
  });
  return true;
}

async function applyPresetWallpaper(assetUrl: string, label: string) {
  const response = await fetch(assetUrl);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  const ext = assetUrl.slice(assetUrl.lastIndexOf('.')).toLowerCase() || '.webp';
  const mime = inferWallpaperMimeType(`preset${ext}`, blob.type) || 'image/webp';
  const file = new File([await blob.arrayBuffer()], `${label}${ext}`, { type: mime });
  return updateCustomWallpaper(file);
}

async function applyRandomAuroraWallpaper(seed = Date.now()) {
  const generated = generateAuroraWallpaperSvg(seed);
  const file = new File([generated.svg], `${generated.title}.svg`, { type: 'image/svg+xml' });
  const encodedThumb = `data:image/svg+xml;utf8,${encodeURIComponent(generated.svg)}`;
  return updateCustomWallpaper(file, {
    precomputedPalette: {
      recommendedAccent: generated.accent,
      recommendedBackground: generated.background,
      recommendedOverlay: 42,
      swatches: generated.swatches,
    },
    precomputedThumbnail: encodedThumb,
  });
}

async function cycleActiveWallpaper(): Promise<string> {
  if (resolved.value === 'immersive-photo') {
    const { cycleFrame, activeFrame } = useImmersivePhoto();
    cycleFrame();
    return activeFrame.value.title;
  }
  if (resolved.value === 'cinematic-video-hero') {
    const { cycleScene, activeScene } = useCinematicVideo();
    cycleScene();
    return activeScene.value.title;
  }
  if (resolved.value === 'custom') {
    if (recentWallpapers.value.length >= 2) {
      const currentIdx = recentWallpapers.value.findIndex((item) => item.id === activeGalleryId.value);
      const nextItem = recentWallpapers.value[(currentIdx + 1) % recentWallpapers.value.length]!;
      const switched = await selectGalleryWallpaper(nextItem.id);
      if (switched) return nextItem.name;
    }
    await applyRandomAuroraWallpaper();
    return customTheme.value.wallpaperName || '流光极光壁纸';
  }
  setTheme('immersive-photo');
  const { activeFrame } = useImmersivePhoto();
  return activeFrame.value.title;
}

async function resetCustomTheme() {
  const revision = ++wallpaperRevision;
  await deleteCustomWallpaper();
  if (revision !== wallpaperRevision) return;
  activeGalleryId.value = '';
  extractedSwatches.value = [];
  replaceWallpaperUrl(null);
  customTheme.value = { ...DEFAULT_CUSTOM_THEME };
  storageAvailable.value = saveCustomTheme(window.localStorage, customTheme.value);
  applyCustomVariables();
}

function syncStoredWallpaper() {
  const revision = ++wallpaperRevision;
  void readCustomWallpaper().then((blob) => {
    if (revision !== wallpaperRevision) return;
    replaceWallpaperUrl(blob);
    applyCustomVariables();
    if (blob && !extractedSwatches.value.length) {
      void analyzeWallpaperBlobInBrowser(blob).then((res) => {
        if (revision !== wallpaperRevision || !res) return;
        extractedSwatches.value = res.analysis.swatches;
      });
    }
  });
}

export function initializeTheme() {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  systemDark.value = media.matches;
  try { preference.value = readTheme(window.localStorage); } catch { preference.value = DEFAULT_THEME; }
  customTheme.value = readCustomTheme(window.localStorage);
  recentWallpapers.value = readWallpaperGallery(window.localStorage);
  const matchingGallery = recentWallpapers.value.find((item) => item.name === customTheme.value.wallpaperName);
  if (matchingGallery) {
    activeGalleryId.value = matchingGallery.id;
    extractedSwatches.value = matchingGallery.swatches;
  }
  applyTheme();
  syncStoredWallpaper();
  const onSystemChange = (event: MediaQueryListEvent) => { systemDark.value = event.matches; applyTheme(); };
  const onStorage = (event: StorageEvent) => {
    if (event.key === CUSTOM_THEME_STORAGE_KEY || event.key === null) customTheme.value = readCustomTheme(window.localStorage);
    if (event.key === CUSTOM_WALLPAPER_GALLERY_KEY || event.key === null) recentWallpapers.value = readWallpaperGallery(window.localStorage);
    if (event.key === THEME_STORAGE_KEY || event.key === null) preference.value = normalizeTheme(event.newValue);
    if (event.key === CUSTOM_THEME_STORAGE_KEY || event.key === CUSTOM_WALLPAPER_FALLBACK_KEY || event.key === null) syncStoredWallpaper();
    if (
      event.key !== THEME_STORAGE_KEY
      && event.key !== CUSTOM_THEME_STORAGE_KEY
      && event.key !== CUSTOM_WALLPAPER_FALLBACK_KEY
      && event.key !== CUSTOM_WALLPAPER_GALLERY_KEY
      && event.key !== null
    ) return;
    applyTheme();
  };
  media.addEventListener('change', onSystemChange);
  window.addEventListener('storage', onStorage);
  return () => { media.removeEventListener('change', onSystemChange); window.removeEventListener('storage', onStorage); replaceWallpaperUrl(null); };
}

export function useTheme() {
  return {
    preference: readonly(preference),
    current,
    customTheme: readonly(customTheme),
    wallpaperUrl: readonly(wallpaperUrl),
    recentWallpapers: readonly(recentWallpapers),
    extractedSwatches: readonly(extractedSwatches),
    activeGalleryId: readonly(activeGalleryId),
    storageAvailable: readonly(storageAvailable),
    setTheme,
    updateCustomTheme,
    updateCustomWallpaper,
    selectGalleryWallpaper,
    removeGalleryWallpaper,
    reextractCurrentPalette,
    applyPresetWallpaper,
    applyRandomAuroraWallpaper,
    cycleActiveWallpaper,
    resetCustomTheme,
  };
}
