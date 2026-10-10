import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWecomIntegration, redactFeedback } from '../server/wecom-integration.js';
import { buildReviewCatalog } from '../src/features/api-integration/review-catalog.js';
import type { BackendFeedbackInput } from '../shared/wecom-integration.js';

const item = buildReviewCatalog().find(item => item.path === '/api/v1/examples/detail')!;
const input: BackendFeedbackInput = {
  interfaceId: item.id, summary: '商家详情缺少契约字段', environment: 'DEV · mock',
  parameters: '{"merchantNo":"test","Authorization":"Bearer only-a-fixture","password":"not-a-real-password"}',
  actual: 'HTTP 200，code=1000；缺少 functionConfigs', expected: '按契约返回 functionConfigs 对象',
  contractReference: '测试契约 fixture v1，仅验证通知，不作为真实缺陷', traceId: 'fixture-request-id',
};
const config = { groupName: '测试群（不发送到真实群）', webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-fixture-only' };

test('无需配置人员即可发群反馈，消息不含提醒字段；敏感值不落盘，并发及重启后仍幂等', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-wecom-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  const configFile = path.join(directory, 'credentials', 'wecom.json');
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetchMock: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 });
  };
  const service = await createWecomIntegration(directory, { configFile, fetch: fetchMock });
  assert.equal(service.config().hasWebhook, false);
  assert.equal(service.preview(input).canSend, false);
  await service.configure(config);
  assert.equal(JSON.stringify(service.config()).includes(config.webhook), false);
  assert.equal((await fs.stat(configFile)).mode & 0o777, 0o600);
  const preview = service.preview(input);
  assert.equal(preview.canSend, true);
  assert.equal('recipients' in preview, false);
  assert.equal('userids' in preview.input, false);
  assert.equal(preview.content.includes('后端负责人'), false);
  assert.equal(preview.content.includes('not-a-real-password'), false);
  const results = await Promise.all([service.send({ input: preview.input, hash: preview.hash }), service.send({ input: preview.input, hash: preview.hash })]);
  assert.equal(requests.length, 1);
  assert.equal(results[0].record.status, 'sent');
  assert.equal(results[0].record.id, results[1].record.id);
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { msgtype: 'text', text: { content: preview.content } });
  assert.equal(results[0].message.includes('@'), false);
  assert.equal(requests[0].init?.redirect, 'error');
  const stored = await fs.readFile(path.join(directory, 'wecom-integration-reports.json'), 'utf8');
  assert.equal(stored.includes('not-a-real-password'), false);
  assert.equal(stored.includes(config.webhook), false);
  const restored = await createWecomIntegration(directory, { configFile, fetch: fetchMock });
  await restored.send({ input: preview.input, hash: preview.hash });
  assert.equal(requests.length, 1);
  await restored.configure({ groupName: config.groupName });
  assert.equal(restored.config().hasWebhook, true);
});

test('无效输入、已移除的人员字段、Webhook 主机、过期预览、方法缺失在发送前阻断', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-wecom-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  let requests = 0;
  const fetchMock: typeof fetch = async () => { requests++; return new Response('{}'); };
  const service = await createWecomIntegration(directory, { configFile: path.join(directory, 'wecom.json'), fetch: fetchMock });
  for (const webhook of ['http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test', 'https://example.com/?key=test', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=a&key=b']) {
    await assert.rejects(service.configure({ ...config, webhook }));
  }
  await assert.rejects(service.configure({ ...config, owners: [] }));
  await service.configure(config);
  assert.throws(() => service.preview({ ...input, expected: '' }));
  assert.throws(() => service.preview({ ...input, userids: ['unknown'] }));
  assert.throws(() => service.preview({ ...input, interfaceId: 'fake-interface' }));
  const missingMethod = buildReviewCatalog().find(item => !item.method);
  if (missingMethod) assert.throws(() => service.preview({ ...input, interfaceId: missingMethod.id }));
  const preview = service.preview(input);
  await service.configure({ ...config, groupName: '另一测试群' });
  await assert.rejects(service.send({ input: preview.input, hash: preview.hash }), /重新预览/);
  assert.equal(requests, 0);
});

test('已有人员配置可正常加载，重新保存移除映射并保留原 Webhook', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-wecom-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  const configFile = path.join(directory, 'wecom.json');
  await fs.writeFile(configFile, JSON.stringify({ ...config, owners: [{ userid: 'fixture_merchant', displayName: '旧配置人员', pathPrefixes: ['/admin/v1/merchants/'] }] }), { mode: 0o600 });
  const service = await createWecomIntegration(directory, { configFile });
  assert.deepEqual(service.config(), { hasWebhook: true, groupName: config.groupName });
  assert.equal(service.preview(input).canSend, true);
  await service.configure({ groupName: config.groupName });
  assert.deepEqual(JSON.parse(await fs.readFile(configFile, 'utf8')), config);
  assert.equal(service.history('').length, 0);
});

test('长中文返回保留完整反馈，UTF-8 群摘要受限；明确失败可手动再发，超时不自动再发', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-wecom-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  let requests = 0;
  const fetchMock: typeof fetch = async () => {
    requests++;
    if (requests === 1) return new Response(JSON.stringify({ errcode: 45009, errmsg: 'rate limited' }));
    throw new Error('simulated timeout including secret URL');
  };
  const service = await createWecomIntegration(directory, { configFile: path.join(directory, 'wecom.json'), fetch: fetchMock });
  await service.configure(config);
  const preview = service.preview({ ...input, actual: '错误字段😀'.repeat(1000) });
  assert.ok(preview.bytes < 2048);
  assert.ok(preview.truncated);
  assert.equal(preview.input.actual.length, '错误字段😀'.repeat(1000).length);
  const longest = service.preview({ ...input, summary: '中'.repeat(160), environment: '中'.repeat(200), parameters: '中'.repeat(12000), actual: '中'.repeat(12000), expected: '中'.repeat(12000), contractReference: '中'.repeat(2000), traceId: '中'.repeat(200) });
  assert.ok(longest.bytes < 1850);
  const first = await service.send({ input: preview.input, hash: preview.hash });
  assert.equal(first.record.status, 'failed');
  assert.match(first.message, /45009/);
  const retry = await service.send({ input: preview.input, hash: preview.hash });
  assert.equal(retry.record.status, 'unknown');
  await service.send({ input: preview.input, hash: preview.hash });
  assert.equal(requests, 2);
  assert.equal(service.history(item.id).length, 2);
});

test('JSON 嵌套、文本头、query、curl、私钥脱敏，保留非敏感请求和响应事实', () => {
  const json = JSON.parse(redactFeedback(JSON.stringify({ code: 1000, nested: { access_token: 'tok', mobile: '13812345678', functionConfigs: null } })));
  assert.equal(json.code, 1000);
  assert.equal(json.nested.functionConfigs, null);
  assert.equal(json.nested.access_token, '[已脱敏]');
  const text = redactFeedback('Authorization: Bearer fixture-token\nCookie: sid=fixture-cookie; role=admin\n?access_token=fixture-query&merchantNo=123\ncurl -H "Authorization: Bearer fixture-curl"\n{"newPassword":"fixture-password"}\n<@all>');
  for (const secret of ['fixture-token', 'fixture-cookie', 'fixture-query', 'fixture-curl', 'fixture-password', '<@all>']) assert.equal(text.includes(secret), false);
  assert.match(text, /merchantNo=123/);
  assert.equal(redactFeedback('-----BEGIN RSA PRIVATE KEY-----\nfixture-key\n-----END RSA PRIVATE KEY-----').includes('fixture-key'), false);
});

test('脱敏保留字符串请求编号、长数字标识和原始文本，避免 JSON 标量改变证据', () => {
  for (const value of ['23494.360', '374388011775406150001', 'false', 'null', '"L900037"']) assert.equal(redactFeedback(value), value);
});

test('HTTP 错误和缺失业务回执不算成功，未知送达结果阻止重复发送', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-wecom-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  let calls = 0;
  const fetchMock: typeof fetch = async () => { calls++; return calls === 1 ? new Response('gateway failure', { status: 502 }) : new Response('{"message":"not a WeCom receipt"}'); };
  const service = await createWecomIntegration(directory, { configFile: path.join(directory, 'wecom.json'), fetch: fetchMock });
  await service.configure(config);
  for (const summary of ['HTTP error fixture', 'missing receipt fixture']) {
    const preview = service.preview({ ...input, summary });
    const result = await service.send({ input: preview.input, hash: preview.hash });
    assert.equal(result.record.status, 'unknown');
    await service.send({ input: preview.input, hash: preview.hash });
  }
  assert.equal(calls, 2);
});

test('每分钟限额含失败请求，避免刷群；重启不重发未完成的请求', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-wecom-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  const configFile = path.join(directory, 'wecom.json');
  let calls = 0;
  const fetchMock: typeof fetch = async () => { calls++; return new Response(JSON.stringify({ errcode: 0 })); };
  const service = await createWecomIntegration(directory, { configFile, fetch: fetchMock });
  await service.configure(config);
  for (let i = 0; i < 10; i++) {
    const preview = service.preview({ ...input, summary: `fixture ${i}` });
    await service.send({ input: preview.input, hash: preview.hash });
  }
  const next = service.preview({ ...input, summary: 'fixture 11' });
  await assert.rejects(service.send({ input: next.input, hash: next.hash }), /10 条/);
  assert.equal(calls, 10);
  const records = service.history('');
  records[0].status = 'sending';
  await fs.writeFile(path.join(directory, 'wecom-integration-reports.json'), JSON.stringify(records));
  const restored = await createWecomIntegration(directory, { configFile, fetch: fetchMock });
  assert.equal(restored.history('').find(record => record.id === records[0].id)?.status, 'unknown');
});
