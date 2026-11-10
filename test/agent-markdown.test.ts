import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownCodeBlock, parseAgentMarkdown, parseMarkdownInline } from '../src/features/agent-workbench/markdown.js';

test('多行概览和纯文本说明保留字段换行、L 码与 HTML 字面值', () => {
  const blocks = parseAgentMarkdown('# 工作区概览\n所属项目: Apex\n当前分支: feature/demo\n接口文案: L_RAW\n<script>alert(1)</script>\n\n> 第一步\n> 第二步');
  assert.deepEqual(blocks[1], { type: 'paragraph', content: [{ type: 'text', text: '所属项目: Apex\n当前分支: feature/demo\n接口文案: L_RAW\n<script>alert(1)</script>' }] });
  assert.deepEqual(blocks[2], { type: 'quote', content: [{ type: 'text', text: '第一步\n第二步' }] });
});

test('动态命令和路径作为字面代码保留，不变成链接或报告块', () => {
  const value = '/工作区/`配置`\n```\n```delivery-report\n**L_RAW** [链接](https://example.com) <script>alert(1)</script>\n````';
  assert.deepEqual(parseAgentMarkdown(markdownCodeBlock(value)), [{ type: 'code', language: 'text', text: value }]);
});

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

test('编号之间有说明段落或代码时保留原始起始编号，不全部重置为第一条', () => {
  const blocks = parseAgentMarkdown('3. 版本差异\n版本说明\n\n```sh\npnpm build\n```\n\n4. 如果你本地执行的是其他脚本，区别如下\n• pnpm dev：启动开发服务\n• pnpm build：先执行类型检查\n\n5. 发现一个值得核验的本地与服务器差异\n接口文案 L_RAW 保持原样');
  const lists = blocks.filter(block => block.type === 'list');
  assert.deepEqual(lists.map(block => block.start), [3, 4, 5]);
  assert.deepEqual(lists[1].items[0], [{ type: 'text', text: '如果你本地执行的是其他脚本，区别如下' }]);
  assert.deepEqual(blocks.at(-1), { type: 'paragraph', content: [{ type: 'text', text: '接口文案 L_RAW 保持原样' }] });
});

test('连续的全 1 Markdown 列表仍由浏览器递增，独立列表按原文重新起号', () => {
  const blocks = parseAgentMarkdown('1. 第一项\n1. 第二项\n1. 第三项\n\n说明段落\n\n1. 新列表\n\n- 无序项');
  const lists = blocks.filter(block => block.type === 'list');
  assert.equal(lists[0].start, 1);
  assert.equal(lists[0].items.length, 3);
  assert.equal(lists[1].start, 1);
  assert.equal(lists[2].ordered, false);
  assert.equal(lists[2].start, undefined);
});

test('长反引号围栏保留较短围栏，并接受更长的闭合围栏', () => {
  const blocks = parseAgentMarkdown([
    '`````sh',
    'printf "**L_RAW** <script>alert(1)</script>"',
    '```',
    '````',
    'echo done',
    '``````',
    '# 后续标题',
  ].join('\n'));

  assert.deepEqual(blocks[0], {
    type: 'code', language: 'sh',
    text: 'printf "**L_RAW** <script>alert(1)</script>"\n```\n````\necho done',
  });
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].type, 'heading');
});

test('未闭合的长围栏不会被较短反引号提前结束', () => {
  assert.deepEqual(parseAgentMarkdown('````text\n/目录/`名称`\n```\n# 仍是代码'), [{
    type: 'code', language: 'text', text: '/目录/`名称`\n```\n# 仍是代码',
  }]);
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

test('运行动态的 Markdown 保留标题与强调，文件引用仅展示标签且不开放 file 协议', () => {
  const blocks = parseAgentMarkdown('### 为什么不可用\n\n已检查 **自动巡检** 和 [DeliverySettings.vue](file:///Users/demo/Desktop/工作台/Delivery/src/DeliverySettings.vue)。');
  assert.equal(blocks[0].type, 'heading');
  assert.equal(blocks[1].type, 'paragraph');
  if (blocks[1].type !== 'paragraph') return;
  assert.deepEqual(blocks[1].content.find(node => node.type === 'strong'), { type: 'strong', text: '自动巡检' });
  assert.ok(blocks[1].content.some(node => node.type === 'text' && node.text === 'DeliverySettings.vue'));
  assert.equal(blocks[1].content.some(node => node.type === 'link'), false);
});
