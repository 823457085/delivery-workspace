/** 执行真实组件脚本，控制网络、可见性和时钟，避免由测试重写刷新逻辑。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { computed, effectScope, nextTick, ref, shallowReactive, shallowRef, watch, type ShallowRef } from 'vue';
import type { RemoteDeliveryPreview } from '../shared/agent-remote-delivery.js';

function response(roomId = 'room', fingerprint = 'initial'): RemoteDeliveryPreview {
  return { roomId, taskId: 'task', fingerprint, issue: { key: 'APEX-602', url: '', title: '原始事项 L123' },
    design: { path: '', body: '', title: '', available: false, reason: '' },
    jira: { body: '', available: false, reason: '' }, projects: [], attempts: [], i18nArtifacts: [] };
}

function fixture() {
  const source = readFileSync(new URL('../src/features/agent-workbench/AgentRemoteDelivery.vue', import.meta.url), 'utf8')
    .match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
  const tree = ts.createSourceFile('AgentRemoteDelivery.ts', source, ts.ScriptTarget.Latest, true);
  const body = tree.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(tree)).join('\n');
  const code = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const props = shallowReactive({ room: { id: 'room', updatedAt: '2026-11-04T00:00:00.000Z' }, active: true });
  const mounted: (() => void)[] = [], unmounted: (() => void)[] = [];
  const listeners = new Map<string, () => void>();
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const messages: string[] = [];
  const calls: { roomId: string; signal: AbortSignal; resolve: (value: RemoteDeliveryPreview) => void; reject: (error: Error) => void }[] = [];
  let timerId = 0;
  const document = { visibilityState: 'visible',
    addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
    removeEventListener: (name: string, callback: () => void) => { if (listeners.get(name) === callback) listeners.delete(name); } };
  const dependencies = { computed, ref, shallowRef, watch, document, AbortController,
    defineProps: () => props,
    useIntegrationPlugins: () => ({ capability: () => true }),
    onMounted: (callback: () => void) => mounted.push(callback),
    onBeforeUnmount: (callback: () => void) => unmounted.push(callback),
    setTimeout: (callback: () => void, delay: number) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id: number | undefined) => { if (id !== undefined) timers.delete(id); },
    ElMessage: { error: (message: string) => messages.push(message) },
    readRemoteDelivery: (roomId: string, signal: AbortSignal) => new Promise<RemoteDeliveryPreview>((resolve, reject) => {
      calls.push({ roomId, signal, resolve, reject });
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }) };
  const scope = effectScope();
  const state = scope.run(() => new Function(...Object.keys(dependencies), `${code}\nreturn { preview, loading, lastChecked, opened, tasksOpen, submitting, refresh, autoRefresh };`)(...Object.values(dependencies))) as {
    preview: ShallowRef<RemoteDeliveryPreview | undefined>;
    loading: ShallowRef<boolean>;
    lastChecked: ShallowRef<string>;
    opened: ShallowRef<boolean>;
    tasksOpen: ShallowRef<boolean>;
    submitting: ShallowRef<boolean>;
    refresh: (silent?: boolean) => Promise<boolean>;
    autoRefresh: () => void;
  };
  mounted.forEach(callback => callback());
  return { state, props, calls, timers, messages, listeners,
    visibility: (value: string) => { document.visibilityState = value; listeners.get('visibilitychange')?.(); },
    tick: () => {
      const scheduled = [...timers];
      for (const [id, timer] of scheduled) { timers.delete(id); timer.callback(); }
    },
    close: () => { unmounted.splice(0).forEach(callback => callback()); scope.stop(); } };
}

async function flush() { await new Promise(resolve => setImmediate(resolve)); await nextTick(); }

test('房间更新时间不变时定时检测仍发现新文件，下一次检测在响应后十秒安排', async () => {
  const f = fixture();
  try {
    assert.equal(f.calls.length, 1);
    assert.equal(f.state.loading.value, true);
    assert.equal(f.timers.size, 0);
    f.calls[0].resolve(response());
    await flush();
    assert.deepEqual([...f.timers.values()].map(timer => timer.delay), [10000]);
    const originalRoom = f.props.room;
    f.tick();
    assert.equal(f.calls.length, 2);
    assert.equal(f.timers.size, 0);
    const latest = response('room', 'new-xlsx');
    latest.i18nArtifacts = [{ id: 'i18n-0', projectId: '0', path: '/task/tempdocs/i18n-import.xlsx',
      name: 'i18n-import.xlsx', size: 123, sha256: 'a'.repeat(64), downloadUrl: '/fixture.xlsx' }];
    f.calls[1].resolve(latest);
    await flush();
    assert.equal(f.props.room, originalRoom);
    assert.equal(f.state.preview.value, latest);
    assert.equal(f.state.preview.value?.i18nArtifacts?.[0].sha256, 'a'.repeat(64));
    assert.equal(f.timers.size, 1);
    assert.ok(f.state.lastChecked.value);
  } finally { f.close(); }
});

test('慢请求期间手动刷新与多次检测共享同一请求，响应后只留一个计时器', async () => {
  const f = fixture();
  try {
    const pending = f.state.refresh();
    for (let index = 0; index < 5; index++) f.state.autoRefresh();
    await flush();
    assert.equal(f.calls.length, 1);
    assert.equal(f.timers.size, 0);
    f.calls[0].resolve(response());
    assert.equal(await pending, true);
    await flush();
    assert.equal(f.calls.length, 1);
    assert.equal(f.timers.size, 1);
    f.tick();
    assert.equal(f.calls.length, 2);
    assert.equal(f.timers.size, 0);
  } finally { f.close(); }
});

test('页面隐藏、侧栏折叠、确认或任务弹窗及提交期间停止检测，恢复后立即读取', async () => {
  for (const blocked of ['hidden', 'collapsed', 'opened', 'tasksOpen', 'submitting'] as const) {
    const f = fixture();
    try {
      f.calls[0].resolve(response());
      await flush();
      if (blocked === 'hidden') f.visibility('hidden');
      else if (blocked === 'collapsed') f.props.active = false;
      else f.state[blocked].value = true;
      await flush();
      assert.equal(f.timers.size, 0, blocked);
      f.state.autoRefresh();
      f.tick();
      await flush();
      assert.equal(f.calls.length, 1, blocked);
      if (blocked === 'hidden') f.visibility('visible');
      else if (blocked === 'collapsed') f.props.active = true;
      else f.state[blocked].value = false;
      await flush();
      assert.equal(f.calls.length, 2, `${blocked} 恢复后立即检测`);
    } finally { f.close(); await flush(); }
  }
});

test('自动检测失败静默保留旧产物和成功时间，手动刷新失败使用全局反馈', async () => {
  const f = fixture();
  try {
    const original = response();
    f.calls[0].resolve(original);
    await flush();
    const checked = f.state.lastChecked.value;
    f.tick();
    f.calls[1].reject(new Error('read failed'));
    await flush();
    assert.equal(f.state.preview.value, original);
    assert.equal(f.state.lastChecked.value, checked);
    assert.equal(f.state.loading.value, false);
    assert.deepEqual(f.messages, []);
    assert.equal(f.timers.size, 1);
    const pending = f.state.refresh();
    f.calls[2].reject(new Error('manual failed'));
    assert.equal(await pending, false);
    assert.deepEqual(f.messages, ['manual failed']);
    assert.equal(f.state.preview.value, original);
  } finally { f.close(); }
});

test('房间身份变化或回包房间不一致时丢弃迟到结果', async () => {
  const f = fixture();
  try {
    f.props.room = { ...f.props.room, id: 'next-room' };
    f.calls[0].resolve(response('room'));
    await flush();
    assert.equal(f.state.preview.value, undefined);
    const pending = f.state.refresh(true);
    assert.equal(f.calls[1].roomId, 'next-room');
    f.calls[1].resolve(response('foreign-room'));
    assert.equal(await pending, false);
    assert.equal(f.state.preview.value, undefined);
    const next = f.state.refresh(true), latest = response('next-room', 'next');
    f.calls[2].resolve(latest);
    assert.equal(await next, true);
    assert.equal(f.state.preview.value, latest);
  } finally { f.close(); }
});

test('卸载时取消进行中请求、移除可见性监听和计时器，迟到响应不能更新产物', async () => {
  const f = fixture();
  f.calls[0].resolve(response());
  await flush();
  const previous = f.state.preview.value;
  f.tick();
  const pending = f.state.refresh();
  assert.equal(f.calls[1].signal.aborted, false);
  f.close();
  assert.equal(f.calls[1].signal.aborted, true);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(await pending, false);
  f.calls[1].resolve(response('room', 'too-late'));
  await flush();
  f.state.autoRefresh();
  assert.equal(f.state.preview.value, previous);
  assert.equal(f.calls.length, 2);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.messages, []);
});
