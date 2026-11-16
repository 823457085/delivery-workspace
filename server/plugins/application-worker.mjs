// Trusted local code runs in its own process, not in the workspace server.
import { connectStdioMcp } from './application-mcp.mjs';
import { pathToFileURL } from 'node:url';
const [entry, dataDirectory, workspaceDirectory] = process.argv.slice(2);
let application, configuration = {};
const connections = new Set(), shutdown = new AbortController();
const mcp = { async connect(options) {
  const connection = await connectStdioMcp({ ...options, signal: shutdown.signal });
  if (closing) { await connection.close(); throw new Error('插件正在停止'); }
  connections.add(connection);
  const close = connection.close; connection.close = async () => { try { await close(); } finally { connections.delete(connection); } };
  return connection;
} };
process.on('message', async message => {
  if (message?.type === 'initialize') { configuration = Object.freeze(message.configuration || {}); return; }
  if (!message || message.type !== 'request') return;
  try {
    application ||= Promise.resolve(import(pathToFileURL(entry).href)).then(module => module.createPlugin({ dataDirectory, workspaceDirectory, configuration, mcp }));
    const result = await (await application).request(message.method, message.input);
    process.send?.({ id: message.id, result });
  } catch (error) { process.send?.({ id: message.id, error: error instanceof Error ? error.message : '插件执行失败' }); }
});
let closing = false;
async function close() {
  if (closing) return; closing = true;
  const timer = setTimeout(() => process.exit(1), 2500);
  shutdown.abort();
  try { await Promise.allSettled([(async () => (await application)?.close?.())(), ...[...connections].map(c => c.close())]); } finally { clearTimeout(timer); process.exit(0); }
}
process.on('SIGTERM', close);
process.on('disconnect', close);
