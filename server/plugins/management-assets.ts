import fs from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
/** Only locally deployed, maintainer-approved static build artifacts. No remote iframe or source import. */
export async function servePluginCenter(request: IncomingMessage, response: ServerResponse, url: URL, root: string) {
  if (!url.pathname.startsWith('/plugin-center/')) return false;
  const file = url.pathname.slice('/plugin-center/'.length);
  const types: Record<string, string> = { 'index.html': 'text/html; charset=utf-8', 'center.js': 'text/javascript; charset=utf-8', 'center.css': 'text/css; charset=utf-8' };
  if (request.method !== 'GET' || !types[file]) { response.writeHead(404); response.end(); return true; }
  try {
    const target = path.join(root, file), stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 10_000_000) throw new Error('invalid artifact');
    response.writeHead(200, { 'Content-Type': types[file], 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src data:; frame-ancestors 'self'; form-action 'none'; base-uri 'none'" });
    response.end(await fs.readFile(target));
  } catch { response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('插件中心构建尚未部署。请配置 DELIVERY_PLUGIN_CENTER_DIR；已安装插件仍可从菜单打开。'); }
  return true;
}
