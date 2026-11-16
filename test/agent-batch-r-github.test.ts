import assert from 'node:assert/strict';
import test from 'node:test';
import { effectScope, nextTick, ref } from 'vue';
import type { AgentRunMode } from '../shared/agent-runtime.js';
import {
  analyzeSmartPaste,
  applySmartPasteAction,
  extractPromptVariables,
  fillPromptVariables,
} from '../src/features/agent-workbench/prompt-variables-and-paste.js';
import {
  useAgentSlashPrompts,
  type PendingSlashVariableContext,
} from '../src/features/agent-workbench/useAgentSlashPrompts.js';
import {
  canRenderMermaidLite,
  renderMermaidLiteSvg,
  svgToDataUri,
} from '../src/features/agent-workbench/mermaid-lite-svg.js';
import {
  AGENT_BOOKMARKS_STORAGE_KEY,
  readAgentBookmarks,
  useAgentBookmarks,
} from '../src/features/agent-workbench/useAgentBookmarks.js';

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear() { map.clear(); },
    getItem(key: string) { return map.get(key) ?? null; },
    key(index: number) { return [...map.keys()][index] ?? null; },
    removeItem(key: string) { map.delete(key); },
    setItem(key: string, value: string) { map.set(key, value); },
  };
}

test('extractPromptVariables 与 fillPromptVariables 支持中英文冒号默认值、去重并忽略光标占位符', async () => {
  const tpl = '请排查 {{接口路径}}，现象：{{异常现象：返回 500 报错}}，核对 {{接口路径}} 与 {{重试次数:3}}。{{光标}}';
  const vars = extractPromptVariables(tpl);
  assert.deepEqual(vars.map(v => ({ key: v.key, defaultValue: v.defaultValue })), [
    { key: '接口路径', defaultValue: '' },
    { key: '异常现象', defaultValue: '返回 500 报错' },
    { key: '重试次数', defaultValue: '3' },
  ]);

  const filled = fillPromptVariables(tpl, { 接口路径: '/api/orders/list' });
  assert.equal(filled, '请排查 /api/orders/list，现象：返回 500 报错，核对 /api/orders/list 与 3。');

  // 验证内置 /查接口 指令选中时自动触发 onVariablePrompt 并切换只读分析模式
  const scope = effectScope();
  await scope.run(async () => {
    const draft = ref('补充背景\n/查接口');
    const modes: AgentRunMode[] = [];
    let captured: PendingSlashVariableContext | undefined;
    const slash = useAgentSlashPrompts(
      draft,
      () => ({ modes: ['agent', 'plan', 'ask'], modeLocked: false }),
      () => false,
      mode => modes.push(mode),
      null,
      ctx => { captured = ctx; },
    );
    await nextTick();
    assert.equal(slash.open.value, true);
    const apiOption = slash.options.value.find(item => item.command === '查接口');
    assert.ok(apiOption);
    slash.select(apiOption);
    assert.equal(slash.open.value, false);
    assert.equal(draft.value, '补充背景\n');
    assert.deepEqual(modes, ['ask']);
    assert.ok(captured);
    assert.equal(captured.option.command, '查接口');
  });
  scope.stop();
});

test('analyzeSmartPaste 与 applySmartPasteAction 识别大段报错日志/JSON，并保留上下文与反引号嵌套安全', () => {
  // 短文本与已包裹代码块不打扰
  assert.equal(analyzeSmartPaste('TypeError: x is undefined'), undefined);
  assert.equal(analyzeSmartPaste('```ts\n' + 'const a = 1;\n'.repeat(12) + '```'), undefined);

  const stack = [
    'TypeError: Cannot read properties of undefined (reading "orderId")',
    '    at submitOrder (/app/src/orders/submit.ts:42:18)',
    '    at async handleCheckout (/app/src/orders/checkout.ts:88:5)',
    '    at async runTask (/app/server/worker.ts:19:3)',
    '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
    '    at async /app/server/http.ts:120:7',
    '    at async dispatch (/app/server/router.ts:54:12)',
    '    at async Server.<anonymous> (/app/server/index.ts:31:9)',
  ].join('\n');

  const hint = analyzeSmartPaste(stack, '');
  assert.ok(hint);
  assert.equal(hint.kind, 'error-log');
  assert.match(hint.summaryLabel, /8 行报错日志/);

  const draftWithPrefix = `我在点提交订单时挂了：\n${stack}`;
  const fixedPrompt = applySmartPasteAction(draftWithPrefix, hint, 'ask-fix-error');
  assert.ok(fixedPrompt.includes('我在点提交订单时挂了：'));
  assert.ok(fixedPrompt.includes('请帮我定位并修复下面这段报错'));
  assert.ok(fixedPrompt.includes('```text\nTypeError: Cannot read properties'));

  // 含三反引号的内容自动升级为四反引号围栏
  const tricky = Array.from({ length: 9 }, (_, i) => `line ${i} \`\`\` nested`).join('\n');
  const codeHint = analyzeSmartPaste(tricky, '');
  assert.ok(codeHint);
  const wrapped = applySmartPasteAction(tricky, codeHint, 'wrap-fence');
  assert.ok(wrapped.startsWith('````text\n'));
  assert.ok(wrapped.endsWith('\n````'));

  // JSON 自动识别为 json 语言标签
  const jsonText = JSON.stringify({ code: 0, list: Array.from({ length: 8 }, (_, i) => ({ id: i, name: `item-${i}` })) }, null, 2);
  const jsonHint = analyzeSmartPaste(jsonText, '');
  assert.ok(jsonHint);
  assert.equal(jsonHint.language, 'json');
  assert.match(jsonHint.summaryLabel, /JSON 数据/);
});

test('Mermaid-Lite 支持带环流程图、链式连线、时序图渲染，并严格转义危险标签', () => {
  const flowSource = [
    'flowchart TD',
    '  A(["开始请求"]) --> B{"<script>alert(1)</script> 鉴权?"}',
    '  B -->|通过| C[查询业务服务] --> D[(MySQL 数据库)]',
    '  B -.->|过期重试| A',
  ].join('\n');

  assert.equal(canRenderMermaidLite('mermaid', flowSource), true);
  assert.equal(canRenderMermaidLite('ts', flowSource), false);

  const flowRes = renderMermaidLiteSvg(flowSource);
  assert.ok(flowRes);
  assert.equal(flowRes.kind, 'flowchart');
  assert.equal(flowRes.nodeCount, 4);
  assert.equal(flowRes.edgeCount, 4);
  assert.ok(!flowRes.svg.includes('<script>'));
  assert.ok(flowRes.svg.includes('&lt;script&gt;'));
  assert.ok(flowRes.svg.includes('&lt;/script&gt;'));
  assert.ok(svgToDataUri(flowRes.svg).startsWith('data:image/svg+xml;charset=utf-8,'));

  const seqSource = [
    'sequenceDiagram',
    '  autonumber',
    '  actor U as 用户',
    '  participant W as 5288工作台',
    '  participant S as 后端服务',
    '  U->>W: 点击部署更新',
    '  W->>W: 校验本地构建产物',
    '  W->>+S: POST /api/workspace/restart',
    '  Note over W,S: 空闲时平滑重启',
    '  S-->>-W: 200 OK',
  ].join('\n');

  const seqRes = renderMermaidLiteSvg(seqSource);
  assert.ok(seqRes);
  assert.equal(seqRes.kind, 'sequence');
  assert.equal(seqRes.nodeCount, 3);
  assert.equal(seqRes.edgeCount, 4);
  assert.ok(seqRes.svg.includes('1. 点击部署更新'));
  assert.ok(seqRes.svg.includes('空闲时平滑重启'));

  // 未支持的图表类型不强行渲染残缺图，回退为普通源码块
  assert.equal(canRenderMermaidLite('mermaid', 'pie title 占比\n  "A" : 40\n  "B" : 60'), false);
});

test('useAgentBookmarks 支持跨会话收藏、取消收藏与持久化恢复', () => {
  const storage = createMemoryStorage();
  const store = useAgentBookmarks(storage);

  assert.equal(store.bookmarks.value.length, 0);
  const added1 = store.toggleBookmark({
    conversationId: 'conv-1',
    conversationTitle: '订单超时排查',
    messageKey: 'msg-9',
    turnIndex: 4,
    content: '### 排查结论\n\n请执行 `curl -s http://127.0.0.1:5288/api/health` 核对服务状态。',
  });
  assert.equal(added1, true);
  assert.equal(store.isBookmarked('conv-1', 'msg-9'), true);

  const added2 = store.toggleBookmark({
    conversationId: 'conv-2',
    conversationTitle: '数据库索引优化',
    messageKey: 'msg-3',
    turnIndex: 2,
    content: '建议补充联合索引 `idx_tenant_created_at`。',
  });
  assert.equal(added2, true);
  assert.equal(store.bookmarks.value.length, 2);
  assert.ok(storage.getItem(AGENT_BOOKMARKS_STORAGE_KEY)?.includes('订单超时排查'));

  // 重新从存储读取仍完整保留跨会话书签
  const persisted = readAgentBookmarks(storage);
  assert.equal(persisted.length, 2);
  assert.equal(persisted[0]?.conversationId, 'conv-2');
  assert.ok(!persisted[1]?.excerpt.includes('###'));

  // 再次点击同一消息即取消收藏
  const toggledOff = store.toggleBookmark({
    conversationId: 'conv-1',
    conversationTitle: '订单超时排查',
    messageKey: 'msg-9',
    content: '任意',
  });
  assert.equal(toggledOff, false);
  assert.equal(store.isBookmarked('conv-1', 'msg-9'), false);
  assert.equal(store.bookmarks.value.length, 1);
});
