import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export async function signHubSession(request: IncomingMessage, response: ServerResponse, root: string, port: number) {
  const host = request.headers.host || '';
  const local = port === 5288 && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress || '')
    && ['127.0.0.1:5288', 'localhost:5288'].includes(host);
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end(); return; }
  if (!local || request.headers.origin !== `http://${host}` || request.headers['sec-fetch-site'] !== 'same-origin') {
    response.writeHead(403).end(); return;
  }
  try {
    const token = (await readFile(path.join(root, '.local', 'sign-hub', 'data', 'admin.token'), 'utf8')).trim();
    const cookie = request.headers.cookie?.split(';').map(value => value.trim()).find(value => /^sign_ui=[a-f0-9]{64}$/.test(value));
    const upstream = await fetch('http://127.0.0.1:8990/api/ui-session', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, ...(cookie ? { Cookie: cookie } : {}) },
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
    });
    if (upstream.status !== 204) { await upstream.body?.cancel(); response.writeHead(503).end(); return; }
    const session = upstream.headers.getSetCookie().find(value => /^sign_ui=[a-f0-9]{64};/.test(value));
    if (session) response.setHeader('Set-Cookie', session);
    response.writeHead(204).end();
  } catch {
    response.writeHead(503).end();
  }
}
