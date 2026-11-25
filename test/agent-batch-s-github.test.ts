import assert from 'node:assert/strict';
import test from 'node:test';
import { effectScope, nextTick, ref } from 'vue';
import type { AgentRun } from '../shared/agent-runtime.js';
import { buildAgentConversations, type AgentConversation } from '../src/features/agent-workbench/conversation.js';
import { useAgentUnreadSessions } from '../src/features/agent-workbench/useAgentUnreadSessions.js';
import {
  AGENT_INPUT_HISTORY_KEY,
  readInputHistory,
  recordSubmittedPrompt,
  useAgentInputHistory,
} from '../src/features/agent-workbench/useAgentInputHistory.js';
import { integrationCatalog } from '../shared/integration-plugins.js';
import { registeredWorkspaceSections } from '../src/pages/agent/workspace-navigation.js';
import { buildCommandPaletteItems, filterCommandPaletteItems } from '../src/pages/agent/command-palette.js';
import {
  inferCodeBlockFilename,
  inspectJsonCodeBlock,
} from '../src/features/agent-workbench/code-block-tools.js';
import {
  matchesSessionQuickFilter,
  summarizeSessionQuickFilters,
} from '../src/features/agent-workbench/session-quick-filter.js';
import {
  computeCommandFrecencyBoost,
  readCommandUsageList,
  recordCommandUsageEntry,
  writeCommandUsageList,
} from '../src/pages/agent/command-palette-history.js';

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

function makeKeyEvent(key: string, extra: Partial<KeyboardEvent> = {}): KeyboardEvent {
  let prevented = false;
  return {
    key,
    keyCode: 0,
    isComposing: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault() { prevented = true; },
    get defaultPrevented() { return prevented; },
    ...extra,
  } as unknown as KeyboardEvent;
}

test('useAgentInputHistory 支持空框 ↑/↓ 翻找历史提问、去重持久化，且修改草稿后不抢占正常多行光标', () => {
  const storage = createMemoryStorage();
  const scope = effectScope();
  scope.run(() => {
    const draft = ref('');
    const hist = useAgentInputHistory(draft, () => false, storage);

    hist.recordSubmitted('第一条：检查登录接口');
    hist.recordSubmitted('第二条：修复订单金额精度');
    // 重复提交相同内容应移至队首去重而非重复入队
    hist.recordSubmitted('第一条：检查登录接口');

    assert.equal(hist.entries.value.length, 2);
    assert.equal(hist.entries.value[0], '第一条：检查登录接口');
    assert.ok(storage.getItem(AGENT_INPUT_HISTORY_KEY)?.includes('修复订单金额精度'));
    assert.equal(readInputHistory(storage).length, 2);

    // 1. 非空手写草稿按 ↑ 不拦截（保留原生多行移动）
    draft.value = '正在输入的新多行草稿\n第二行';
    assert.equal(hist.handleKeydown(makeKeyEvent('ArrowUp')), false);
    assert.equal(draft.value, '正在输入的新多行草稿\n第二行');

    // 2. 空输入框按 ↑ 依次调出最近记录，按 ↓ 退回直至清空
    draft.value = '';
    assert.equal(hist.handleKeydown(makeKeyEvent('ArrowUp')), true);
    assert.equal(draft.value, '第一条：检查登录接口');
    assert.equal(hist.handleKeydown(makeKeyEvent('ArrowUp')), true);
    assert.equal(draft.value, '第二条：修复订单金额精度');
    assert.equal(hist.handleKeydown(makeKeyEvent('ArrowDown')), true);
    assert.equal(draft.value, '第一条：检查登录接口');
    assert.equal(hist.handleKeydown(makeKeyEvent('ArrowDown')), true);
    assert.equal(draft.value, '');

    // 3. 调出历史后一旦用户改动了文字，继续按 ↑/↓ 不再覆盖用户编辑
    assert.equal(hist.handleKeydown(makeKeyEvent('ArrowUp')), true);
    draft.value = `${draft.value}（补充条件）`;
    assert.equal(hist.handleKeydown(makeKeyEvent('ArrowUp')), false);
    assert.equal(draft.value, '第一条：检查登录接口（补充条件）');
  });
  scope.stop();
});

test('inferCodeBlockFilename 与 inspectJsonCodeBlock 智能提取注释文件名、安全防越界并支持 JSON 格式化与压缩', () => {
  // 从首行注释提取真实文件名，并剥离危险路径前缀
  const withComment = inferCodeBlockFilename('ts', '// ../../src/utils/retry-policy.ts\nexport const retries = 3;\n', 0);
  assert.equal(withComment.filename, 'retry-policy.ts');

  const shellWithShebang = inferCodeBlockFilename('bash', '#!/usr/bin/env bash\n# scripts/deploy_prod.sh\necho ok\n', 1);
  assert.equal(shellWithShebang.filename, 'deploy_prod.sh');

  const sqlFallback = inferCodeBlockFilename('sql', 'SELECT id, total FROM orders WHERE status = 1;', 2);
  assert.equal(sqlFallback.filename, 'query-3.sql');

  // JSON 检测、美化排版与单行压缩
  const compactJson = '{"code":0,"message":"ok","items":[1,2,3]}';
  const inspected = inspectJsonCodeBlock('json', compactJson);
  assert.equal(inspected.valid, true);
  if (inspected.valid) {
    assert.equal(inspected.summary, 'JSON · 3 个字段');
    assert.equal(inspected.isMultiLine, false);
    assert.ok(inspected.pretty.includes('\n  "code": 0,'));
    assert.equal(inspected.minified, compactJson);
  }

  assert.equal(inspectJsonCodeBlock('ts', 'const obj = { a: 1 };').valid, false);
  assert.equal(inspectJsonCodeBlock('json', '{ broken json').valid, false);
});

test('会话快捷筛选区分未读、进行中、有改代码和异常', () => {
  const mkRun = (id: string, overrides: Partial<AgentRun>): AgentRun => ({
    id,
    provider: 'codex',
    mode: 'agent',
    accessMode: 'workspace',
    model: 'gpt-5',
    reasoningEffort: '',
    objective: `任务 ${id}`,
    workspacePath: '/repo',
    branch: 'main',
    headSha: '',
    status: 'completed',
    sessionId: id,
    pid: null,
    result: 'ok',
    error: '',
    events: [],
    createdAt: '2026-11-15T10:00:00Z',
    updatedAt: '2026-11-15T10:05:00Z',
    ...overrides,
  });

  const conversations = buildAgentConversations([
    mkRun('c1', { status: 'running' }),
    mkRun('c2', { status: 'failed', error: 'Build error', changedFiles: [{ path: 'src/a.ts', status: 'modified' }] }),
    mkRun('c3', { status: 'completed', hasChangedFiles: true }),
    mkRun('c4', { status: 'completed' }),
  ]);

  const unread = new Set(['c3']);
  const counts = summarizeSessionQuickFilters(conversations, unread);
  assert.deepEqual(counts, {
    all: 4,
    unread: 1,
    active: 1,
    changed: 2,
    attention: 1,
  });

  assert.deepEqual(conversations.filter(c => matchesSessionQuickFilter(c, 'unread', unread.has(c.id))).map(c => c.id), ['c3']);
  assert.equal(conversations.filter(c => matchesSessionQuickFilter(c, 'active')).length, 1);
  assert.equal(conversations.filter(c => matchesSessionQuickFilter(c, 'changed')).length, 2);
  assert.equal(conversations.filter(c => matchesSessionQuickFilter(c, 'attention')).length, 1);
});

test('完成未读跨刷新保留，详情画面读到当前结果后才清除', async () => {
  const now = Date.parse('2026-11-15T10:00:00Z');
  const run = (id: string, time: number, extra: Partial<AgentRun> = {}): AgentRun => ({
    id, conversationId: 'thread', provider: 'codex', mode: 'agent', accessMode: 'workspace',
    model: 'gpt-5', reasoningEffort: '', objective: id, workspacePath: '/repo',
    branch: 'main', headSha: '', status: 'completed', sessionId: 'cli', pid: null,
    result: 'ok', error: '', events: [], createdAt: new Date(time - 10).toISOString(),
    updatedAt: new Date(time).toISOString(), ...extra,
  });
  const old = run('old', now - 1), saved = run('saved', now + 50);
  const conversations = ref(buildAgentConversations([old]));
  const visible = ref<AgentConversation[]>([]);
  const storage = createMemoryStorage(), scope = effectScope();
  const unread = scope.run(() => useAgentUnreadSessions(conversations, visible, storage, now))!;
  assert.equal(unread.value.size, 0);
  for (const latest of [run('failed', now + 1, { status: 'failed' }), run('cancelled', now + 2, { status: 'cancelled' }),
    run('saving', now + 3, { resultReady: false })]) {
    conversations.value = buildAgentConversations([latest]);
    assert.equal(unread.value.size, 0);
  }
  conversations.value = buildAgentConversations([saved]);
  assert.deepEqual([...unread.value], ['thread']);
  visible.value = buildAgentConversations([saved]).map(conversation => ({ ...conversation, loaded: false }));
  await nextTick();
  assert.deepEqual([...unread.value], ['thread']);
  visible.value = buildAgentConversations([old]);
  await nextTick();
  assert.deepEqual([...unread.value], ['thread']);
  scope.stop();

  const refreshed = effectScope();
  visible.value = [];
  const restoredUnread = refreshed.run(() => useAgentUnreadSessions(conversations, visible, storage, now + 100))!;
  assert.deepEqual([...restoredUnread.value], ['thread']);
  visible.value = buildAgentConversations([saved]);
  await nextTick();
  assert.equal(restoredUnread.value.size, 0);
  refreshed.stop();

  const reopened = effectScope();
  visible.value = [];
  const read = reopened.run(() => useAgentUnreadSessions(conversations, visible, storage, now + 100))!;
  assert.equal(read.value.size, 0);
  conversations.value = buildAgentConversations([run('next-result', now + 200)]);
  assert.deepEqual([...read.value], ['thread']);
  reopened.stop();
});

test('command-palette-history 按使用频次与时间衰减计算 Frecency 提权分值', () => {
  const storage = createMemoryStorage();
  const now = 1_760_000_000_000;
  let list = recordCommandUsageEntry([], 'workspace:ports', now - 10 * 24 * 3600 * 1000);
  list = recordCommandUsageEntry(list, 'workspace:interfaces', now - 5 * 60 * 1000);
  list = recordCommandUsageEntry(list, 'workspace:interfaces', now - 60 * 1000);
  writeCommandUsageList(list, storage);

  const restored = readCommandUsageList(storage);
  assert.equal(restored.length, 2);
  assert.equal(restored[0]?.id, 'workspace:interfaces');
  assert.equal(restored[0]?.count, 2);

  const recentBoost = computeCommandFrecencyBoost(restored[0], now);
  const oldBoost = computeCommandFrecencyBoost(restored[1], now);
  assert.ok(recentBoost > oldBoost, '高频且刚用过的命令项提权分值应高于数天前的低频项');

  // 验证 recordSubmittedPrompt 独立写入与读取
  recordSubmittedPrompt('通过发送按钮提交的指令', storage);
  assert.equal(readInputHistory(storage)[0], '通过发送按钮提交的指令');

  // 验证命令面板集成：支持 ! 筛选重点收藏书签，且常用工作区获得 Frecency 提权与常用标记
  const sections = registeredWorkspaceSections(integrationCatalog.map(plugin => plugin.id));
  const items = buildCommandPaletteItems({
    sections,
    isChatActive: true,
    chatMode: 'session',
    railCollapsed: false,
    currentThemeId: 'cursor',
    bookmarks: [
      {
        id: 'conv-1::run-1:assistant',
        conversationId: 'conv-1',
        conversationTitle: '生产慢查询治理',
        turnIndex: 3,
        excerpt: 'ALTER TABLE orders ADD INDEX idx_created_status (created_at, status)',
        content: '```sql\nALTER TABLE orders ADD INDEX idx_created_status (created_at, status);\n```',
      },
    ],
  });

  const onlyBookmarks = filterCommandPaletteItems(items, '! idx_created_status', 'all', restored, now);
  assert.equal(onlyBookmarks.length, 1);
  assert.equal(onlyBookmarks[0]?.category, 'bookmark');
  assert.ok(onlyBookmarks[0]?.bookmarkContent?.includes('ALTER TABLE orders'));

  const workspacesRanked = filterCommandPaletteItems(items, '', 'workspace', restored, now);
  assert.equal(workspacesRanked[0]?.id, 'workspace:interfaces');
  assert.equal(workspacesRanked[0]?.frequentlyUsed, true);
});
