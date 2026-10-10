/** 根节点统一驱动 CSS 和传送到 body 的弹层；自定义主题仍只影响浏览器本地外观，不进入业务状态。 */
import { computed, readonly, shallowRef } from 'vue';
import { CUSTOM_THEME_STORAGE_KEY, DEFAULT_CUSTOM_THEME, deleteCustomWallpaper, normalizeCustomTheme, readCustomTheme, readCustomWallpaper, saveCustomTheme, saveCustomWallpaper, type CustomThemeSettings } from './customTheme';
import { normalizeTheme, readTheme, resolveTheme, saveTheme, THEME_STORAGE_KEY, themeOptions, type ThemePreference } from './theme';
const preference = shallowRef<ThemePreference>('cobalt');
const storageAvailable = shallowRef(true);
const systemDark = shallowRef(false);
const customTheme = shallowRef<CustomThemeSettings>({ ...DEFAULT_CUSTOM_THEME });
const wallpaperUrl = shallowRef('');
const resolved = computed(() => resolveTheme(preference.value, systemDark.value));
const current = computed(() => themeOptions.find((option) => option.id === preference.value)!);
function replaceWallpaperUrl(blob: Blob | null) {
  if (wallpaperUrl.value) URL.revokeObjectURL(wallpaperUrl.value);
  wallpaperUrl.value = blob ? URL.createObjectURL(blob) : '';
}
function applyCustomVariables() {
  const root = document.documentElement;
  const shade = customTheme.value.overlay / 100;
  root.style.setProperty('--custom-accent', customTheme.value.accent);
  root.style.setProperty('--custom-background', customTheme.value.background);
  root.style.setProperty('--custom-wallpaper', wallpaperUrl.value ? `url("${wallpaperUrl.value}")` : 'none');
  root.style.setProperty('--custom-wallpaper-position', customTheme.value.position);
  root.style.setProperty('--custom-wallpaper-empty-shade', `rgb(0 0 0 / ${shade})`);
  root.style.setProperty('--custom-wallpaper-chat-shade', `rgb(0 0 0 / ${Math.min(0.94, shade + 0.2)})`);
  root.style.setProperty('--custom-message-opacity', `${customTheme.value.messageOpacity}%`);
}
function applyTheme() {
  applyCustomVariables();
  document.documentElement.dataset.theme = resolved.value;
  const dark = themeOptions.find((option) => option.id === resolved.value)?.dark ?? false;
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
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
async function updateCustomWallpaper(file: File | null) {
  const saved = file ? await saveCustomWallpaper(file) : await deleteCustomWallpaper();
  if (!saved) return false;
  replaceWallpaperUrl(file);
  updateCustomTheme({ wallpaperName: file?.name ?? '' });
  return true;
}
async function resetCustomTheme() {
  await deleteCustomWallpaper();
  replaceWallpaperUrl(null);
  customTheme.value = { ...DEFAULT_CUSTOM_THEME };
  storageAvailable.value = saveCustomTheme(window.localStorage, customTheme.value);
  applyCustomVariables();
}
export function initializeTheme() {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  systemDark.value = media.matches;
  try { preference.value = readTheme(window.localStorage); } catch { preference.value = 'cobalt'; }
  customTheme.value = readCustomTheme(window.localStorage);
  applyTheme();
  void readCustomWallpaper().then((blob) => { replaceWallpaperUrl(blob); applyCustomVariables(); });
  const onSystemChange = (event: MediaQueryListEvent) => { systemDark.value = event.matches; applyTheme(); };
  const onStorage = (event: StorageEvent) => {
    if (event.key === CUSTOM_THEME_STORAGE_KEY || event.key === null) customTheme.value = readCustomTheme(window.localStorage);
    if (event.key === THEME_STORAGE_KEY || event.key === null) preference.value = normalizeTheme(event.newValue);
    if (event.key !== THEME_STORAGE_KEY && event.key !== CUSTOM_THEME_STORAGE_KEY && event.key !== null) return;
    applyTheme();
  };
  media.addEventListener('change', onSystemChange);
  window.addEventListener('storage', onStorage);
  return () => { media.removeEventListener('change', onSystemChange); window.removeEventListener('storage', onStorage); replaceWallpaperUrl(null); };
}
export function useTheme() {
  return { preference: readonly(preference), current, customTheme: readonly(customTheme), wallpaperUrl: readonly(wallpaperUrl), storageAvailable: readonly(storageAvailable), setTheme, updateCustomTheme, updateCustomWallpaper, resetCustomTheme };
}
