import { computed, onScopeDispose, shallowRef, watchPostEffect, type Ref } from 'vue';
import type { AgentConversation } from './conversation';

export const unreadSessionsStorageKey = 'delivery-workspace.agent-unread-sessions:v1';

type ReadResult = { runId: string; completedAt: number };
type ReadState = { enabledAt: number; read: Record<string, ReadResult> };

function getStorage() {
  try { return typeof window === 'undefined' ? undefined : window.localStorage; }
  catch { return undefined; }
}

function readState(storage?: Pick<Storage, 'getItem'>): ReadState | undefined {
  try {
    const raw = JSON.parse(storage?.getItem(unreadSessionsStorageKey) || 'null');
    if (!Number.isFinite(raw?.enabledAt) || !raw.read || typeof raw.read !== 'object') return;
    const read = Object.fromEntries(Object.entries(raw.read as Record<string, ReadResult>).filter(([, value]) =>
      typeof value?.runId === 'string' && Number.isFinite(value.completedAt)));
    return { enabledAt: raw.enabledAt, read };
  } catch { return undefined; }
}

function completion(conversation: AgentConversation): ReadResult | undefined {
  const run = conversation.latest;
  if (conversation.source !== 'workspace' || conversation.teamChat || run.syncedHistory || run.pausedForEdit
    || run.status !== 'completed' || run.resultReady === false) return;
  const completedAt = Date.parse(run.updatedAt);
  if (Number.isFinite(completedAt)) return { runId: run.id, completedAt };
}

function mergeReadState(current: ReadState, saved: ReadState): ReadState {
  const read = { ...saved.read };
  for (const [id, result] of Object.entries(current.read)) {
    if (result.completedAt > (Object.hasOwn(read, id) ? read[id].completedAt : -Infinity)) read[id] = result;
  }
  return { enabledAt: Math.min(current.enabledAt, saved.enabledAt), read };
}

/** The caller supplies only the main and side results whose conversation details are rendered. */
export function useAgentUnreadSessions(
  conversations: Readonly<Ref<readonly AgentConversation[]>>,
  visibleResults: Readonly<Ref<readonly (AgentConversation | undefined)[]>>,
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = getStorage(),
  now = Date.now(),
): Readonly<Ref<ReadonlySet<string>>> {
  const saved = readState(storage);
  const state = shallowRef<ReadState>(saved || { enabledAt: now, read: {} });
  const windowAvailable = typeof window !== 'undefined' && typeof document !== 'undefined';
  const visible = shallowRef(!windowAvailable || document.visibilityState === 'visible' && document.hasFocus());
  function persist(next: ReadState) {
    const current = readState(storage);
    state.value = current ? mergeReadState(next, current) : next;
    try { storage?.setItem(unreadSessionsStorageKey, JSON.stringify(state.value)); }
    catch { /* Keep read state in this tab when browser storage is unavailable. */ }
  }
  if (!saved) persist(state.value);

  const unread = computed(() => {
    const ids = new Set<string>();
    const { enabledAt, read } = state.value;
    for (const conversation of conversations.value) {
      const result = completion(conversation);
      const previous = Object.hasOwn(read, conversation.id) ? read[conversation.id] : undefined;
      if (result && result.completedAt > enabledAt && previous?.runId !== result.runId
        && (previous?.completedAt ?? -Infinity) < result.completedAt) ids.add(conversation.id);
    }
    return ids;
  });

  watchPostEffect(() => {
    const results = visibleResults.value, unreadIds = unread.value;
    if (!visible.value || !results.some(result => result && unreadIds.has(result.id))) return;
    const summaries = new Map(conversations.value.map(conversation => [conversation.id, conversation]));
    const read = { ...state.value.read };
    let changed = false;
    for (const result of results) {
      if (!result?.loaded || result.latest.summaryOnly || !unreadIds.has(result.id)) continue;
      const detail = completion(result);
      const summary = summaries.get(result.id);
      if (!detail || !summary || detail.runId !== summary.latest.id) continue;
      read[result.id] = detail;
      changed = true;
    }
    if (changed) persist({ ...state.value, read });
  });

  if (windowAvailable) {
    const updateVisibility = () => { visible.value = document.visibilityState === 'visible' && document.hasFocus(); };
    const sync = (event: StorageEvent) => {
      if (event.key !== unreadSessionsStorageKey) return;
      const next = readState(storage);
      if (next) state.value = mergeReadState(state.value, next);
    };
    document.addEventListener('visibilitychange', updateVisibility);
    window.addEventListener('focus', updateVisibility);
    window.addEventListener('blur', updateVisibility);
    window.addEventListener('storage', sync);
    onScopeDispose(() => {
      document.removeEventListener('visibilitychange', updateVisibility);
      window.removeEventListener('focus', updateVisibility);
      window.removeEventListener('blur', updateVisibility);
      window.removeEventListener('storage', sync);
    });
  }

  return unread;
}
