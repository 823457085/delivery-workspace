import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRun } from '../shared/agent-runtime.js';
import type { AgentConversation } from '../src/features/agent-workbench/conversation.js';
import { parsePinnedAgentSessionIds, PINNED_AGENT_SESSIONS_STORAGE_KEY, readPinnedAgentSessionIds,
  isPinnedAgentSession, migratePinnedAgentSessionIds, pinnedAgentSessionId, savePinnedAgentSessionIds,
  togglePinnedAgentSession } from '../src/features/agent-workbench/session-pins.js';

function conversation(id: string, originSessionId = ''): AgentConversation {
  const run: AgentRun = { id, ...(originSessionId ? { originSessionId } : {}), provider: 'codex', mode: 'ask', accessMode: 'workspace',
    model: '', reasoningEffort: '', objective: '测试会话', workspacePath: '/repo', branch: 'feature/test', headSha: '', status: 'completed',
    sessionId: originSessionId || id, pid: null, result: '', error: '', events: [], createdAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z' };
  return { id, title: run.objective, runs: [run], latest: run, updatedAt: run.updatedAt, source: originSessionId ? 'workspace' : 'codex', loaded: true };
}

test('置顶会话去重并忽略非字符串或损坏的本地数据', () => {
  assert.deepEqual([...parsePinnedAgentSessionIds('["session-1","session-1",2,""]')], ['session-1']);
  assert.deepEqual([...parsePinnedAgentSessionIds('{broken')], []);
});

test('置顶会话在专用本地存储键中完整往返', () => {
  const entries = new Map<string, string>();
  const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); } };
  assert.equal(savePinnedAgentSessionIds(storage, new Set(['session-1', 'session-2'])), true);
  assert.equal(entries.has(PINNED_AGENT_SESSIONS_STORAGE_KEY), true);
  assert.deepEqual([...readPinnedAgentSessionIds(storage)], ['session-1', 'session-2']);
});

test('Codex 历史会话续聊时将旧置顶键迁移到本地会话 ID', () => {
  const sessionId = 'session-1';
  const history = conversation(sessionId);
  const continued = conversation('local-run-1', sessionId);
  assert.equal(pinnedAgentSessionId(history), sessionId);
  assert.equal(pinnedAgentSessionId(continued), 'local-run-1');
  assert.deepEqual([...migratePinnedAgentSessionIds(new Set([sessionId]), [continued])], ['local-run-1']);
});

test('旧的本地运行置顶键继续生效并可正常取消', () => {
  const continued = conversation('local-run-1', 'session-1');
  const legacyPins = new Set(['local-run-1']);
  assert.equal(isPinnedAgentSession(legacyPins, continued), true);
  assert.deepEqual([...togglePinnedAgentSession(legacyPins, continued)], []);
  assert.deepEqual([...togglePinnedAgentSession(new Set(), continued)], ['local-run-1']);
});

test('旧根运行被裁掉后迁移为侧栏会话 ID', () => {
  const item = conversation('retained-run');
  item.runs[0].parentRunId = 'pruned-root';
  item.runs[0].sessionId = 'cli-session';
  assert.deepEqual([...migratePinnedAgentSessionIds(new Set(['pruned-root']), [item])], ['retained-run']);
  assert.equal(pinnedAgentSessionId(item), 'retained-run');
});

test('共享旧 Codex session 的两行迁移后可以分别取消置顶', () => {
  const first = conversation('conversation-first');
  const second = conversation('conversation-second');
  first.runs[0].sessionId = 'shared-session';
  second.runs[0].sessionId = 'shared-session';
  const migrated = migratePinnedAgentSessionIds(new Set(['shared-session']), [first, second]);
  assert.deepEqual(migrated, new Set(['conversation-first', 'conversation-second']));
  const unpinned = togglePinnedAgentSession(migrated, first);
  assert.equal(isPinnedAgentSession(unpinned, first), false);
  assert.equal(isPinnedAgentSession(unpinned, second), true);
});
