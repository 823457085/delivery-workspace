/**
 * 自定义主题把用户壁纸和固定预设分开：这里只处理浏览器本地外观，不接触任务、会话或服务端数据。
 * 图片使用 IndexedDB，避免大图挤占 localStorage；颜色参数仍用 localStorage，便于同步更新和恢复默认。
 */
export type WallpaperPosition = 'center' | 'top' | 'bottom';

export interface CustomThemeSettings {
  accent: string;
  background: string;
  messageOpacity: number;
  overlay: number;
  position: WallpaperPosition;
  wallpaperName: string;
}

export const CUSTOM_THEME_STORAGE_KEY = 'delivery-workspace.custom-theme.v1';
export const DEFAULT_CUSTOM_THEME: CustomThemeSettings = {
  accent: '#b79cff',
  background: '#101521',
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
    background: typeof input.background === 'string' && HEX_COLOR.test(input.background) ? input.background : DEFAULT_CUSTOM_THEME.background,
    messageOpacity: typeof input.messageOpacity === 'number' && Number.isFinite(input.messageOpacity) ? Math.min(100, Math.max(35, Math.round(input.messageOpacity))) : DEFAULT_CUSTOM_THEME.messageOpacity,
    overlay: typeof input.overlay === 'number' && Number.isFinite(input.overlay) ? Math.min(90, Math.max(20, Math.round(input.overlay))) : DEFAULT_CUSTOM_THEME.overlay,
    position: positions.includes(input.position as WallpaperPosition) ? input.position as WallpaperPosition : DEFAULT_CUSTOM_THEME.position,
    wallpaperName: typeof input.wallpaperName === 'string' ? input.wallpaperName.slice(0, 180) : '',
  };
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

function openAssetDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withAssetStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openAssetDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = action(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function readCustomWallpaper(): Promise<Blob | null> {
  try {
    return await withAssetStore<Blob | undefined>('readonly', (store) => store.get(WALLPAPER_KEY)) ?? null;
  } catch {
    return null;
  }
}

export async function saveCustomWallpaper(file: Blob): Promise<boolean> {
  try {
    await withAssetStore<IDBValidKey>('readwrite', (store) => store.put(file, WALLPAPER_KEY));
    return true;
  } catch {
    return false;
  }
}

export async function deleteCustomWallpaper(): Promise<boolean> {
  try {
    await withAssetStore<undefined>('readwrite', (store) => store.delete(WALLPAPER_KEY));
    return true;
  } catch {
    return false;
  }
}
