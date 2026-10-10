/**
 * 桌面端已持有原会话时，使用其跨窗口协作协议；不删除锁、不创建替代会话。
 * 协议版本来自本机桌面端。版本不匹配、非本用户 socket 或未确认 owner 时均不发送任务。
 */
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { codexHome } from './cli-runtime.js';

export type DesktopObject = Record<string, unknown>;
export function desktopObject(value: unknown): DesktopObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as DesktopObject : {};
}

export async function connectCodexDesktopThread(threadId: string, options: { socketPath?: string; timeoutMs?: number } = {}) {
  const socketPath = options.socketPath || (process.platform === 'win32' ? '\\\\.\\pipe\\codex-ipc' : path.join(codexHome, 'ipc', 'ipc.sock'));
  const timeoutMs = options.timeoutMs ?? 5000;
  if (process.platform !== 'win32') {
    const [socketStat, parentStat] = await Promise.all([fs.lstat(socketPath), fs.lstat(path.dirname(socketPath))]);
    const uid = process.getuid?.();
    if (uid === undefined || !socketStat.isSocket() || socketStat.uid !== uid || !parentStat.isDirectory()
      || parentStat.uid !== uid || (parentStat.mode & 0o022)) throw new Error('Codex 桌面连接目录不属于当前用户或权限不安全');
  }
  const socket = net.createConnection(socketPath);
  const pending = new Map<string, { resolve(value: DesktopObject): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let buffer = Buffer.alloc(0);
  let clientId = '';
  let ownerId = '';
  let closedError: Error | undefined;
  let snapshotWaiter: { resolve(value: DesktopObject): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | undefined;
  const fail = (error: Error) => {
    closedError = error;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
    if (snapshotWaiter) { clearTimeout(snapshotWaiter.timer); snapshotWaiter.reject(error); snapshotWaiter = undefined; }
    socket.destroy();
  };
  const write = (message: DesktopObject) => {
    if (closedError) throw closedError;
    const body = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    socket.write(Buffer.concat([header, body]));
  };
  socket.on('error', error => fail(error));
  socket.on('close', () => fail(closedError || new Error('Codex 桌面连接已关闭')));
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    try {
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (!length || length > 64 * 1024 * 1024) throw new Error('Codex 桌面响应长度异常');
        if (buffer.length < length + 4) break;
        const message = desktopObject(JSON.parse(buffer.subarray(4, length + 4).toString('utf8')));
        buffer = buffer.subarray(length + 4);
        if (message.type === 'client-discovery-request') {
          write({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
        } else if (message.type === 'response') {
          const item = pending.get(String(message.requestId));
          if (!item) continue;
          pending.delete(String(message.requestId)); clearTimeout(item.timer);
          if (message.resultType !== 'success') item.reject(new Error(String(message.error || 'Codex 桌面请求失败')));
          else item.resolve(message);
        } else if (message.type === 'broadcast' && message.method === 'thread-stream-state-changed' && snapshotWaiter) {
          const params = desktopObject(message.params);
          const change = desktopObject(params.change);
          if (message.sourceClientId !== ownerId || params.hostId !== 'local' || params.conversationId !== threadId
            || change.type !== 'snapshot') continue;
          if (message.version !== 11) throw new Error('Codex 桌面会话协议版本不兼容');
          const state = desktopObject(change.conversationState);
          if (state.id !== threadId) throw new Error('Codex 桌面返回的会话 ID 不一致');
          clearTimeout(snapshotWaiter.timer); snapshotWaiter.resolve(state); snapshotWaiter = undefined;
        }
      }
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  });
  const request = (method: string, params: DesktopObject, version: number, requestTimeout = timeoutMs) => new Promise<DesktopObject>((resolve, reject) => {
    if (closedError) { reject(closedError); return; }
    const requestId = randomUUID();
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${method} 回执超时`)); }, requestTimeout);
    pending.set(requestId, { resolve, reject, timer });
    try { write({ type: 'request', requestId, sourceClientId: clientId, method, params, version,
      ...(ownerId ? { targetClientId: ownerId } : {}), timeoutMs: requestTimeout }); }
    catch (error) { clearTimeout(timer); pending.delete(requestId); reject(error); }
  });
  try {
    const initialized = await request('initialize', { clientType: 'delivery' }, 0);
    clientId = String(desktopObject(initialized.result).clientId || '');
    if (!clientId) throw new Error('Codex 桌面未确认连接身份');
    const owner = await request('thread-owner-discovery', { hostId: 'local', conversationId: threadId }, 1);
    ownerId = String(owner.handledByClientId || '');
    if (!ownerId) throw new Error('未找到 Codex 原会话的持有者');
    return {
      request: async (method: string, params: DesktopObject, version: number) => {
        const response = await request(method, params, version, 30_000);
        if (response.handledByClientId !== ownerId || response.method !== method) throw new Error('Codex 桌面回执与原会话持有者不一致');
        return desktopObject(response.result);
      },
      snapshot: () => new Promise<DesktopObject>((resolve, reject) => {
        if (closedError) { reject(closedError); return; }
        if (snapshotWaiter) { reject(new Error('已有会话状态读取未完成')); return; }
        const timer = setTimeout(() => { snapshotWaiter = undefined; reject(new Error('未能确认 Codex 原会话是否空闲')); }, timeoutMs);
        snapshotWaiter = { resolve, reject, timer };
        try { write({ type: 'broadcast', sourceClientId: clientId, method: 'thread-stream-following-changed', version: 1,
          targetClientIds: [ownerId], params: { hostId: 'local', conversationId: threadId, following: true } }); }
        catch (error) { clearTimeout(timer); snapshotWaiter = undefined; reject(error); }
      }),
      assertConnected: () => { if (closedError) throw closedError; },
      close: () => fail(new Error('Codex 桌面协作连接已结束')),
    };
  } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); throw error; }
}
