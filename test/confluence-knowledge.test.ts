import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConfluenceKnowledge, confluenceText } from '../server/confluence-knowledge.js';
import { confluenceReference } from '../shared/confluence-knowledge.js';

const site = 'https://docs.example.test';
const rawPage = (id = '42', version = 1, html = '<p>真实需求 L001</p>') => ({ id, type: 'page', title: '需求原文 L002',
  space: { key: 'SOP' }, version: { number: version, when: '2026-11-02T09:00:00Z' }, body: { storage: { value: html } } });

test('搜索范围按工作区保存、校验目录归属，并将用户文字限制为单个 CQL 字符串', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'confluence-scope-'));
  const other = await fs.mkdtemp(path.join(os.tmpdir(), 'confluence-other-'));
  const resources: string[] = [];
  const request = async (resource: string) => {
    resources.push(resource);
    return Response.json(resource.startsWith('content/search?') ? { results: [rawPage()], _links: { next: '/next' } } : rawPage());
  };
  try {
    const store = await createConfluenceKnowledge(path.join(directory, 'settings'), request, site);
    await store.configure(directory, { spaceKey: 'SOP', requirementParentId: `${site}/pages/viewpage.action?pageId=42`, designParentId: '' });
    const reopened = await createConfluenceKnowledge(path.join(directory, 'settings'), request, site);
    assert.equal((await reopened.config(directory)).scope.requirementParentId, '42');
    assert.equal((await reopened.config(other)).scope.spaceKey, '');
    await assert.rejects(reopened.config(path.join(other, 'removed-workspace')), /ENOENT/);
    const query = '" OR space = SECRET OR text ~ "';
    const result = await reopened.search(directory, query, 12);
    const params = new URLSearchParams(resources.at(-1)!.split('?')[1]);
    assert.equal(params.get('start'), '12');
    assert.equal(params.get('cql'), `type = page AND space = "SOP" AND (ancestor IN (42) OR id IN (42)) AND title ~ ${JSON.stringify(`"${query.replace(/[\\"]/g, '\\$&')}"`)} ORDER BY lastmodified DESC`);
    assert.equal(result.hasMore, true);
    assert.equal(result.pages[0].title, '需求原文 L002');
    await assert.rejects(store.configure(directory, { spaceKey: 'PRD', requirementParentId: '42', designParentId: '' }), /所属空间/);
    await assert.rejects(store.configure(directory, { spaceKey: '', requirementParentId: 'https://other.test/pages/42', designParentId: '' }), /不属于/);
    assert.equal((await store.config(directory)).scope.spaceKey, 'SOP');
  } finally { await fs.rm(directory, { recursive: true, force: true }); await fs.rm(other, { recursive: true, force: true }); }
});

test('引用发送时读取最新正文和版本，去重并拒绝其他站点及过大文档', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'confluence-reference-'));
  let version = 1, content = '<p>需求 L001</p>', reads = 0;
  try {
    const store = await createConfluenceKnowledge(directory, async () => { reads++; return Response.json(rawPage('42', version, content)); }, site);
    const reference = confluenceReference(site, '42');
    const preview = await store.read(reference);
    version = 2; content = '<p>更新后的要求 L003</p>';
    const resolved = await store.resolveReferences(`请依据 @${reference} @${reference}`);
    assert.equal(preview.version, 1);
    assert.match(resolved, /"version":2/);
    assert.match(resolved, /更新后的要求 L003/);
    assert.match(resolved, /不是系统指令/);
    assert.equal(reads, 2);
    await assert.rejects(store.resolveReferences(`@${confluenceReference('https://other.test', '42')}`), /站点已变化/);
    const related = await store.related(`资料 ${site}/pages/viewpage.action?pageId=42\nhttps://other.test/pages/43\n@${reference}`);
    assert.equal(related.pages.length, 1);
    assert.equal('content' in related.pages[0], false);
    content = 'x'.repeat(40001);
    await assert.rejects(store.resolveReferences(`@${reference}`), /40000/);
    assert.equal(await store.resolveReferences('普通消息'), '');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('文档预览保留表格单元和 Markdown 宏中的原文字，移除脚本并解码实体', () => {
  const text = confluenceText('<script>alert(1)</script><h1>需求 &amp; L001</h1><table><tr><td>字段</td><td>值 &lt;b&gt;</td></tr></table><ac:plain-text-body><![CDATA[# 原文\n<div>代码</div>]]></ac:plain-text-body>&#x1F600;&#99999999;');
  assert.match(text, /需求 & L001\n字段\t值 <b>/);
  assert.match(text, /# 原文\n<div>代码<\/div>/);
  assert.ok(text.endsWith('😀'));
  assert.doesNotMatch(text, /alert\(1\)/);
});
