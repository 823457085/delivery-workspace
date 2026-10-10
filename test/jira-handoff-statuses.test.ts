/** 完整目录必须限定当前事项类型；仅用受控 GET 验证，不接触真实 Jira 凭据或状态。 */
import test from 'node:test';
import assert from 'node:assert/strict';

// 测试显式提供端点，分享版本不再带企业 Jira 默认地址。
process.env.JIRA_BASE_URL = 'https://jira.example.test';

test('Jira 完整状态聚合只读取事项所在项目和类型，不混入其他类型的状态', async t => {
  const old = process.env.JIRA_AUTH_HEADER;
  process.env.JIRA_AUTH_HEADER = 'Bearer test-only';
  t.after(() => { if (old === undefined) delete process.env.JIRA_AUTH_HEADER; else process.env.JIRA_AUTH_HEADER = old; });
  const urls: string[] = [];
  let available = true;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(init.method || 'GET', 'GET'); urls.push(url);
    if (url.includes('/issue/TEST-123?fields=project,issuetype')) return Response.json({ fields: { project: { id: '10102' }, issuetype: { id: 'bug' } } });
    assert.ok(url.endsWith('/project/10102/statuses'));
    return Response.json([
      { id: 'task', statuses: [{ id: 'other', name: '其他事项状态' }] },
      ...(available ? [{ id: 'bug', statuses: [{ id: '10000', name: '待开始' }, { id: '10100', name: '测试中' }] }] : []),
    ]);
  });
  const backend = await import(new URL('../server/jira-backend/server.mjs', import.meta.url).href);
  assert.deepEqual(await backend.jiraFixHandoffRequest('TEST-123', '/workflow-statuses'), [
    { id: '10000', name: '待开始' }, { id: '10100', name: '测试中' },
  ]);
  assert.equal(urls.length, 2);
  await assert.rejects(backend.jiraFixHandoffRequest('TEST-123', '/workflow-statuses', 'POST'), /不支持/);
  assert.equal(urls.length, 2);
  available = false;
  await assert.rejects(backend.jiraFixHandoffRequest('TEST-123', '/workflow-statuses'), /该事项类型/);
});

test('Jira 流转错误保留字段校验原文，非 JSON 响应回退到 HTTP 错误', async t => {
  const old = process.env.JIRA_AUTH_HEADER;
  process.env.JIRA_AUTH_HEADER = 'Bearer test-only';
  t.after(() => { if (old === undefined) delete process.env.JIRA_AUTH_HEADER; else process.env.JIRA_AUTH_HEADER = old; });
  let reply = () => Response.json({ errorMessages: ['工作流校验失败'], errors: { customfield_10109: '目标开始日期为必填项' } }, { status: 400 });
  t.mock.method(globalThis, 'fetch', async () => reply());
  const backend = await import(new URL('../server/jira-backend/server.mjs', import.meta.url).href);
  await assert.rejects(backend.jiraFixHandoffRequest('TEST-123', '/transitions', 'POST', { transition: { id: '11' } }),
    (error: Error & { definite?: boolean }) => {
      assert.equal(error.message, 'Jira 交接请求失败：HTTP 400，工作流校验失败；目标开始日期为必填项');
      assert.equal(error.definite, true); return true;
    });
  reply = () => new Response('<html>gateway secret</html>', { status: 502 });
  await assert.rejects(backend.jiraFixHandoffRequest('TEST-123', '/transitions', 'POST', { transition: { id: '11' } }),
    (error: Error & { definite?: boolean }) => {
      assert.match(error.message, /HTTP 502/); assert.doesNotMatch(error.message, /gateway secret/);
      assert.equal(error.definite, false); return true;
    });
  reply = () => Response.json({ transitions: [] });
  assert.deepEqual(await backend.jiraFixHandoffRequest('TEST-123', '/transitions?expand=transitions.fields'), { transitions: [] });
});
