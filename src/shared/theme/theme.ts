/** 主题是整个面板的展示偏好，不属于业务数据；用固定预设避免引入可视化配色器或新的状态库。 */
export const themeOptions = [
  { id: 'cobalt', name: '深海蓝', description: '深色导航 · 清晰明亮', colors: ['#11213b', '#e9eff7', '#245bd6'], dark: false, artwork: null },
  { id: 'night', name: '曜石黑', description: '低亮背景 · 夜间专注', colors: ['#080e17', '#172232', '#91baff'], dark: true, artwork: null },
  { id: 'forest', name: '松林绿', description: '墨绿导航 · 温润纸白', colors: ['#123c34', '#f2efe6', '#0f766e'], dark: false, artwork: null },
  { id: 'violet', name: '暮光紫', description: '深紫导航 · 冷调专注', colors: ['#241735', '#f1eef8', '#6d28d9'], dark: false, artwork: null },
  { id: 'amber', name: '暖沙橙', description: '暖棕导航 · 低饱和纸感', colors: ['#3a2416', '#f4efe7', '#9a4c0e'], dark: false, artwork: null },
  { id: 'custom', name: '自定义', description: '本地壁纸 · 自选配色', colors: ['#101521', '#20293a', '#b79cff'], dark: true, artwork: null },
  { id: 'system', name: '跟随系统', description: '随系统切换深海蓝 / 曜石黑', colors: ['#11213b', '#f3f6fb', '#172232'], dark: false, artwork: null },
] as const;
export type ThemePreference = typeof themeOptions[number]['id'];
export type ResolvedTheme = Exclude<ThemePreference, 'system'>;
export const THEME_STORAGE_KEY = 'delivery-workspace.theme.v1';
export function normalizeTheme(value: unknown): ThemePreference {
  return themeOptions.some((option) => option.id === value) ? value as ThemePreference : 'cobalt';
}
export function resolveTheme(preference: ThemePreference, dark: boolean): ResolvedTheme {
  return preference === 'system' ? dark ? 'night' : 'cobalt' : preference;
}
export function readTheme(storage: Pick<Storage, 'getItem'>): ThemePreference {
  try { return normalizeTheme(storage.getItem(THEME_STORAGE_KEY)); } catch { return 'cobalt'; }
}
export function saveTheme(storage: Pick<Storage, 'setItem'>, preference: ThemePreference): boolean {
  try { storage.setItem(THEME_STORAGE_KEY, preference); return true; } catch { return false; }
}
