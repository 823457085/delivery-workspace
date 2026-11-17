import { z } from 'zod';

export const menuIconNames = ['grid', 'checklist', 'calendar', 'notebook', 'folder', 'code', 'book', 'message', 'chart', 'star', 'bookmark', 'briefcase', 'layers', 'plug', 'settings', 'sun',
  'home', 'search', 'bell', 'alarm', 'clock', 'timer', 'rocket', 'terminal', 'bug', 'git-branch', 'git-pull', 'database', 'server', 'cloud', 'globe', 'network', 'shield', 'key', 'lock', 'users', 'user', 'mail', 'file', 'files', 'image', 'video', 'music', 'download', 'upload', 'trash', 'archive', 'package', 'wrench', 'cpu', 'monitor', 'phone', 'palette', 'graduation', 'lightbulb', 'zap', 'heart', 'target', 'map', 'link', 'workflow', 'bot', 'clipboard', 'activity'] as const;
export const menuIconUrlSchema = z.string().max(2048).refine(value => {
  if (!/^https?:\/\//i.test(value) || /[\s\x00-\x1f\x7f]/.test(value)) return false;
  try { const url = new URL(value); return !!url.hostname && !url.username && !url.password; }
  catch { return false; }
}, '请输入有效的 HTTP 或 HTTPS 图片链接，不能包含账号密码');
export const menuIconSchema = z.union([z.enum(menuIconNames), menuIconUrlSchema]);
export function isMenuIconUrl(value: unknown): value is string { return menuIconUrlSchema.safeParse(value).success; }
const menuId = z.string().regex(/^(custom:)?[a-z][a-z0-9-]{0,79}$/);
export const navigationPreferencesSchema = z.object({
  order: z.array(menuId).max(200).refine(items => new Set(items).size === items.length, '菜单不能重复').default([]),
  groups: z.record(menuId, z.string().max(40)).optional(),
  icons: z.record(menuId, menuIconSchema).refine(items => Object.keys(items).length <= 200).default({}),
}).strict();
export type NavigationPreferences = z.infer<typeof navigationPreferencesSchema>;
export type MenuIconName = typeof menuIconNames[number];
