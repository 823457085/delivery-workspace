import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sendIntegrationEvidence } from '../scripts/send-integration-evidence.js';
import { renderIntegrationRequestEvidence } from '../scripts/render-integration-request-evidence.js';

const issueText = '## TEST-BE-001｜商家详情：未返回配置\n请求：GET /admin/v1/merchants/detail?merchantNo=123\n实际：HTTP200/code1000，externalIntegration缺失\n预期：按契约返回真实配置\ntraceId: fixture-trace';

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-evidence-'));
  t.after(() => fs.rm(dir, { recursive: true }));
  const markdown = path.join(dir, 'issue.md'), image = path.join(dir, 'page.png'), receipt = path.join(dir, 'receipt.json'), configFile = path.join(dir, 'config.json');
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8VsAAAAASUVORK5CYII=', 'base64');
  await fs.writeFile(markdown, issueText.replace('externalIntegration缺失', 'externalIntegration缺失；Authorization: Bearer fixture-only-secret <@all>'));
  await fs.writeFile(image, imageBytes);
  await fs.writeFile(configFile, JSON.stringify({ webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture-only' }));
  return { markdown, image, receipt, configFile, imageBytes, inlineImageUrl: 'http://172.20.100.50:5199/integration-runs/page.png' };
}

test('预览不发送；问题与截图只提交一条图文，重复执行及历史回执不刷群', async t => {
  const f = await fixture(t);
  const requests: Record<string, unknown>[] = [];
  const fetchMock: typeof fetch = async (_url, init) => { requests.push(JSON.parse(String(init?.body))); assert.equal(init?.redirect, 'error'); return new Response('{"errcode":0}'); };
  const options = { send: true, inlineImageUrl: f.inlineImageUrl, configFile: f.configFile, fetch: fetchMock };
  const preview = await sendIntegrationEvidence(f.markdown, f.image, f.receipt, { ...options, send: false });
  assert.equal(requests.length, 0);
  assert.equal('sent' in preview && preview.sent, false);
  const result = await sendIntegrationEvidence(f.markdown, f.image, f.receipt, options);
  assert.ok('receipt' in result && result.receipt?.parts.every(part => part.status === 'sent'));
  assert.equal(result.receipt?.imageMd5, createHash('md5').update(f.imageBytes).digest('hex'));
  assert.deepEqual(requests, [{ msgtype: 'markdown_v2', markdown_v2: { content: 'content' in preview ? preview.content : '' } }]);
  await sendIntegrationEvidence(f.markdown, f.image, f.receipt, options);
  const legacy = { ...result.receipt, content: result.receipt.content.replace('预期：🔴 ', '预期：'),
    parts: [{ type: 'image', status: 'sent', code: 0 }, { type: 'markdown_v2', status: 'sent', code: 0 }] };
  await fs.writeFile(f.receipt, JSON.stringify(legacy));
  const duplicate = await sendIntegrationEvidence(f.markdown, f.image, f.receipt, options);
  assert.ok(duplicate.duplicate);
  assert.equal(duplicate.receipt?.parts.length, 2);
  assert.equal(requests.length, 1);
  const stored = await fs.readFile(f.receipt, 'utf8');
  for (const secret of ['fixture-only-secret', '<@all>', 'base64', 'webhook/send?key=']) assert.equal(stored.includes(secret), false);
  assert.equal((await fs.stat(f.receipt)).mode & 0o777, 0o600);
});

test('后端关注行带红色标记，行内代码和原始返回保持一致，多张关键图只发一次', async t => {
  const f = await fixture(t), requests: Record<string, unknown>[] = [];
  const network = path.join(path.dirname(f.image), 'native-network.png');
  await fs.writeFile(network, f.imageBytes);
  const content = issueText.replace('externalIntegration缺失', '`data.externalIntegration 缺失`；message=success；label=L900037')
    .replace('按契约返回真实配置', '后端请`补齐 externalIntegration 的真实配置`');
  await fs.writeFile(f.markdown, content);
  const options = { send: true, inlineImageUrl: f.inlineImageUrl, additionalScreenshots: [network], configFile: f.configFile, fetch: (async (_url, init) => {
    requests.push(JSON.parse(String(init?.body))); return new Response('{"errcode":0}');
  }) as typeof fetch };
  await sendIntegrationEvidence(f.markdown, f.image, f.receipt, options);
  await sendIntegrationEvidence(f.markdown, f.image, f.receipt, options);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], { msgtype: 'markdown_v2', markdown_v2: { content: content.replace('预期：', '预期：🔴 ') + `\n\n![页面截图](${f.inlineImageUrl})\n\n![关键返回](http://172.20.100.50:5199/integration-runs/native-network.png)` } });
});

test('历史模块和摘要问题ID沿用原编号发送一次，仍拒绝前端摘要ID', async t => {
  for (const issueId of ['operations-5554bcb0-consumer-list-500', 'equipment-operation-exceptions-400-77cbfb82',
    'finance-31df91d5-payment-import-invalid-request', 'CONFIGURATION-BE-CB83351A']) {
    const f = await fixture(t); let calls = 0;
    const content = issueText.replace('TEST-BE-001', issueId);
    await fs.writeFile(f.markdown, content);
    const options = { send: true, inlineImageUrl: f.inlineImageUrl, configFile: f.configFile,
      fetch: (async (_url, init) => { calls++; assert.ok(String(init?.body).includes(issueId)); return new Response('{"errcode":0}'); }) as typeof fetch };
    await sendIntegrationEvidence(f.markdown, f.image, f.receipt, options);
    await sendIntegrationEvidence(f.markdown, f.image, f.receipt, options);
    assert.equal(calls, 1);
  }
  const f = await fixture(t); let calls = 0;
  await fs.writeFile(f.markdown, issueText.replace('TEST-BE-001', 'CONFIGURATION-FE-CB83351A'));
  await assert.rejects(sendIntegrationEvidence(f.markdown, f.image, f.receipt, {
    send: true, inlineImageUrl: f.inlineImageUrl, configFile: f.configFile,
    fetch: (async () => { calls++; return new Response('{"errcode":0}'); }) as typeof fetch,
  }), /前端问题/);
  assert.equal(calls, 0);
  await assert.rejects(fs.access(f.receipt), /ENOENT/);
});

test('枚举选择表达式被误脱敏时拒绝外发，组名和真实空选项完整发送一次', async t => {
  const f = await fixture(t); let calls = 0;
  const options = { send: true, inlineImageUrl: f.inlineImageUrl, configFile: f.configFile,
    fetch: (async (_url, init) => {
      calls++; assert.ok(String(init?.body).includes('onboardingTypeCode.options=[]'));
      return new Response('{"errcode":0}');
    }) as typeof fetch };
  await fs.writeFile(f.markdown, issueText.replace('externalIntegration缺失', '`data.list[key="onboardingTypeCode"].options=[]`；页面下拉为空'));
  await assert.rejects(sendIntegrationEvidence(f.markdown, f.image, f.receipt, options), /枚举选择表达式被误脱敏/);
  assert.equal(calls, 0);
  await assert.rejects(fs.access(f.receipt), /ENOENT/);
  await fs.writeFile(f.markdown, issueText.replace('externalIntegration缺失', '`onboardingTypeCode.options=[]`；页面下拉为空'));
  await sendIntegrationEvidence(f.markdown, f.image, f.receipt, options);
  await sendIntegrationEvidence(f.markdown, f.image, f.receipt, options);
  assert.equal(calls, 1);
});

test('前端与网络问题在外发前拒绝，不生成回执；真实后端错误仍可发送', async t => {
  const f = await fixture(t); let calls = 0;
  const options = { send: true, inlineImageUrl: f.inlineImageUrl, configFile: f.configFile,
    fetch: (async () => { calls++; return new Response('{"errcode":0}'); }) as typeof fetch };
  for (const content of [issueText.replace('TEST-BE-001', 'TEST-FE-001'),
    ...['net::ERR_CONNECTION_REFUSED', 'ECONNRESET', 'DNS解析失败', '网络超时', '请求已取消']
      .map(actual => issueText.replace('HTTP200/code1000，externalIntegration缺失', actual))]) {
    await fs.writeFile(f.markdown, content);
    await assert.rejects(sendIntegrationEvidence(f.markdown, f.image, f.receipt, options), /前端问题|网络或环境问题/);
    assert.equal(calls, 0);
    await assert.rejects(fs.access(f.receipt), /ENOENT/);
  }
  await fs.writeFile(f.markdown, issueText.replace('HTTP200/code1000，externalIntegration缺失', 'HTTP500/code1000002；message=internal error，列表无法查询'));
  await sendIntegrationEvidence(f.markdown, f.image, f.receipt, options);
  assert.equal(calls, 1);
});

test('不支持的font颜色语法在外发前拒绝，不产生成功回执或拆分消息', async t => {
  const f = await fixture(t); let calls = 0;
  await fs.writeFile(f.markdown, issueText.replace('externalIntegration缺失', '<font color="warning">externalIntegration缺失</font>'));
  await assert.rejects(sendIntegrationEvidence(f.markdown, f.image, f.receipt, {
    send: true, inlineImageUrl: f.inlineImageUrl, configFile: f.configFile,
    fetch: (async () => { calls++; return new Response('{"errcode":0}'); }) as typeof fetch,
  }), /markdown_v2 不支持指定字体颜色/);
  assert.equal(calls, 0);
  await assert.rejects(fs.access(f.receipt), /ENOENT/);
});

test('图文发送失败或未知时不补发图片或文字，重新执行不重复发送', async t => {
  for (const failure of ['business', 'http', 'timeout']) {
    const f = await fixture(t); let calls = 0;
    const fetchMock: typeof fetch = async () => { calls++; if (failure === 'timeout') throw new Error('timeout'); return failure === 'http' ? new Response('', { status: 502 }) : new Response('{"errcode":45009}'); };
    const options = { send: true, inlineImageUrl: f.inlineImageUrl, configFile: f.configFile, fetch: fetchMock };
    const result = await sendIntegrationEvidence(f.markdown, f.image, f.receipt, options);
    assert.equal(result.receipt?.parts[0].type, 'markdown_v2');
    assert.equal(result.receipt?.parts[0].status, failure === 'business' ? 'failed' : 'unknown');
    assert.equal(result.receipt?.parts.length, 1);
    await sendIntegrationEvidence(f.markdown, f.image, f.receipt, options);
    assert.equal(calls, 1);
  }
});

test('进度、成功通知、长篇问题和仅图片旧调用在外发与回执创建前阻断', async t => {
  const f = await fixture(t); let calls = 0;
  const options = { send: true, inlineImageUrl: f.inlineImageUrl, configFile: f.configFile, fetch: (async () => { calls++; return new Response('{"errcode":0}'); }) as typeof fetch };
  for (const content of ['APEX联调进度\n5个会话开始执行', '接口200，截图通道已验证', issueText.replace('预期：按契约返回真实配置\n', ''), issueText + '\n详细字段说明\n处理分工']) {
    await fs.writeFile(f.markdown, content);
    await assert.rejects(sendIntegrationEvidence(f.markdown, f.image, f.receipt, options), /群反馈/);
  }
  await fs.writeFile(f.markdown, issueText);
  await assert.rejects(sendIntegrationEvidence(f.markdown, f.image, f.receipt, { ...options, imageOnly: true }), /独立的问题说明/);
  assert.equal(calls, 0);
  await assert.rejects(fs.access(f.receipt), /ENOENT/);
});

test('内嵌图文只有一次机器人请求，不单独发送图片，预览不发送且不重复提交', async t => {
  const f = await fixture(t), requests: Record<string, unknown>[] = [];
  const imageUrl = 'http://172.20.100.50:5199/integration-runs/evidence.jpg';
  const options = { inlineImageUrl: imageUrl, configFile: f.configFile, fetch: (async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return new Response('{"errcode":0}'); }) as typeof fetch };
  const preview = await sendIntegrationEvidence(f.markdown, f.image, f.receipt, options);
  assert.ok(preview.content);
  assert.ok(preview.content.includes(`![页面截图](${imageUrl})`));
  assert.equal(requests.length, 0);
  const result = await sendIntegrationEvidence(f.markdown, f.image, f.receipt, { ...options, send: true });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], { msgtype: 'markdown_v2', markdown_v2: { content: 'content' in preview ? preview.content : '' } });
  assert.ok(result.receipt);
  assert.ok(result.receipt.parts.length === 1 && result.receipt.parts.every(part => part.status === 'sent'));
  await sendIntegrationEvidence(f.markdown, f.image, f.receipt, { ...options, send: true });
  assert.equal(requests.length, 1);
});

test('群内直接保留关键参数和返回，正文证据链接在发送及创建回执前阻断', async t => {
  const f = await fixture(t), requests: Record<string, unknown>[] = [];
  const content = issueText.replace('实际：HTTP200/code1000，externalIntegration缺失', '参数：X-Region=NA；无Body\n实际：HTTP200/code1000；onboardingTypeCode 返回片段 {"options":[]}');
  const options = { send: true, inlineImageUrl: f.inlineImageUrl, configFile: f.configFile, fetch: (async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response('{"errcode":0}');
  }) as typeof fetch };
  for (const linked of [content.replace('traceId: fixture-trace', 'traceId: fixture-trace；http://172.20.100.50:5199/integration-runs/evidence.html'),
    issueText + '\n证据：[完整报告](http://172.20.100.50:5199/integration-runs/evidence.html)']) {
    await fs.writeFile(f.markdown, linked);
    await assert.rejects(sendIntegrationEvidence(f.markdown, f.image, f.receipt, options), /正文.*链接/);
    assert.equal(requests.length, 0);
    await assert.rejects(fs.access(f.receipt), /ENOENT/);
  }
  await fs.writeFile(f.markdown, content);
  const result = await sendIntegrationEvidence(f.markdown, f.image, f.receipt, options);
  assert.equal(requests.length, 1);
  assert.equal(result.receipt?.parts[0].status, 'sent');
  const sent = (requests[0].markdown_v2 as { content: string }).content;
  assert.ok(sent.includes('X-Region=NA'));
  assert.ok(sent.includes('onboardingTypeCode 返回片段 {"options":[]}'));
  assert.ok(sent.includes(`![页面截图](${f.inlineImageUrl})`));
  assert.ok(!sent.includes('.html'));
});

test('内嵌图文拒绝含凭据地址、非法协议和拼接后超长正文；失败不自动重发', async t => {
  const f = await fixture(t); let calls = 0;
  const options = { send: true, inlineImageUrl: f.inlineImageUrl, configFile: f.configFile, fetch: (async () => { calls++; return new Response('{"errcode":40008}'); }) as typeof fetch };
  for (const inlineImageUrl of ['javascript:alert(1)', 'https://user:secret@example.com/a.jpg', 'https://example.com/a.jpg?key=secret']) await assert.rejects(sendIntegrationEvidence(f.markdown, f.image, f.receipt, { ...options, inlineImageUrl }));
  const remaining = 3800 - Buffer.byteLength(issueText.replace('externalIntegration缺失', ''));
  await fs.writeFile(f.markdown, issueText.replace('externalIntegration缺失', '中'.repeat(Math.floor(remaining / 3))));
  await assert.rejects(sendIntegrationEvidence(f.markdown, f.image, f.receipt, { ...options, inlineImageUrl: 'https://example.com/a.jpg' }), /3800/);
  assert.equal(calls, 0);
  await fs.writeFile(f.markdown, issueText);
  const failureOptions = { ...options, inlineImageUrl: 'https://example.com/a.jpg' };
  const result = await sendIntegrationEvidence(f.markdown, f.image, f.receipt, failureOptions);
  assert.ok(result.receipt);
  assert.ok(result.receipt.parts[0].status === 'failed');
  await sendIntegrationEvidence(f.markdown, f.image, f.receipt, failureOptions);
  assert.equal(calls, 1);
});

test('长文、非法截图、超大截图和不可信 Webhook 在外发前阻断', async t => {
  const f = await fixture(t); let calls = 0;
  const options = { send: true, inlineImageUrl: f.inlineImageUrl, configFile: f.configFile, fetch: (async () => { calls++; return new Response('{}'); }) as typeof fetch };
  await fs.writeFile(f.markdown, '中'.repeat(1400));
  await assert.rejects(sendIntegrationEvidence(f.markdown, f.image, f.receipt, options), /3800/);
  await fs.writeFile(f.markdown, issueText); await fs.writeFile(f.image, 'not an image');
  await assert.rejects(sendIntegrationEvidence(f.markdown, f.image, f.receipt, options), /PNG/);
  await fs.writeFile(f.image, Buffer.concat([f.imageBytes, Buffer.alloc(2 * 1024 * 1024)]));
  await assert.rejects(sendIntegrationEvidence(f.markdown, f.image, f.receipt, options), /2MB/);
  await fs.writeFile(f.image, f.imageBytes); await fs.writeFile(f.configFile, '{"webhook":"https://example.com/"}');
  await assert.rejects(sendIntegrationEvidence(f.markdown, f.image, f.receipt, options), /Webhook/);
  assert.equal(calls, 0);
});

test('缺截图、纯文字及旧待补图调用在外发和创建回执前被阻断', async t => {
  const f = await fixture(t); let calls = 0;
  const options = { send: true, inlineImageUrl: f.inlineImageUrl, configFile: f.configFile, fetch: (async () => { calls++; return new Response('{"errcode":0}'); }) as typeof fetch };
  await assert.rejects(sendIntegrationEvidence(f.markdown, '-', f.receipt, options), /必须提供真实截图/);
  await assert.rejects(sendIntegrationEvidence(f.markdown, f.image, f.receipt, { ...options, textOnly: true }), /禁止纯文字/);
  await assert.rejects(sendIntegrationEvidence(f.markdown, 'missing.jpg', f.receipt, options), /ENOENT/);
  await assert.rejects(sendIntegrationEvidence(f.markdown, f.image, f.receipt, { ...options, inlineImageUrl: undefined }), /只发一条内嵌截图/);
  assert.equal(calls, 0);
  await assert.rejects(fs.access(f.receipt), /ENOENT/);
});

test('并行会话各自只发一条完整图文，不拆开发送', async t => {
  const f = await fixture(t), messages: string[] = [];
  const second = path.join(path.dirname(f.markdown), 'second.md');
  await fs.writeFile(second, issueText.replace('TEST-BE-001', 'TEST-BE-002'));
  const options = { send: true, inlineImageUrl: f.inlineImageUrl, configFile: f.configFile, fetch: (async (_url, init) => { const body = JSON.parse(String(init?.body)); messages.push(body.msgtype); return new Response('{"errcode":0}'); }) as typeof fetch };
  const results = await Promise.all([
    sendIntegrationEvidence(f.markdown, f.image, f.receipt, options),
    sendIntegrationEvidence(second, f.image, path.join(path.dirname(f.receipt), 'second.json'), options),
  ]);
  assert.deepEqual(messages, ['markdown_v2', 'markdown_v2']);
  assert.ok(results.every(result => result.receipt?.parts.every(part => part.status === 'sent')));
});

test('页面和接口关键截图都内嵌在同一条消息，失败保留回执且不重发', async t => {
  for (const failMessage of [false, true]) {
    const f = await fixture(t), requests: Record<string, unknown>[] = [];
    const network = path.join(path.dirname(f.image), 'request-response.png');
    await fs.writeFile(network, f.imageBytes);
    const options = { send: true, inlineImageUrl: f.inlineImageUrl, additionalScreenshots: [network], configFile: f.configFile, fetch: (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ errcode: failMessage ? 45009 : 0 }));
    }) as typeof fetch };
    const result = await sendIntegrationEvidence(f.markdown, f.image, f.receipt, options);
    assert.deepEqual(requests.map(item => item.msgtype), ['markdown_v2']);
    assert.deepEqual(result.receipt?.parts.map(part => part.status), failMessage ? ['failed'] : ['sent']);
    const content = (requests[0].markdown_v2 as { content: string }).content;
    assert.ok(content.includes(f.inlineImageUrl));
    assert.ok(content.includes('http://172.20.100.50:5199/integration-runs/request-response.png'));
    const calls = requests.length;
    await sendIntegrationEvidence(f.markdown, f.image, f.receipt, options);
    assert.equal(requests.length, calls);
  }
});

test('缺少或非法接口图在任何消息和回执创建前阻断', async t => {
  const f = await fixture(t); let calls = 0;
  const options = { send: true, inlineImageUrl: f.inlineImageUrl, configFile: f.configFile, fetch: (async () => { calls++; return new Response('{"errcode":0}'); }) as typeof fetch };
  await assert.rejects(sendIntegrationEvidence(f.markdown, f.image, f.receipt, { ...options, additionalScreenshots: ['missing.png'] }), /ENOENT/);
  await assert.rejects(sendIntegrationEvidence(f.markdown, f.image, f.receipt, { ...options, additionalScreenshots: [f.markdown] }), /PNG/);
  await assert.rejects(sendIntegrationEvidence(f.markdown, f.image, f.receipt, { ...options, additionalScreenshots: [f.image, f.image, f.image] }), /最多/);
  assert.equal(calls, 0);
  await assert.rejects(fs.access(f.receipt), /ENOENT/);
});

test('请求证据页保留真实响应及接口文案，脱敏敏感数据并转义返回中的HTML', () => {
  const evidence = { source: 'browser-cdp', batchId: 'same-browser-batch', capturedAt: '2026-10-09T11:00:00.000Z',
    pageUrl: 'http://fixture-owner1.localhost:6791/OperateManage/MerchantList',
    request: { requestId: '23494.360', method: 'GET', url: 'http://fixture-owner1.localhost:6791/admin/v1/merchants/list?page=1', headers: { Authorization: 'Bearer fixture-secret', 'X-Region': 'NA' } },
    response: { status: 200, headers: { 'Set-Cookie': 'private-cookie' }, body: { code: 1000, data: { key: 'countryRegion', canResetPassword: false, label: 'L900037', phone: 'private-phone', message: '<script>alert(1)</script>' } } },
  };
  const html = renderIntegrationRequestEvidence(evidence);
  assert.ok(html.includes('浏览器请求证据'));
  for (const text of ['same-browser-batch', '23494.360', 'L900037', 'HTTP 200', 'X-Region']) assert.ok(html.includes(text));
  for (const secret of ['fixture-secret', 'private-cookie', 'private-phone', '<script>']) assert.ok(!html.includes(secret));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('countryRegion'));
  assert.ok(html.includes('&quot;canResetPassword&quot;: false'));
  const rawBodyHtml = renderIntegrationRequestEvidence({ ...evidence, response: { ...evidence.response, body: JSON.stringify(evidence.response.body) } });
  assert.ok(rawBodyHtml.includes('countryRegion'));
  assert.ok(rawBodyHtml.includes('&quot;canResetPassword&quot;: false'));
  assert.throws(() => renderIntegrationRequestEvidence({ ...evidence, source: 'curl' }));
  assert.throws(() => renderIntegrationRequestEvidence({ ...evidence, response: { status: 200 } }));
  assert.throws(() => renderIntegrationRequestEvidence({ ...evidence, pageUrl: 'http://other.localhost:6791/' }));
});
