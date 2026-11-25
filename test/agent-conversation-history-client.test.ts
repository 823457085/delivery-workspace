import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { QueryClient } from '@tanstack/vue-query';
import { effectScope, shallowRef } from 'vue';
import type { AgentRun, AgentRuntimeDashboard } from '../shared/agent-runtime';
import { createRuntimeStreamState, sameAgentRunSummary } from '../src/features/agent-workbench/runtime-stream-state';
import { useAgentConversationHistories } from '../src/features/agent-workbench/useAgentConversationHistories';

function run(id: string, offset: number, conversationId = 'a'): AgentRun {
  const time = new Date(offset * 1000).toISOString();
  return { id, conversationId, mode: 'ask', provider: 'codex', accessMode: 'workspace',
    model: '', reasoningEffort: '', objective: '', workspacePath: '/tmp', branch: '', headSha: '',
    sessionId: '', pid: 1, error: '', result: '', events: [], status: 'running', createdAt: time, updatedAt: time };
}

test('同一会话只更新正文时间时保持索引身份，结束状态仍会更新', () => {
  const state = createRuntimeStreamState(sameAgentRunSummary);
  const a = run('a', 1);
  const b = run('b', 1, 'b');
  const snapshot: AgentRuntimeDashboard = { revision: 1, runs: [a, b], runtimes: [], codexSessions: [],
    conversationTitles: {}, codexSync: { total: 0, hidden: 0, syncedAt: '' }, activeWorkspaceLocks: [] };
  assert.equal(state.receive(2, [{ ...a, updatedAt: '1970-01-01T00:00:03.000Z' }], snapshot), snapshot);
  const finished = state.receive(3, [{ ...a, status: 'completed' }], snapshot);
  assert.equal(finished?.runs.find(item => item.id === 'a')?.status, 'completed');
  assert.equal(finished?.runs.find(item => item.id === 'b'), b);
});

test('只追读受影响的打开会话，实时首页刷新与加载上一页同时发生也不会丢旧页锚点', { timeout: 5000 }, async (context) => {
  const client = new QueryClient();
  const scope = effectScope();
  const requests: string[] = [];
  const a3 = run('a3', 3), a2 = run('a2', 2), a1 = run('a1', 1);
  let revision = 1;
  let finishOlder!: (response: Response) => void;
  context.mock.method(globalThis, 'fetch', (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname.includes('/runs/')) {
      requests.push(`run/${url.pathname.split('/').at(-1)}`);
      return Promise.resolve(Response.json({ ...a3, result: '实时正文' }, { headers: { 'X-Agent-Revision': String(revision) } }));
    }
    const id = url.pathname.split('/').at(-2)!;
    requests.push(id + url.search);
    if (url.search) return new Promise<Response>(resolve => { finishOlder = resolve; });
    return Promise.resolve(Response.json({
      revision, runs: id === 'a' ? [revision === 1 ? a2 : a3] : [run('b1', 1, 'b')],
      olderCursor: id === 'a' ? revision === 1 ? a2.id : a3.id : null,
    }));
  });
  const { histories, main, side } = scope.run(() => {
    const histories = useAgentConversationHistories(client, shallowRef(true));
    return { histories, main: histories.useHistory(() => 'a'), side: histories.useHistory(() => 'b') };
  })!;
  const until = async (condition: () => boolean) => {
    for (let i = 0; i < 100 && !condition(); i++) await delay(20);
    assert.ok(condition());
  };
  try {
    await until(() => main.ready.value && side.ready.value);
    const older = main.loadOlder();
    await until(() => !!finishOlder);
    revision = 2;
    histories.requestRefresh(['a', 'not-open'], 2);
    await until(() => main.runs.value[0]?.id === 'a3');
    assert.deepEqual(requests.sort(), ['a', 'a', 'a?before=a2', 'b']);
    finishOlder(Response.json({ revision: 1, runs: [a1], olderCursor: null }));
    await older;
    assert.deepEqual(main.runs.value.map(run => run.id), ['a3', 'a2', 'a1']);
    assert.deepEqual(side.runs.value.map(run => run.id), ['b1']);
    assert.equal(main.olderCursor.value, null);
    revision = 3;
    histories.requestRunUpdates([a3, run('offscreen', 1, 'not-open')], revision, ['a', 'not-open']);
    await until(() => main.runs.value[0]?.result === '实时正文');
    assert.deepEqual(requests.sort(), ['a', 'a', 'a?before=a2', 'b', 'run/a3']);
    assert.deepEqual(main.runs.value.map(run => run.id), ['a3', 'a2', 'a1']);
    assert.equal(main.olderCursor.value, null);
  } finally {
    scope.stop();
    client.clear();
  }
});
