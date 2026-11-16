import path from 'node:path';
import { fileURLToPath } from 'node:url';
const origin = process.argv[2] || 'http://localhost:5199';
const url = new URL(origin);
if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('请提供本机工作台地址');
if (!process.argv.includes('--trust-local-code')) throw new Error('此插件运行本机代码，具有当前用户权限。核对来源后加 --trust-local-code 明确信任；它不是系统沙箱。');
const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'package');
async function request(action, body) {
  const response = await fetch(`${url.origin}/api/custom-plugins${action ? '/' + action : ''}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url.origin, 'X-Delivery-Confirmed': 'yes' }, body: JSON.stringify(body) } : {});
  const result = await response.json(); if (!response.ok) throw new Error(result.message || '插件请求失败'); return result;
}
const inspected = await request('inspect', { directory });
const existing = (await request('')).plugins.find(p => p.manifest.id === inspected.manifest.id);
if (existing) {
  if (existing.digest !== inspected.digest) throw new Error('已安装的是不同版本，未覆盖其授权和数据，请先处理版本迁移');
  console.log('插件已添加，保留现有启停、授权与菜单设置。');
} else {
  await request('install', { directory, digest: inspected.digest, grants: inspected.manifest.permissions, confirmed: true, trustedLocalCode: true, showInMenu: true });
  console.log('Go 实训已作为自定义插件添加。');
}
console.log(`${url.origin}/agent?view=plugins&plugin=${inspected.manifest.id}`);
