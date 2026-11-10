import test from 'node:test';
import assert from 'node:assert/strict';
import { jiraWikiMarkdown } from '../src/features/jira-issue/jira-description';
import { parseAgentMarkdown } from '../src/features/agent-workbench/markdown';

test('Jira 描述兼容 CRLF、缩进列表和带花括号的粗体标记，保留原文与链接', () => {
  const source = 'h2. 需求范围\r\n\r\n * 新增 {*}POS 服务商{*}选择 L1001\r\n * 模式支持{*}大商户、平台账户、独立账户{*}。\r\n\r\nh2. 验收标准\r\n # 必填信息缺失时，无法创建。\r\n # 创建成功后，列表字段与提交内容一致。\r\n\r\n[原型|https://example.test/a_b]';
  const blocks = parseAgentMarkdown(jiraWikiMarkdown(source));
  assert.deepEqual(blocks.map(block => block.type), ['heading', 'list', 'heading', 'list', 'paragraph']);
  assert.deepEqual(blocks[1], { type: 'list', ordered: false, items: [
    [{ type: 'text', text: '新增 ' }, { type: 'strong', text: 'POS 服务商' }, { type: 'text', text: '选择 L1001' }],
    [{ type: 'text', text: '模式支持' }, { type: 'strong', text: '大商户、平台账户、独立账户' }, { type: 'text', text: '。' }],
  ] });
  assert.equal(blocks[3].type === 'list' && blocks[3].ordered, true);
  assert.deepEqual(blocks[4], { type: 'paragraph', content: [{ type: 'link', text: '原型', href: 'https://example.test/a_b' }] });
});

test('Jira 转换保留已有 Markdown 粗体、行内代码和代码块中的原始标记', () => {
  const markdown = '## Markdown 标题\n\n**原有粗体** 与 `*原始代码*`\n\n```text\nh2. 原始代码\n * {*}保留标记{*}\n```';
  assert.equal(jiraWikiMarkdown(markdown), markdown);
  assert.equal(jiraWikiMarkdown('{{{*}代码{*}}}'), '`{*}代码{*}`');
  assert.equal(jiraWikiMarkdown('{code}\n * {*}保留标记{*}\n{code}'), '```\n * {*}保留标记{*}\n```');
});
