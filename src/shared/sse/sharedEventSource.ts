/**
 * 跨标签页 + 同标签页共享 SSE 总线。
 *
 * 解决痛点：Chrome 对同源 HTTP/1.1（如 http://127.0.0.1:5288）全浏览器最多允许 6 条并发 TCP 连接。
 * 若每个工作台标签页各自打开 3~5 条长连接 EventSource，开 2 个以上标签页就会占满全部 6 个连接槽位，
 * 导致「更新工作台 (POST /api/workspace/restart)」与普通请求长期处于 Pending / Stalled（卡在“正在提交更新”）。
 *
 * 方案：
 * 1. 同标签页内同 URL 复用同一订阅通道（消除重复 EventSource）。
 * 2. 多标签页通过 Web Locks 选出唯一 Leader 标签页，仅由 Leader 建立 1 条聚合 `/api/workspace/events` 连接
 *    （旧版后端未重启前若返回 404，自动降级为仅 Leader 建立单路连接），其余所有标签页通过 BroadcastChannel 零连接同步。
 * 3. 点击重启时通过 `suspendSharedEventSources` 广播立即释放所有标签页物理 SSE 连接，确保重启请求与健康轮询零排队。
 */

const CHANNEL_NAME = 'delivery-workspace-sse-v1';
const LOCK_NAME = 'delivery-workspace-sse-leader-v1';

export const WORKSPACE_MULTIPLEX_URLS = [
  '/api/agent-runtimes/events?updates=runs',
  '/api/agent-runtimes/team-tasks/events',
  '/api/workflow/events',
] as const;

const MULTIPLEX_SET = new Set<string>(WORKSPACE_MULTIPLEX_URLS);

type Listener = (event: Event) => void;

interface WireEnvelope {
  url: string;
  event: string;
  data: string;
  id?: string;
}

type BroadcastPayload =
  | { type: 'event'; envelope: WireEnvelope }
  | { type: 'status'; url: string | '*'; connected: boolean }
  | { type: 'sync-request' }
  | { type: 'sync-state'; connectedUrls: string[]; readyByUrl: Record<string, string> }
  | { type: 'suspend'; until: number }
  | { type: 'resume' };

class VirtualEventSource {
  readonly url: string;
  readyState = 0; // CONNECTING = 0, OPEN = 1, CLOSED = 2
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly onCloseCallback: (instance: VirtualEventSource) => void;

  constructor(url: string, onCloseCallback: (instance: VirtualEventSource) => void) {
    this.url = url;
    this.onCloseCallback = onCloseCallback;
  }

  addEventListener(type: string, listener: Listener | EventListenerOrEventListenerObject | null): void {
    if (!listener) return;
    const fn: Listener = typeof listener === 'function'
      ? listener
      : event => listener.handleEvent(event);
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }

  removeEventListener(type: string, listener: Listener | EventListenerOrEventListenerObject | null): void {
    if (!listener || typeof listener !== 'function') return;
    this.listeners.get(type)?.delete(listener);
  }

  emitOpen(): void {
    if (this.readyState === 2) return;
    this.readyState = 1;
    this.dispatch('open', new Event('open'));
  }

  emitError(): void {
    if (this.readyState === 2) return;
    this.readyState = 0;
    this.dispatch('error', new Event('error'));
  }

  emitMessage(eventName: string, data: string, lastEventId = ''): void {
    if (this.readyState === 2) return;
    if (this.readyState === 0) this.emitOpen();
    const message = new MessageEvent(eventName, { data, lastEventId });
    this.dispatch(eventName, message);
  }

  close(): void {
    if (this.readyState === 2) return;
    this.readyState = 2;
    this.listeners.clear();
    this.onCloseCallback(this);
  }

  private dispatch(type: string, event: Event): void {
    const handlers = this.listeners.get(type);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try { handler(event); } catch { /* 单个订阅者异常不影响总线其他监听方 */ }
    }
  }
}

const TEAM_EVENT_TYPES = ['ready', 'workflow.updated', 'workflow.message', 'workflow.intent', 'workflow.decision'] as const;
const RUN_EVENT_TYPES = ['ready', 'refresh', 'runs'] as const;
const WORKFLOW_EVENT_TYPES = ['ready', 'refresh'] as const;

function knownEventsForUrl(url: string): readonly string[] {
  if (url.startsWith('/api/agent-runtimes/team-tasks/events')) return TEAM_EVENT_TYPES;
  if (url.startsWith('/api/agent-runtimes/events')) return RUN_EVENT_TYPES;
  if (url.startsWith('/api/workflow/events')) return WORKFLOW_EVENT_TYPES;
  return ['ready', 'refresh', 'message'];
}

class WorkspaceSseHub {
  private readonly subscribers = new Map<string, Set<VirtualEventSource>>();
  private readonly directSources = new Map<string, EventSource>();
  private readonly connectedUrls = new Set<string>();
  private readonly lastReadyByUrl = new Map<string, string>();
  private channel: BroadcastChannel | null = null;
  private isLeader = false;
  private leaderRelease: (() => void) | null = null;
  private requestingLeadership = false;
  private multiplexSource: EventSource | null = null;
  private legacySources = new Map<string, EventSource>();
  private useLegacyLeaderFallback = false;
  private probingMultiplex = false;
  private suspendedUntil = 0;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.channel = new BroadcastChannel(CHANNEL_NAME);
        (this.channel as unknown as { unref?: () => void }).unref?.();
        this.channel.onmessage = ( raw: MessageEvent<BroadcastPayload> ) => this.onBroadcast(raw.data);
      } catch {
        this.channel = null;
      }
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => this.releaseLeadership());
      window.addEventListener('beforeunload', () => this.releaseLeadership());
    }
  }

  open(url: string): EventSource {
    if (typeof EventSource === 'undefined') {
      return new VirtualEventSource(url, () => {}) as unknown as EventSource;
    }
    const virtual = new VirtualEventSource(url, instance => this.unsubscribe(instance));
    let bucket = this.subscribers.get(url);
    if (!bucket) {
      bucket = new Set();
      this.subscribers.set(url, bucket);
    }
    bucket.add(virtual);

    if (MULTIPLEX_SET.has(url)) {
      this.ensureMultiplexParticipation();
      if (this.connectedUrls.has(url)) {
        queueMicrotask(() => {
          if (virtual.readyState === 2) return;
          virtual.emitOpen();
          const readyData = this.lastReadyByUrl.get(url);
          if (readyData !== undefined) virtual.emitMessage('ready', readyData);
        });
      } else {
        this.post({ type: 'sync-request' });
      }
    } else {
      this.ensureDirectSource(url);
      if (this.connectedUrls.has(url)) {
        queueMicrotask(() => {
          if (virtual.readyState === 2) return;
          virtual.emitOpen();
          const readyData = this.lastReadyByUrl.get(url);
          if (readyData !== undefined) virtual.emitMessage('ready', readyData);
        });
      }
    }
    return virtual as unknown as EventSource;
  }

  suspend(durationMs = 10_000, broadcast = true): void {
    const until = Date.now() + Math.max(1000, durationMs);
    this.suspendedUntil = Math.max(this.suspendedUntil, until);
    if (broadcast) this.post({ type: 'suspend', until: this.suspendedUntil });
    this.closeAllPhysicalSources();
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      this.suspendedUntil = 0;
      this.reconnectActive();
    }, Math.max(1000, this.suspendedUntil - Date.now()));
    (this.resumeTimer as unknown as { unref?: () => void }).unref?.();
  }

  resume(broadcast = true): void {
    this.suspendedUntil = 0;
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
    this.useLegacyLeaderFallback = false;
    if (broadcast) this.post({ type: 'resume' });
    this.reconnectActive();
  }

  private isSuspended(): boolean {
    return Date.now() < this.suspendedUntil;
  }

  private hasMultiplexSubscribers(): boolean {
    for (const url of MULTIPLEX_SET) {
      if ((this.subscribers.get(url)?.size || 0) > 0) return true;
    }
    return false;
  }

  private unsubscribe(instance: VirtualEventSource): void {
    const bucket = this.subscribers.get(instance.url);
    if (!bucket) return;
    bucket.delete(instance);
    if (bucket.size === 0) {
      this.subscribers.delete(instance.url);
      const direct = this.directSources.get(instance.url);
      if (direct) {
        direct.close();
        this.directSources.delete(instance.url);
        this.connectedUrls.delete(instance.url);
      }
    }
    if (!this.hasMultiplexSubscribers() && this.isLeader) {
      this.releaseLeadership();
    }
  }

  private ensureMultiplexParticipation(): void {
    if (this.isSuspended()) return;
    if (this.isLeader) {
      this.ensureLeaderTransport();
      return;
    }
    if (this.requestingLeadership) return;
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (!locks?.request || !this.channel) {
      this.isLeader = true;
      this.ensureLeaderTransport();
      return;
    }
    this.requestingLeadership = true;
    void locks.request(LOCK_NAME, () => new Promise<void>(resolve => {
      this.isLeader = true;
      this.leaderRelease = resolve;
      if (!this.isSuspended()) this.ensureLeaderTransport();
    })).catch(() => {
      this.isLeader = true;
      if (!this.isSuspended()) this.ensureLeaderTransport();
    }).finally(() => {
      this.isLeader = false;
      this.leaderRelease = null;
      this.requestingLeadership = false;
    });
  }

  private releaseLeadership(): void {
    this.closeLeaderSources();
    if (this.leaderRelease) {
      const release = this.leaderRelease;
      this.leaderRelease = null;
      this.isLeader = false;
      release();
    }
  }

  private ensureLeaderTransport(): void {
    if (!this.isLeader || this.isSuspended()) return;
    if (this.useLegacyLeaderFallback) {
      this.ensureLegacyLeaderSources();
      return;
    }
    if (this.multiplexSource) return;
    let openedOnce = false;
    const source = new EventSource('/api/workspace/events');
    this.multiplexSource = source;
    source.addEventListener('open', () => {
      openedOnce = true;
      for (const url of WORKSPACE_MULTIPLEX_URLS) this.markConnected(url, true, true);
    });
    source.addEventListener('envelope', event => {
      try {
        const envelope = JSON.parse((event as MessageEvent<string>).data) as WireEnvelope;
        if (!envelope?.url || !envelope.event) return;
        this.deliverEnvelope(envelope, true);
      } catch { /* 忽略格式异常帧 */ }
    });
    source.addEventListener('error', () => {
      for (const url of WORKSPACE_MULTIPLEX_URLS) this.markConnected(url, false, true);
      if (!openedOnce && !this.probingMultiplex && !this.isSuspended()) {
        this.probingMultiplex = true;
        void this.probeMultiplexSupport().finally(() => { this.probingMultiplex = false; });
      }
    });
  }

  private async probeMultiplexSupport(): Promise<void> {
    try {
      const response = await fetch('/api/workspace/events?probe=1', {
        method: 'GET',
        cache: 'no-store',
        signal: AbortSignal.timeout(1200),
      });
      if (response.status === 404 && this.isLeader && !this.isSuspended()) {
        this.useLegacyLeaderFallback = true;
        this.multiplexSource?.close();
        this.multiplexSource = null;
        this.ensureLegacyLeaderSources();
      }
    } catch { /* 服务重启窗口内连接中断属预期行为，等待重连即可 */ }
  }

  private ensureLegacyLeaderSources(): void {
    if (!this.isLeader || this.isSuspended()) return;
    for (const url of WORKSPACE_MULTIPLEX_URLS) {
      if (this.legacySources.has(url)) continue;
      const source = new EventSource(url);
      this.legacySources.set(url, source);
      source.addEventListener('open', () => this.markConnected(url, true, true));
      source.addEventListener('error', () => this.markConnected(url, false, true));
      for (const eventName of knownEventsForUrl(url)) {
        source.addEventListener(eventName, event => {
          const message = event as MessageEvent<string>;
          this.deliverEnvelope({ url, event: eventName, data: message.data ?? '', id: message.lastEventId || undefined }, true);
        });
      }
    }
  }

  private ensureDirectSource(url: string): void {
    if (this.isSuspended() || this.directSources.has(url)) return;
    const source = new EventSource(url);
    this.directSources.set(url, source);
    source.addEventListener('open', () => this.markConnected(url, true, false));
    source.addEventListener('error', () => this.markConnected(url, false, false));
    for (const eventName of knownEventsForUrl(url)) {
      source.addEventListener(eventName, event => {
        const message = event as MessageEvent<string>;
        this.deliverEnvelope({ url, event: eventName, data: message.data ?? '', id: message.lastEventId || undefined }, false);
      });
    }
  }

  private markConnected(url: string, connected: boolean, broadcast: boolean): void {
    if (connected) {
      this.connectedUrls.add(url);
      for (const sub of this.subscribers.get(url) || []) sub.emitOpen();
    } else {
      this.connectedUrls.delete(url);
      for (const sub of this.subscribers.get(url) || []) sub.emitError();
    }
    if (broadcast) this.post({ type: 'status', url, connected });
  }

  private deliverEnvelope(envelope: WireEnvelope, broadcast: boolean): void {
    this.connectedUrls.add(envelope.url);
    if (envelope.event === 'ready') this.lastReadyByUrl.set(envelope.url, envelope.data);
    for (const sub of this.subscribers.get(envelope.url) || []) {
      sub.emitMessage(envelope.event, envelope.data, envelope.id);
    }
    if (broadcast) this.post({ type: 'event', envelope });
  }

  private closeLeaderSources(): void {
    if (this.multiplexSource) {
      this.multiplexSource.close();
      this.multiplexSource = null;
    }
    for (const source of this.legacySources.values()) source.close();
    this.legacySources.clear();
  }

  private closeAllPhysicalSources(): void {
    this.closeLeaderSources();
    for (const source of this.directSources.values()) source.close();
    this.directSources.clear();
    for (const url of [...this.connectedUrls]) this.markConnected(url, false, false);
  }

  private reconnectActive(): void {
    if (this.isSuspended()) return;
    if (this.hasMultiplexSubscribers()) this.ensureMultiplexParticipation();
    for (const url of this.subscribers.keys()) {
      if (!MULTIPLEX_SET.has(url)) this.ensureDirectSource(url);
    }
  }

  private post(payload: BroadcastPayload): void {
    try { this.channel?.postMessage(payload); } catch { /* 忽略页面卸载期广播异常 */ }
  }

  private onBroadcast(payload: BroadcastPayload): void {
    if (!payload || typeof payload !== 'object') return;
    switch (payload.type) {
      case 'event':
        if (!this.isLeader) this.deliverEnvelope(payload.envelope, false);
        break;
      case 'status':
        if (!this.isLeader) {
          if (payload.url === '*') {
            for (const url of WORKSPACE_MULTIPLEX_URLS) this.markConnected(url, payload.connected, false);
          } else {
            this.markConnected(payload.url, payload.connected, false);
          }
        }
        break;
      case 'sync-request':
        if (this.isLeader) {
          this.post({
            type: 'sync-state',
            connectedUrls: [...this.connectedUrls].filter(url => MULTIPLEX_SET.has(url)),
            readyByUrl: Object.fromEntries(this.lastReadyByUrl),
          });
        }
        break;
      case 'sync-state':
        if (!this.isLeader) {
          for (const [url, readyData] of Object.entries(payload.readyByUrl)) {
            this.lastReadyByUrl.set(url, readyData);
          }
          for (const url of payload.connectedUrls) {
            this.markConnected(url, true, false);
            const readyData = payload.readyByUrl[url];
            if (readyData !== undefined) {
              for (const sub of this.subscribers.get(url) || []) sub.emitMessage('ready', readyData);
            }
          }
        }
        break;
      case 'suspend':
        this.suspend(Math.max(1000, payload.until - Date.now()), false);
        break;
      case 'resume':
        this.resume(false);
        break;
    }
  }
}

let singletonHub: WorkspaceSseHub | null = null;

function getHub(): WorkspaceSseHub {
  return singletonHub ??= new WorkspaceSseHub();
}

export function openSharedEventSource(url: string): EventSource {
  return getHub().open(url);
}

export function suspendSharedEventSources(durationMs = 10_000): void {
  singletonHub?.suspend(durationMs, true);
}

export function resumeSharedEventSources(): void {
  singletonHub?.resume(true);
}

export function installSharedEventSourceHub(): void {
  (globalThis as { __deliveryOpenEventSource?: (url: string) => EventSource }).__deliveryOpenEventSource = openSharedEventSource;
}
