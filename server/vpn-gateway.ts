/**
 * Mac 的私人 VPN 入口复用现有转发和同源保护，只绑定已连接的指定隧道地址。
 * 不管理 VPN 密钥或服务器，不监听公网，也不放宽主服务；避免另建一套代理和登录系统。
 */
import os from 'node:os';
import { isIPv4 } from 'node:net';
import { createLanGateway } from './lan-gateway.js';

function privateIPv4(address: string): boolean {
  if (!isIPv4(address)) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function vpnGatewayConfig(env = process.env, interfaces = os.networkInterfaces()) {
  const address = env.DELIVERY_VPN_ADDRESS?.trim() ?? '';
  if (!privateIPv4(address)) throw new Error('DELIVERY_VPN_ADDRESS 必须是指定 VPN 的私有 IPv4 地址');
  const clients = (env.DELIVERY_VPN_CLIENTS ?? '').split(',').map((value) => value.trim());
  if (clients.some((client) => !privateIPv4(client) || client === address)) {
    throw new Error('DELIVERY_VPN_CLIENTS 必须为逗号分隔的远端设备私有 IPv4 地址，不允许空值、网段或本机入口地址');
  }
  const network = Object.entries(interfaces).flatMap(([name, entries]) => /^utun\d+$/.test(name) ? entries ?? [] : [])
    .find((entry) => entry.family === 'IPv4' && !entry.internal && entry.address === address);
  if (!network) throw new Error('指定 VPN 地址尚未分配给本机 utun 隧道，请先连接私人 VPN');
  return { network: { address, netmask: network.netmask }, clients: [...new Set(clients)] };
}

export async function startVpnGateway() {
  const { network, clients } = vpnGatewayConfig();
  const server = createLanGateway(network, 5199, clients);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(5199, network.address, () => { server.off('error', reject); resolve(); });
  });
  console.log(`Delivery VPN: http://${network.address}:5199/agent（仅指定 VPN 设备可访问）`);
  const stop = () => { server.closeAllConnections(); server.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
