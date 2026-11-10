import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWecomIntegration } from '../server/wecom-integration.js';
import { integrationCatalogFixture } from './fixtures/integration-catalog';
import { buildReviewCatalog } from '../src/features/api-integration/review-catalog.js';
import type { BackendFeedbackInput } from '../shared/wecom-integration.js';
import { wecomMessageLimits, type WecomMessageInput, type WecomMessagePreview } from '../shared/wecom-messages.js';

const input: WecomMessageInput = { title: '本地消息名称', msgtype: 'text', content: '  第一行\n第二行😀  ' };
const config = { groupName: '消息测试群', webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=message-fixture-secret' };
const toSend = (preview: WecomMessagePreview) => ({ input: preview.input, previewId: preview.previewId, hash: preview.hash });
const feedbackInput: BackendFeedbackInput = {
  interfaceId: buildReviewCatalog(integrationCatalogFixture).find(item => item.path === '/admin/v1/merchants/detail')!.id,
  summary: '仅测试共享限额', environment: 'fixture', parameters: '{}', actual: '缺少字段', expected: '返回字段', contractReference: 'fixture', traceId: '',
};

async function fixture(t: TestContext, respond: (url: string, init?: RequestInit) => Promise<Response> = async () => new Response('{"errcode":0}')) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-wecom-messages-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  const configFile = path.join(directory, 'credentials', 'fixture.json');
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetchMock: typeof fetch = async (url, init) => { requests.push({ url: String(url), init }); return respond(String(url), init); };
  const service = await createWecomIntegration(directory, { catalog: integrationCatalogFixture, configFile, fetch: fetchMock });
  return { directory, configFile, requests, fetchMock, service };
}

test('通用消息独立于接口，预览不发送；text 和 Markdown v2 只发送正文，保留空白', async t => {
  const f = await fixture(t);
  const unconfigured = f.service.messagePreview(input);
  assert.equal(unconfigured.canSend, false);
  await assert.rejects(f.service.sendMessage(toSend(unconfigured)), /配置群机器人/);
  assert.equal(f.requests.length, 0);
  await f.service.configure(config);
  for (const msgtype of ['text', 'markdown_v2'] as const) {
    const content = msgtype === 'text' ? input.content : '# 标题\n\n**内容**\n![截图](https://example.com/fixture.png)';
    const preview = f.service.messagePreview({ ...input, msgtype, content });
    assert.equal(preview.content, content);
    assert.equal(preview.input.content, content);
    assert.equal(preview.bytes, Buffer.byteLength(content));
    assert.equal(preview.limit, wecomMessageLimits[msgtype]);
    assert.equal(f.requests.length, msgtype === 'text' ? 0 : 1);
    const result = await f.service.sendMessage(toSend(preview));
    assert.equal(result.record.status, 'sent');
    assert.deepEqual(JSON.parse(String(f.requests.at(-1)!.init?.body)), { msgtype, [msgtype]: { content } });
    assert.equal(f.requests.at(-1)!.init?.redirect, 'error');
    assert.ok(f.requests.at(-1)!.init?.signal);
    assert.ok(!String(f.requests.at(-1)!.init?.body).includes(input.title));
  }
  const sensitive = f.service.messagePreview({ ...input, content: JSON.stringify({ token: 'body-secret', webhook: config.webhook }) });
  await f.service.sendMessage(toSend(sensitive));
  const stored = await fs.readFile(path.join(f.directory, 'wecom-messages-history.json'), 'utf8');
  for (const secret of ['body-secret', config.webhook, 'message-fixture-secret']) assert.ok(!stored.includes(secret));
});

test('按 UTF-8 字节限制接受完整边界正文，超限及非法格式在发送和保存前拒绝', async t => {
  const f = await fixture(t);
  for (const msgtype of ['text', 'markdown_v2'] as const) {
    const limit = wecomMessageLimits[msgtype], content = 'a'.repeat(limit - 4) + '😀';
    const preview = f.service.messagePreview({ ...input, msgtype, content });
    assert.equal(preview.bytes, limit);
    assert.equal(preview.content, content);
    assert.throws(() => f.service.messagePreview({ ...input, msgtype, content: content + 'a' }), new RegExp(`${limit} 字节`));
    await assert.rejects(f.service.saveMessage({ ...input, kind: 'draft', msgtype, content: content + 'a' }), new RegExp(`${limit} 字节`));
  }
  for (const invalid of [{ ...input, msgtype: 'markdown' }, { ...input, content: ' \n ' }, { ...input, title: '' }, { ...input, title: 'a'.repeat(161) }, { ...input, interfaceId: 'must-not-be-required' }]) {
    assert.throws(() => f.service.messagePreview(invalid));
  }
  assert.throws(() => f.service.messagePreview({ ...input, content: 'token=' + 'x'.repeat(2048) }), /2048 字节/);
  assert.equal(f.requests.length, 0);
});

test('同一预览并发、重启后幂等；用户主动新预览可再次发送相同正文', async t => {
  const f = await fixture(t);
  await f.service.configure(config);
  const preview = f.service.messagePreview(input);
  const [first, duplicate] = await Promise.all([f.service.sendMessage(toSend(preview)), f.service.sendMessage(toSend(preview))]);
  assert.equal(first.record.id, duplicate.record.id);
  assert.equal(f.requests.length, 1);
  const restored = await createWecomIntegration(f.directory, { catalog: integrationCatalogFixture, configFile: f.configFile, fetch: f.fetchMock });
  const repeated = await restored.sendMessage(toSend(preview));
  assert.equal(repeated.record.id, first.record.id);
  assert.equal(f.requests.length, 1);
  const next = restored.messagePreview(input);
  assert.notEqual(next.previewId, preview.previewId);
  assert.notEqual(next.hash, preview.hash);
  await restored.sendMessage(toSend(next));
  assert.equal(f.requests.length, 2);
  const history = restored.messageHistory();
  history[0].preview.content = 'mutated output';
  assert.equal(restored.messageHistory()[0].preview.content, input.content);
  assert.equal((await fs.stat(path.join(f.directory, 'wecom-messages-history.json'))).mode & 0o777, 0o600);
});

test('预览 hash 绑定名称、正文、格式、previewId 和群机器人配置，篡改或过期不发出请求', async t => {
  const f = await fixture(t);
  await f.service.configure(config);
  const preview = f.service.messagePreview(input), request = toSend(preview);
  for (const changed of [
    { ...request, input: { ...request.input, title: '不同名称' } },
    { ...request, input: { ...request.input, content: '不同正文' } },
    { ...request, input: { ...request.input, msgtype: 'markdown_v2' } },
    { ...request, previewId: randomUUID() }, { ...request, hash: '0'.repeat(64) },
  ]) await assert.rejects(f.service.sendMessage(changed), /重新预览/);
  await assert.rejects(f.service.sendMessage({ input: preview.input, hash: preview.hash }));
  await f.service.configure({ groupName: '另一测试群' });
  await assert.rejects(f.service.sendMessage(request), /重新预览/);
  await f.service.configure({ ...config, webhook: config.webhook.replace('message-fixture-secret', 'changed-fixture-secret') });
  await assert.rejects(f.service.sendMessage(request), /重新预览/);
  assert.equal(f.requests.length, 0);
});

test('明确业务失败可手动重试；超时、HTTP 错误、回执缺失均记录 unknown 并阻止重发', async t => {
  let attempts = 0;
  const f = await fixture(t, async () => {
    attempts++;
    if (attempts === 1) return new Response(JSON.stringify({ errcode: 45009, errmsg: `拒绝：${config.webhook} message-fixture-secret token=reply-secret` }));
    throw new Error(`simulated timeout ${config.webhook}`);
  });
  await f.service.configure(config);
  const request = toSend(f.service.messagePreview(input));
  const [failed, duplicate] = await Promise.all([f.service.sendMessage(request), f.service.sendMessage(request)]);
  assert.equal(failed.record.status, 'failed');
  assert.equal(duplicate.record.id, failed.record.id);
  assert.equal(attempts, 1);
  assert.match(failed.message, /45009/);
  for (const secret of [config.webhook, 'message-fixture-secret', 'reply-secret']) assert.ok(!JSON.stringify(failed).includes(secret));
  const retry = await f.service.sendMessage(request);
  assert.equal(retry.record.status, 'unknown');
  assert.notEqual(retry.record.id, failed.record.id);
  assert.equal((await f.service.sendMessage(request)).record.id, retry.record.id);
  assert.equal(attempts, 2);
  for (const response of [new Response('gateway fixture', { status: 502 }), new Response('{"message":"no business receipt"}'), new Response('invalid json')]) {
    const other = await fixture(t, async () => response);
    await other.service.configure(config);
    const preview = other.service.messagePreview(input);
    assert.equal((await other.service.sendMessage(toSend(preview))).record.status, 'unknown');
    await other.service.sendMessage(toSend(preview));
    assert.equal(other.requests.length, 1);
  }
});

test('草稿和模板只保存脱敏内容，支持更新、并发保存、重启及删除，不发消息', async t => {
  const f = await fixture(t);
  await f.service.configure(config);
  const sensitive = { ...input, title: '名称 token=title-secret', content: `password=body-secret\n${config.webhook}\nmessage-fixture-secret\n<@all>` };
  const preview = f.service.messagePreview(sensitive);
  const [draft, template] = await Promise.all([
    f.service.saveMessage({ ...sensitive, kind: 'draft' }),
    f.service.saveMessage({ ...input, kind: 'template' }),
  ]);
  for (const value of [preview, draft, f.service.messageLibrary()]) {
    for (const secret of ['title-secret', 'body-secret', config.webhook, 'message-fixture-secret', '<@all>']) assert.ok(!JSON.stringify(value).includes(secret));
  }
  const updated = await f.service.saveMessage({ title: '更新后的草稿', content: '新的正文', msgtype: draft.msgtype, kind: draft.kind, id: draft.id });
  assert.equal(updated.id, draft.id);
  assert.equal(f.service.messageLibrary().length, 2);
  const stored = await fs.readFile(path.join(f.directory, 'wecom-messages-library.json'), 'utf8');
  assert.ok(!stored.includes('body-secret'));
  assert.equal((await fs.stat(path.join(f.directory, 'wecom-messages-library.json'))).mode & 0o777, 0o600);
  const restored = await createWecomIntegration(f.directory, { catalog: integrationCatalogFixture, configFile: f.configFile, fetch: f.fetchMock });
  assert.equal(restored.messageLibrary().find(item => item.id === draft.id)?.content, '新的正文');
  await restored.deleteMessage({ id: template.id });
  assert.deepEqual(restored.messageLibrary().map(item => item.id), [draft.id]);
  await assert.rejects(restored.deleteMessage({ id: template.id }), /不存在/);
  await assert.rejects(restored.saveMessage({ ...input, kind: 'draft', id: randomUUID() }), /不存在/);
  assert.equal(f.requests.length, 0);
  assert.equal(restored.messageHistory().length, 0);
});

test('发送前落盘 sending；服务中断恢复为 unknown，同一预览不会重发', async t => {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(t, async () => {
    const stored = JSON.parse(await fs.readFile(path.join(f.directory, 'wecom-messages-history.json'), 'utf8'));
    assert.equal(stored[0].status, 'sending');
    assert.equal(stored[0].finishedAt, '');
    return new Response('{"errcode":0}');
  });
  await f.service.configure(config);
  const preview = f.service.messagePreview(input);
  await f.service.sendMessage(toSend(preview));
  const records = f.service.messageHistory();
  records[0].status = 'sending'; records[0].finishedAt = '';
  await fs.writeFile(path.join(f.directory, 'wecom-messages-history.json'), JSON.stringify(records));
  const restored = await createWecomIntegration(f.directory, { catalog: integrationCatalogFixture, configFile: f.configFile, fetch: f.fetchMock });
  assert.equal(restored.messageHistory()[0].status, 'unknown');
  assert.match(restored.messageHistory()[0].message, /服务中断/);
  assert.equal((await restored.sendMessage(toSend(preview))).record.status, 'unknown');
  assert.equal(f.requests.length, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, 'wecom-messages-history.json'), 'utf8'))[0].status, 'unknown');
});

test('通用消息与旧联调反馈共享每分钟 10 次限额，明确失败也占用且重启保留', async t => {
  const f = await fixture(t, async () => new Response('{"errcode":45009,"errmsg":"fixture reject"}'));
  await f.service.configure(config);
  for (let index = 0; index < 5; index++) {
    const preview = f.service.preview({ ...feedbackInput, summary: `fixture feedback ${index}` });
    await f.service.send({ input: preview.input, hash: preview.hash });
    await f.service.sendMessage(toSend(f.service.messagePreview({ ...input, title: `fixture message ${index}` })));
  }
  const blockedFeedback = f.service.preview({ ...feedbackInput, summary: 'blocked feedback' });
  await assert.rejects(f.service.send({ input: blockedFeedback.input, hash: blockedFeedback.hash }), /10 条/);
  await assert.rejects(f.service.sendMessage(toSend(f.service.messagePreview(input))), /10 条/);
  const restored = await createWecomIntegration(f.directory, { catalog: integrationCatalogFixture, configFile: f.configFile, fetch: f.fetchMock });
  await assert.rejects(restored.sendMessage(toSend(restored.messagePreview(input))), /10 条/);
  assert.equal(f.requests.length, 10);
});
