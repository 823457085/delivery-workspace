/** 首次部署生成独立登录密码，明文只留在 Mac 的用户私有目录，不上传服务器或写入仓库。 */
import { mkdir, writeFile, lstat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { passwordRecord } from './gateway.mjs';

const originValue = process.env.DELIVERY_REMOTE_ORIGIN;
const username = process.env.DELIVERY_REMOTE_USERNAME;
if (!originValue || !username?.trim()) throw new Error('请设置 DELIVERY_REMOTE_ORIGIN 与 DELIVERY_REMOTE_USERNAME');
const origin = new URL(originValue);
if (origin.protocol !== 'https:' || !/^\d+\.\d+\.\d+\.\d+$/.test(origin.hostname) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('远程入口必须为无凭证的精确 HTTPS IPv4 origin');
if (!/^[a-zA-Z0-9_-]{1,64}$/.test(username.trim())) throw new Error('远程用户名只允许 1 至 64 位字母、数字、下划线或短横线');
const upstreamPort = Number(process.env.DELIVERY_REMOTE_UPSTREAM_PORT || 15199);
const macHost = process.env.DELIVERY_REMOTE_UPSTREAM_HOST || '127.0.0.1:5220';
if (!Number.isInteger(upstreamPort) || upstreamPort < 1024 || upstreamPort > 65535 || !/^127\.0\.0\.1:\d+$/.test(macHost)) throw new Error('隧道必须使用固定回环端口');
const directory = process.env.DELIVERY_REMOTE_CONFIG_DIR || path.join(os.homedir(), '.config/delivery-remote');
await mkdir(directory, { recursive: true, mode: 0o700 });
const stat = await lstat(directory);
if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) throw new Error('凭据目录权限不安全');
const password = randomBytes(24).toString('base64url');
const credentials = await passwordRecord(username.trim(), password);
await writeFile(path.join(directory, 'config.json'), JSON.stringify({
  origin: origin.origin, upstreamPort, macHost,
  cert: process.env.DELIVERY_REMOTE_CERT || '/etc/delivery-remote/tls/fullchain.pem', key: process.env.DELIVERY_REMOTE_KEY || '/etc/delivery-remote/tls/privkey.pem', ...credentials,
}, null, 2), { mode: 0o600, flag: 'wx' });
await writeFile(path.join(directory, 'login.json'), JSON.stringify({
  url: new URL('/remote/login', origin).href, username: username.trim(), password,
}, null, 2), { mode: 0o600, flag: 'wx' });
console.log('独立登录凭据已生成到用户配置目录（权限 600），未输出密码');
