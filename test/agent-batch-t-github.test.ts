import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRun } from '../shared/agent-runtime.js';
import { buildAgentConversations } from '../src/features/agent-workbench/conversation.js';
import { formatCodeBlockFollowUp } from '../src/features/agent-workbench/code-block-tools.js';
import {
  buildSelectionActionPrompt,
  looksLikeErrorSelection,
} from '../src/features/agent-workbench/selection-quick-actions.js';
import {
  buildConversationClipboardDigest,
  countKeywordOccurrences,
  stepSearchMatchIndex,
} from '../src/features/agent-workbench/conversation-search-and-share.js';
import {
  canEnhancePromptDraft,
  enhancePromptDraft,
} from '../src/features/agent-workbench/prompt-enhancer.js';

test('code-block-tools formatCodeBlockFollowUp 支持安全反引号包裹代码块追问并防重复追加', () => {
  const simple = formatCodeBlockFollowUp('ts', 'export const timeout = 3000;\n');
  assert.equal(simple, '```ts\nexport const timeout = 3000;\n```\n\n');

  // 重复点击同一代码块不会重复插入
  assert.equal(formatCodeBlockFollowUp('ts', 'export const timeout = 3000;\n', simple), simple);

  // 代码块内若本身含有三反引号，自动升级外层围栏长度避免破损
  const nested = formatCodeBlockFollowUp('md', '示例：\n```bash\npnpm build\n```', '请帮我改一下这段说明：');
  assert.ok(nested.includes('````md\n示例：\n```bash\npnpm build\n```\n````\n\n'));
  assert.ok(nested.startsWith('请帮我改一下这段说明：\n\n````md'));
});

test('selection-quick-actions 支持识别报错选区并生成解释、排障与总结引用提示词', () => {
  assert.equal(looksLikeErrorSelection('TypeError: Cannot read properties of undefined'), true);
  assert.equal(looksLikeErrorSelection('接口返回结果包含三个分页字段'), false);

  const explainPrompt = buildSelectionActionPrompt('const memo = new WeakMap();', 'explain');
  assert.ok(explainPrompt.startsWith('> const memo = new WeakMap();\n\n'));
  assert.ok(explainPrompt.includes('通俗易懂的大白话解释'));

  const fixPrompt = buildSelectionActionPrompt('ERR! ECONNREFUSED 127.0.0.1:6379', 'fix-error', '上下文说明');
  assert.ok(fixPrompt.startsWith('> ERR! ECONNREFUSED 127.0.0.1:6379\n\n上下文说明\n'));
  assert.ok(fixPrompt.includes('排查上面这段报错'));
});

test('conversation-search-and-share 准确统计搜索命中、支持循环步进并生成清爽剪贴板纪要', () => {
  assert.equal(countKeywordOccurrences('OrderId orderid ORDERID', 'orderId'), 3);
  assert.equal(stepSearchMatchIndex(0, 4, -1), 3);
  assert.equal(stepSearchMatchIndex(3, 4, 1), 0);

  const sampleRun: AgentRun = {
    id: 'run-digest-1',
    provider: 'codex',
    mode: 'agent',
    accessMode: 'workspace',
    model: 'gpt-5',
    reasoningEffort: '',
    objective: '修复导出超时问题',
    workspacePath: '/Users/demo/order-web',
    branch: 'fix/export-timeout',
    headSha: '',
    status: 'completed',
    sessionId: 'sess-1',
    pid: null,
    result: '已改为流式分页导出并补充单测。',
    error: '',
    events: [],
    changedFiles: [{ path: 'src/export.ts', status: 'modified' }],
    createdAt: '2026-11-15T12:00:00Z',
    updatedAt: '2026-11-15T12:05:00Z',
  };
  const [conv] = buildAgentConversations([sampleRun]);
  const digest = buildConversationClipboardDigest(conv!);
  assert.ok(digest.includes('# 修复导出超时问题'));
  assert.ok(digest.includes('`src/export.ts（modified）`'));
  assert.ok(digest.includes('已改为流式分页导出并补充单测。'));
});

test('prompt-enhancer 本地零延迟扩写简短提问并防止重复扩写已结构化草稿', () => {
  const shortBug = '把 @order-list.vue 切换页码白屏的问题修一下';
  assert.equal(canEnhancePromptDraft(shortBug), true);
  const res = enhancePromptDraft(shortBug, 'agent');
  assert.equal(res.intentLabel, '缺陷排查修复');
  assert.ok(res.enhanced.includes('@order-list.vue'), '必须完整保留原有的 @ 引用');
  assert.ok(res.enhanced.includes('定位根因'));
  // 扩写后的结构化文本不应再次允许重复套娃扩写
  assert.equal(canEnhancePromptDraft(res.enhanced), false);

  const planRes = enhancePromptDraft('给网关增加限流中间件', 'plan');
  assert.equal(planRes.intentLabel, '方案规划');
  assert.ok(planRes.enhanced.includes('暂不直接改代码'));
});
