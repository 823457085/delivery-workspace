import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createBrowserConnection } from './browser-connection.js';
import { chromeRelayPrefix } from './chrome-cdp-relay.js';

const [command, rootDirectory, socketPath, debugPortFile] = process.argv.slice(2);
if (!rootDirectory || !socketPath) throw new Error('Chrome 连接后台缺少本机路径。');

if (command === 'launch') {
  // 启动器退出后，Chrome 进程不在工作台的进程树内，PM2 重启 5288 时也不会结束它。
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url),
    'serve', rootDirectory, socketPath, debugPortFile ?? ''], { detached: true, stdio: 'ignore' });
  await once(child, 'spawn');
  child.unref();
} else if (command === 'serve') {
  const connection = createBrowserConnection({ rootDirectory, debugPortFile: debugPortFile || undefined });
  const relay = http.createServer((_request, response) => response.writeHead(404).end());
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  const { port } = relay.address() as { port: number };
  relay.on('upgrade', (request, socket, head) => {
    if (request.url?.startsWith(chromeRelayPrefix)) connection.upgrade(request, socket, head, port);
    else socket.destroy();
  });

  const actions = new Map<string, () => Promise<unknown>>([
    ['GET /status', connection.status],
    ['GET /task-endpoint', () => connection.taskEndpoint(port)],
    ['POST /open-settings', connection.openSettings],
    ['POST /connect', () => connection.connect()],
    ['POST /disconnect', connection.disconnect],
  ]);
  let lastActionAt = Date.now();
  const control = http.createServer(async (request, response) => {
    const action = actions.get(`${request.method} ${request.url}`);
    if (!action) { response.writeHead(404).end(); return; }
    if (request.method === 'POST') lastActionAt = Date.now();
    try {
      const result = await action();
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result ?? null));
    } catch {
      response.writeHead(500).end();
    }
  });
  control.listen(socketPath);
  try { await once(control, 'listening'); }
  catch (error) { relay.close(); throw error; }

  function stop() {
    clearInterval(idle);
    void connection.disconnect().catch(() => {});
    control.close();
    control.closeAllConnections();
    relay.close();
    relay.closeAllConnections();
  }
  const idle = setInterval(() => {
    if (Date.now() - lastActionAt >= 60_000 && !connection.keepsConnection()) stop();
  }, 10_000);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
} else {
  throw new Error('Chrome 连接后台启动命令无效。');
}
