/** 手工浏览器回归夹具：启动时仅 GET 原快照，之后所有请求在内存服务中处理；绝不写入 5188。 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { proxySource, READ_ROUTES } from '../../server/source-proxy.js';
import type { AutomationData, CatchupData, MergeData, MeetingData } from '../../shared/hub.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const nativeFetch = globalThis.fetch;
async function read<T>(key: string): Promise<T> {
  const response = await nativeFetch(`http://127.0.0.1:5188${READ_ROUTES[key]}`);
  if (!response.ok) throw new Error(`Read fixture source ${key}: ${response.status}`);
  return response.json();
}
const [merge, catchup, automation] = await Promise.all([read<MergeData>('merge'), read<CatchupData>('catchup'), read<AutomationData>('automation')]);
// 例外合入回归使用真实领域逻辑，但不导入带调度副作用的 server，不读写实际状态文件。
const directMode = process.argv.includes('--direct-merge');
const pipeline = directMode ? await import(pathToFileURL(path.join(process.env.CATCHUP_APP_ROOT!, 'catchup-merge-pipeline.mjs')).href) : null;
const item = structuredClone(merge.items.find((value) => value.action?.action === 'approve') ?? merge.items[0]);
item.requirementId = 'REQ-999'; item.title = '隔离验收：迁移提交链路';
item.action = { enabled: true, action: 'approve', label: '截图审核通过，确认合入推送' };
item.status = 'AWAITING_REVIEW';
merge.items = [item]; merge.revision = 1; merge.target.branch = 'fixture/no-real-git';
let directState: unknown;
if (directMode) {
  Object.assign(item, { decision: 'READY', status: 'READY', sourceBranch: 'feature/fixture-only', sourceRemoteSha: 'a'.repeat(40), merged: false });
  merge.target.branch = 'feature/sync-demo-apex-master';
  directState = pipeline.normalizeCatchupMergePipelineState({ revision: 1, requirements: { 'REQ-999': {
    status: 'AWAITING_REVIEW', phase: 'preflight', error: '隔离：特殊环境不受支持',
    evidence: { summary: '隔离：保留失败结果', automatedChecks: [{ name: '环境检查', status: 'FAIL', evidence: '特殊环境不受支持' }], testResults: [{ tcId: 'REQ-999-TC-001', status: 'FAIL', evidence: '环境不可用' }] }
  } } });
}
catchup.requirements = []; catchup.executionRevision = 1;
automation.jobs = [{ ...automation.jobs[0], id: 'fixture-job', title: '隔离验收队列任务', status: 'blocked', error: '隔离旧状态', result: '' }];
automation.plan = []; automation.runs = [];
automation.settings.enabled = false; automation.settings.autoCreateCodex = false; automation.settings.autoTransitionJira = false; automation.settings.autoCreateMergeRequest = false;
const meeting: MeetingData = { localDate: '2099-01-01', scannedAt: '2099-01-01T01:00:00Z', schedule: '隔离验收', sectionTitle: '内存夹具', source: { pageId: 'fixture-page', title: '隔离例会', url: '', version: 1 }, assignee: { name: '测试' }, todayTasks: [{ id: 'fixture-task', sourceText: '隔离原文', dueText: '' }], tomorrowTasks: [], warnings: [] };
const writes: { path: string; origin?: string; body: unknown; status: number }[] = [];
let jiraVersion = 1;
const fixture = http.createServer(async (request, response) => {
  const url = new URL(request.url!, 'http://fixture');
  const reply = (status: number, data: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
  if (request.method === 'GET') {
    const data: Record<string, unknown> = { [READ_ROUTES.merge]: directMode ? pipeline.attachCatchupMergePipeline(merge, directState) : merge, [READ_ROUTES.catchup]: catchup, [READ_ROUTES.automation]: automation, [READ_ROUTES.meeting]: meeting, [READ_ROUTES['merge-jira']]: { version: jiraVersion, message: '隔离 Jira 报告' }, [READ_ROUTES.config]: { baseUrl: '', hasCredentials: false } };
    if (url.pathname === READ_ROUTES.evidence) { response.writeHead(200, { 'Content-Type': 'image/svg+xml' }); response.end('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="160"><rect width="600" height="160" fill="#162c55"/><text x="24" y="80" fill="white" font-size="22">ISOLATED QA - NO REAL APPROVAL</text></svg>'); return; }
    reply(Object.hasOwn(data, url.pathname) ? 200 : 404, data[url.pathname] ?? { error: 'Fixture GET not mapped' }); return;
  }
  let text = ''; for await (const chunk of request) text += chunk;
  const body = JSON.parse(text);
  const entry = { path: url.pathname, origin: request.headers.origin, body, status: 200 }; writes.push(entry);
  if (request.headers.origin !== 'http://127.0.0.1:5188') { entry.status = 403; reply(403, { error: 'Untrusted catchup merge request origin' }); return; }
  if (url.pathname.endsWith('/merge/actions')) {
    if (directMode) {
      try {
        directState = pipeline.applyCatchupMergeAction(directState, merge.items, body);
        reply(200, { message: '隔离例外授权已入队，失败记录保留；未执行真实 Git 操作' });
      } catch (error) { entry.status = 409; reply(409, { message: String(error) }); }
      return;
    }
    if (merge.revision === 1) merge.revision = 2; // First attempt deterministically races a newer snapshot.
    if (body.expectedRevision !== merge.revision) { entry.status = 409; reply(409, { message: '版本冲突：已更新到版本 2，请重新核对证据并确认' }); return; }
    item.status = 'PENDING'; item.pipeline.phase = 'delivery'; item.action = { enabled: false, action: '', label: '隔离审核已接受' }; merge.revision++;
  } else if (url.pathname.endsWith('/jobs/update')) { automation.jobs[0].status = body.status; automation.jobs[0].error = ''; automation.jobs[0].result = '隔离验收：已刷新到最新状态';
  } else if (url.pathname.endsWith('/settings')) { Object.assign(automation.settings, body);
  } else if (url.pathname.endsWith('/jira-completion')) { jiraVersion++;
  } else if (url.pathname.endsWith('/confluence-sync')) { await new Promise((resolve) => setTimeout(resolve, 800)); meeting.source.version++; meeting.localDate = '2099-01-02';
  } else { entry.status = 404; reply(404, { error: 'Fixture POST not mapped' }); return; }
  reply(200, { message: '隔离验收已接受：没有执行真实合入或外部写入' });
});
await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
const fixtureOrigin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
const sourceBackend = {
  dispatch: async (request: http.IncomingMessage, response: http.ServerResponse, target: string) => {
    let body = '';
    if (request.method === 'POST') for await (const chunk of request) body += chunk;
    const upstream = await nativeFetch(`${fixtureOrigin}${target}`, {
      method: request.method,
      body: request.method === 'POST' ? body : undefined,
      headers: request.method === 'POST' ? { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5188' } : undefined,
    });
    response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' });
    response.end(Buffer.from(await upstream.arrayBuffer()));
  },
};
const gateway = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url!, `http://127.0.0.1:${request.socket.localPort}`);
    if (url.pathname === '/__qa/writes') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(writes)); return; }
    if (url.pathname.startsWith('/api/source/')) { await proxySource(request, response, url, sourceBackend); return; }
    if (url.pathname.startsWith('/api/')) { response.writeHead(404); response.end('{}'); return; }
    const filename = path.extname(url.pathname) ? path.resolve(root, 'dist', `.${url.pathname}`) : path.join(root, 'dist/index.html');
    if (!filename.startsWith(path.join(root, 'dist') + path.sep)) throw new Error('Invalid asset path');
    const types: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
    const content = await fs.readFile(filename);
    response.writeHead(200, { 'Content-Type': types[path.extname(filename)] ?? 'application/octet-stream' }); response.end(content);
  } catch (error) { response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ message: String(error) })); }
});
gateway.listen(0, '127.0.0.1', () => console.log(`ISOLATED QA http://127.0.0.1:${(gateway.address() as { port: number }).port}/catchup/merge — all writes stay in memory`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { gateway.close(); fixture.close(); process.exit(0); });
