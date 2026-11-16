import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';

export const chromeRelayPrefix = '/api/browser/connection/session/';

type Peer = { client: WebSocket; root?: string; timer: ReturnType<typeof setTimeout> };
type Packet = { id?: number; method?: string; sessionId?: string; params?: { sessionId?: string }; result?: { sessionId?: string } };

/** 每个工具使用独立的 CDP browser session；只有设置页的连接直接进入 Chrome。 */
export function createChromeCdpRelay(upstream: { readyState: number; send(data: string): void }) {
  const route = chromeRelayPrefix + randomUUID();
  const server = new WebSocketServer({ noServer: true });
  const pending = new Map<number, Peer>();
  const sessions = new Map<string, Peer>();
  let nextId = 0;
  let closed = false;

  function send(message: object) {
    if (closed || upstream.readyState !== 1) return false;
    try { upstream.send(JSON.stringify(message)); return true; } catch { return false; }
  }
  function detach(sessionId: string) {
    send({ id: ++nextId, method: 'Target.detachFromTarget', params: { sessionId } });
  }
  function receive(value: unknown) {
    if (!value || typeof value !== 'object') return;
    const packet = value as Packet;
    const { id, sessionId, method } = packet;
    if (sessionId === undefined && id !== undefined) {
      const peer = pending.get(id);
      const root = packet.result?.sessionId;
      if (!peer) { if (root) detach(root); return; }
      pending.delete(id);
      if (!root || peer.client.readyState !== WebSocket.OPEN) {
        if (root) detach(root);
        peer.client.terminate();
        return;
      }
      peer.root = root;
      sessions.set(root, peer);
      clearTimeout(peer.timer);
      peer.client.resume();
      return;
    }
    if (sessionId === undefined) {
      if (method === 'Target.detachedFromTarget' && packet.params?.sessionId) {
        sessions.get(packet.params.sessionId)?.client.terminate();
      }
      return;
    }
    const peer = sessions.get(sessionId);
    if (!peer || peer.client.readyState !== WebSocket.OPEN) return;
    const child = packet.params?.sessionId;
    if (method === 'Target.attachedToTarget' && child) sessions.set(child, peer);
    if (method === 'Target.detachedFromTarget' && child) sessions.delete(child);
    if (peer.client.bufferedAmount > 64 * 1024 * 1024) { peer.client.terminate(); return; }
    peer.client.send(JSON.stringify({ ...packet, sessionId: sessionId === peer.root ? undefined : sessionId }));
  }

  function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, port: number) {
    if (closed || upstream.readyState !== 1 || request.url !== route
      || request.headers.host !== `127.0.0.1:${port}`
      || request.socket.remoteAddress !== '127.0.0.1' || request.headers.origin !== undefined
      || server.clients.size >= 32 || pending.size >= 32) { socket.destroy(); return; }
    server.handleUpgrade(request, socket, head, client => {
      const id = ++nextId;
      const peer: Peer = { client, timer: setTimeout(() => client.terminate(), 5_000) };
      client.on('error', () => client.terminate());
      client.on('close', () => {
        pending.delete(id);
        clearTimeout(peer.timer);
        for (const [session, owner] of sessions) if (owner === peer) sessions.delete(session);
        if (peer.root) detach(peer.root);
      });
      client.on('message', (data, binary) => {
        let packet: Packet;
        try { packet = JSON.parse(data.toString()); } catch { client.terminate(); return; }
        if (binary || !packet || !Number.isSafeInteger(packet.id) || typeof packet.method !== 'string') { client.terminate(); return; }
        const { id, method, params, sessionId = peer.root } = packet;
        if (!sessionId || sessions.get(sessionId) !== peer || method === 'Browser.close' || method === 'Target.attachToBrowserTarget') {
          client.send(JSON.stringify({ id, sessionId: packet.sessionId, error: { code: -32601, message: 'Chrome command or session is unavailable' } }));
          return;
        }
        if (!send({ id, method, params, sessionId })) client.terminate();
      });
      client.pause();
      pending.set(id, peer);
      if (!send({ id, method: 'Target.attachToBrowserTarget' })) { pending.delete(id); client.terminate(); }
    });
  }

  return { route, receive, upgrade, close() {
    closed = true;
    pending.clear();
    sessions.clear();
    for (const client of server.clients) client.terminate();
    server.close();
  } };
}
