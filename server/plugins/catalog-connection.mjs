/** Only explicitly configured loopback endpoints may use plaintext HTTP. */
export function catalogEndpoint(value, transport = 'http') {
  if (!['http', 'mcp'].includes(transport)) throw new Error('请选择 HTTP 或 MCP 连接');
  let url;
  try { url = new URL(value); } catch { throw new Error('请填写有效的市场连接地址'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('市场连接不能包含账号密码、查询参数或片段');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) throw new Error('远端市场须使用 HTTPS；HTTP 仅允许本机回环地址');
  // Do not trust DNS resolution of a plaintext localhost endpoint.
  if (url.hostname === 'localhost' && url.protocol === 'http:') url.hostname = '127.0.0.1';
  if (transport === 'http' && !url.pathname.endsWith('.json')) url.pathname = url.pathname.replace(/\/$/, '') + '/catalog.json';
  if (transport === 'mcp' && url.pathname === '/') url.pathname = '/mcp';
  return url;
}
