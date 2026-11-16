/**
 * 壁纸智能视觉引擎（GitHub 开源方案融合借鉴）：
 * 1. InioX/matugen & material-foundation/material-color-utilities：色度加权像素量化提取 + WCAG 4.5:1 暗色对比度抬升 + 自适应遮罩浓度推荐；
 * 2. joelshepherd/tabliss：多槽位 IndexedDB 历史壁纸画廊指纹去重与 LRU 淘汰；
 * 3. victrme/Bonjourr (Daylight)：按本地时段的摄影画幅 / 电影幕次自动昼夜流转；
 * 4. Raycast / ShaderGradient：零网络依赖的高清流光极光 SVG 程序化壁纸生成。
 */

export interface WallpaperPaletteAnalysis {
  recommendedAccent: string;
  recommendedBackground: string;
  recommendedOverlay: number;
  swatches: string[];
  meanLuminance: number;
}

export interface WallpaperGalleryItem {
  id: string;
  fingerprint: string;
  name: string;
  mime: string;
  createdAt: string;
  thumbnailDataUrl: string;
  accent: string;
  background: string;
  overlay: number;
  swatches: string[];
}

export interface DaylightWallpaperSlot {
  period: 'dawn' | 'day' | 'dusk' | 'night';
  label: string;
  photoFrameId: 'dawn-ridge' | 'fog-forest' | 'dusk-coast';
  videoSceneId: 'orbital-horizon' | 'aurora-fjord' | 'neon-rain';
}

export interface GeneratedAuroraWallpaper {
  svg: string;
  title: string;
  accent: string;
  background: string;
  swatches: string[];
}

export const MAX_WALLPAPER_GALLERY_ITEMS = 6;
const DEFAULT_DARK_SURFACE = '#191c24';

function clamp(min: number, max: number, value: number): number {
  return Math.min(max, Math.max(min, value));
}

export function rgbToHex(r: number, g: number, b: number): string {
  const toByte = (v: number) => clamp(0, 255, Math.round(v)).toString(16).padStart(2, '0');
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
}

export function hexToRgb(hex: string): [number, number, number] | null {
  const cleaned = hex.trim().replace(/^#/, '');
  const normalized = cleaned.length === 3
    ? cleaned.split('').map((ch) => ch + ch).join('')
    : cleaned;
  if (!/^[\da-f]{6}$/i.test(normalized)) return null;
  return [
    parseInt(normalized.slice(0, 2), 16),
    parseInt(normalized.slice(2, 4), 16),
    parseInt(normalized.slice(4, 6), 16),
  ];
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h * 360, s, l];
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hn = ((h % 360) + 360) % 360 / 360;
  const sn = clamp(0, 1, s);
  const ln = clamp(0, 1, l);
  if (sn === 0) {
    const gray = Math.round(ln * 255);
    return [gray, gray, gray];
  }
  const hue2rgb = (p: number, q: number, t: number) => {
    let tn = t;
    if (tn < 0) tn += 1;
    if (tn > 1) tn -= 1;
    if (tn < 1 / 6) return p + (q - p) * 6 * tn;
    if (tn < 1 / 2) return q;
    if (tn < 2 / 3) return p + (q - p) * (2 / 3 - tn) * 6;
    return p;
  };
  const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
  const p = 2 * ln - q;
  return [
    Math.round(hue2rgb(p, q, hn + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, hn) * 255),
    Math.round(hue2rgb(p, q, hn - 1 / 3) * 255),
  ];
}

export function relativeLuminanceFromRgb(r: number, g: number, b: number): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatioHex(foregroundHex: string, backgroundHex: string): number {
  const fg = hexToRgb(foregroundHex);
  const bg = hexToRgb(backgroundHex);
  if (!fg || !bg) return 1;
  const l1 = relativeLuminanceFromRgb(fg[0], fg[1], fg[2]);
  const l2 = relativeLuminanceFromRgb(bg[0], bg[1], bg[2]);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/**
 * 保留色相与适度饱和度，自动抬升明度以确保在暗色玻璃卡片上满足 WCAG AA (>= 4.6:1) 对比度。
 */
export function ensureDarkSurfaceContrast(candidateHex: string, surfaceHex = DEFAULT_DARK_SURFACE, minRatio = 4.6): string {
  const rgb = hexToRgb(candidateHex);
  if (!rgb) return '#8ab4ff';
  const [h, rawS, rawL] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  const s = rawS < 0.08 ? rawS : clamp(0.42, 0.92, rawS * 1.08);
  let l = clamp(0.52, 0.86, rawL);
  let currentHex = rgbToHex(...hslToRgb(h, s, l));
  if (contrastRatioHex(currentHex, surfaceHex) >= minRatio) return currentHex;

  let low = l;
  let high = 0.94;
  for (let step = 0; step < 14; step += 1) {
    const mid = (low + high) / 2;
    const testHex = rgbToHex(...hslToRgb(h, s, mid));
    if (contrastRatioHex(testHex, surfaceHex) >= minRatio) {
      currentHex = testHex;
      high = mid;
    } else {
      low = mid;
    }
  }
  return contrastRatioHex(currentHex, surfaceHex) >= minRatio
    ? currentHex
    : rgbToHex(...hslToRgb(h, Math.min(s, 0.75), 0.88));
}

function circularHueDistance(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

interface ColorBucket {
  count: number;
  sumR: number;
  sumG: number;
  sumB: number;
  hue: number;
  sat: number;
  light: number;
}

/**
 * 从 RGBA 像素缓冲区提取主色、深色背景底调、自适应遮罩浓度与最多 4 枚高对比色板。
 */
export function extractPaletteFromRgbaPixels(pixels: ArrayLike<number>): WallpaperPaletteAnalysis {
  const buckets = new Map<string, ColorBucket>();
  const luminances: number[] = [];
  let validCount = 0;

  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const alpha = pixels[i + 3]!;
    if (alpha < 128) continue;
    const r = pixels[i]!;
    const g = pixels[i + 1]!;
    const b = pixels[i + 2]!;
    validCount += 1;

    const lum = relativeLuminanceFromRgb(r, g, b);
    luminances.push(lum);

    const [h, s, l] = rgbToHsl(r, g, b);
    const key = s < 0.08
      ? `neutral:${Math.floor(l * 6)}`
      : `chroma:${Math.floor(h / 15)}:${Math.floor(s * 4)}:${Math.floor(l * 5)}`;

    const existing = buckets.get(key);
    if (existing) {
      existing.count += 1;
      existing.sumR += r;
      existing.sumG += g;
      existing.sumB += b;
    } else {
      buckets.set(key, { count: 1, sumR: r, sumG: g, sumB: b, hue: h, sat: s, light: l });
    }
  }

  if (!validCount || !buckets.size) {
    return {
      recommendedAccent: '#b79cff',
      recommendedBackground: '#101521',
      recommendedOverlay: 58,
      swatches: ['#b79cff', '#8ab4ff', '#5ad08a', '#f2b45a'],
      meanLuminance: 0.18,
    };
  }

  luminances.sort((a, b) => a - b);
  const meanLuminance = luminances.reduce((acc, v) => acc + v, 0) / luminances.length;
  const p90Luminance = luminances[Math.min(luminances.length - 1, Math.floor(luminances.length * 0.9))] ?? meanLuminance;
  const recommendedOverlay = clamp(24, 72, Math.round(24 + meanLuminance * 32 + p90Luminance * 14));

  const scored = [...buckets.values()].map((bucket) => {
    const avgR = bucket.sumR / bucket.count;
    const avgG = bucket.sumG / bucket.count;
    const avgB = bucket.sumB / bucket.count;
    const [hue, sat, light] = rgbToHsl(avgR, avgG, avgB);
    const populationRatio = bucket.count / validCount;
    const chromaWeight = sat < 0.08 ? 0.12 : 0.35 + (sat ** 1.25) * 2.6;
    const midtoneWeight = light < 0.07 || light > 0.94 ? 0.18 : light < 0.14 || light > 0.88 ? 0.55 : 1;
    const score = (populationRatio ** 0.65) * chromaWeight * midtoneWeight;
    return { hue, sat, light, avgR, avgG, avgB, score };
  }).sort((a, b) => b.score - a.score);

  const primary = scored[0]!;
  const bgSat = primary.sat < 0.06 ? 0.08 : clamp(0.18, 0.34, primary.sat * 0.62);
  const recommendedBackground = rgbToHex(...hslToRgb(primary.hue, bgSat, 0.085));
  const surfaceRef = DEFAULT_DARK_SURFACE;

  const chosen: { hue: number; hex: string }[] = [];
  for (const minHueGap of [26, 12, 0]) {
    for (const item of scored) {
      if (chosen.length >= 4) break;
      const safeHex = ensureDarkSurfaceContrast(rgbToHex(item.avgR, item.avgG, item.avgB), surfaceRef);
      if (chosen.some((existing) => existing.hex === safeHex)) continue;
      if (minHueGap > 0 && chosen.some((existing) => circularHueDistance(existing.hue, item.hue) < minHueGap)) continue;
      chosen.push({ hue: item.hue, hex: safeHex });
    }
    if (chosen.length >= 4) break;
  }

  const swatches = chosen.map((c) => c.hex);
  const recommendedAccent = swatches[0] ?? '#b79cff';

  return {
    recommendedAccent,
    recommendedBackground,
    recommendedOverlay,
    swatches,
    meanLuminance: Number(meanLuminance.toFixed(4)),
  };
}

/**
 * 计算壁纸二进制指纹（确定性双 32-bit FNV-1a 采样哈希），用于历史壁纸库去重。
 */
export function computeWallpaperFingerprint(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const len = bytes.byteLength;
  const step = Math.max(1, Math.floor(len / 4096));
  for (let i = 0; i < len; i += step) {
    const byte = bytes[i]!;
    h1 ^= byte;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= (byte + (i & 0xff)) & 0xff;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return `${len.toString(36)}-${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

export function normalizeGalleryItems(raw: unknown): WallpaperGalleryItem[] {
  if (!Array.isArray(raw)) return [];
  const valid: WallpaperGalleryItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Partial<WallpaperGalleryItem>;
    if (typeof item.id !== 'string' || !item.id) continue;
    if (typeof item.fingerprint !== 'string' || !item.fingerprint) continue;
    valid.push({
      id: item.id.slice(0, 80),
      fingerprint: item.fingerprint.slice(0, 80),
      name: typeof item.name === 'string' && item.name ? item.name.slice(0, 180) : '自定义壁纸',
      mime: typeof item.mime === 'string' && item.mime.startsWith('image/') ? item.mime : 'image/png',
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString(),
      thumbnailDataUrl: typeof item.thumbnailDataUrl === 'string' && item.thumbnailDataUrl.startsWith('data:image/')
        ? item.thumbnailDataUrl
        : '',
      accent: typeof item.accent === 'string' && /^#[\da-f]{6}$/i.test(item.accent) ? item.accent : '#b79cff',
      background: typeof item.background === 'string' && /^#[\da-f]{6}$/i.test(item.background) ? item.background : '#101521',
      overlay: typeof item.overlay === 'number' && Number.isFinite(item.overlay) ? clamp(20, 90, Math.round(item.overlay)) : 58,
      swatches: Array.isArray(item.swatches)
        ? item.swatches.filter((s): s is string => typeof s === 'string' && /^#[\da-f]{6}$/i.test(s)).slice(0, 4)
        : [],
    });
    if (valid.length >= MAX_WALLPAPER_GALLERY_ITEMS) break;
  }
  return valid;
}

export function upsertWallpaperGallery(
  current: readonly WallpaperGalleryItem[],
  incoming: WallpaperGalleryItem,
  maxItems = MAX_WALLPAPER_GALLERY_ITEMS,
): { items: WallpaperGalleryItem[]; activeItem: WallpaperGalleryItem; evictedIds: string[] } {
  const existingMatch = current.find((item) => item.fingerprint === incoming.fingerprint || item.id === incoming.id);
  const mergedItem: WallpaperGalleryItem = existingMatch
    ? {
        ...existingMatch,
        ...incoming,
        id: existingMatch.id,
        thumbnailDataUrl: incoming.thumbnailDataUrl || existingMatch.thumbnailDataUrl,
        swatches: incoming.swatches.length ? incoming.swatches : existingMatch.swatches,
      }
    : incoming;

  const rest = current.filter((item) => item.id !== mergedItem.id && item.fingerprint !== mergedItem.fingerprint);
  const nextAll = [mergedItem, ...rest];
  const kept = nextAll.slice(0, Math.max(1, maxItems));
  const keptIds = new Set(kept.map((item) => item.id));
  const evictedIds = current.filter((item) => !keptIds.has(item.id)).map((item) => item.id);
  return { items: kept, activeItem: mergedItem, evictedIds };
}

/**
 * Bonjourr Daylight 风格时段映射：按本地小时返回最契合环境光线的画幅与幕次。
 */
export function resolveDaylightWallpaperSlot(input: Date | number = new Date()): DaylightWallpaperSlot {
  const rawHour = typeof input === 'number' ? input : input.getHours();
  const hour = ((Math.floor(rawHour) % 24) + 24) % 24;
  if (hour >= 5 && hour <= 9) {
    return {
      period: 'dawn',
      label: '破晓晨光 (05:00–10:00)',
      photoFrameId: 'dawn-ridge',
      videoSceneId: 'orbital-horizon',
    };
  }
  if (hour >= 10 && hour <= 16) {
    return {
      period: 'day',
      label: '日间晴岚 (10:00–17:00)',
      photoFrameId: 'fog-forest',
      videoSceneId: 'aurora-fjord',
    };
  }
  if (hour >= 17 && hour <= 20) {
    return {
      period: 'dusk',
      label: '暮色余晖 (17:00–21:00)',
      photoFrameId: 'dusk-coast',
      videoSceneId: 'aurora-fjord',
    };
  }
  return {
    period: 'night',
    label: '静谧暗夜 (21:00–05:00)',
    photoFrameId: 'dusk-coast',
    videoSceneId: 'neon-rain',
  };
}

const AURORA_PRESETS = [
  { name: '极光翡翠', bg: '#09131c', orbs: ['#2dd4bf', '#6366f1', '#38bdf8', '#a855f7'] },
  { name: '星云暮紫', bg: '#100c1c', orbs: ['#c084fc', '#f472b6', '#60a5fa', '#818cf8'] },
  { name: '暖金破晓', bg: '#16110c', orbs: ['#f59e0b', '#fb7185', '#fbbf24', '#38bdf8'] },
  { name: '深海霓虹', bg: '#08111e', orbs: ['#38bdf8', '#34d399', '#818cf8', '#22d3ee'] },
  { name: '熔岩暗夜', bg: '#170d12', orbs: ['#fb7185', '#f97316', '#c084fc', '#facc15'] },
  { name: '松林薄雾', bg: '#0b1614', orbs: ['#4ade80', '#2dd4bf', '#93c5fd', '#a3e635'] },
] as const;

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 生成零外部依赖的 1920x1080 高清流光极光 SVG 壁纸及配套 WCAG 安全色板。
 */
export function generateAuroraWallpaperSvg(seed = Date.now()): GeneratedAuroraWallpaper {
  const rand = mulberry32(Math.floor(seed));
  const preset = AURORA_PRESETS[Math.floor(rand() * AURORA_PRESETS.length)]!;
  const orbs = preset.orbs.map((color, idx) => {
    const cx = Math.round((18 + idx * 22 + (rand() - 0.5) * 20));
    const cy = Math.round((22 + ((idx * 31) % 58) + (rand() - 0.5) * 24));
    const r = Math.round(42 + rand() * 26);
    const opacity = (0.34 + rand() * 0.22).toFixed(2);
    return { id: `orb${idx}`, color, cx, cy, r, opacity };
  });

  const swatches = preset.orbs.map((hex) => ensureDarkSurfaceContrast(hex));
  const defs = orbs.map((orb) => (
    `<radialGradient id="${orb.id}" cx="${orb.cx}%" cy="${orb.cy}%" r="${orb.r}%">`
    + `<stop offset="0%" stop-color="${orb.color}" stop-opacity="${orb.opacity}"/>`
    + `<stop offset="55%" stop-color="${orb.color}" stop-opacity="${(Number(orb.opacity) * 0.35).toFixed(2)}"/>`
    + `<stop offset="100%" stop-color="${preset.bg}" stop-opacity="0"/>`
    + '</radialGradient>'
  )).join('');
  const layers = orbs.map((orb) => `<rect width="1920" height="1080" fill="url(#${orb.id})"/>`).join('');
  const tag = String(Math.abs(Math.floor(seed)) % 1000).padStart(3, '0');
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="1920" height="1080">',
    `<defs>${defs}</defs>`,
    `<rect width="1920" height="1080" fill="${preset.bg}"/>`,
    layers,
    '</svg>',
  ].join('');

  return {
    svg,
    title: `流光极光 · ${preset.name} #${tag}`,
    accent: swatches[0]!,
    background: preset.bg,
    swatches,
  };
}

function decodeImageElementWithTimeout(objectUrl: string, timeoutMs = 2000): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Image decode timeout'));
    }, timeoutMs);
    element.decoding = 'async';
    element.onload = () => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      resolve(element);
    };
    element.onerror = () => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      reject(new Error('Image decode failed'));
    };
    element.src = objectUrl;
  });
}

/**
 * 浏览器端：将大图压缩为 <= 1600px 的 WebP/JPEG Data URL，用于 IndexedDB 受限环境下的 localStorage 兜底持久化。
 */
export async function compressWallpaperToDataUrlInBrowser(blob: Blob, maxEdge = 1600): Promise<string | null> {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return null;
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = await decodeImageElementWithTimeout(objectUrl, 2500);
    const srcW = Math.max(1, img.naturalWidth || img.width || 1280);
    const srcH = Math.max(1, img.naturalHeight || img.height || 720);
    const scale = Math.min(1, maxEdge / Math.max(srcW, srcH));
    const dstW = Math.max(1, Math.round(srcW * scale));
    const dstH = Math.max(1, Math.round(srcH * scale));
    const canvas = document.createElement('canvas');
    canvas.width = dstW;
    canvas.height = dstH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, dstW, dstH);
    let dataUrl = canvas.toDataURL('image/webp', 0.8);
    if (!dataUrl.startsWith('data:image/webp')) {
      dataUrl = canvas.toDataURL('image/jpeg', 0.8);
    }
    return dataUrl.length <= 3_600_000 ? dataUrl : canvas.toDataURL('image/jpeg', 0.62);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * 浏览器端：将图片 Blob 缩放到离屏小画布，提取智能主题色板并生成轻量历史缩略图。
 */
export async function analyzeWallpaperBlobInBrowser(blob: Blob): Promise<{
  analysis: WallpaperPaletteAnalysis;
  thumbnailDataUrl: string;
} | null> {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return null;
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = await decodeImageElementWithTimeout(objectUrl, 2000);

    const sampleCanvas = document.createElement('canvas');
    sampleCanvas.width = 48;
    sampleCanvas.height = 48;
    const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });
    if (!sampleCtx) return null;
    sampleCtx.drawImage(img, 0, 0, 48, 48);
    const pixels = sampleCtx.getImageData(0, 0, 48, 48).data;
    const analysis = extractPaletteFromRgbaPixels(pixels);

    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = 96;
    thumbCanvas.height = 54;
    const thumbCtx = thumbCanvas.getContext('2d');
    let thumbnailDataUrl = '';
    if (thumbCtx) {
      thumbCtx.drawImage(img, 0, 0, 96, 54);
      try {
        thumbnailDataUrl = thumbCanvas.toDataURL('image/webp', 0.72);
        if (!thumbnailDataUrl.startsWith('data:image/webp')) {
          thumbnailDataUrl = thumbCanvas.toDataURL('image/jpeg', 0.72);
        }
      } catch {
        thumbnailDataUrl = '';
      }
    }
    return { analysis, thumbnailDataUrl };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
