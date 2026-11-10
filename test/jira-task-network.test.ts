/** 调用真实任务读取处理器，Jira fetch 由替身接管，不读取真实账号也不发送网络请求。 */
import test from 'node:test';
import assert from 'node:assert/strict';

async function readIssues(t: { after(callback: () => void): void }) {
  const previousSite = process.env.JIRA_BASE_URL;
  process.env.JIRA_BASE_URL = 'https://jira.example.test';
  t.after(() => { if (previousSite === undefined) delete process.env.JIRA_BASE_URL; else process.env.JIRA_BASE_URL = previousSite; });
  const previous = process.env.JIRA_AUTH_HEADER;
  process.env.JIRA_AUTH_HEADER = 'Bearer local-test-only';
  t.after(() => { if (previous === undefined) delete process.env.JIRA_AUTH_HEADER; else process.env.JIRA_AUTH_HEADER = previous; });
  const backend = await import(new URL('../server/jira-backend/server.mjs', import.meta.url).href);
  let status = 0, body = '';
  const response = {
    setHeader() {},
    writeHead(value: number) { status = value; },
    end(value: string) { body = value; },
  };
  await backend.handleJiraTaskCalendarRequest({ method: 'GET', url: '/api/issues?allTime=true', headers: { host: 'localhost:5199' } }, response);
  return { status, body: JSON.parse(body) };
}

test('任务搜索虽使用 POST，短暂断连仍只重读一次且不创建任何任务', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    assert.match(String(url), /\/rest\/api\/2\/search$/);
    assert.equal(options?.method, 'POST');
    assert.ok(options?.signal);
    if (++calls === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error('private detail'), { code: 'ECONNRESET' }) });
    return Response.json({ total: 0, issues: [] });
  });
  const result = await readIssues(t);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.issues, []);
  assert.equal(calls, 2);
});

test('任务读取 DNS 故障返回可操作原因，不暴露连接细节或凭据', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('private detail'), { code: 'ENOTFOUND' }) });
  });
  const result = await readIssues(t);
  assert.equal(result.status, 500);
  assert.match(result.body.details, /读取 Jira.*域名解析失败.*ENOTFOUND/);
  assert.doesNotMatch(result.body.details, /private detail|local-test-only/);
  assert.equal(calls, 1);
});

test('认证、权限和限流错误不重试，保留 Jira 原始业务原因', async t => {
  let status = 401, calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ errorMessages: ['原始 Jira 原因 L1001'] }, { status }); });
  for (const [code, message] of [[401, '身份认证失败'], [403, '无权访问'], [429, '请求过于频繁']] as const) {
    status = code;
    const result = await readIssues(t);
    assert.match(result.body.details, new RegExp(`HTTP ${code}.*${message}`));
    assert.ok(result.body.details.includes('原始 Jira 原因 L1001'));
  }
  assert.equal(calls, 3);
});

test('任务超时不重试且明确提示超时', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new DOMException('timed out', 'TimeoutError'); });
  const result = await readIssues(t);
  assert.match(result.body.details, /读取 Jira.*网络请求超时/);
  assert.equal(calls, 1);
});

test('收到 HTTP 200 后读取响应体超时也返回诊断，不当作任务查询成功', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    const response = Response.json({});
    t.mock.method(response, 'json', async () => { throw new DOMException('The operation was aborted.', 'AbortError'); });
    return response;
  });
  const result = await readIssues(t);
  assert.equal(result.status, 500);
  assert.match(result.body.details, /读取 Jira 任务失败.*响应读取超时或中断/);
  assert.equal(calls, 1);
});
