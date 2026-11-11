import { z } from 'zod';

export const menuIconNames = ['grid', 'checklist', 'calendar', 'notebook', 'folder', 'code', 'book', 'message', 'chart', 'star', 'bookmark', 'briefcase', 'layers', 'plug', 'settings', 'sun'] as const;
export const menuIconSchema = z.enum(menuIconNames);
const menuId = z.string().regex(/^(custom:)?[a-z][a-z0-9-]{0,79}$/);
export const navigationPreferencesSchema = z.object({
  order: z.array(menuId).max(200).refine(items => new Set(items).size === items.length, '菜单不能重复').default([]),
  icons: z.record(menuId, menuIconSchema).refine(items => Object.keys(items).length <= 200).default({}),
}).strict();
export type NavigationPreferences = z.infer<typeof navigationPreferencesSchema>;
export type MenuIconName = z.infer<typeof menuIconSchema>;
