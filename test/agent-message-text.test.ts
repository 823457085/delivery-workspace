import test from 'node:test';
import assert from 'node:assert/strict';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { groupTaskMessage, splitUserMessage } from '../src/features/agent-workbench/message-text.js';

test('群聊生成任务只展示摘要，完整提示词原样保留，普通消息不受影响', () => {
  const marker = '[重构管理任务:eb4f3bef-8582-4c34-ac3c-66ae78b048be]';
  const metadata = { action: 'retest', moduleId: 'doc-test', environment: 'LOCAL', version: 'abc123' };
  const prompt = `${marker}\n${JSON.stringify(metadata)}\n原始任务资料、路径与补充要求\n${'长资料'.repeat(5000)}`;
  for (const text of [prompt, prompt.replaceAll('\n', '\r\n')]) {
    assert.deepEqual(groupTaskMessage({ text }), { text: '重构管理 · 复测问题（LOCAL）', prompt: text });
  }
  assert.deepEqual(groupTaskMessage({ text: '需求开发 · OPay', taskPrompt: prompt }), { text: '需求开发 · OPay', prompt });
  const noVersion = `${marker}\n${JSON.stringify({ ...metadata, action: 'integrate', version: '' })}\n联调任务资料`;
  assert.deepEqual(groupTaskMessage({ text: noVersion }), { text: '重构管理 · 触发联调（LOCAL）', prompt: noVersion });
  for (const text of ['普通消息', '普通长消息'.repeat(5000), `请参考这个例子：\n${prompt}`, `${marker}\n{不完整JSON`,
    `${marker}\nnull`, `${marker}\n${JSON.stringify({ ...metadata, action: 'unknown' })}`,
    `${marker}\n${JSON.stringify({ ...metadata, action: 'toString' })}`, `${marker}\n${JSON.stringify({ action: 'retest' })}`]) {
    assert.deepEqual(groupTaskMessage({ text }), { text }, '不明确的任务格式不能隐藏正文');
  }
});

test('用户消息折叠保留完整原文、交接后的要求与普通短消息', () => {
  const before = '请继续当前任务。\r\n\r\n';
  const after = '\r\n\r\n本轮只修改页面，不要提交。';
  const history = JSON.stringify([{ user: '文本含 ]、[ 和 "引号"', assistant: '已有结果\\路径'.repeat(220), status: 'completed' }]);
  for (const heading of ['以下是当前工作台对话跨执行器交接的近期文本', '以下是跨执行器带入的近期对话文本']) {
    const context = `${heading}，仅供背景参考。最多包含最近 6 轮。\r\n${history}`;
    const source = before + context + after;
    const parts = splitUserMessage(source);
    assert.equal(parts.before, before);
    assert.equal(parts.hidden, context);
    assert.equal(parts.after, after, '交接之后新增的用户要求不能藏进背景内容');
    assert.equal(parts.handoff, true);
    assert.equal(parts.before + parts.hidden + parts.after, source);
  }
  for (const source of ['普通消息，包含交接上下文这个词。', '短消息\n第二行', 'a'.repeat(1599)]) {
    assert.equal(splitUserMessage(source).before, source);
    assert.equal(splitUserMessage(source).hidden, '');
  }
  for (const source of ['a'.repeat(1600), Array.from({ length: 20 }, (_, index) => `第 ${index + 1} 行`).join('\n'), 'a'.repeat(479) + '😀' + '后文'.repeat(800)]) {
    const parts = splitUserMessage(source);
    assert.ok(parts.before.length <= 480);
    assert.ok(parts.hidden.length > 0);
    assert.equal(parts.handoff, false);
    assert.equal(parts.before + parts.hidden + parts.after, source);
    assert.doesNotMatch(parts.before, /[\uD800-\uDBFF]$/);
  }
  const quotedExample = '以下是跨执行器带入的近期对话文本\n[这只是格式说明，不是 JSON]';
  assert.equal(splitUserMessage(quotedExample).hidden, '');
});

test('展开普通长消息时 URL 和 Markdown 链接保留完整 href，收起预览不创建截断链接', async () => {
  const server = await createServer({ configFile: false, plugins: [vue()], appType: 'custom',
    server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const { default: MessageText } = await server.ssrLoadModule('/src/features/agent-workbench/AgentMessageText.vue');
    const url = 'https://example.com/' + 'a'.repeat(1700);
    for (const source of [url, `[完整链接](${url})`]) {
      for (const searchQuery of ['', 'example.com']) {
        const html = await renderToString(createSSRApp({ render: () => h(MessageText, { source, searchQuery }) }));
        const links = [...html.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map(match => match[1]);
        assert.deepEqual(links, [url], '只有完整原文中的链接可点击，预览不产生截断链接');
        const preview = html.slice(0, html.indexOf('<details'));
        assert.equal(preview.includes('example.com'), !searchQuery, '展开全文后不重复显示预览');
      }
    }
  } finally { await server.close(); }
});
