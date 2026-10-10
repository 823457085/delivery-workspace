import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { connectCodexDesktopThread, desktopObject as object, type DesktopObject } from '../server/codex-desktop-ipc.js';

const threadId = '33333333-3333-3333-3333-333333333333';
const ownerId = 'desktop-owner';
const frame = (value: DesktopObject) => {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
};

async function peer(options: { version?: number; stateId?: string; owner?: boolean; wrongReceipt?: boolean; invalidFrame?: boolean } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-desktop-ipc-'));
  const socketPath = path.join(directory, 'ipc.sock');
  const sockets = new Set<net.Socket>();
  const received: DesktopObject[] = [];
  let snapshots = 0;
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const size = buffer.readUInt32LE(0);
        const message = object(JSON.parse(buffer.subarray(4, size + 4).toString()));
        buffer = buffer.subarray(size + 4); received.push(message);
        const respond = (result: DesktopObject, method = message.method, handledByClientId = ownerId) => {
          const bytes = frame({ type: 'response', requestId: message.requestId, resultType: 'success', method, handledByClientId, result });
          // Exercise fragmented headers and payloads without relying on TCP packet boundaries.
          socket.write(bytes.subarray(0, 2)); socket.write(bytes.subarray(2, 8)); socket.write(bytes.subarray(8));
        };
        if (message.method === 'initialize') {
          if (options.invalidFrame) { socket.write(Buffer.from([255, 255, 255, 127])); continue; }
          respond({ clientId: 'delivery-client' });
        } else if (message.method === 'thread-owner-discovery') {
          socket.write(frame({ type: 'client-discovery-request', requestId: 'foreign-request', request: { method: 'unsupported' } }));
          if (options.owner === false) socket.write(frame({ type: 'response', requestId: message.requestId, resultType: 'error', error: 'no-client-found' }));
          else respond({ supportsUntrustedAppInput: true });
        } else if (message.method === 'thread-stream-following-changed') {
          if (object(message.params).following !== true) continue;
          snapshots++;
          const params = { hostId: 'local', conversationId: threadId, change: { type: 'snapshot', revision: snapshots,
            conversationState: { id: options.stateId || threadId, hostId: 'local', cwd: directory,
              resumeState: 'resumed', threadRuntimeStatus: { type: 'idle' } } } };
          socket.write(frame({ type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: 'unrelated-client', params }));
          socket.write(frame({ type: 'broadcast', method: 'thread-stream-state-changed', version: options.version ?? 11, sourceClientId: ownerId, params }));
        } else if (message.method === 'thread-follower-start-turn') {
          respond({ result: { turn: { id: 'accepted-turn' } } }, message.method, options.wrongReceipt ? 'unrelated-client' : ownerId);
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  return { directory, socketPath, received, get snapshots() { return snapshots; },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

test('desktop IPC 使用本用户 socket、身份握手与 owner 定向请求，隔离其他会话广播', async () => {
  const p = await peer();
  try {
    const desktop = await connectCodexDesktopThread(threadId, { socketPath: p.socketPath });
    try {
      const first = await desktop.snapshot();
      const second = await desktop.snapshot();
      assert.equal(first.id, threadId); assert.equal(second.id, threadId); assert.equal(p.snapshots, 2);
      const response = await desktop.request('thread-follower-start-turn', { conversationId: threadId }, 2);
      assert.equal(object(object(response.result).turn).id, 'accepted-turn');
      const request = p.received.find(message => message.method === 'thread-follower-start-turn');
      assert.equal(request?.targetClientId, ownerId);
      assert.equal(request?.sourceClientId, 'delivery-client'); assert.equal(request?.version, 2);
      const refusal = p.received.find(message => message.type === 'client-discovery-response');
      assert.deepEqual(refusal?.response, { canHandle: false });
    } finally { desktop.close(); }
  } finally { await p.close(); }
});

test('desktop 协议不兼容或会话 ID 不一致时拒绝，不发送任务', async () => {
  for (const options of [{ version: 99 }, { stateId: 'another-thread' }]) {
    const p = await peer(options);
    try {
      const desktop = await connectCodexDesktopThread(threadId, { socketPath: p.socketPath, timeoutMs: 200 });
      try { await assert.rejects(desktop.snapshot(), /不兼容|不一致/); }
      finally { desktop.close(); }
      assert.ok(!p.received.some(message => message.method === 'thread-follower-start-turn'));
    } finally { await p.close(); }
  }
});

test('desktop owner 不存在、帧非法以及其他 owner 的回执均保守失败', async () => {
  for (const options of [{ owner: false }, { invalidFrame: true }]) {
    const p = await peer(options);
    try { await assert.rejects(connectCodexDesktopThread(threadId, { socketPath: p.socketPath }), /no-client-found|响应长度异常/); }
    finally { await p.close(); }
  }
  const p = await peer({ wrongReceipt: true });
  try {
    const desktop = await connectCodexDesktopThread(threadId, { socketPath: p.socketPath });
    try { await assert.rejects(desktop.request('thread-follower-start-turn', { conversationId: threadId }, 2), /持有者不一致/); }
    finally { desktop.close(); }
  } finally { await p.close(); }
});

test('不连接可被其他用户替换的 desktop socket', { skip: process.platform === 'win32' }, async () => {
  const p = await peer();
  try {
    await fs.chmod(p.directory, 0o777);
    await assert.rejects(connectCodexDesktopThread(threadId, { socketPath: p.socketPath }), /权限不安全/);
    assert.equal(p.received.length, 0);
  } finally { await fs.chmod(p.directory, 0o700); await p.close(); }
});
