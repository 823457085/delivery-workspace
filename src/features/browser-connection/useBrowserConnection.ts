import { computed, onBeforeUnmount, shallowRef, watch } from 'vue';
import type { BrowserConnectionStatus } from '../../../shared/browser-connection';
import { changeBrowserConnection, readBrowserConnection, type BrowserConnectionAction } from './api';

interface BrowserConnectionApi {
  read(signal: AbortSignal): Promise<BrowserConnectionStatus>;
  change(action: BrowserConnectionAction, signal: AbortSignal): Promise<BrowserConnectionStatus>;
}

/** 设置页与会话弹层共用一次探测；没有可见入口时停止轮询及在途读取。 */
export function createBrowserConnectionState(api: BrowserConnectionApi = { read: readBrowserConnection, change: changeBrowserConnection },
  // 原生计时器必须以全局对象为 this 调用；直接存成对象方法会在浏览器中抛出 Illegal invocation。
  timers: { set: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>; clear: (id: ReturnType<typeof setTimeout>) => void }
    = { set: (handler, ms) => setTimeout(handler, ms), clear: id => clearTimeout(id) }) {
  const status = shallowRef<BrowserConnectionStatus>();
  const busy = shallowRef<BrowserConnectionAction | 'read' | ''>('');
  const error = shallowRef('');
  const viewers = new Set<symbol>();
  let generation = 0;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function stopPolling() {
    if (timer !== undefined) timers.clear(timer);
    timer = undefined;
  }
  function cancel() {
    generation++;
    controller?.abort();
    controller = undefined;
    busy.value = '';
    stopPolling();
  }
  function schedule() {
    stopPolling();
    const phase = status.value?.phase;
    const interval = error.value ? 5000 : phase === 'connected' ? 10_000
      : phase === 'connecting' || phase === 'reconnecting' ? 1500 : 0;
    if (viewers.size && interval) timer = timers.set(() => { timer = undefined; void refresh(); }, interval);
  }
  async function run(action?: BrowserConnectionAction) {
    if (!viewers.size || busy.value && busy.value !== 'read') return;
    cancel();
    const current = ++generation;
    const request = new AbortController();
    controller = request;
    busy.value = action || 'read';
    error.value = '';
    try {
      const value = action ? await api.change(action, request.signal) : await api.read(request.signal);
      if (current !== generation || !viewers.size) return;
      status.value = value;
      return value;
    } catch (cause) {
      if (current !== generation || request.signal.aborted) return;
      error.value = cause instanceof Error ? cause.message : '浏览器连接操作失败';
      if (action) throw cause;
    } finally {
      if (current === generation) {
        controller = undefined;
        busy.value = '';
        schedule();
      }
    }
  }
  const refresh = () => run();
  const act = (action: BrowserConnectionAction) => run(action);
  function activate(id: symbol) {
    if (viewers.has(id)) return;
    viewers.add(id);
    if (viewers.size === 1) void refresh();
  }
  function deactivate(id: symbol) {
    viewers.delete(id);
    if (!viewers.size) cancel();
  }
  return { status, busy, error, refresh, act, activate, deactivate };
}

const connection = createBrowserConnectionState();

export function useBrowserConnection(active: () => boolean) {
  const viewer = Symbol('browser-connection');
  watch(active, value => value ? connection.activate(viewer) : connection.deactivate(viewer), { immediate: true, flush: 'sync' });
  onBeforeUnmount(() => connection.deactivate(viewer));
  return { ...connection, status: computed(() => connection.status.value), busy: computed(() => connection.busy.value), error: computed(() => connection.error.value) };
}
