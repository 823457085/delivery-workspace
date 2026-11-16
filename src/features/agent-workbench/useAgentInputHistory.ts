/**
 * 设计说明：借鉴 GitHub 标杆项目 Aider / OpenCode / Zed 的终端风格历史提问回溯（Prompt History）。
 * 1. 自动记录最近发送的 50 条提问（去重、限制单条体积防撑爆 localStorage）；
 * 2. 仅当输入框为空，或正处于未修改的历史回溯态时，按 ↑ / ↓ 键才翻阅历史提问，绝不抢占多行文本编辑时的正常光标上下移动；
 * 3. 同时支持从工具栏「历史」弹出层直接点选或清理历史记录。
 */
import { computed, shallowRef, type Ref, type ShallowRef } from 'vue';

export const AGENT_INPUT_HISTORY_KEY = 'agent-prompt-input-history:v1';
const MAX_HISTORY_ITEMS = 50;
const MAX_SINGLE_PROMPT_CHARS = 8_000;

function defaultStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readInputHistory(
  storage: Pick<Storage, 'getItem'> | null = defaultStorage(),
): string[] {
  if (!storage) return [];
  try {
    const raw = JSON.parse(storage.getItem(AGENT_INPUT_HISTORY_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      if (typeof item !== 'string') continue;
      const normalized = item.replace(/\r\n/g, '\n').trim();
      if (normalized.length < 2 || normalized.length > MAX_SINGLE_PROMPT_CHARS) continue;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
      if (out.length >= MAX_HISTORY_ITEMS) break;
    }
    return out;
  } catch {
    return [];
  }
}

export function writeInputHistory(
  entries: readonly string[],
  storage: Pick<Storage, 'setItem'> | null = defaultStorage(),
) {
  if (!storage) return;
  try {
    storage.setItem(
      AGENT_INPUT_HISTORY_KEY,
      JSON.stringify(entries.slice(0, MAX_HISTORY_ITEMS)),
    );
  } catch {
    /* localStorage 受限时仅保留当前内存态 */
  }
}

export function pushInputHistoryEntry(
  current: readonly string[],
  rawPrompt: string,
): string[] {
  const normalized = rawPrompt.replace(/\r\n/g, '\n').trim();
  if (normalized.length < 2 || normalized.length > MAX_SINGLE_PROMPT_CHARS) {
    return [...current];
  }
  return [
    normalized,
    ...current.filter(item => item !== normalized),
  ].slice(0, MAX_HISTORY_ITEMS);
}

let sharedBrowserHistory: ShallowRef<string[]> | undefined;

export function recordSubmittedPrompt(
  rawPrompt: string,
  customStorage?: Storage | null,
) {
  const storage = customStorage === undefined ? defaultStorage() : customStorage;
  const current = customStorage === undefined
    ? (sharedBrowserHistory ??= shallowRef(readInputHistory(storage))).value
    : readInputHistory(storage);
  const next = pushInputHistoryEntry(current, rawPrompt);
  if (customStorage === undefined && sharedBrowserHistory) {
    sharedBrowserHistory.value = next;
  }
  writeInputHistory(next, storage);
}

export function useAgentInputHistory(
  draft: Ref<string>,
  disabled: () => boolean,
  customStorage?: Storage | null,
) {
  const storage = customStorage === undefined ? defaultStorage() : customStorage;
  const entries: ShallowRef<string[]> = customStorage === undefined
    ? (sharedBrowserHistory ??= shallowRef(readInputHistory(storage)))
    : shallowRef(readInputHistory(storage));

  const cursorIndex = shallowRef(-1);
  const savedDraft = shallowRef('');
  const panelOpen = shallowRef(false);

  const isBrowsingUnmodified = computed(() =>
    cursorIndex.value >= 0
    && cursorIndex.value < entries.value.length
    && draft.value === entries.value[cursorIndex.value],
  );

  function recordSubmitted(promptText?: string) {
    const target = typeof promptText === 'string' ? promptText : draft.value;
    const next = pushInputHistoryEntry(entries.value, target);
    entries.value = next;
    writeInputHistory(next, storage);
    cursorIndex.value = -1;
    savedDraft.value = '';
    panelOpen.value = false;
  }

  function selectHistoryItem(text: string) {
    draft.value = text;
    cursorIndex.value = entries.value.indexOf(text);
    panelOpen.value = false;
  }

  function removeHistoryItem(text: string) {
    const next = entries.value.filter(item => item !== text);
    entries.value = next;
    writeInputHistory(next, storage);
    if (cursorIndex.value >= next.length) cursorIndex.value = -1;
  }

  function clearAllHistory() {
    entries.value = [];
    writeInputHistory([], storage);
    cursorIndex.value = -1;
    panelOpen.value = false;
  }

  function togglePanel() {
    if (disabled()) return;
    if (!panelOpen.value) {
      entries.value = readInputHistory(storage);
    }
    panelOpen.value = !panelOpen.value;
  }

  function closePanel() {
    panelOpen.value = false;
  }

  function handleKeydown(event: KeyboardEvent): boolean {
    if (disabled() || event.isComposing || event.keyCode === 229) return false;
    if (panelOpen.value && event.key === 'Escape') {
      panelOpen.value = false;
      event.preventDefault();
      return true;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;

    if (event.key === 'ArrowUp') {
      if (!entries.value.length) return false;
      if (draft.value === '') {
        savedDraft.value = '';
        cursorIndex.value = 0;
        draft.value = entries.value[0]!;
        event.preventDefault();
        return true;
      }
      if (isBrowsingUnmodified.value) {
        const nextIdx = Math.min(entries.value.length - 1, cursorIndex.value + 1);
        cursorIndex.value = nextIdx;
        draft.value = entries.value[nextIdx]!;
        event.preventDefault();
        return true;
      }
      return false;
    }

    if (event.key === 'ArrowDown') {
      if (!isBrowsingUnmodified.value) return false;
      const nextIdx = cursorIndex.value - 1;
      if (nextIdx < 0) {
        cursorIndex.value = -1;
        draft.value = savedDraft.value;
      } else {
        cursorIndex.value = nextIdx;
        draft.value = entries.value[nextIdx]!;
      }
      event.preventDefault();
      return true;
    }

    if (event.key === 'Escape' && isBrowsingUnmodified.value) {
      cursorIndex.value = -1;
      draft.value = savedDraft.value;
      event.preventDefault();
      return true;
    }

    return false;
  }

  return {
    entries,
    cursorIndex,
    panelOpen,
    isBrowsingUnmodified,
    recordSubmitted,
    selectHistoryItem,
    removeHistoryItem,
    clearAllHistory,
    togglePanel,
    closePanel,
    handleKeydown,
  };
}
