/** 交接只读网络故障可有限重试；不重放写操作，也不暴露底层连接信息。 */
import test from 'node:test';
import assert from 'node:assert/strict';

const query = '?fields=summary,status,reporter,assignee';
const networkError = (code: string) => new TypeError('fetch failed', {
  cause: Object.assign(new Error('private connection detail'), { code }),
});

function auth(t: { after(callback: () => void): void }) {
  const previous = process.env.JIRA_AUTH_HEADER;
  process.env.JIRA_AUTH_HEADER = 'Bearer local-test-only';
  t.after(() => { if (previous === undefined) delete process.env.JIRA_AUTH_HEADER; else process.env.JIRA_AUTH_HEADER = previous; });
}

test('交接 GET 遇到临时断连只重试一次', async t => {
  auth(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (++calls === 1) throw networkError('ECONNRESET');
    return Response.json({ key: 'TEST-123' });
  });
  const backend = await import(new URL('../server/jira-backend/server.mjs', import.meta.url).href);
  assert.deepEqual(await backend.jiraFixHandoffRequest('TEST-123', query), { key: 'TEST-123' });
  assert.equal(calls, 2);
});

test('持续网络故障至多读取两次，错误只显示安全诊断码', async t => {
  auth(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw networkError('UND_ERR_SOCKET'); });
  const backend = await import(new URL('../server/jira-backend/server.mjs', import.meta.url).href);
  await assert.rejects(backend.jiraFixHandoffRequest('TEST-123', query), (error: Error) => {
    assert.match(error.message, /读取 Jira.*UND_ERR_SOCKET/);
    assert.doesNotMatch(error.message, /private connection detail|local-test-only/);
    return true;
  });
  assert.equal(calls, 2);
});

test('评论、流转、指派网络失败均不自动重放', async t => {
  auth(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw networkError('ECONNRESET'); });
  const backend = await import(new URL('../server/jira-backend/server.mjs', import.meta.url).href);
  for (const [suffix, method] of [['/comment', 'POST'], ['/transitions', 'POST'], ['/assignee', 'PUT']]) {
    const before = calls;
    await assert.rejects(backend.jiraFixHandoffRequest('TEST-123', suffix, method, {}), (error: Error & { definite?: boolean }) => {
      assert.match(error.message, /写入 Jira.*ECONNRESET/);
      assert.notEqual(error.definite, true);
      return true;
    });
    assert.equal(calls, before + 1);
  }
});

test('证书错误与超时不重试', async t => {
  auth(t);
  let calls = 0;
  let reason: Error = networkError('CERT_HAS_EXPIRED');
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw reason; });
  const backend = await import(new URL('../server/jira-backend/server.mjs', import.meta.url).href);
  await assert.rejects(backend.jiraFixHandoffRequest('TEST-123', query), /读取 Jira.*证书校验失败/);
  assert.equal(calls, 1);
  reason = new DOMException('timed out', 'TimeoutError');
  await assert.rejects(backend.jiraFixHandoffRequest('TEST-123', query), /读取 Jira.*网络请求超时/);
  assert.equal(calls, 2);
});

test('事项请求使用固定来源、保留 Jira 错误文案且写入不重试', async t => {
  auth(t);const seen:{url:string;options:RequestInit}[]=[];
  t.mock.method(globalThis,'fetch',async (url:unknown,options:RequestInit)=>{seen.push({url:String(url),options});return Response.json({errorMessages:['L1001 原始校验文案']},{status:400});});
  const backend=await import(new URL('../server/jira-backend/server.mjs',import.meta.url).href);
  await assert.rejects(backend.jiraIssueRequest('https://evil.test/issue/TEST-1'),/不支持/);assert.equal(seen.length,0);
  await assert.rejects(backend.jiraIssueRequest('issue/TEST-1/comment','POST',{body:'test'}),(error:Error&{definite?:boolean})=>error.message==='L1001 原始校验文案'&&error.definite===true);
  assert.equal(seen.length,1);assert.equal(seen[0].options.redirect,'manual');assert.equal(seen[0].options.headers && (seen[0].options.headers as Record<string,string>).Authorization,'Bearer local-test-only');
});
