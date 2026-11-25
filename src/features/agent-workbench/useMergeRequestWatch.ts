import { computed, onMounted, onScopeDispose, shallowRef, watch } from 'vue';
import { useQueries, useQueryClient } from '@tanstack/vue-query';
import { ElNotification } from 'element-plus';
import type { MergeRequestWatchStatus } from '../../../shared/merge-request-watch';

type Link = { path: string; url: string };
type Seen = { status: MergeRequestWatchStatus; time: number };
type WatchStore = { links: Record<string, Link>; seen: Record<string, Seen> };
const storageKey = 'delivery:conversation-merge-requests:v1';
const keyFor = (url: string) => ['agent-merge-request-watch', url];

function readStore(): WatchStore | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || 'null') as WatchStore | null;
    if (value?.links && value.seen) return value;
  } catch { /* Local preferences may be unavailable. */ }
}

async function fetchStatus(link: Link, signal?: AbortSignal): Promise<MergeRequestWatchStatus> {
  const response = await fetch('/api/projects/git/merge-request/watch', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(link), signal,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body.message === 'string' ? body.message : '');
  return body;
}

export function mergeRequestNotice(before: MergeRequestWatchStatus, after: MergeRequestWatchStatus): string[] {
  if (before.state !== after.state && after.state !== 'open') return [after.state === 'merged' ? '已合并' : '已关闭'];
  if (after.state !== 'open') return [];
  const notices: string[] = [];
  const newHead = !!(before.headSha && after.headSha && before.headSha !== after.headSha);
  if (after.checks === 'failed' && (before.checks !== 'failed' || newHead)) notices.push('流水线失败');
  if (after.checks === 'passed' && before.checks && (before.checks !== 'passed' || newHead)) notices.push('流水线通过');
  if (after.conflict === true && before.conflict !== true) notices.push('发现冲突');
  if (after.conflict === false && before.conflict === true) notices.push('冲突已解除');
  if (after.review && before.review !== after.review) {
    notices.push({ approved: '评审已通过', pending: '等待评审', 'changes-requested': '评审要求修改' }[after.review]);
  }
  return notices;
}

export function useMergeRequestWatch() {
  const client = useQueryClient();
  const initial = readStore();
  const links = shallowRef(initial?.links || {});
  const seen = shallowRef(initial?.seen || {});
  const distinct = computed(() => [...new Map(Object.values(links.value).map(link => [link.url, link] as const)).values()]);
  function save(update: (latest: WatchStore) => WatchStore) {
    const latest = readStore() || { links: links.value, seen: seen.value };
    const value = update(latest);
    try { localStorage.setItem(storageKey, JSON.stringify(value)); } catch { /* Keep the in-memory values. */ }
    links.value = value.links;
    seen.value = value.seen;
  }
  const sync = (event: StorageEvent) => {
    if (event.key !== storageKey) return;
    const latest = readStore();
    links.value = latest?.links || {};
    seen.value = latest?.seen || {};
  };
  onMounted(() => window.addEventListener('storage', sync));
  onScopeDispose(() => window.removeEventListener('storage', sync));

  const queries = useQueries({ queries: computed(() => distinct.value.map(link => ({
    queryKey: keyFor(link.url),
    queryFn: ({ signal }: { signal: AbortSignal }) => fetchStatus(link, signal),
    initialData: () => seen.value[link.url]?.status,
    initialDataUpdatedAt: () => seen.value[link.url]?.time,
    refetchInterval: (query: { state: { data?: MergeRequestWatchStatus } }) =>
      query.state.data?.state && query.state.data.state !== 'open' ? false : 120_000,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: seen.value[link.url]?.status.state === 'open' || !seen.value[link.url],
    retry: false,
  }))) });

  watch(queries, (results) => {
    const stored = readStore()?.seen || {};
    for (const query of results) {
      const current = query.data;
      if (!current || !distinct.value.some(link => link.url === current.url)) continue;
      const url = current.url;
      const prior = stored[url] || seen.value[url];
      if (prior && prior.time >= query.dataUpdatedAt) continue;
      if (prior) {
        const notices = mergeRequestNotice(prior.status, current);
        if (notices.length) ElNotification({ title: current.title, message: notices.join(' · '), type: current.checks === 'failed' || current.conflict ? 'warning' : 'info' });
      }
      const carry = !!prior && current.state === 'open' && (!current.headSha || current.headSha === prior.status.headSha);
      const status = carry ? { ...current, headSha: current.headSha ?? prior.status.headSha, checks: current.checks ?? prior.status.checks,
        review: current.review ?? prior.status.review, conflict: current.conflict ?? prior.status.conflict } : current;
      save(latest => ({ ...latest, seen: { ...latest.seen, [url]: { status, time: query.dataUpdatedAt } } }));
    }
  });

  function lookup(conversationId: string) {
    const link = links.value[conversationId];
    const status = link ? queries.value[distinct.value.findIndex(candidate => candidate.url === link.url)] : undefined;
    return { link, status: status?.data, error: status?.error, refreshing: status?.isFetching || false };
  }
  async function add(conversationId: string, link: Link) {
    const status = await fetchStatus(link);
    client.setQueryData(keyFor(status.url), status);
    save(latest => ({ links: { ...latest.links, [conversationId]: { ...link, url: status.url } },
      seen: { ...latest.seen, [status.url]: { status, time: Date.now() } } }));
  }
  async function refresh(conversationId: string) {
    const { link } = lookup(conversationId);
    if (link) await client.refetchQueries({ queryKey: keyFor(link.url), exact: true }, { throwOnError: true });
  }
  function remove(conversationId: string) {
    if (!links.value[conversationId]) return;
    save(latest => {
      const links = { ...latest.links };
      delete links[conversationId];
      const visible = new Set(Object.values(links).map(link => link.url));
      return { links, seen: Object.fromEntries(Object.entries(latest.seen).filter(([url]) => visible.has(url))) };
    });
  }
  function move(from: string, to: string) {
    if (from === to || !links.value[from] || links.value[to]) return;
    save(latest => {
      if (!latest.links[from] || latest.links[to]) return latest;
      const links = { ...latest.links, [to]: latest.links[from]! };
      delete links[from];
      return { ...latest, links };
    });
  }
  return { lookup, add, refresh, remove, move };
}
