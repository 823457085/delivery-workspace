// Trusted local code runs in its own process, not in the workspace server.
import { connectStdioMcp } from './application-mcp.mjs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [entry, dataDirectory, workspaceDirectory] = process.argv.slice(2);
let application, configuration = {};
const calls = new Map();
function hostCall(type, input) {
  if (closing) return Promise.reject(new Error('插件正在停止'));
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { calls.delete(id); reject(new Error('能力调用超时，结果待核对')); }, 60000);
    calls.set(id, { resolve, reject, timer }); process.send?.({ type, id, input });
  });
}
const capabilities = { call: (name, method, input, provider) => hostCall('host-capability', {name, version:1, method, input, provider}) };
const workspaces = {
  access: () => hostCall('host-workspaces', { method: 'access' }),
  list: () => hostCall('host-workspaces', { method: 'list' }),
  preview: path => hostCall('host-workspaces', { method: 'preview', input: {path} }),
  remove: input => hostCall('host-workspaces', { method: 'remove', input }),
};
const connections = new Set(), shutdown = new AbortController();
const mcp = { async connect(options) {
  const connection = await connectStdioMcp({ ...options, signal: shutdown.signal });
  if (closing) { await connection.close(); throw new Error('插件正在停止'); }
  connections.add(connection);
  const close = connection.close; connection.close = async () => { try { await close(); } finally { connections.delete(connection); } };
  return connection;
} };
process.on('message', async message => {
  if (message?.type === 'host-capability-result') { const call=calls.get(message.id); if(call){clearTimeout(call.timer);calls.delete(message.id);message.error?call.reject(new Error(message.error)):call.resolve(message.result);} return; }
  if (message?.type === 'initialize') { configuration = Object.freeze(message.configuration || {}); return; }
  if (!message || message.type !== 'request') return;
  try {
    application ||= Promise.resolve(import(pathToFileURL(entry).href)).then(module => module.createPlugin({ dataDirectory, workspaceDirectory, configuration, mcp, capabilities, workspaces }));
    const result = await (await application).request(message.method, message.input);
    process.send?.({ id: message.id, result });
  } catch (error) { process.send?.({ id: message.id, error: error instanceof Error ? error.message : '插件执行失败' }); }
});
let closing = false;
async function close() {
  if (closing) return; closing = true;
  const timer = setTimeout(() => process.exit(1), 2500);
  shutdown.abort();
  for (const call of calls.values()) { clearTimeout(call.timer); call.reject(new Error('插件已停止，结果待核对')); } calls.clear();
  try { await Promise.allSettled([(async () => (await application)?.close?.())(), ...[...connections].map(c => c.close())]); } finally { clearTimeout(timer); process.exit(0); }
}
process.on('SIGTERM', close);
process.on('disconnect', close);
