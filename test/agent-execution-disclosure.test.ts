import test from 'node:test';
import assert from 'node:assert/strict';
import { createSSRApp, effectScope, h, nextTick, shallowRef } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import type { AgentRun } from '../shared/agent-runtime.js';
import type { AgentConversation } from '../src/features/agent-workbench/conversation.js';
import { useExecutionRunDisclosure } from '../src/features/agent-workbench/execution-run-disclosure.js';

function run(id: string, index: number, options: Partial<AgentRun> = {}): AgentRun {
  const at = new Date(Date.UTC(2026, 10, 5, 10, index)).toISOString();
  return { id, provider: 'codex', mode: 'agent', accessMode: 'workspace', model: 'gpt-6.1-sol', reasoningEffort: '',
    objective: `原始任务 ${id}`, workspacePath: '/fixture', branch: '', headSha: '', status: 'completed',
    sessionId: '', pid: null, result: `历史原文-${id}`, error: '', events: [], createdAt: at, updatedAt: at, ...options };
}

test('106条记录只默认展开当前执行，排队和保存中的并行记录不被隐藏，未改写记录', () => {
  const runs = Array.from({ length: 106 }, (_, index) => run(String(index), index));
  runs[3]!.status = 'running'; runs[5]!.status = 'queued'; runs[7]!.resultReady = false;
  const before = structuredClone(runs), scope = effectScope();
  const disclosure = scope.run(() => useExecutionRunDisclosure(() => 'group:a', () => runs))!;
  try {
    assert.deepEqual(runs.filter(run => disclosure.isExpanded(run.id)).map(run => run.id), ['3', '5', '7']);
    assert.deepEqual(runs, before);
  } finally { scope.stop(); }
});

test('无活跃执行时默认最近更新一条，手动开合在轮询和新执行出现后保留，切群清空选择', async () => {
  const scope = effectScope(), id = shallowRef('group:a');
  const runs = shallowRef([run('old', 0), run('latest', 1)]);
  const disclosure = scope.run(() => useExecutionRunDisclosure(() => id.value, () => runs.value))!;
  try {
    assert.equal(disclosure.isExpanded('old'), false);
    assert.equal(disclosure.isExpanded('latest'), true);
    disclosure.setExpanded('old', true); disclosure.setExpanded('latest', false);
    runs.value = runs.value.map(run => ({ ...run, result: run.result + ' 新回读' })); await nextTick();
    assert.equal(disclosure.isExpanded('old'), true);
    assert.equal(disclosure.isExpanded('latest'), false);
    runs.value = [...runs.value, run('active', 2, { status: 'running' })]; await nextTick();
    assert.equal(disclosure.isExpanded('active'), true);
    assert.equal(disclosure.isExpanded('old'), true, '保留正在阅读的历史记录');
    disclosure.setExpanded('foreign', true);
    assert.equal(disclosure.isExpanded('foreign'), false);
    id.value = 'group:b'; await nextTick();
    assert.equal(disclosure.isExpanded('old'), false);
    assert.equal(disclosure.isExpanded('active'), true);
  } finally { scope.stop(); }
});

test('默认open产生的toggle事件不固定旧执行，完成后新记录自动成为默认展开项', async () => {
  const scope = effectScope(), runs = shallowRef([run('first', 0, { status: 'running' })]);
  const disclosure = scope.run(() => useExecutionRunDisclosure(() => 'group:a', () => runs.value))!;
  try {
    disclosure.setExpanded('first', true);
    runs.value = [run('first', 0), run('next', 1, { status: 'running' })]; await nextTick();
    assert.equal(disclosure.isExpanded('first'), false);
    assert.equal(disclosure.isExpanded('next'), true);
  } finally { scope.stop(); }
});

test('真实群执行组件只渲染展开记录正文，Markdown链接列表可读，普通聊天保持全部展开', async () => {
  const server = await createServer({ configFile: false, plugins: [vue()], appType: 'custom',
    server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const { agentTranslateSettings } = await server.ssrLoadModule('/src/features/agent-workbench/useAgentTranslate.ts');
    agentTranslateSettings.enabled = false;
    const { default: ExecutionPanel } = await server.ssrLoadModule('/src/features/agent-workbench/AgentExecutionPanel.vue');
    const runs = Array.from({ length: 106 }, (_, index) => run(String(index), index));
    runs[105]!.result = '本轮报告\n\n- [查看文件](https://example.com/report.xlsx)\n- 原始结论 L123';
    const conversation: AgentConversation = { id: 'group:fixture', title: '测试群', source: 'workspace', loaded: true,
      runs, latest: runs[105]!, updatedAt: runs[105]!.updatedAt };
    async function render(collapsibleRuns: boolean) {
      const app = createSSRApp({ render: () => h(ExecutionPanel, { conversation, collapsibleRuns, compact: true, visible: false,
        runLabel: (run: AgentRun) => `成员 ${run.id}` }) });
      app.component('el-empty', { render: () => null });
      return renderToString(app);
    }
    const html = await render(true), details = [...html.matchAll(/<details\b[^>]*class="execution-round"[^>]*>/g)].map(match => match[0]);
    assert.equal(details.length, 106, '全部运行仍可逐条浏览');
    assert.equal(details.filter(tag => /\sopen(?:[\s=>])/.test(tag)).length, 1);
    assert.doesNotMatch(html, /历史原文-0/);
    assert.match(html, /<a\b[^>]*href="https:\/\/example.com\/report.xlsx"/);
    assert.match(html, /<ul\b/); assert.match(html, /原始结论 L123/);
    assert.match(html, /运行已结束/); assert.doesNotMatch(html, /验收完成/);
    assert.equal([...html.matchAll(/aria-label="查看运行 \d+ 的日志"/g)].length, 106);
    const ordinary = await render(false);
    assert.doesNotMatch(ordinary, /<details\b[^>]*class="execution-round"/);
    assert.match(ordinary, /历史原文-0/);
    assert.match(ordinary, /历史原文-104/);
    runs[105] = { ...runs[105]!, status: 'failed', error: 'L998：工具拒绝\n<原错误> & 原因', result: '' };
    const failure = await render(true);
    assert.match(failure, /L998：工具拒绝/);
    assert.match(failure, /&lt;原错误&gt; &amp; 原因/);
  } finally { await server.close(); }
});
