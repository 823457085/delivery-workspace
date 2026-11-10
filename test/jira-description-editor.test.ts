import test from 'node:test';
import assert from 'node:assert/strict';
import { formatJiraSelection } from '../src/features/jira-issue/jira-description-edit';
import { jiraWikiMarkdown } from '../src/features/jira-issue/jira-description';
import { parseAgentMarkdown } from '../src/features/agent-workbench/markdown';

test('行内格式保留选中内容、前后原文和光标范围，链接选中待填写的位置', () => {
  const source = ' L1001\n接口返回原文\n{panel}保留原宏{panel}\n';
  const start = source.indexOf('接口');
  const result = formatJiraSelection(source, start, start + 6, 'bold');
  assert.equal(result.value, ' L1001\n*接口返回原文*\n{panel}保留原宏{panel}\n');
  assert.equal(result.value.slice(result.start, result.end), '接口返回原文');
  assert.equal(formatJiraSelection(result.value, result.start, result.end, 'bold').value, source);
  const link = formatJiraSelection(source, start, start + 6, 'link');
  assert.equal(link.value, ' L1001\n[接口返回原文|https://]\n{panel}保留原宏{panel}\n');
  assert.equal(link.value.slice(link.start, link.end), 'https://');
  const url = formatJiraSelection('https://example.test/a_b', 0, 24, 'link');
  assert.equal(url.value, '[链接文字|https://example.test/a_b]');
  assert.equal(url.value.slice(url.start, url.end), '链接文字');
});

test('标题与列表按完整选中行编辑，选区末尾换行不波及下一行', () => {
  const source = '原有标题\n第一项\n第二项\n不修改的下一项';
  const start = source.indexOf('第一');
  const end = source.indexOf('不修改');
  assert.equal(formatJiraSelection(source, start, end, 'numbered').value, '原有标题\n# 第一项\n# 第二项\n不修改的下一项');
  assert.equal(formatJiraSelection('h3. 原有标题', 4, 8, 'heading').value, 'h2. 原有标题');
  assert.equal(formatJiraSelection('* 第一项\n# 第二项', 0, 11, 'bullet').value, '* 第一项\n* 第二项');
  assert.equal(formatJiraSelection('\n原文', 0, 0, 'heading').value, 'h2. \n原文');
});

test('格式工具插入的 Jira 语法可预览，代码、链接与标识符不被当作格式改写', () => {
  const source = 'h2. L1001 原文\n*粗体* 与 _斜体_\n* 第一项\n* 第二项\n# 顺序项\n[链接文案|https://example.test/a_b]\n{{*原始代码*}}\n{code:js}\nh2. code\n* keep *\n{code}\napi_raw_value';
  const markdown = jiraWikiMarkdown(source);
  const blocks = parseAgentMarkdown(markdown);
  assert.ok(blocks.some(block => block.type === 'heading' && block.level === 2));
  assert.ok(blocks.some(block => block.type === 'list' && !block.ordered && block.items.length === 2));
  assert.ok(blocks.some(block => block.type === 'list' && block.ordered));
  assert.deepEqual(blocks.find(block => block.type === 'code'), { type: 'code', language: 'js', text: 'h2. code\n* keep *' });
  assert.ok(markdown.includes('**粗体** 与 *斜体*'));
  assert.ok(markdown.includes('[链接文案](https://example.test/a_b)'));
  assert.ok(markdown.includes('`*原始代码*`'));
  assert.ok(markdown.endsWith('api_raw_value'));
  assert.equal(jiraWikiMarkdown(formatJiraSelection('选中代码', 0, 4, 'code').value), '```\n选中代码\n```');
});
