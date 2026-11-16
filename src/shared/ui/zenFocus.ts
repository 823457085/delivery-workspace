/**
 * 沉浸专注模式（Zen Focus，借鉴 Zed `workspace: toggle zoom` 与 Cherry Studio 极简专注布局）
 * + 壁纸时钟屏保预览（Ambient Wallpaper Showcase，借鉴 joelshepherd/tabliss 与 victrme/Bonjourr）。
 * 纯前端本地外观状态，不干预任何业务会话或后台队列。
 */
import { readonly, shallowRef } from 'vue';

export const ZEN_FOCUS_STORAGE_KEY = 'delivery-workspace.zen-focus.v1';

export interface AmbientClockSnapshot {
  time: string;
  seconds: string;
  dateLine: string;
  greeting: string;
}

function defaultStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readZenFocusPreference(storage: Pick<Storage, 'getItem'> | null = defaultStorage()): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(ZEN_FOCUS_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveZenFocusPreference(
  enabled: boolean,
  storage: Pick<Storage, 'setItem'> | null = defaultStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(ZEN_FOCUS_STORAGE_KEY, enabled ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}

export function isZenToggleShortcut(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'isComposing'>): boolean {
  if (event.isComposing) return false;
  return (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key === '\\';
}

export function formatAmbientClock(now: Date = new Date()): AmbientClockSnapshot {
  const pad = (n: number) => String(n).padStart(2, '0');
  const hour = now.getHours();
  const greeting = hour < 5
    ? '夜深了，注意休息'
    : hour < 9
      ? '破晓早安'
      : hour < 12
        ? '上午好'
        : hour < 14
          ? '午间好'
          : hour < 18
            ? '下午好'
            : hour < 22
              ? '晚上好'
              : '夜深了';
  const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(now);
  return {
    time: `${pad(hour)}:${pad(now.getMinutes())}`,
    seconds: pad(now.getSeconds()),
    dateLine: `${now.getMonth() + 1}月${now.getDate()}日 · ${weekday}`,
    greeting,
  };
}

const zenFocusEnabled = shallowRef<boolean>(readZenFocusPreference());
const ambientShowcaseOpen = shallowRef<boolean>(false);

export function useZenFocus() {
  function setZenFocus(next: boolean) {
    zenFocusEnabled.value = next;
    saveZenFocusPreference(next);
  }

  function toggleZenFocus() {
    setZenFocus(!zenFocusEnabled.value);
  }

  function openAmbientShowcase() {
    ambientShowcaseOpen.value = true;
  }

  function closeAmbientShowcase() {
    ambientShowcaseOpen.value = false;
  }

  function toggleAmbientShowcase() {
    ambientShowcaseOpen.value = !ambientShowcaseOpen.value;
  }

  return {
    zenFocusEnabled: readonly(zenFocusEnabled),
    ambientShowcaseOpen: readonly(ambientShowcaseOpen),
    setZenFocus,
    toggleZenFocus,
    openAmbientShowcase,
    closeAmbientShowcase,
    toggleAmbientShowcase,
  };
}
