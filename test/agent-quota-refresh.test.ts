/** Run the real composable and TanStack query lifecycle with controlled HTTP responses. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { computed, effectScope, shallowRef } from 'vue';
import { QueryClient, useQuery } from '@tanstack/vue-query';
import { createRuntimeRefresh, createRuntimeStreamState } from '../src/features/agent-workbench/runtime-stream-state.js';

function fixture() {
  const source = fs.readFileSync(new URL('../src/features/agent-workbench/useAgentRuntimes.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('useAgentRuntimes.ts', source, ts.ScriptTarget.Latest, true);
  const body = tree.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(tree)).join('\n');
  const code = ts.transpileModule(body.replace('export function useAgentRuntimes', 'function useAgentRuntimes'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const client = new QueryClient();
  const requests: { url: string; signal: AbortSignal; resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
  const messages: { type: string; message: string }[] = [];
  const queryOptions: Parameters<typeof useQuery>[0][] = [];
  const unmounted: (() => void)[] = [];
  const dependencies = { computed, shallowRef, createRuntimeRefresh, createRuntimeStreamState,
    useQuery: (options: Parameters<typeof useQuery>[0]) => { queryOptions.push(options); return useQuery(options, client); }, useQueryClient: () => client,
    onMounted: () => {}, onUnmounted: (fn: () => void) => unmounted.push(fn),
    ElMessage: { success: (message: string) => messages.push({ type: 'success', message }),
      warning: (message: string) => messages.push({ type: 'warning', message }),
      error: (message: string) => messages.push({ type: 'error', message }) },
    ElMessageBox: { confirm: async () => {} },
    fetch: (url: string, { signal }: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
      requests.push({ url, signal: signal || new AbortController().signal, resolve: value => resolve({ ok: true, json: async () => value }), reject });
    }) };
  const scope = effectScope();
  const state = scope.run(() => new Function(...Object.keys(dependencies), `${code}\nreturn useAgentRuntimes();`)(...Object.values(dependencies)))!;
  return { state, requests, messages, queryOptions, close() { unmounted.forEach(fn => fn()); scope.stop(); client.clear(); } };
}

const flush = () => new Promise(resolve => setImmediate(resolve));
const snapshot = (remainingPercent: number) => ({ revision: 1, runtimes: [], runs: [], activeWorkspaceLocks: [],
  codexUsage: { available: true, checkedAt: new Date().toISOString(), primary: { remainingPercent } } });

test('首次慢查询期间点击立即强制刷新；连点只发一次，迟到结果不覆盖新额度', async () => {
  const f = fixture();
  try {
    assert.equal(f.requests[0].url, '/api/agent-runtimes?status=0');
    assert.equal(f.requests[1].url, '/api/agent-runtimes/status');
    f.requests[0].resolve(snapshot(0));
    const refreshed = f.state.refreshStatus();
    assert.equal(f.state.refreshing.value, true);
    await f.state.refreshStatus();
    await flush();
    assert.equal(f.requests.length, 3);
    assert.equal(f.requests[0].signal.aborted, false, '额度刷新不能取消会话快照');
    assert.equal(f.requests[1].signal.aborted, true);
    assert.equal(f.requests[2].url, '/api/agent-runtimes/status?refresh=1');
    f.requests[2].resolve(snapshot(67));
    await refreshed;
    f.requests[1].resolve(snapshot(12));
    await flush();
    assert.equal(f.state.query.data.value.codexUsage.primary.remainingPercent, 67);
    assert.equal(f.state.refreshing.value, false);
    assert.deepEqual(f.messages, [{ type: 'success', message: '连接与额度已刷新' }]);
  } finally { f.close(); }
});

test('刷新失败保留已有额度并反馈错误，恢复按钮后可以再次刷新', async () => {
  const f = fixture();
  try {
    f.requests[0].resolve(snapshot(67));
    f.requests[1].resolve(snapshot(67));
    await flush();
    const failed = f.state.refreshStatus();
    await flush();
    f.requests[2].reject(new Error('额度查询暂不可用'));
    await failed;
    assert.equal(f.state.query.data.value.codexUsage.primary.remainingPercent, 67);
    assert.equal(f.state.refreshing.value, false);
    assert.deepEqual(f.messages, [{ type: 'error', message: '额度查询暂不可用' }]);
    const retried = f.state.refreshStatus();
    await flush();
    assert.equal(f.requests[3].url, '/api/agent-runtimes/status?refresh=1');
    f.requests[3].resolve(snapshot(66));
    await retried;
    assert.equal(f.state.query.data.value.codexUsage.primary.remainingPercent, 66);
    assert.equal(f.state.refreshing.value, false);
    assert.equal(f.messages[1].type, 'success');
  } finally { f.close(); }
});

test('HTTP 成功但 Antigravity 读取失败时如实提示，恢复后才提示刷新成功', async () => {
  const f = fixture();
  const quota = { available: true, checkedAt: '2026-11-06T03:00:00Z', groups: [{ name: 'Gemini Models', buckets: [
    { id: 'weekly', name: 'Weekly', window: 'weekly', remainingPercent: 72, resetsAt: null },
  ] }] };
  try {
    f.requests[0].resolve(snapshot(67));
    f.requests[1].resolve({ ...snapshot(67), antigravityUsage: quota });
    await flush();
    const stale = { ...quota, stale: true, lastSuccessAt: quota.checkedAt, errorKind: 'timeout', message: 'Antigravity 读取超时，保留上次额度' };
    const failed = f.state.refreshStatus(); await flush();
    f.requests[2].resolve({ ...snapshot(66), antigravityUsage: stale });
    await failed;
    assert.deepEqual(f.state.query.data.value.antigravityUsage, stale);
    assert.deepEqual(f.messages, [{ type: 'warning', message: stale.message }]);
    const authentication = f.state.refreshStatus(); await flush();
    f.requests[3].resolve({ ...snapshot(66), antigravityUsage: { available: false, checkedAt: quota.checkedAt, groups: [],
      errorKind: 'authentication', message: 'Antigravity 登录状态待确认' } });
    await authentication;
    assert.deepEqual(f.messages[1], { type: 'warning', message: 'Antigravity 登录状态待确认' });
    const recovered = f.state.refreshStatus(); await flush();
    f.requests[4].resolve({ ...snapshot(66), antigravityUsage: quota });
    await recovered;
    assert.deepEqual(f.messages[2], { type: 'success', message: '连接与额度已刷新' });
  } finally { f.close(); }
});

test('Codex 额度短暂失败或历史快照不能提示刷新成功，并更快回读恢复', async () => {
  const f = fixture();
  try {
    f.requests[0].resolve(snapshot(38)); f.requests[1].resolve(snapshot(38)); await flush();
    const options = f.queryOptions[1] as { refetchInterval: (query: { state: { data: unknown } }) => number };
    assert.equal(options.refetchInterval({ state: { data: snapshot(38) } }), 60_000);
    for (const stale of [false, true]) {
      const usage = { ...snapshot(38).codexUsage, available: stale, stale, errorKind: 'timeout', message: 'Codex 额度读取超时' };
      const refresh = f.state.refreshStatus(); await flush();
      f.requests.at(-1)!.resolve({ ...snapshot(38), codexUsage: usage }); await refresh;
      assert.deepEqual(f.messages.at(-1), { type: 'warning', message: usage.message });
      assert.equal(options.refetchInterval({ state: { data: { codexUsage: usage } } }), 10_000);
      assert.deepEqual(f.state.query.data.value.codexUsage, usage);
    }
    const recovered = f.state.refreshStatus(); await flush();
    f.requests.at(-1)!.resolve(snapshot(37)); await recovered;
    assert.deepEqual(f.messages.at(-1), { type: 'success', message: '连接与额度已刷新' });
    assert.equal(f.state.query.data.value.codexUsage.primary.remainingPercent, 37);
    assert.equal(options.refetchInterval({ state: { data: snapshot(37) } }), 60_000);
    const changedAccount = f.state.refreshStatus(); await flush();
    f.requests.at(-1)!.resolve({ runtimes: [], runtimeStatusVersion: 2 }); await changedAccount;
    assert.deepEqual(f.messages.at(-1), { type: 'warning', message: '连接状态已变化，额度尚未更新，请刷新重试' });
    assert.equal(f.state.query.data.value.codexUsage, undefined);
    assert.equal(options.refetchInterval({ state: { data: { runtimes: [], runtimeStatusVersion: 2 } } }), 10_000);
  } finally { f.close(); }
});

test('保存和移除模型立即强制回读状态，初次慢目录回包不能覆盖保存后的目录', async () => {
  const f = fixture();
  try {
    f.requests[0].resolve(snapshot(67)); await flush();
    const savedModels = [{ id: 'custom-model', label: 'L123', customId: 'custom-id' }];
    const adding = f.state.addCustomModel({ provider: 'codex', modelId: 'custom-model', label: 'L123' });
    assert.equal(f.requests[2].url, '/api/agent-runtimes/models');
    f.requests[2].resolve({}); await flush();
    assert.equal(f.requests[3].url, '/api/agent-runtimes?status=0');
    f.requests[3].resolve(snapshot(67)); await flush();
    assert.equal(f.requests[1].signal.aborted, true);
    assert.equal(f.requests[4].url, '/api/agent-runtimes/status?refresh=1');
    f.requests[4].resolve({ ...snapshot(67), runtimes: [{ provider: 'codex', models: savedModels }] });
    await adding;
    f.requests[1].resolve(snapshot(12)); await flush();
    assert.deepEqual(f.state.query.data.value.runtimes[0].models, savedModels);
    const removing = f.state.removeCustomModel('custom-id'); await flush();
    assert.equal(f.requests[5].url, '/api/agent-runtimes/models/custom-id/delete');
    f.requests[5].resolve({}); await flush();
    f.requests[6].resolve(snapshot(67)); await flush();
    assert.equal(f.requests[7].url, '/api/agent-runtimes/status?refresh=1');
    f.requests[7].resolve({ ...snapshot(67), runtimes: [{ provider: 'codex', models: [] }] });
    await removing;
    assert.deepEqual(f.state.query.data.value.runtimes[0].models, []);
    assert.equal(f.state.changing.value, '');
  } finally { f.close(); }
});
