/**
 * 独立的 HTTPS 登录边界：服务器只保存密码散列、会话和 TLS 密钥，通过固定回环隧道访问 Mac。
 * 不迁移工作台数据，不放宽原服务保护，不做代理任意地址；登录前所有业务资源一律拒绝。
 */
import https from 'node:https';
import http from 'node:http';
import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';

const derive = promisify(scrypt);
const template = readFileSync(new URL('./login.html', import.meta.url), 'utf8');
const cookieName = '__Host-delivery_session';
const sessionDuration = 12 * 60 * 60 * 1000;
const rememberedSessionDuration = 30 * 24 * 60 * 60 * 1000;
const digest = (value) => createHash('sha256').update(value).digest('hex');

export async function passwordRecord(username, password) {
  const salt = randomBytes(32).toString('hex');
  return { username, salt, hash: (await derive(password, salt, 64)).toString('hex') };
}

function cleanHeaders(original) {
  const headers = { ...original };
  const connection = String(headers.connection ?? '').split(',').map(value => value.trim().toLowerCase());
  for (const key of [...connection, 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']) delete headers[key];
  return headers;
}

export function createGateway(config, { now = Date.now } = {}) {
  const origin = new URL(config.origin);
  if (origin.protocol !== 'https:' || origin.origin !== config.origin || !/^\d+\.\d+\.\d+\.\d+$/.test(origin.hostname)) throw new Error('请配置精确的 HTTPS IP 入口');
  if (!Number.isInteger(config.upstreamPort) || config.upstreamPort < 1024 || config.upstreamPort > 65535 || !/^127\.0\.0\.1:\d+$/.test(config.macHost)) throw new Error('隧道必须使用固定回环端口');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(config.username) || !/^[a-f0-9]{64}$/.test(config.salt) || !/^[a-f0-9]{128}$/.test(config.hash)) throw new Error('登录配置不正确');
  const sessions = new Map();
  const attempts = new Map();
  let globalWindow = { count: 0, until: 0 };
  let verifying = 0;
  function revoke(key) {
    const session = sessions.get(key);
    sessions.delete(key);
    if (session) for (const response of session.streams) response.destroy();
  }
  const timer = setInterval(() => {
    for (const [key, session] of sessions) if (session.until <= now()) revoke(key);
    for (const [key, value] of attempts) if (value.until <= now()) attempts.delete(key);
  }, 30_000).unref();
  const security = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' };
  function send(response, status, body, headers = {}) {
    response.writeHead(status, { ...security, 'Content-Type': 'text/plain; charset=utf-8', ...headers });
    response.end(body);
  }
  const redirect = (response, location, headers = {}) => send(response, 303, '', { Location: location, ...headers });
  function page(response, status = 200, message = '', signedIn = false) {
    const content = signedIn
      ? '<h2>已登录</h2><a class="enter" href="/agent">进入工作台</a><form method="post" action="/remote/logout"><button class="secondary">退出登录</button></form>'
      : `<h2>登录工作台</h2><form method="post" action="/remote/login"><label for="username">账号</label><input id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="64" required><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="256" required><label class="remember"><input name="remember" type="checkbox" value="yes">记住登录（30 天）</label><p class="error" role="alert">${message}</p><button type="submit">登录</button></form>`;
    send(response, status, template.replace('<!--CONTENT-->', content), {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
  }
  function sessionFor(request) {
    const cookies = String(request.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${cookieName}=`));
    if (cookies.length !== 1) return {};
    const token = cookies[0].slice(cookieName.length + 1);
    if (!/^[a-f0-9]{64}$/.test(token)) return {};
    const key = digest(token);
    const session = sessions.get(key);
    if (session && session.until <= now()) { revoke(key); return {}; }
    return { key, session };
  }
  async function handle(request, response) {
    // X-Forwarded-* 不参与鉴权，只有直连 TLS 入口的 Host、Origin 和实际来源地址可信。
    if (request.headers.host !== origin.host) return send(response, 403, '入口地址不匹配');
    if (!request.url?.startsWith('/') || request.url.startsWith('//')) return send(response, 400, '请求路径不正确');
    const url = new URL(request.url, origin);
    const safe = request.method === 'GET' || request.method === 'HEAD';
    const fetchSite = request.headers['sec-fetch-site'];
    // 允许外部链接打开公开登录页；不读取会话，也不向业务接口放行跨站请求。
    const externalNavigation = request.method === 'GET' && ['cross-site', 'same-site'].includes(fetchSite) &&
      request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document';
    if (externalNavigation && ['/', '/agent', '/remote/login'].includes(url.pathname)) {
      if (url.pathname === '/remote/login') return page(response);
      return redirect(response, '/remote/login');
    }
    if ((request.headers.origin && request.headers.origin !== origin.origin) || (!safe && request.headers.origin !== origin.origin) || (fetchSite && !['same-origin', 'none'].includes(fetchSite))) {
      return send(response, 403, '请求来源不匹配');
    }
    const { key, session } = sessionFor(request);
    if (url.pathname === '/remote/login') {
      if (request.method === 'GET') return page(response, 200, '', !!session);
      if (request.method !== 'POST') return send(response, 405, '请求方法不支持');
      if (request.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') return send(response, 415, '请通过登录表单提交');
      const ip = request.socket.remoteAddress;
      if (globalWindow.until <= now()) globalWindow = { count: 0, until: now() + 60_000 };
      const previous = attempts.get(ip);
      const attempt = previous && previous.until > now() ? previous : { count: 0, until: now() + 15 * 60_000 };
      if (attempt.count >= 5 || globalWindow.count >= 100 || verifying >= 4 || (!previous && attempts.size >= 4096)) return page(response, 429, '尝试过于频繁，请稍后再试');
      attempt.count++; globalWindow.count++; attempts.set(ip, attempt);
      let data = '';
      for await (const chunk of request) {
        data += chunk;
        if (Buffer.byteLength(data) > 4096) return send(response, 413, '登录内容过长');
      }
      const form = new URLSearchParams(data);
      const password = form.get('password') ?? '';
      if (!password || password.length > 256 || form.getAll('username').length !== 1 || form.getAll('password').length !== 1) return page(response, 401, '账号或密码错误');
      verifying++;
      let hash;
      try { hash = await derive(password, config.salt, 64); } finally { verifying--; }
      if (!timingSafeEqual(hash, Buffer.from(config.hash, 'hex')) || form.get('username') !== config.username) return page(response, 401, '账号或密码错误');
      attempts.delete(ip);
      if (key) revoke(key);
      if (sessions.size >= 32) revoke(sessions.keys().next().value);
      const token = randomBytes(32).toString('hex');
      const duration = form.getAll('remember').length === 1 && form.get('remember') === 'yes' ? rememberedSessionDuration : sessionDuration;
      sessions.set(digest(token), { until: now() + duration, streams: new Set() });
      return redirect(response, '/agent', { 'Set-Cookie': `${cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${duration / 1000}` });
    }
    if (!session) {
      if (safe && !url.pathname.startsWith('/api/')) return redirect(response, '/remote/login');
      return send(response, 401, JSON.stringify({ message: '请先登录远程工作台' }), { 'Content-Type': 'application/json; charset=utf-8' });
    }
    if (url.pathname === '/remote/logout') {
      if (request.method !== 'POST') return send(response, 405, '请通过登录页面退出');
      revoke(key);
      return redirect(response, '/remote/login', { 'Set-Cookie': `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
    }
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return send(response, 405, '请求方法不支持');
    // 保留业务显式确认语义，认证通过不等于授权每一个写操作。
    const directoryRead = request.method === 'POST' && ['/api/workspace/browse', '/api/workspace/select-directory'].includes(url.pathname);
    if (!safe && !directoryRead && request.headers['x-delivery-confirmed'] !== 'yes') return send(response, 403, '请在工作台确认此操作');
    const headers = cleanHeaders(request.headers);
    for (const name of Object.keys(headers)) if (['cookie', 'authorization', 'forwarded', 'x-real-ip'].includes(name) || name.startsWith('x-forwarded-')) delete headers[name];
    headers.host = config.macHost;
    if (request.headers.origin) headers.origin = `http://${config.macHost}`;
    // 隧道中不复用可能已被另一端回收的空闲 HTTP 连接，避免远程请求偶发 ECONNRESET。
    const upstream = http.request({ hostname: '127.0.0.1', port: config.upstreamPort, path: request.url, method: request.method, headers, agent: false }, result => {
      const resultHeaders = cleanHeaders(result.headers);
      delete resultHeaders['set-cookie'];
      // 不允许本机接口意外将浏览器导航到回环或其他站点。
      if (resultHeaders.location && (!resultHeaders.location.startsWith('/') || resultHeaders.location.startsWith('//'))) {
        result.resume(); send(response, 502, '上游返回了不支持的跳转'); return;
      }
      const acceptsGzip = /\bgzip\b/.test(String(request.headers['accept-encoding'] ?? ''));
      const compress = acceptsGzip && !resultHeaders['content-encoding'] && !resultHeaders['content-range'] && request.method !== 'HEAD' &&
        /^(application\/(json|javascript)|text\/(html|css|javascript)|image\/svg\+xml)/.test(String(resultHeaders['content-type'] ?? ''));
      if (compress) {
        delete resultHeaders['content-length'];
        resultHeaders['content-encoding'] = 'gzip';
        resultHeaders.vary = resultHeaders.vary ? `${resultHeaders.vary}, Accept-Encoding` : 'Accept-Encoding';
      }
      response.writeHead(result.statusCode ?? 502, { ...resultHeaders, ...security });
      result.on('error', () => response.destroy());
      // 外网压缩文本资源和大 JSON；SSE 不压缩、不缓存，保持实时事件即到即发。
      if (compress) {
        const gzip = createGzip({ level: 4 });
        gzip.on('error', () => response.destroy());
        response.once('close', () => gzip.destroy());
        result.pipe(gzip).pipe(response);
      } else result.pipe(response);
    });
    session.streams.add(response);
    upstream.setTimeout(120_000, () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', error => {
      if (response.destroyed) return;
      console.warn('Remote upstream unavailable:', error.code ?? 'timeout');
      if (response.headersSent) response.destroy();
      else send(response, 502, 'Mac 暂时离线，请确认工作台和安全隧道正在运行');
    });
    request.on('aborted', () => upstream.destroy());
    request.on('error', () => upstream.destroy());
    response.on('close', () => { session.streams.delete(response); if (!response.writableFinished) upstream.destroy(); });
    request.pipe(upstream);
  }
  return {
    handler(request, response) {
      void handle(request, response).catch(() => {
        if (response.headersSent) response.destroy();
        else send(response, 400, '请求未完成');
      });
    },
    close() { clearInterval(timer); for (const key of sessions.keys()) revoke(key); },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(readFileSync(process.argv[2] ?? '/etc/delivery-remote/config.json', 'utf8'));
  const gateway = createGateway(config);
  const tls = () => ({ key: readFileSync(config.key), cert: readFileSync(config.cert), minVersion: 'TLSv1.2' });
  const server = https.createServer({ ...tls(), maxHeaderSize: 8192 }, gateway.handler);
  server.maxConnections = 256;
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.listen(Number(new URL(config.origin).port || 443), '0.0.0.0', () => console.log('Delivery remote HTTPS gateway ready'));
  process.on('SIGUSR2', () => { try { server.setSecureContext(tls()); console.log('TLS certificate reloaded'); } catch { console.error('TLS reload failed'); } });
  const stop = () => { gateway.close(); server.closeAllConnections(); server.close(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
