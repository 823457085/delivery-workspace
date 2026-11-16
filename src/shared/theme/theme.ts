/** 主题是整个面板的展示偏好，不属于业务数据；用固定预设避免引入可视化配色器或新的状态库。 */
export const themeOptions = [
  { id: 'acid', name: '酸性荧光 · Acid', description: '纯黑底 #0a0a0a · 荧光绿 #39ff14 · 电紫硬阴影与等宽扭曲字', colors: ['#0a0a0a', '#121212', '#39ff14'], dark: true, artwork: null },
  { id: 'cinematic-video-hero', name: '电影首屏 · Cinematic', description: '影黑底幕 #05060a · 暖金聚光 #e4c063 · 海报先行与静音循环预告片', colors: ['#05060a', '#141821', '#e4c063'], dark: true, artwork: null },
  { id: 'immersive-photo', name: '沉浸摄影 · Immersive', description: '全幅暗房视口 #0c0d10 · 暖光琥珀金 #e8b04b · 呼吸镜头与磨砂遮罩', colors: ['#0c0d10', '#1a1c22', '#e8b04b'], dark: true, artwork: null },
  { id: 'holy-grail', name: '圣杯浅色 · Holy Grail', description: '经典三栏白卡 · 薄雾灰底 #f1f5f9 · 结构蓝强调', colors: ['#f1f5f9', '#ffffff', '#2563eb'], dark: false, artwork: null },
  // awesome-design-md（VoltAgent）DESIGN.md 预设：配色、几何与壳层布局一并切换，详见 designMd.ts。
  { id: 'linear', name: 'Linear 暗夜', description: '近黑 #010102 · 薰衣草蓝 #5e6ad2 · 内嵌画布与细线四阶表面', colors: ['#010102', '#0f1011', '#828fff'], dark: true, artwork: null },
  { id: 'vercel', name: 'Vercel 极简', description: '近白 #fafafa · 墨黑 #171717 主按钮 · 下划线顶栏与发丝描边', colors: ['#fafafa', '#ffffff', '#0761d1'], dark: false, artwork: null },
  { id: 'raycast', name: 'Raycast 指令', description: '近黑 #07080a · 白色主按钮 · 悬浮指令面板分区', colors: ['#07080a', '#0d0d0d', '#57c1ff'], dark: true, artwork: null },
  { id: 'cursor', name: 'Cursor 暖纸', description: '暖奶油 #f7f7f4 · 光标橙 #f54e00 · 纸页卡片与 400 字重排版', colors: ['#f7f7f4', '#ffffff', '#c53f00'], dark: false, artwork: null },
  { id: 'supabase', name: 'Supabase 翠绿', description: '纯白控制台 · 翡翠绿 #3ecf8e 深字 CTA · 6px 技术圆角', colors: ['#fafafa', '#ffffff', '#1f7d53'], dark: false, artwork: null },
  { id: 'supabase-dark', name: 'Supabase 夜间', description: '夜幕 #1c1c1c · 翡翠绿 #3ecf8e · 细边框控制台', colors: ['#171717', '#1c1c1c', '#3ecf8e'], dark: true, artwork: null },
  { id: 'bento', name: 'Bento 浅色', description: '暖石灰岩画布 · 象牙纸岛与赤陶强调', colors: ['#f2f0ea', '#fcfbf8', '#9e3f1e'], dark: false, artwork: null },
  { id: 'bento-dark', name: 'Bento 深色', description: '纯黑与暗灰阶 · 赤铜强调', colors: ['#000000', '#181818', '#f09a67'], dark: true, artwork: null },
  { id: 'studio', name: 'Volt 控制台', description: '纯黑与暗灰阶 · 高对比纯白主控', colors: ['#000000', '#181818', '#ffffff'], dark: true, artwork: null },
  { id: 'split', name: '云雾白', description: '浅色背景 · 紫色强调', colors: ['#f7f7f9', '#ffffff', '#5a4ee1'], dark: false, artwork: null },
  { id: 'ink', name: '墨笺', description: '暖白纸色 · 朱红强调 · 衬线标题', colors: ['#1c1a16', '#f3efe7', '#b3341c'], dark: false, artwork: null },
  { id: 'cobalt', name: '远洋蓝', description: '深色导航 · 清晰明亮', colors: ['#11213b', '#e9eff7', '#245bd6'], dark: false, artwork: null },
  { id: 'night', name: '极夜黑', description: '低亮背景 · 夜间专注', colors: ['#080e17', '#172232', '#91baff'], dark: true, artwork: null },
  { id: 'obsidian', name: '纯黑', description: '中性黑底 · 灰白正文', colors: ['#101010', '#171717', '#9dc3fe'], dark: true, artwork: null },
  { id: 'forest', name: '青竹绿', description: '墨绿导航 · 温润纸白', colors: ['#123c34', '#f2efe6', '#0f766e'], dark: false, artwork: null },
  { id: 'violet', name: '星云紫', description: '深紫导航 · 冷调专注', colors: ['#241735', '#f1eef8', '#6d28d9'], dark: false, artwork: null },
  { id: 'amber', name: '琥珀橙', description: '暖棕导航 · 低饱和纸感', colors: ['#3a2416', '#f4efe7', '#9a4c0e'], dark: false, artwork: null },
  { id: 'custom', name: '随心配色', description: '本地壁纸 · 自选配色', colors: ['#101521', '#20293a', '#b79cff'], dark: true, artwork: null },
  { id: 'system', name: '自动明暗', description: '跟随系统切换远洋蓝 / 极夜黑', colors: ['#11213b', '#f3f6fb', '#172232'], dark: false, artwork: null },
] as const;
export type ThemePreference = typeof themeOptions[number]['id'];
export type ResolvedTheme = Exclude<ThemePreference, 'system'>;
export const DEFAULT_THEME: ResolvedTheme = 'acid';
export const THEME_STORAGE_KEY = 'delivery-workspace.theme.v2';
export function normalizeTheme(value: unknown): ThemePreference {
  if (value === 'github') return 'bento';
  if (value === 'github-dark') return 'bento-dark';
  return themeOptions.some((option) => option.id === value) ? value as ThemePreference : DEFAULT_THEME;
}
export function resolveTheme(preference: ThemePreference, dark: boolean): ResolvedTheme {
  return preference === 'system' ? dark ? 'night' : 'cobalt' : preference;
}
export function readTheme(storage: Pick<Storage, 'getItem'>): ThemePreference {
  try { return normalizeTheme(storage.getItem(THEME_STORAGE_KEY)); } catch { return DEFAULT_THEME; }
}
export function saveTheme(storage: Pick<Storage, 'setItem'>, preference: ThemePreference): boolean {
  try { storage.setItem(THEME_STORAGE_KEY, preference); return true; } catch { return false; }
}
