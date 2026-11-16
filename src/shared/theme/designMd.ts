/**
 * awesome-design-md（https://github.com/voltagent/awesome-design-md）预设的展示元数据。
 * 色板写在 themes.css，几何与壳层布局写在 design-md-themes.css；这里只给页脚和测试提供可读标签。
 */
export const designMdThemes = {
  linear: { source: 'linear.app', layout: 'INSET CANVAS', footer: 'LINEAR · INSET CANVAS · 4-STEP SURFACE LADDER', note: 'HAIRLINE 1PX · LAVENDER FOCUS · NO GRADIENTS' },
  vercel: { source: 'vercel', layout: 'TOP TABS', footer: 'VERCEL · TOP TABS · SHADOW-AS-BORDER', note: 'GEIST · INK PRIMARY · 6PX APP RADIUS' },
  raycast: { source: 'raycast', layout: 'FLOATING PANELS', footer: 'RAYCAST · FLOATING COMMAND PANELS', note: 'INSET HIGHLIGHT · WHITE CTA · SS03' },
  cursor: { source: 'cursor', layout: 'PAPER SHEETS', footer: 'CURSOR · WARM PAPER SHEETS', note: 'CREAM FLOOR · EDITORIAL 400 · ONE ORANGE' },
  supabase: { source: 'supabase', layout: 'CONSOLE', footer: 'SUPABASE · DASHBOARD CONSOLE', note: 'GREEN CTA · DARK TEXT · 6PX RADIUS' },
  'supabase-dark': { source: 'supabase', layout: 'CONSOLE', footer: 'SUPABASE NIGHT · DASHBOARD CONSOLE', note: 'GREEN CTA · DARK TEXT · BORDER DEPTH' },
} as const;

export type DesignMdThemeId = keyof typeof designMdThemes;

export function designMdMeta(id: string) {
  return Object.prototype.hasOwnProperty.call(designMdThemes, id) ? designMdThemes[id as DesignMdThemeId] : null;
}
