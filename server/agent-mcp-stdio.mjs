/** Thin MCP stdio frontend. Only the host broker executes tools; stdout is protocol only. */
import net from 'node:net';
import { randomUUID } from 'node:crypto';

const socketPath = process.env.DELIVERY_BRIDGE_SOCKET;
const token = process.env.DELIVERY_BRIDGE_TOKEN;
delete process.env.DELIVERY_BRIDGE_TOKEN;
delete process.env.DELIVERY_BRIDGE_SOCKET;
if (!socketPath || !token) process.exit(1);
const socket = net.createConnection(socketPath);
const pending = new Map();
const ids = new Set();
let input = Buffer.alloc(0), replies = Buffer.alloc(0), initialized = false, closed = false;
const send = value => {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 700_000) return stop();
  process.stdout.write(text + '\n');
};
const error = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
const stop = () => {
  if (closed) return;
  closed = true;
  socket.destroy();
  process.stdin.pause();
  // Host disconnect cancels in-flight tools; no reconnect or silent retry.
  for (const { id, timer } of pending.values()) { clearTimeout(timer); error(id, -32000, '宿主工具连接已断开，禁止自动重放'); }
  pending.clear();
  process.exitCode = 1;
};
function forward(id, method, args = {}) {
  if (pending.size >= 32) return stop();
  const requestId = randomUUID();
  const timer = setTimeout(stop, 60_000);
  pending.set(requestId, { id, method, timer });
  socket.write(JSON.stringify({ token, id: requestId, method, ...args }) + '\n');
}
function message(frame) {
  if (closed) return;
  if (!frame || frame.jsonrpc !== '2.0' || typeof frame.method !== 'string') { error(null, -32600, 'Invalid Request'); return; }
  if (!Object.hasOwn(frame, 'id')) {
    if (frame.method === 'notifications/cancelled') stop();
    return;
  }
  const id = frame.id;
  if (!(typeof id === 'string' && id.length <= 200 || typeof id === 'number' && Number.isSafeInteger(id))) { error(null, -32600, 'Invalid Request'); return; }
  const key = `${typeof id}:${id}`;
  if (ids.has(key)) { error(id, -32600, 'Duplicate request ID'); return; }
  ids.add(key);
  if (ids.size > 1000) return stop();
  if (frame.method === 'initialize') {
    if (initialized) { error(id, -32600, 'Already initialized'); return; }
    initialized = true;
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} },
      serverInfo: { name: 'delivery-host-tools', version: '1.0.0' } } });
  } else if (!initialized) error(id, -32002, 'Not initialized');
  else if (frame.method === 'ping') send({ jsonrpc: '2.0', id, result: {} });
  else if (frame.method === 'tools/list') forward(id, 'list');
  else if (frame.method === 'tools/call') {
    if (!frame.params || typeof frame.params.name !== 'string' || Object.keys(frame.params).some(key => !['name', 'arguments'].includes(key))) {
      error(id, -32602, 'Invalid tool parameters'); return;
    }
    forward(id, 'call', { name: frame.params.name, args: frame.params.arguments });
  } else error(id, -32601, 'Method not found');
}
process.stdin.on('data', chunk => {
  input = Buffer.concat([input, chunk]);
  if (input.length > 1_100_000) return stop();
  let end;
  while ((end = input.indexOf(10)) >= 0) {
    const line = input.subarray(0, end); input = input.subarray(end + 1);
    try { message(JSON.parse(line.toString('utf8'))); } catch { error(null, -32700, 'Parse error'); }
  }
});
socket.on('data', chunk => {
  replies = Buffer.concat([replies, chunk]);
  if (replies.length > 700_000) return stop();
  let end;
  while ((end = replies.indexOf(10)) >= 0) {
    const line = replies.subarray(0, end); replies = replies.subarray(end + 1);
    try {
      const frame = JSON.parse(line.toString('utf8'));
      const request = pending.get(frame.id);
      if (!request) return stop();
      pending.delete(frame.id); clearTimeout(request.timer);
      if (request.method === 'list') send({ jsonrpc: '2.0', id: request.id, result: { tools: frame.result } });
      else send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(frame.error ? { error: frame.error } : frame.result) }], isError: !!frame.isError } });
    } catch { stop(); }
  }
});
socket.on('error', stop);
socket.on('close', stop);
process.stdin.on('end', () => { socket.end(); });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, stop);
