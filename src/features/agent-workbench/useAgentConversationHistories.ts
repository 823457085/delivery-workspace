import { useQuery, type QueryClient } from '@tanstack/vue-query';
import { computed, onScopeDispose, shallowReactive, watch, type Ref } from 'vue';
import type { AgentConversationHistoryPage, AgentRun } from '../../../shared/agent-runtime';
import { agentConversationIndexKey, createRuntimeRefresh } from './runtime-stream-state';

const historyKey = (id: string) => ['agent-conversation-history', id] as const;
const retainedConversations = 12;
const cacheLifetime = 5 * 60_000;

interface CachedHistory extends AgentConversationHistoryPage {
  loadedOlder: boolean;
}

function mergeRuns(primary: AgentRun[], additional: AgentRun[]) {
  const ids = new Set(primary.map(run => run.id));
  return [...primary, ...additional.filter(run => !ids.has(run.id))]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function readPage(id: string, signal: AbortSignal, before?: string): Promise<AgentConversationHistoryPage> {
  const query = before ? `?${new URLSearchParams({ before })}` : '';
  const response = await fetch(`/api/agent-runtimes/conversations/${encodeURIComponent(id)}/history${query}`, { signal });
  const page = await response.json();
  signal.throwIfAborted();
  if (!response.ok) throw Object.assign(new Error(page.message || '会话历史读取失败'), { status: response.status });
  return page;
}

export function useAgentConversationHistories(client: QueryClient, connected: Readonly<Ref<boolean>>) {
  // 通过 Map 的会话键订阅正文，侧聊的正文变化不会重算主会话。
  const histories = shallowReactive(new Map<string, CachedHistory>());
  const readingOlder = shallowReactive(new Map<string, AbortController>());
  const observed = new Set<Readonly<Ref<string>>>();
  const recentlyViewed = new Set<string>();
  const dirty = new Set<string>();
  const dirtyRuns = new Map<string, Map<string, number>>();
  const readingRuns = new Map<string, AbortController>();
  const requiredRevision = new Map<string, number>();
  const receipts = new Map<string, Map<string, { revision: number; run: AgentRun }>>();
  let generation = 0;
  let retainedIndex: { revision: number; runIds: Set<string> } | undefined;

  const visibleIds = () => new Set([...observed].map(source => source.value).filter(Boolean));
  const refresh = createRuntimeRefresh(async () => {
    const visible = visibleIds();
    const heads = [...dirty].filter(id => visible.has(id));
    const patches = [...dirtyRuns].filter(([id]) => visible.has(id) && !dirty.has(id));
    dirty.clear();
    dirtyRuns.clear();
    await Promise.allSettled([
      ...heads.map(id => client.refetchQueries(
        { queryKey: historyKey(id), exact: true, type: 'active' }, { cancelRefetch: false },
      )),
      ...patches.map(([id, runs]) => patchHistory(id, runs)),
    ]);
  }, 200);

  function requestRefresh(ids?: readonly string[], revision?: number) {
    const visible = visibleIds();
    for (const id of ids || visible) {
      if (!visible.has(id)) continue;
      if (revision !== undefined) {
        if ((histories.get(id)?.revision ?? -1) >= revision) continue;
        requiredRevision.set(id, Math.max(requiredRevision.get(id) || 0, revision));
      }
      dirty.add(id);
      dirtyRuns.delete(id);
    }
    if (dirty.size) refresh.request();
  }

  function requestRunUpdates(runs: AgentRun[], revision: number, ids: readonly string[] = []) {
    const visible = visibleIds();
    const covered = new Set<string>();
    for (const run of runs) {
      const id = run.conversationId || run.id;
      if (!visible.has(id)) continue;
      covered.add(id);
      const history = histories.get(id);
      if (!history?.runs.some(item => item.id === run.id) || dirty.has(id)) {
        requestRefresh([id], revision);
        continue;
      }
      if (history.revision >= revision || (receipts.get(id)?.get(run.id)?.revision ?? -1) >= revision) continue;
      const updates = dirtyRuns.get(id) || new Map<string, number>();
      updates.set(run.id, Math.max(updates.get(run.id) || 0, revision));
      dirtyRuns.set(id, updates);
    }
    requestRefresh(ids.filter(id => !covered.has(id)), revision);
    if (dirtyRuns.size) refresh.request();
  }

  async function patchHistory(id: string, updates: Map<string, number>) {
    const controller = new AbortController();
    readingRuns.set(id, controller);
    try {
      const results = await Promise.allSettled([...updates].map(async ([runId, expected]) => {
        const response = await fetch(`/api/agent-runtimes/runs/${encodeURIComponent(runId)}`, { signal: controller.signal });
        if (!response.ok) throw new Error('运行记录已更新');
        const revision = Number(response.headers.get('X-Agent-Revision'));
        const run: AgentRun = await response.json();
        controller.signal.throwIfAborted();
        if (!Number.isSafeInteger(revision) || revision < expected || run.id !== runId
          || (run.conversationId && run.conversationId !== id)) throw new Error('运行记录已更新');
        if (!histories.get(id)?.runs.some(item => item.id === runId)) throw new Error('运行记录已更新');
        applyReceipt({ ...run, conversationId: id }, revision);
      }));
      if (!controller.signal.aborted && results.some(result => result.status === 'rejected'))
        requestRefresh([id], Math.max(...updates.values()));
    } finally {
      if (readingRuns.get(id) === controller) readingRuns.delete(id);
    }
  }

  function retain(id: string) {
    recentlyViewed.delete(id);
    recentlyViewed.add(id);
    const visible = visibleIds();
    for (const candidate of recentlyViewed) {
      if (recentlyViewed.size <= retainedConversations) break;
      if (visible.has(candidate)) continue;
      recentlyViewed.delete(candidate);
      histories.delete(candidate);
      receipts.delete(candidate);
      requiredRevision.delete(candidate);
      readingOlder.get(candidate)?.abort();
      readingRuns.get(candidate)?.abort();
    }
  }

  function applyReceipt(run: AgentRun, revision: number) {
    const id = run.conversationId || run.id;
    const history = histories.get(id);
    if (!history || history.revision >= revision) return;
    const pending = receipts.get(id) || new Map();
    if ((pending.get(run.id)?.revision ?? -1) >= revision) return;
    pending.set(run.id, { revision, run });
    receipts.set(id, pending);
    histories.set(id, { ...history, runs: mergeRuns([run], history.runs) });
  }

  function reconcileIndex(revision: number, runs: AgentRun[]) {
    if (retainedIndex && retainedIndex.revision > revision) return;
    const retained = new Set(runs.map(run => run.id));
    retainedIndex = { revision, runIds: retained };
    for (const [id, history] of histories) {
      if (history.revision > revision) continue;
      const remaining = history.runs.filter(run => retained.has(run.id));
      if (remaining.length === history.runs.length) continue;
      const olderCursor = history.olderCursor && !retained.has(history.olderCursor)
        ? remaining.at(-1)?.id ?? null : history.olderCursor;
      histories.set(id, { ...history, runs: remaining, olderCursor });
    }
  }

  function reset() {
    generation++;
    retainedIndex = undefined;
    requiredRevision.clear();
    receipts.clear();
    dirtyRuns.clear();
    for (const controller of readingOlder.values()) controller.abort();
    for (const controller of readingRuns.values()) controller.abort();
    for (const [id, history] of histories) histories.set(id, { ...history, revision: -1 });
    requestRefresh();
  }

  function useHistory(readId: () => string | undefined) {
    const id = computed(() => readId() || '');
    observed.add(id);
    watch(id, (value, previous) => {
      if (value) retain(value);
      if (previous && !visibleIds().has(previous)) {
        requiredRevision.delete(previous);
        readingRuns.get(previous)?.abort();
      }
    }, { immediate: true });
    onScopeDispose(() => observed.delete(id));
    const query = useQuery({
      queryKey: computed(() => historyKey(id.value)),
      enabled: computed(() => !!id.value),
      gcTime: cacheLifetime,
      staleTime: 0,
      retry: false,
      refetchInterval: () => connected.value ? false : 3_000,
      queryFn: async ({ signal, queryKey: [, key] }) => {
        const epoch = generation;
        const page = await readPage(key, signal);
        const previous = histories.get(key);
        if (epoch !== generation || (previous && previous.revision > page.revision)) return page.revision;
        const pending = receipts.get(key);
        const recent: AgentRun[] = [];
        for (const [runId, receipt] of pending || []) {
          if (receipt.revision <= page.revision) pending?.delete(runId);
          else recent.push(receipt.run);
        }
        if (pending && !pending.size) receipts.delete(key);
        const index = retainedIndex;
        const pageRuns = index && index.revision >= page.revision
          ? page.runs.filter(run => index.runIds.has(run.id)) : page.runs;
        const pageCursor = page.olderCursor && index && index.revision >= page.revision
          && !index.runIds.has(page.olderCursor) ? pageRuns.at(-1)?.id ?? null : page.olderCursor;
        const head = recent.length ? mergeRuns(recent, pageRuns) : pageRuns;
        histories.set(key, {
          revision: page.revision,
          runs: previous?.loadedOlder ? mergeRuns(head, previous.runs) : head,
          olderCursor: previous?.loadedOlder ? previous.olderCursor : pageCursor,
          loadedOlder: previous?.loadedOlder || false,
        });
        if ((requiredRevision.get(key) ?? -1) > page.revision) requestRefresh([key]);
        else requiredRevision.delete(key);
        return page.revision;
      },
    }, client);
    const history = computed(() => histories.get(id.value));

    async function loadOlder() {
      const key = id.value;
      const base = history.value;
      const before = base?.olderCursor;
      if (!key || !base || !before || readingOlder.has(key)) return;
      const controller = new AbortController();
      readingOlder.set(key, controller);
      try {
        let page: AgentConversationHistoryPage;
        try { page = await readPage(key, controller.signal, before); }
        catch (error) {
          if (!(error instanceof Error) || !('status' in error) || error.status !== 409) throw error;
          await client.refetchQueries({ queryKey: agentConversationIndexKey, exact: true, type: 'active' },
            { cancelRefetch: false });
          controller.signal.throwIfAborted();
          const cursor = histories.get(key)?.olderCursor;
          if (!cursor) return;
          if (cursor === before) throw error;
          page = await readPage(key, controller.signal, cursor);
        }
        const current = histories.get(key);
        if (!current) return;
        const index = retainedIndex;
        const baseRuns = index && index.revision >= base.revision
          ? base.runs.filter(run => index.runIds.has(run.id)) : base.runs;
        const pageRuns = index && index.revision >= page.revision
          ? page.runs.filter(run => index.runIds.has(run.id)) : page.runs;
        const runs = mergeRuns(current.runs, mergeRuns(baseRuns, pageRuns));
        const olderCursor = page.olderCursor && index && index.revision >= page.revision
          && !index.runIds.has(page.olderCursor) ? runs.at(-1)?.id ?? null : page.olderCursor;
        histories.set(key, {
          ...current,
          runs,
          olderCursor,
          loadedOlder: true,
        });
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        if (readingOlder.get(key) === controller) readingOlder.delete(key);
      }
    }

    return {
      runs: computed(() => history.value?.runs ?? []),
      ready: computed(() => !!history.value),
      loading: computed(() => !!id.value && !history.value && (query.isPending.value || query.isFetching.value)),
      error: query.error,
      olderCursor: computed(() => history.value?.olderCursor ?? null),
      loadingOlder: computed(() => readingOlder.has(id.value)),
      loadOlder,
      refresh: () => { if (id.value) requestRefresh([id.value]); },
    };
  }

  onScopeDispose(() => {
    refresh.close();
    for (const controller of readingOlder.values()) controller.abort();
    for (const controller of readingRuns.values()) controller.abort();
  });
  return { useHistory, applyReceipt, reconcileIndex, requestRefresh, requestRunUpdates, reset };
}
