/**
 * 自定义主题把用户壁纸和固定预设分开：这里只处理浏览器本地外观，不接触任务、会话或服务端数据。
 * 图片使用 IndexedDB，避免大图挤占 localStorage；颜色参数仍用 localStorage，便于同步更新和恢复默认。
 */
import { compressWallpaperToDataUrlInBrowser, normalizeGalleryItems, type WallpaperGalleryItem } from './wallpaperEngine';

export type WallpaperPosition = 'center' | 'top' | 'bottom';

export interface CustomThemeSettings {
  accent: string;
  autoPalette: boolean;
  background: string;
  blur: number;
  brightness: number;
  messageOpacity: number;
  overlay: number;
  position: WallpaperPosition;
  wallpaperName: string;
}

export const CUSTOM_THEME_STORAGE_KEY = 'delivery-workspace.custom-theme.v1';
export const CUSTOM_WALLPAPER_GALLERY_KEY = 'delivery-workspace.wallpaper-gallery.v1';
export const DEFAULT_CUSTOM_THEME: CustomThemeSettings = {
  accent: '#b79cff',
  autoPalette: true,
  background: '#101521',
  blur: 0,
  brightness: 100,
  messageOpacity: 78,
  overlay: 58,
  position: 'center',
  wallpaperName: '',
};

const HEX_COLOR = /^#[\da-f]{6}$/i;
const positions: WallpaperPosition[] = ['center', 'top', 'bottom'];

export function normalizeCustomTheme(value: unknown): CustomThemeSettings {
  const input = value && typeof value === 'object' ? value as Partial<CustomThemeSettings> : {};
  return {
    accent: typeof input.accent === 'string' && HEX_COLOR.test(input.accent) ? input.accent : DEFAULT_CUSTOM_THEME.accent,
    autoPalette: typeof input.autoPalette === 'boolean' ? input.autoPalette : DEFAULT_CUSTOM_THEME.autoPalette,
    background: typeof input.background === 'string' && HEX_COLOR.test(input.background) ? input.background : DEFAULT_CUSTOM_THEME.background,
    blur: typeof input.blur === 'number' && Number.isFinite(input.blur) ? Math.min(24, Math.max(0, Math.round(input.blur))) : DEFAULT_CUSTOM_THEME.blur,
    brightness: typeof input.brightness === 'number' && Number.isFinite(input.brightness) ? Math.min(130, Math.max(50, Math.round(input.brightness))) : DEFAULT_CUSTOM_THEME.brightness,
    messageOpacity: typeof input.messageOpacity === 'number' && Number.isFinite(input.messageOpacity) ? Math.min(100, Math.max(35, Math.round(input.messageOpacity))) : DEFAULT_CUSTOM_THEME.messageOpacity,
    overlay: typeof input.overlay === 'number' && Number.isFinite(input.overlay) ? Math.min(90, Math.max(20, Math.round(input.overlay))) : DEFAULT_CUSTOM_THEME.overlay,
    position: positions.includes(input.position as WallpaperPosition) ? input.position as WallpaperPosition : DEFAULT_CUSTOM_THEME.position,
    wallpaperName: typeof input.wallpaperName === 'string' ? input.wallpaperName.slice(0, 180) : '',
  };
}

export function readWallpaperGallery(storage: Pick<Storage, 'getItem'>): WallpaperGalleryItem[] {
  try {
    const raw = storage.getItem(CUSTOM_WALLPAPER_GALLERY_KEY);
    return normalizeGalleryItems(raw ? JSON.parse(raw) : null);
  } catch {
    return [];
  }
}

export function saveWallpaperGallery(storage: Pick<Storage, 'setItem'>, items: readonly WallpaperGalleryItem[]): boolean {
  try {
    storage.setItem(CUSTOM_WALLPAPER_GALLERY_KEY, JSON.stringify(normalizeGalleryItems(items)));
    return true;
  } catch {
    return false;
  }
}

export function readCustomTheme(storage: Pick<Storage, 'getItem'>): CustomThemeSettings {
  try {
    const raw = storage.getItem(CUSTOM_THEME_STORAGE_KEY);
    return normalizeCustomTheme(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_CUSTOM_THEME };
  }
}

export function saveCustomTheme(storage: Pick<Storage, 'setItem'>, value: CustomThemeSettings): boolean {
  try {
    storage.setItem(CUSTOM_THEME_STORAGE_KEY, JSON.stringify(normalizeCustomTheme(value)));
    return true;
  } catch {
    return false;
  }
}

const DB_NAME = 'delivery-workspace-theme';
const STORE_NAME = 'assets';
const WALLPAPER_KEY = 'custom-wallpaper';
export const CUSTOM_WALLPAPER_FALLBACK_KEY = 'delivery-workspace.custom-wallpaper.v1';
const MAX_FALLBACK_WALLPAPER_BYTES = 2_500_000;

const IMAGE_EXTENSION_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

export interface StoredWallpaperRecord {
  data: ArrayBuffer;
  type: string;
}

export function inferWallpaperMimeType(name = '', declaredType = ''): string {
  const normalizedType = declaredType.trim().toLowerCase();
  if (normalizedType.startsWith('image/')) return normalizedType;
  const dotIndex = name.lastIndexOf('.');
  if (dotIndex < 0) return '';
  return IMAGE_EXTENSION_MIME[name.slice(dotIndex).toLowerCase()] ?? '';
}

export function isSupportedWallpaperFile(file: Pick<File, 'name' | 'type'> | null | undefined): boolean {
  if (!file) return false;
  return Boolean(inferWallpaperMimeType(file.name, file.type));
}

export function normalizeWallpaperRecord(stored: unknown): Blob | null {
  if (typeof Blob !== 'undefined' && stored instanceof Blob) return stored;
  if (!stored || typeof stored !== 'object' || !('data' in stored)) return null;
  const candidate = stored as { data?: unknown; type?: unknown };
  const mime = typeof candidate.type === 'string' && candidate.type.startsWith('image/')
    ? candidate.type
    : 'image/png';
  if (candidate.data instanceof ArrayBuffer) {
    return new Blob([candidate.data], { type: mime });
  }
  if (ArrayBuffer.isView(candidate.data)) {
    const view = candidate.data;
    const copy = new Uint8Array(view.byteLength);
    copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    return new Blob([copy], { type: mime });
  }
  return null;
}

function encodeFallbackDataUrl(bytes: ArrayBuffer, mime: string): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < view.length; offset += chunkSize) {
    binary += String.fromCharCode(...view.subarray(offset, offset + chunkSize));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

function decodeFallbackDataUrl(raw: string | null): Blob | null {
  if (!raw || !raw.startsWith('data:image/')) return null;
  const commaIndex = raw.indexOf(',');
  if (commaIndex < 0) return null;
  const header = raw.slice(5, commaIndex);
  const [mime] = header.split(';');
  if (!header.includes(';base64')) return null;
  try {
    const binary = atob(raw.slice(commaIndex + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime || 'image/png' });
  } catch {
    return null;
  }
}

function readFallbackWallpaper(): Blob | null {
  try {
    return decodeFallbackDataUrl(window.localStorage.getItem(CUSTOM_WALLPAPER_FALLBACK_KEY));
  } catch {
    return null;
  }
}

function clearFallbackWallpaper(): boolean {
  try {
    window.localStorage.removeItem(CUSTOM_WALLPAPER_FALLBACK_KEY);
    return true;
  } catch {
    return false;
  }
}

const IDB_OPERATION_TIMEOUT_MS = 1500;

function openAssetDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('IndexedDB open timeout'));
    }, IDB_OPERATION_TIMEOUT_MS);
    let request: IDBOpenDBRequest;
    try {
      request = window.indexedDB.open(DB_NAME, 1);
    } catch (error) {
      globalThis.clearTimeout(timer);
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => {
      if (settled) {
        try { request.result.close(); } catch { /* ignore */ }
        return;
      }
      settled = true;
      globalThis.clearTimeout(timer);
      resolve(request.result);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      reject(request.error ?? new Error('IndexedDB open failed'));
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      reject(new Error('IndexedDB open blocked'));
    };
  });
}

async function withAssetStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openAssetDatabase();
  return new Promise((resolve, reject) => {
    let settled = false;
    let result!: T;
    let hasResult = false;
    const timer = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      try { database.close(); } catch { /* ignore */ }
      reject(new Error('IndexedDB transaction timeout'));
    }, IDB_OPERATION_TIMEOUT_MS);
    const finishResolve = (value: T) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      database.close();
      resolve(value);
    };
    const finishReject = (reason: unknown) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      database.close();
      reject(reason ?? new Error('IndexedDB transaction failed'));
    };
    const transaction = database.transaction(STORE_NAME, mode);
    const request = action(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => {
      result = request.result;
      hasResult = true;
    };
    request.onerror = () => finishReject(request.error);
    transaction.oncomplete = () => {
      if (hasResult) finishResolve(result);
      else finishReject(new Error('IndexedDB transaction completed without result'));
    };
    transaction.onabort = () => finishReject(transaction.error ?? request.error ?? new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => finishReject(transaction.error ?? request.error);
  });
}

export async function readCustomWallpaper(): Promise<Blob | null> {
  try {
    const stored = await withAssetStore<unknown>('readonly', (store) => store.get(WALLPAPER_KEY));
    const normalized = normalizeWallpaperRecord(stored);
    if (normalized) return normalized;
  } catch {
    // Fall through to localStorage fallback when IndexedDB is restricted in WebKit / private mode.
  }
  return readFallbackWallpaper();
}

export async function saveCustomWallpaper(file: Blob): Promise<boolean> {
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    return false;
  }
  const fileName = 'name' in file && typeof file.name === 'string' ? file.name : '';
  const mime = inferWallpaperMimeType(fileName, file.type) || file.type || 'image/png';
  try {
    const record: StoredWallpaperRecord = { data: bytes, type: mime };
    await withAssetStore<IDBValidKey>('readwrite', (store) => store.put(record, WALLPAPER_KEY));
    clearFallbackWallpaper();
    return true;
  } catch {
    try {
      if (bytes.byteLength <= MAX_FALLBACK_WALLPAPER_BYTES) {
        window.localStorage.setItem(CUSTOM_WALLPAPER_FALLBACK_KEY, encodeFallbackDataUrl(bytes, mime));
        return true;
      }
      const compressed = await compressWallpaperToDataUrlInBrowser(new Blob([bytes], { type: mime }));
      if (compressed) {
        window.localStorage.setItem(CUSTOM_WALLPAPER_FALLBACK_KEY, compressed);
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }
}

export async function deleteCustomWallpaper(): Promise<boolean> {
  const clearedFallback = clearFallbackWallpaper();
  try {
    await withAssetStore<undefined>('readwrite', (store) => store.delete(WALLPAPER_KEY));
    return true;
  } catch {
    return clearedFallback;
  }
}

function galleryAssetKey(id: string): string {
  return `${WALLPAPER_KEY}:${id}`;
}

export async function saveGalleryWallpaperBlob(id: string, file: Blob): Promise<boolean> {
  if (!id) return false;
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    return false;
  }
  const fileName = 'name' in file && typeof file.name === 'string' ? file.name : '';
  const mime = inferWallpaperMimeType(fileName, file.type) || file.type || 'image/png';
  try {
    const record: StoredWallpaperRecord = { data: bytes, type: mime };
    await withAssetStore<IDBValidKey>('readwrite', (store) => store.put(record, galleryAssetKey(id)));
    return true;
  } catch {
    return false;
  }
}

export async function readGalleryWallpaperBlob(id: string): Promise<Blob | null> {
  if (!id) return null;
  try {
    const stored = await withAssetStore<unknown>('readonly', (store) => store.get(galleryAssetKey(id)));
    return normalizeWallpaperRecord(stored);
  } catch {
    return null;
  }
}

export async function deleteGalleryWallpaperBlob(id: string): Promise<boolean> {
  if (!id) return false;
  try {
    await withAssetStore<undefined>('readwrite', (store) => store.delete(galleryAssetKey(id)));
    return true;
  } catch {
    return false;
  }
}
