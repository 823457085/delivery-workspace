import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentMarkdown, parseMarkdownInline } from '../src/features/agent-workbench/markdown.js';

test('Markdown 解析覆盖标题、列表、代码块与表格', () => {
  const blocks = parseAgentMarkdown(`# 标题

- 文件
- 模型

\`\`\`ts
const ready = true;
\`\`\`

| 名称 | 状态 |
| --- | --- |
| Codex | 可用 |`);

  assert.deepEqual(blocks.map((block) => block.type), ['heading', 'list', 'code', 'table']);
  assert.equal(blocks[2].type === 'code' && blocks[2].language, 'ts');
  assert.equal(blocks[3].type === 'table' && blocks[3].rows.length, 1);
});

test('Markdown 行内链接只保留 http、https 与 mailto 协议', () => {
  const safe = parseMarkdownInline('[文档](https://example.com) [邮箱](mailto:test@example.com)');
  const unsafe = parseMarkdownInline('[运行脚本](javascript:alert(1))');

  assert.deepEqual(safe.filter((node) => node.type === 'link').map((node) => node.href), [
    'https://example.com',
    'mailto:test@example.com',
  ]);
  assert.deepEqual(unsafe, [{ type: 'text', text: '运行脚本' }]);
});

test('会话中的原始网页地址成为链接，不吞掉尾随标点或代码内容', () => {
  const nodes = parseMarkdownInline('查看 https://example.com/docs?q=1。 再看 http://localhost:5199/agent, `https://example.com/code`');
  assert.deepEqual(nodes.filter((node) => node.type === 'link').map((node) => node.href), [
    'https://example.com/docs?q=1',
    'http://localhost:5199/agent',
  ]);
  assert.deepEqual(nodes.find((node) => node.type === 'code'), { type: 'code', text: 'https://example.com/code' });
  assert.deepEqual(parseMarkdownInline('https:// 不可点击').filter((node) => node.type === 'link'), []);
});
