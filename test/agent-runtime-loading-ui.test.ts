/** Exercise the real composable with controlled requests; connection probes must not gate conversation state. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { computed, effectScope, nextTick, shallowRef } from 'vue';
import { createRuntimeRefresh, createRuntimeStreamState } from '../src/features/agent-workbench/runtime-stream-state.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture() {
  const source = fs.readFileSync(new URL('../src/features/agent-workbench/useAgentRuntimes.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('useAgentRuntimes.ts', source, ts.ScriptTarget.Latest, true);
  const body = tree.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(tree)).join('\n');
  const code = ts.transpileModule(body.replace('export function useAgentRuntimes', 'function useAgentRuntimes'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const connection = deferred<unknown>();
  const queries = new Map<string, any>();
  const messages: string[] = [];
  const urls: string[] = [];
  const mounted: (() => void)[] = [], unmounted: (() => void)[] = [];
  let stream: { listeners: Map<string, (event: unknown) => void> };
  class EventSource {
    listeners = new Map<string, (event: unknown) => void>();
    constructor() { stream = this; }
    addEventListener(name: string, listener: (event: unknown) => void) { this.listeners.set(name, listener); }
    close() {}
  }
  const snapshot = { revision: 1, runtimeStatusVersion: 1, runtimes: [], runs: [{ id: 'run', result: '已保存的回复', status: 'running',
    createdAt: '2026-11-02T00:00:00Z', workspacePath: '/fixture', provider: 'antigravity' }],
    activeWorkspaceLocks: [], codexSessions: [], conversationTitles: {}, codexSync: { total: 0, hidden: 0, syncedAt: '' } };
  const useQuery = (options: any) => {
    const data = shallowRef(), error = shallowRef<Error | null>(null), isPending = shallowRef(true);
    const query = { data, error, isPending, refetch: async (request: { throwOnError?: boolean } = {}) => {
      try { data.value = await options.queryFn({ signal: new AbortController().signal }); error.value = null; }
      catch (cause) { error.value = cause as Error; if (request.throwOnError) throw cause; }
      finally { isPending.value = false; }
      return { data: data.value, error: error.value };
    } };
    queries.set(options.queryKey[0], query);
    void query.refetch();
    return query;
  };
  const dependencies = { computed, shallowRef, useQuery, createRuntimeRefresh, createRuntimeStreamState, EventSource,
    onMounted: (fn: () => void) => mounted.push(fn), onUnmounted: (fn: () => void) => unmounted.push(fn),
    useQueryClient: () => ({ cancelQueries: async () => {}, setQueryData: (key: string[], update: (current: unknown) => unknown) => {
      const query = queries.get(key[0]); query.data.value = update(query.data.value);
    } }),
    ElMessage: { error: (message: string) => messages.push(message) },
    fetch: async (url: string) => {
      urls.push(url);
      if (url.startsWith('/api/agent-runtimes/status')) return { ok: true, json: () => connection.promise };
      assert.equal(url, '/api/agent-runtimes?status=0');
      return { ok: true, json: async () => structuredClone(snapshot) };
    } };
  const scope = effectScope();
  const state = scope.run(() => new Function(...Object.keys(dependencies), `${code}\nreturn useAgentRuntimes();`)(...Object.values(dependencies)))!;
  mounted.forEach(fn => fn());
  return { state, connection, urls, queries, messages,
    replaceSnapshot: (fields: Record<string, unknown>) => Object.assign(snapshot, fields),
    update: () => stream!.listeners.get('runs')!({ data: JSON.stringify({ revision: 2,
      runs: [{ ...snapshot.runs[0], result: '最新流式回复' }] }) }),
    close: () => { unmounted.forEach(fn => fn()); scope.stop(); } };
}

const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await nextTick(); };

test('连接与额度仍在等待时，首屏会话和 SSE 正文已可用；迟到的状态不覆盖正文', async () => {
  const f = fixture();
  try {
    await flush();
    assert.equal(f.state.query.isPending.value, false);
    assert.equal(f.state.query.data.value.runs[0].result, '已保存的回复');
    assert.equal(f.queries.get('agent-runtime-status').isPending.value, true);
    f.update();
    assert.equal(f.state.query.data.value.runs[0].result, '最新流式回复');
    f.connection.resolve({ runtimeStatusVersion: 1, runtimes: [{ provider: 'antigravity', ready: true, models: [{ id: 'native', label: 'L123' }] }] });
    await flush();
    assert.equal(f.state.query.data.value.runtimes[0].models[0].label, 'L123');
    assert.equal(f.state.query.data.value.runs[0].result, '最新流式回复');
    await f.state.query.refetch();
    assert.equal(f.state.query.data.value.runs[0].result, '最新流式回复');
  } finally { f.close(); }
});

test('维护和模型版本推进后保留快照的禁用或清空状态，旧账号连接与额度不再投影', async () => {
  const f = fixture();
  try {
    await flush();
    const original = { provider: 'antigravity', ready: true, models: [{ id: 'old-model', label: 'L123' }] };
    f.connection.resolve({ runtimeStatusVersion: 1, runtimes: [original],
      codexUsage: { available: true, primary: { remainingPercent: 75 } } });
    await flush();
    assert.equal(f.state.query.data.value.runtimes[0].ready, true);
    assert.equal(f.state.query.data.value.codexUsage.primary.remainingPercent, 75);
    f.replaceSnapshot({ revision: 3, runtimeStatusVersion: 2, runtimes: [{ ...original, ready: false, message: '正在管理账号' }] });
    await f.state.query.refetch();
    assert.equal(f.state.query.data.value.runtimes[0].ready, false);
    assert.equal(f.state.query.data.value.runtimes[0].message, '正在管理账号');
    assert.equal(f.state.query.data.value.codexUsage, undefined);
    f.replaceSnapshot({ revision: 4, runtimeStatusVersion: 3, runtimes: [] });
    await f.state.query.refetch();
    assert.deepEqual(f.state.query.data.value.runtimes, []);
    assert.equal(f.state.query.data.value.codexUsage, undefined);
  } finally { f.close(); }
});

test('旧状态在新版维护快照后迟到不恢复旧账号；同版的新状态及时显示真实模型', async () => {
  const f = fixture();
  try {
    await flush();
    f.replaceSnapshot({ revision: 3, runtimeStatusVersion: 2, runtimes: [] });
    await f.state.query.refetch();
    f.connection.resolve({ runtimeStatusVersion: 1, runtimes: [{ provider: 'antigravity', ready: true, models: [] }],
      codexUsage: { available: true, primary: { remainingPercent: 75 } } });
    await flush();
    assert.deepEqual(f.state.query.data.value.runtimes, []);
    assert.equal(f.state.query.data.value.codexUsage, undefined);
    const current = { provider: 'antigravity', ready: true, models: [{ id: 'new-model', label: 'L456' }] };
    f.queries.get('agent-runtime-status').data.value = { runtimeStatusVersion: 2, runtimes: [current] };
    assert.equal(f.state.query.data.value.runtimes[0].models[0].label, 'L456');
    assert.equal(f.state.query.data.value.revision, 3);
    assert.equal(f.state.query.data.value.runs[0].result, '已保存的回复');
    f.queries.get('agent-runtime-status').data.value = { runtimeStatusVersion: 3, runtimes: [current] };
    assert.equal(f.state.query.data.value.runtimeStatusVersion, 3, '状态更新比本地快照新时也立即投影');
    assert.equal(f.state.query.data.value.runtimes[0].models[0].label, 'L456');
    assert.equal(f.state.query.data.value.revision, 3, '状态版本不改写运行 revision');
  } finally { f.close(); }
});

test('状态查询失败不清空会话或恢复首屏加载；手动刷新仍走原有全局反馈', async () => {
  const f = fixture();
  try {
    f.connection.reject(new Error('连接查询暂不可用'));
    await flush();
    assert.equal(f.state.query.isPending.value, false);
    assert.equal(f.state.query.error.value, null);
    assert.equal(f.state.query.data.value.runs[0].result, '已保存的回复');
    assert.deepEqual(f.messages, []);
    await f.state.refreshStatus();
    assert.ok(f.urls.includes('/api/agent-runtimes/status?refresh=1'));
    assert.deepEqual(f.messages, ['连接查询暂不可用']);
    assert.equal(f.state.query.data.value.runs[0].result, '已保存的回复');
  } finally { f.close(); }
});
