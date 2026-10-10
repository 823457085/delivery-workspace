/** 固定映射内嵌业务接口，保留业务状态唯一来源；拒绝任意 URL 和未确认的写操作。 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SourceBackend } from './source-backend.js';

export const READ_ROUTES: Record<string, string> = {
  config: '/api/config', issues: '/api/issues', users: '/api/users',
  automation: '/api/automation', catchup: '/api/automation/catchup',
  merge: '/api/automation/catchup/merge-plan', projects: '/api/local-projects',
  meeting: '/meeting-snapshot.json', 'merge-jira': '/api/automation/catchup/merge/jira-completion',
  artifact: '/api/automation/artifact', document: '/api/automation/catchup/document',
  evidence: '/api/automation/catchup/merge/evidence',
};
export const WRITE_ROUTES: Record<string, string> = {
  settings: '/api/automation/settings', scan: '/api/automation/scan',
  'weekly-report': '/api/automation/weekly-report/generate',
  'job-update': '/api/automation/jobs/update', 'catchup-action': '/api/automation/catchup/actions',
  'merge-action': '/api/automation/catchup/merge/actions',
  'merge-jira': '/api/automation/catchup/merge/jira-completion',
  'project-label': '/api/local-projects/label', 'project-open': '/api/local-projects/open',
  'meeting-sync': '/api/meeting/confluence-sync',
};

export function resolveSourceRoute(key: string, method: string, confirmed = false) {
  if (method === 'GET' && Object.hasOwn(READ_ROUTES, key)) return READ_ROUTES[key];
  if (method === 'POST' && Object.hasOwn(WRITE_ROUTES, key)) {
    if (!confirmed) throw new Error('必须先确认此操作对原系统的影响');
    return WRITE_ROUTES[key];
  }
  throw new Error('未开放的来源接口或请求方法');
}

export async function proxySource(request: IncomingMessage, response: ServerResponse, url: URL, backend: Pick<SourceBackend, 'dispatch'>) {
  if (request.method === 'POST') {
    // 先验证浏览器到面板这一跳，再进入固定的内嵌路由；不能绕过确认和来源防护。
    const hosts = [`localhost:${request.socket.localPort}`, `127.0.0.1:${request.socket.localPort}`];
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '');
    const trusted = local && hosts.includes(request.headers.host ?? '') && hosts.some((host) => request.headers.origin === `http://${host}`);
    const confirmed = request.headers['x-delivery-confirmed'] === 'yes';
    const json = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() === 'application/json';
    if (!trusted || !confirmed || !json) {
      response.writeHead(!trusted || !confirmed ? 403 : 415, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ message: !trusted ? '请求来源不匹配，请从本机面板重新确认操作' : !confirmed ? '必须先确认此操作对原系统的影响' : '请发送 JSON' }));
      return;
    }
  }
  const key = url.pathname.slice('/api/source/'.length);
  const pathname = resolveSourceRoute(key, request.method ?? 'GET', request.headers['x-delivery-confirmed'] === 'yes');
  await backend.dispatch(request, response, `${pathname}${url.search}`);
}
