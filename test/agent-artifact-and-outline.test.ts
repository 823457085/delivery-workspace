import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildArtifactSandboxSrcdoc,
  detectPreviewableCodeArtifact,
  markdownTableToCsv,
  markdownTableToTsv,
} from '../src/features/agent-workbench/markdown-artifact-preview.js';
import { parseAgentMarkdown } from '../src/features/agent-workbench/markdown.js';
import {
  buildConversationOutlineItems,
  formatChangedFileReference,
  formatQuoteReply,
  summarizeOutlineText,
} from '../src/features/agent-workbench/conversation-outline.js';

test('detectPreviewableCodeArtifact 精准识别可预览的 HTML 与 SVG 代码块，忽略普通文本与其他语言', () => {
  assert.equal(detectPreviewableCodeArtifact('html', '<div class="card"><h2>标题</h2></div>'), 'html');
  assert.equal(detectPreviewableCodeArtifact('htm', '<!doctype html><html><body>Hello World</body></html>'), 'html');
  assert.equal(detectPreviewableCodeArtifact('svg', '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>'), 'svg');
  assert.equal(detectPreviewableCodeArtifact('xml', '<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20"/></svg>'), 'svg');

  assert.equal(detectPreviewableCodeArtifact('ts', 'const html = "<div>hello</div>";'), undefined);
  assert.equal(detectPreviewableCodeArtifact('html', 'just plain text without tags'), undefined);
  assert.equal(detectPreviewableCodeArtifact('svg', '<svg>broken'), undefined);
});

test('buildArtifactSandboxSrcdoc 自动注入严格 CSP 阻断外部联网与表单外发', () => {
  const htmlDoc = buildArtifactSandboxSrcdoc('html', '<button onclick="alert(1)">点我</button>');
  assert.ok(htmlDoc.includes("connect-src 'none'"));
  assert.ok(htmlDoc.includes("form-action 'none'"));
  assert.ok(htmlDoc.includes('<button onclick="alert(1)">点我</button>'));

  const fullDoc = buildArtifactSandboxSrcdoc('html', '<!DOCTYPE html><html><head><title>Demo</title></head><body><h1>Hi</h1></body></html>');
  assert.ok(fullDoc.includes("connect-src 'none'"));
  assert.ok(fullDoc.includes('<title>Demo</title>'));

  const svgDoc = buildArtifactSandboxSrcdoc('svg', '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>');
  assert.ok(svgDoc.includes("default-src 'none'"));
  assert.ok(!svgDoc.includes('allow-same-origin'));
});

test('buildConversationOutlineItems 与 formatQuoteReply 提取轮次摘要并生成标准引用块', () => {
  assert.equal(summarizeOutlineText('> 旧引用行\n\n请帮我把这里的超时改成 10 秒'), '请帮我把这里的超时改成 10 秒');
  assert.equal(summarizeOutlineText('   '), '（附件或图片消息）');

  const items = buildConversationOutlineItems([
    { id: 'r1', text: '帮我查一下登录接口为什么 401', status: 'completed', changedFiles: 0, createdAt: '2026-11-15T10:00:00Z' },
    { id: 'r2', text: '把 token 过期判断修好并补个单测', status: 'running', changedFiles: 2, createdAt: '2026-11-15T10:05:00Z' },
  ]);
  assert.equal(items.length, 2);
  assert.equal(items[0]?.round, 1);
  assert.equal(items[1]?.changedFiles, 2);

  const quoted = formatQuoteReply('第一行结论\n第二行建议', '');
  assert.equal(quoted, '> 第一行结论\n> 第二行建议\n\n');

  const withDraft = formatQuoteReply('选中内容', '这段改成异步处理');
  assert.equal(withDraft, '> 选中内容\n\n这段改成异步处理');
  assert.equal(formatQuoteReply('选中内容', withDraft), withDraft, '相同引用不重复插入');
});

test('markdownTableToTsv 与 markdownTableToCsv 支持富文本剥离、逗号引号转义及 Excel 公式注入防护', () => {
  const blocks = parseAgentMarkdown([
    '| 字段 | 说明 | 风险公式 |',
    '| --- | --- | --- |',
    '| **token** | 含,逗号与"引号" | =CMD() |',
  ].join('\n'));
  const table = blocks.find(b => b.type === 'table');
  assert.ok(table && table.type === 'table');

  const tsv = markdownTableToTsv(table.headers, table.rows);
  assert.equal(tsv, '字段\t说明\t风险公式\ntoken\t含,逗号与"引号"\t=CMD()');

  const csv = markdownTableToCsv(table.headers, table.rows);
  assert.ok(csv.startsWith('\uFEFF'), '包含 UTF-8 BOM 防止 Excel 中文乱码');
  assert.ok(csv.includes('"含,逗号与""引号"""'), '逗号与双引号按 RFC 4180 转义');
  assert.ok(csv.includes("'=CMD()"), '拦截等号开头的表格公式注入');
});

test('formatChangedFileReference 支持普通文件与带空格路径的精确行号定位引用', () => {
  assert.equal(formatChangedFileReference('src/app.ts'), '@src/app.ts');
  assert.equal(formatChangedFileReference('src/app.ts', 42), '@src/app.ts:42');
  assert.equal(formatChangedFileReference('src/my page/index.vue', 18), '@"src/my page/index.vue":18');
  assert.equal(formatChangedFileReference('src/app.ts', 0), '@src/app.ts');
});
