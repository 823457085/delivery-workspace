import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAgentRemoteDeliveryConfluence } from '../server/agent-remote-delivery-confluence.js';

const site = 'https://docs.example.test/wiki';
const destination = { site, spaceKey: 'SOP', parentId: '42' };
const input = { destination, title: 'APEX-602 技术方案', body: '# 方案\n\nL001\n```xml\n]]>\n```', taskId: '11df7e9c-b2c0-409c-b44e-2663b2fd1151' };
const page = (id = '42', body = '', version = 1) => ({ id, type: 'page', title: id === '42' ? '技术方案目录' : input.title,
  space: { key: 'SOP' }, ancestors: id === '42' ? [] : [{ id: '42' }], version: { number: version }, body: { storage: { value: body } } });

test('创建方案使用 Markdown CDATA，回读正文、空间、父目录和版本后返回发布证据', async () => {
  let created: ReturnType<typeof page> | undefined;
  const writes: { resource: string; method: string; payload: any }[] = [];
  const service = createAgentRemoteDeliveryConfluence(async resource => Response.json(resource.startsWith('content/search?')
    ? { results: [] } : resource.startsWith('content/42?') ? page() : created), async (resource, method, payload: any) => {
    writes.push({ resource, method, payload }); created = page('43', payload.body.storage.value); return Response.json({ id: '43' });
  }, site);
  const published = await service.publish(input);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].resource, 'content'); assert.equal(writes[0].method, 'POST');
  assert.match(writes[0].payload.body.storage.value, /\]\]\]\]><!\[CDATA\[>/);
  assert.equal(published.bodySha256, createHash('sha256').update(input.body).digest('hex'));
  assert.equal(published.url, `${site}/pages/viewpage.action?pageId=43`);
  assert.equal(published.parentId, '42'); assert.equal(published.version, 1);
  // 刷新后重试只复用完全相同的 Markdown，不创建第二页。
  const reopened = createAgentRemoteDeliveryConfluence(async resource => Response.json(resource.startsWith('content/search?')
    ? { results: [created] } : resource.startsWith('content/42?') ? page() : created), async () => { throw new Error('不得重复创建'); }, site);
  assert.equal((await reopened.publish(input)).pageId, '43');
});

test('同名不同正文、重复页面、目录空间或站点不符时均拒绝写入', async () => {
  let pages = [page('43', '<p>其他人的方案</p>')], parent = page();
  const service = createAgentRemoteDeliveryConfluence(async resource => Response.json(resource.startsWith('content/search?')
    ? { results: pages } : resource.startsWith('content/42?') ? parent : pages[0]), async () => { throw new Error('不得写入'); }, site);
  await assert.rejects(service.publish(input), (error: any) => error.definite === true && /内容不同的同名/.test(error.message));
  pages = [page('43'), page('44')];
  await assert.rejects(service.publish(input), /多个同名方案/);
  parent = { ...parent, space: { key: 'PRD' } };
  await assert.rejects(service.publish(input), /父页面所属空间/);
  await assert.rejects(service.publish({ ...input, destination: { ...destination, site: 'https://other.test' } }), /站点不一致/);
});

test('从开发主任务定位历史方案，确认新版时使用原页面编号和版本', async () => {
  const oldBody = '# 技术方案\n开发主任务 APEX-603';
  const oldStorage = `<ac:structured-macro ac:name="markdown"><ac:plain-text-body><![CDATA[${oldBody}]]></ac:plain-text-body></ac:structured-macro>`;
  let saved = { ...page('43', oldStorage, 7), title: 'APEX-603 开发交付 · 前端技术方案' };
  const writes: string[] = [];
  const service = createAgentRemoteDeliveryConfluence(async resource => Response.json(resource.startsWith('content/search?')
    ? { results: [saved, { ...saved, id: '44', title: 'APEX-6030 技术方案' }] }
    : resource.startsWith('content/42?') ? page() : saved), async (resource, method, payload: any) => {
    writes.push(`${method} ${resource}`);
    saved = { ...saved, body: { storage: { value: payload.body.storage.value } }, version: { number: payload.version.number } };
    return Response.json({ id: saved.id });
  }, site);
  const issueKeys = ['APEX-602', 'APEX-603'];
  const match = await service.lookup({ ...input, issueKeys });
  assert.equal(match?.pageId, '43');
  assert.equal(match?.title, saved.title);
  assert.equal(match?.version, 7);
  assert.deepEqual(writes, []);
  await assert.rejects(service.publish({ ...input, issueKeys }), /与预览不一致/);
  const update = await service.publish({ ...input, title: match!.title, issueKeys, existingPageId: match!.pageId,
    expectedVersion: match!.version, expectedBodySha256: match!.bodySha256 });
  assert.equal(update.pageId, '43');
  assert.equal(update.version, 8);
  assert.deepEqual(writes, ['PUT content/43']);
});

test('仅对已登记页面进行版本受控更新，结果不确定或回读不符不会自动重发', async () => {
  const oldBody = '# 旧方案', oldHash = createHash('sha256').update(oldBody).digest('hex');
  let saved = page('43', `<ac:structured-macro ac:name="markdown"><ac:plain-text-body><![CDATA[${oldBody}]]></ac:plain-text-body></ac:structured-macro>`, 3), count = 0, mismatch = false;
  const service = createAgentRemoteDeliveryConfluence(async resource => Response.json(resource.startsWith('content/42?') ? page() : saved),
    async (resource, method, payload: any) => {
      count++; assert.equal(resource, 'content/43'); assert.equal(method, 'PUT'); assert.equal(payload.version.number, saved.version.number + 1);
      saved = page('43', payload.body.storage.value, payload.version.number);
      if (mismatch) saved.ancestors = [{ id: '99' }];
      return Response.json({ id: '43' });
    }, site);
  await assert.rejects(service.publish({ ...input, existingPageId: '43', expectedVersion: 2, expectedBodySha256: oldHash }), /版本或正文与已登记/);
  await assert.rejects(service.publish({ ...input, existingPageId: '43', expectedVersion: 3, expectedBodySha256: '0'.repeat(64) }), /版本或正文与已登记/);
  assert.equal((await service.publish({ ...input, existingPageId: '43', expectedVersion: 3, expectedBodySha256: oldHash })).version, 4);
  mismatch = true;
  await assert.rejects(service.publish({ ...input, body: '# 第二版', existingPageId: '43', expectedVersion: 4,
    expectedBodySha256: createHash('sha256').update(input.body).digest('hex') }), (error: any) => error.uncertain === true && /回读|父目录/.test(error.message));
  assert.equal(count, 2);
  let calls = 0;
  const uncertain = createAgentRemoteDeliveryConfluence(async resource => Response.json(resource.startsWith('content/search?') ? { results: [] } : page()),
    async () => { calls++; throw new Error('network timeout'); }, site);
  await assert.rejects(uncertain.publish(input), (error: any) => error.uncertain === true);
  assert.equal(calls, 1);
});
