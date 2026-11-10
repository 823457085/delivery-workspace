/** 偏好解析和存储属于展示规则；系统事件、弹层及对比度另用真实浏览器验证。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CUSTOM_THEME_STORAGE_KEY, DEFAULT_CUSTOM_THEME, normalizeCustomTheme, readCustomTheme, saveCustomTheme } from '../src/shared/theme/customTheme';
import { normalizeTheme, resolveTheme, readTheme, saveTheme, THEME_STORAGE_KEY, themeOptions } from '../src/shared/theme/theme';

test('known preferences resolve, including the previous GitHub theme pair', () => {
  for (const option of themeOptions) assert.equal(normalizeTheme(option.id), option.id);
  for (const value of [null, undefined, '', 'pink', {}, 1]) assert.equal(normalizeTheme(value), 'bento');
  assert.equal(normalizeTheme('github'), 'bento');
  assert.equal(normalizeTheme('github-dark'), 'bento-dark');
});
test('system follows OS preference, explicit skins never change with the OS', () => {
  assert.equal(resolveTheme('system', true), 'night');
  assert.equal(resolveTheme('system', false), 'cobalt');
  for (const value of themeOptions.map((option) => option.id).filter((id) => id !== 'system')) {
    assert.equal(resolveTheme(value, false), value);
    assert.equal(resolveTheme(value, true), value);
  }
});
test('theme round trips through the dedicated local storage key', () => {
  const entries = new Map<string, string>();
  const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); } };
  assert.equal(readTheme(storage), 'bento');
  assert.equal(saveTheme(storage, 'forest'), true);
  assert.equal(entries.get(THEME_STORAGE_KEY), 'forest');
  assert.equal(readTheme(storage), 'forest');
});
test('denied browser storage does not break rendering or switching', () => {
  const storage = { getItem(): string { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(readTheme(storage), 'bento');
  assert.equal(saveTheme(storage, 'night'), false);
});
test('默认使用 Bento 浅色，Bento 深色与其他旧预设仍可选择', () => {
  const fallback = readTheme({ getItem: () => null });
  assert.equal(fallback, 'bento');
  assert.equal(themeOptions.find(option => option.id === resolveTheme(fallback, false))?.dark, false);
  assert.equal(themeOptions.find(option => option.id === resolveTheme('bento-dark', false))?.dark, true);
  assert.equal(themeOptions.find(option => option.id === resolveTheme('studio', false))?.dark, true);
  assert.equal(themeOptions.find(option => option.id === resolveTheme('split', true))?.dark, false);
  assert.equal(THEME_STORAGE_KEY, 'delivery-workspace.theme.v1');
});
test('custom theme validates colors and clamps wallpaper and message transparency', () => {
  assert.deepEqual(normalizeCustomTheme({ accent: 'red', background: '#123456', messageOpacity: 10, overlay: 120, position: 'left', wallpaperName: 'demo.png' }), {
    ...DEFAULT_CUSTOM_THEME,
    background: '#123456',
    messageOpacity: 35,
    overlay: 90,
    wallpaperName: 'demo.png',
  });
  const entries = new Map<string, string>();
  const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); } };
  const custom = normalizeCustomTheme({ accent: '#112233', messageOpacity: 72, overlay: 45, position: 'top' });
  assert.equal(saveCustomTheme(storage, custom), true);
  assert.ok(entries.has(CUSTOM_THEME_STORAGE_KEY));
  assert.deepEqual(readCustomTheme(storage), custom);
});

const css = readFileSync(new URL('../src/app/themes.css', import.meta.url), 'utf8');
test('纯黑主题独立保存，完整覆盖色板且主要表面为中性黑灰', () => {
  const option = themeOptions.find(item => item.id === 'obsidian');
  assert.equal(option?.name, '纯黑');
  assert.equal(option?.dark, true);
  const entries = new Map<string, string>();
  const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); } };
  assert.equal(saveTheme(storage, 'obsidian'), true);
  assert.equal(readTheme(storage), 'obsidian');
  const base = css.match(/:root\[data-theme='cobalt'\]\s*\{([^}]+)/)![1];
  const block = css.match(/:root\[data-theme='obsidian'\]\s*\{([^}]+)/)![1];
  const tokens = (value: string) => Object.fromEntries([...value.matchAll(/(--ui-[\w-]+):\s*([^;]+)/g)].map(match => [match[1], match[2]]));
  const original = tokens(base), palette = tokens(block);
  assert.deepEqual(Object.keys(palette).filter(key => !key.startsWith('--ui-user-message-')).sort(), Object.keys(original).sort());
  assert.equal(palette['--ui-bg'], '#171717');
  for (const name of ['bg', 'surface', 'raised', 'hover', 'accent-soft', 'nav', 'nav-raised', 'nav-selected', 'purple-bg']) {
    const value = palette[`--ui-${name}`];
    assert.match(value, /^#[\da-f]{6}$/);
    assert.equal(value.slice(1, 3), value.slice(3, 5), `${name} must not have a color cast`);
    assert.equal(value.slice(3, 5), value.slice(5, 7), `${name} must not have a color cast`);
  }
});
function luminance(hex: string) {
  const value = hex.length === 4 ? hex.slice(1).split('').map((c) => c + c).join('') : hex.slice(1);
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255)
    .map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
}
for (const name of themeOptions.map((option) => option.id).filter((id) => id !== 'system')) {
  test(`${name} key text and status pairs meet 4.5:1 contrast`, () => {
    const block = css.match(new RegExp(`:root\\[data-theme='${name}'\\]\\s*\\{([^}]+)`))?.[1];
    assert.ok(block, `missing ${name} palette`);
    const colors = Object.fromEntries([...block.matchAll(/--ui-([\w-]+):\s*(#[\da-f]+)/g)].map((match) => [match[1], match[2]]));
    const pairs = [['text', 'surface'], ['muted', 'surface'], ['muted', 'raised'], ['accent', 'surface'], ['success', 'success-bg'], ['warning', 'warning-bg'], ['danger', 'danger-bg'], ['nav-muted', 'nav'], ['on-primary', 'primary']];
    if (name === 'obsidian' || name === 'studio') pairs.push(['user-message-text', 'user-message-bg'], ['user-message-muted', 'user-message-bg']);
    if (name === 'studio') pairs.push(['secondary', 'surface'], ['muted', 'hover'], ['accent', 'nav-selected'], ['on-primary', 'primary-hover'],
      ['on-primary', 'success'], ['on-primary', 'warning'], ['on-primary', 'danger'], ['on-primary', 'secondary']);
    for (const [fg, bg] of pairs) {
      assert.ok(colors[fg] && colors[bg], `missing ${fg}/${bg}`);
      const [a, b] = [luminance(colors[fg]), luminance(colors[bg])];
      assert.ok((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5, `${fg}/${bg} contrast below 4.5`);
    }
  });
}
