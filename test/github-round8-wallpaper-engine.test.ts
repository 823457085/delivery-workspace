import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { integrationCatalog } from '../shared/integration-plugins.js';
import { registeredWorkspaceSections } from '../src/pages/agent/workspace-navigation.js';
import { buildCommandPaletteItems, filterCommandPaletteItems } from '../src/pages/agent/command-palette.js';
import {
  CUSTOM_WALLPAPER_GALLERY_KEY,
  normalizeCustomTheme,
  readWallpaperGallery,
  saveWallpaperGallery,
} from '../src/shared/theme/customTheme.js';
import {
  computeWallpaperFingerprint,
  contrastRatioHex,
  ensureDarkSurfaceContrast,
  extractPaletteFromRgbaPixels,
  generateAuroraWallpaperSvg,
  hexToRgb,
  MAX_WALLPAPER_GALLERY_ITEMS,
  resolveDaylightWallpaperSlot,
  upsertWallpaperGallery,
  type WallpaperGalleryItem,
} from '../src/shared/theme/wallpaperEngine.js';

test('Matugen 风格智能取色：优先提取高色度主色、保证暗色卡片 WCAG >= 4.5:1 对比度并按亮度推荐遮罩', () => {
  // 构造 100 个像素：75% 中性深灰 + 15% 深青翡翠 (#0b6e58) + 10% 珊瑚橙 (#d94f30)
  const pixels: number[] = [];
  for (let i = 0; i < 75; i += 1) pixels.push(44, 47, 54, 255);
  for (let i = 0; i < 15; i += 1) pixels.push(11, 110, 88, 255);
  for (let i = 0; i < 10; i += 1) pixels.push(217, 79, 48, 255);

  const darkResult = extractPaletteFromRgbaPixels(pixels);
  assert.ok(darkResult.swatches.length >= 2);
  for (const swatch of darkResult.swatches) {
    assert.ok(
      contrastRatioHex(swatch, '#191c24') >= 4.5,
      `swatch ${swatch} must meet 4.5:1 contrast on #191c24`,
    );
  }
  // 主色不应退化为无色度中性灰
  const [ar, ag, ab] = hexToRgb(darkResult.recommendedAccent)!;
  assert.ok(Math.max(ar, ag, ab) - Math.min(ar, ag, ab) >= 40, 'recommendedAccent should preserve vivid chroma');

  // 极深色候选色经过 ensureDarkSurfaceContrast 后自动抬升至 >= 4.5:1
  const lifted = ensureDarkSurfaceContrast('#162b5b', '#191c24');
  assert.ok(contrastRatioHex(lifted, '#191c24') >= 4.5);

  // 高亮雪景像素应自动推荐更高浓度的背景保护遮罩
  const brightPixels: number[] = [];
  for (let i = 0; i < 100; i += 1) brightPixels.push(238, 242, 248, 255);
  const brightResult = extractPaletteFromRgbaPixels(brightPixels);
  assert.ok(brightResult.recommendedOverlay > darkResult.recommendedOverlay + 15);
});

test('Tabliss / Open-WebUI 风格光学景深参数与多槽位历史壁纸画廊：指纹去重与 6 槽 LRU 淘汰', () => {
  const normalized = normalizeCustomTheme({
    blur: 99,
    brightness: 10,
    autoPalette: false,
  });
  assert.equal(normalized.blur, 24);
  assert.equal(normalized.brightness, 50);
  assert.equal(normalized.autoPalette, false);

  const bytesA = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
  const bytesA2 = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
  const bytesB = new Uint8Array([137, 80, 78, 71, 9, 8, 7, 6]);
  assert.equal(computeWallpaperFingerprint(bytesA), computeWallpaperFingerprint(bytesA2));
  assert.notEqual(computeWallpaperFingerprint(bytesA), computeWallpaperFingerprint(bytesB));

  let gallery: WallpaperGalleryItem[] = [];
  let lastEvicted: string[] = [];
  for (let idx = 1; idx <= 7; idx += 1) {
    const fp = computeWallpaperFingerprint(new Uint8Array([idx, idx * 3, idx * 7]));
    const res = upsertWallpaperGallery(gallery, {
      id: `wp-${idx}`,
      fingerprint: fp,
      name: `wall-${idx}.webp`,
      mime: 'image/webp',
      createdAt: `2026-11-15T10:0${idx}:00.000Z`,
      thumbnailDataUrl: 'data:image/webp;base64,UklGRg==',
      accent: '#8ab4ff',
      background: '#101521',
      overlay: 58,
      swatches: ['#8ab4ff', '#5ad08a'],
    });
    gallery = res.items;
    lastEvicted = res.evictedIds;
  }

  assert.equal(gallery.length, MAX_WALLPAPER_GALLERY_ITEMS);
  assert.equal(gallery[0]?.id, 'wp-7');
  assert.deepEqual(lastEvicted, ['wp-1']);

  // 再次上传相同指纹的壁纸（如 wp-3）应去重并置顶，不产生新槽位淘汰
  const fp3 = computeWallpaperFingerprint(new Uint8Array([3, 9, 21]));
  const deduped = upsertWallpaperGallery(gallery, {
    id: 'wp-duplicate',
    fingerprint: fp3,
    name: 'renamed-wall-3.webp',
    mime: 'image/webp',
    createdAt: '2026-11-15T11:00:00.000Z',
    thumbnailDataUrl: '',
    accent: '#b79cff',
    background: '#101521',
    overlay: 52,
    swatches: [],
  });
  assert.equal(deduped.items.length, MAX_WALLPAPER_GALLERY_ITEMS);
  assert.equal(deduped.activeItem.id, 'wp-3');
  assert.equal(deduped.items[0]?.id, 'wp-3');
  assert.equal(deduped.items[0]?.name, 'renamed-wall-3.webp');
  assert.equal(deduped.evictedIds.length, 0);

  const store = new Map<string, string>();
  const mockStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
  };
  assert.equal(saveWallpaperGallery(mockStorage, deduped.items), true);
  assert.ok(store.has(CUSTOM_WALLPAPER_GALLERY_KEY));
  assert.equal(readWallpaperGallery(mockStorage).length, MAX_WALLPAPER_GALLERY_ITEMS);
});

test('Bonjourr Daylight 时段映射与程序化流光极光 SVG 壁纸生成', () => {
  assert.deepEqual(resolveDaylightWallpaperSlot(7), {
    period: 'dawn',
    label: '破晓晨光 (05:00–10:00)',
    photoFrameId: 'dawn-ridge',
    videoSceneId: 'orbital-horizon',
  });
  assert.equal(resolveDaylightWallpaperSlot(13).photoFrameId, 'fog-forest');
  assert.equal(resolveDaylightWallpaperSlot(19).period, 'dusk');
  assert.equal(resolveDaylightWallpaperSlot(23).videoSceneId, 'neon-rain');
  assert.equal(resolveDaylightWallpaperSlot(2).period, 'night');

  const aurora1 = generateAuroraWallpaperSvg(20261115);
  const aurora2 = generateAuroraWallpaperSvg(20261115);
  assert.equal(aurora1.svg, aurora2.svg);
  assert.match(aurora1.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 1920 1080"/);
  assert.match(aurora1.svg, /<radialGradient id="orb0"/);
  assert.equal(aurora1.swatches.length, 4);
  for (const swatch of aurora1.swatches) {
    assert.ok(contrastRatioHex(swatch, '#191c24') >= 4.5);
  }
});

test('命令面板（⌘K）集成壁纸上传、随机流光生成、轮换与昼夜流转快捷动作', () => {
  const sections = registeredWorkspaceSections(integrationCatalog.map(plugin => plugin.id));
  const items = buildCommandPaletteItems({
    sections,
    currentViewId: 'today',
    isChatActive: false,
    chatMode: 'session',
    railCollapsed: false,
    currentThemeId: 'immersive-photo',
    daylightEnabled: true,
  });

  const wallpaperActions = filterCommandPaletteItems(items, '> 壁纸');
  const actionIds = wallpaperActions.map(item => item.actionId);
  assert.ok(actionIds.includes('upload-wallpaper'));
  assert.ok(actionIds.includes('generate-wallpaper'));
  assert.ok(actionIds.includes('cycle-wallpaper'));
  assert.ok(actionIds.includes('toggle-daylight'));

  const daylightItem = items.find(item => item.actionId === 'toggle-daylight');
  assert.equal(daylightItem?.title, '关闭壁纸昼夜自动流转');
  assert.equal(daylightItem?.active, true);

  const wallpaperThemes = filterCommandPaletteItems(items, '# 壁纸');
  assert.deepEqual(
    wallpaperThemes.map(item => item.themeId).sort(),
    ['cinematic-video-hero', 'custom', 'immersive-photo'],
  );
});

test('全视口壁纸透传回归保护：.session-shell、.workbench-column 与 .conversation-column 绝不被实色画布遮挡', () => {
  const designSystemCss = readFileSync(new URL('../src/app/design-system.css', import.meta.url), 'utf8');
  const agentStudioCss = readFileSync(new URL('../src/features/agent-workbench/agent-studio.css', import.meta.url), 'utf8');
  const indexVue = readFileSync(new URL('../src/pages/agent/index.vue', import.meta.url), 'utf8');

  for (const themeSelector of [
    ":root[data-theme='immersive-photo']",
    ":root[data-theme='cinematic-video-hero']",
    ":root[data-theme='custom'][data-custom-wallpaper='1']",
  ]) {
    const startIdx = designSystemCss.indexOf(`${themeSelector} :is(`);
    assert.ok(startIdx >= 0, `design-system.css missing ${themeSelector} :is(`);
    const snippet = designSystemCss.slice(startIdx, startIdx + 720);
    assert.match(snippet, /\.session-shell/, `${themeSelector} must make .session-shell transparent`);
    assert.match(snippet, /\.workbench-column/, `${themeSelector} must make .workbench-column transparent`);
    assert.match(snippet, /background:\s*transparent\s*!important/, `${themeSelector} must enforce transparent background`);

    const studioIdx = agentStudioCss.indexOf(themeSelector);
    assert.ok(studioIdx >= 0, `agent-studio.css missing ${themeSelector}`);
    const studioSnippet = agentStudioCss.slice(studioIdx, studioIdx + 640);
    assert.match(studioSnippet, /\.conversation-column/, `${themeSelector} must make .conversation-column transparent in chat`);
  }

  assert.match(indexVue, /<CustomWallpaperStage\b/, 'index.vue must mount <CustomWallpaperStage />');
});
