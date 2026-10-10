/**
 * 网络入口独立于工作台进程：LAN 校验同网段，VPN 使用明确的设备白名单，再校验请求来源。
 * 不放宽主服务的本机校验，也不重启正在执行任务的服务；写操作仍由原接口要求用户确认。
 */
import http from 'node:http';
import os from 'node:os';
import { isIPv4 } from 'node:net';
import { createWorkspaceBrowserRoute } from './workspace-browser.js';

type LanInterface = { address: string; netmask: string };

export function lanInterfaces(interfaces = os.networkInterfaces()): LanInterface[] {
  return Object.entries(interfaces).flatMap(([name, entries]) => {
    // macOS 的有线和 Wi-Fi 网卡；不监听 VPN、虚拟网卡或公网地址。
    if (!/^en\d+$/.test(name)) return [];
    return (entries ?? []).filter((entry) => {
      const [a, b] = entry.address.split('.').map(Number);
      return entry.family === 'IPv4' && !entry.internal &&
        (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168));
    }).map(({ address, netmask }) => ({ address, netmask }));
  });
}

export function sameSubnet(client: string, network: LanInterface): boolean {
  const address = client.replace(/^::ffff:/, '');
  if (![address, network.address, network.netmask].every(isIPv4)) return false;
  const mask = network.netmask.split('.').map(Number);
  const target = network.address.split('.').map(Number);
  return address.split('.').every((part, i) => (Number(part) & mask[i]) === (target[i] & mask[i]));
}

function cleanHeaders(original: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const headers = { ...original };
  const connectionHeaders = String(headers.connection ?? '').split(',').map((name) => name.trim().toLowerCase());
  for (const name of [...connectionHeaders, 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']) delete headers[name];
  return headers;
}

export function createLanGateway(network: LanInterface, upstreamPort = 5199, allowedClients?: readonly string[]) {
  if (allowedClients?.some((address) => !isIPv4(address))) throw new Error('设备白名单必须为独立 IPv4 地址');
  // VPN 不继承整个网段的信任；空白名单拒绝所有设备，且不读取可伪造的代理头。
  const clients = allowedClients === undefined ? undefined : new Set(allowedClients);
  const workspaceBrowser = createWorkspaceBrowserRoute();
  return http.createServer((request, response) => {
    const reject = (status: number, message: string) => {
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(message);
    };
    const host = `${network.address}:${request.socket.localPort}`;
    const origin = `http://${host}`;
    const remoteAddress = (request.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    const allowed = clients ? clients.has(remoteAddress) : sameSubnet(remoteAddress, network);
    if (request.headers.host !== host || !allowed) {
      reject(403, '仅接受已授权网络地址访问'); return;
    }
    const safe = request.method === 'GET' || request.method === 'HEAD';
    const fetchSite = request.headers['sec-fetch-site'];
    if ((request.headers.origin && request.headers.origin !== origin) || (!safe && request.headers.origin !== origin) ||
      (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none')) {
      reject(403, '请求来源不匹配'); return;
    }
    if (!request.url?.startsWith('/') || request.url.startsWith('//')) { reject(400, '请求路径不正确'); return; }
    const pathname = new URL(request.url, origin).pathname;
    if (pathname === '/api/workspace/browse' || pathname === '/api/workspace/select-directory') {
      void workspaceBrowser(request, response, pathname.endsWith('/browse') ? 'browse' : 'select');
      return;
    }

    const headers = cleanHeaders(request.headers);
    for (const name of Object.keys(headers)) {
      if (name === 'authorization' || name === 'forwarded' || name === 'x-real-ip' || name.startsWith('x-forwarded-')) delete headers[name];
    }
    headers.host = `127.0.0.1:${upstreamPort}`;
    if (request.headers.origin) headers.origin = `http://${headers.host}`;
    // 不注入 X-Delivery-Confirmed；原接口继续检查用户是否确认了写操作。
    const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort, method: request.method, path: request.url, headers }, (result) => {
      response.writeHead(result.statusCode ?? 502, { ...cleanHeaders(result.headers), 'cache-control': 'no-store' });
      result.on('error', () => response.destroy());
      result.pipe(response);
    });
    upstream.on('error', () => {
      if (response.destroyed) return;
      if (response.headersSent) response.destroy();
      else reject(502, '本机工作台暂时不可用');
    });
    request.on('aborted', () => upstream.destroy());
    request.on('error', () => upstream.destroy());
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  });
}

export async function startLanGateway() {
  const networks = lanInterfaces();
  if (!networks.length) throw new Error('没有可用的有线或 Wi-Fi 私有 IPv4 地址');
  const servers = networks.map((network) => createLanGateway(network));
  const stop = () => {
    for (const server of servers) { server.closeAllConnections(); server.close(); }
  };
  try {
    for (const [index, server] of servers.entries()) {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(5199, networks[index].address, () => { server.off('error', reject); resolve(); });
      });
      console.log(`Delivery LAN: http://${networks[index].address}:5199/agent`);
    }
  } catch (error) { stop(); throw error; }
  console.log('局域网入口免登录，仅供可信同网段设备使用，请勿配置公网端口转发。');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
