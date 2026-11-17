import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { computed, shallowRef } from 'vue';
import type { BrowserConnectionStatus } from '../shared/browser-connection.js';
import { createBrowserConnectionState } from '../src/features/browser-connection/useBrowserConnection.js';
import { changeBrowserConnection, readBrowserConnection } from '../src/features/browser-connection/api.js';

const status = (phase: BrowserConnectionStatus['phase'], verified = false): BrowserConnectionStatus => ({
  phase, message: 'fixture', checkedAt: '2026-11-11T04:00:00Z', toolAvailable: true, chromeAvailable: true,
  debuggingEnabled: phase !== 'setup_required', connectionVerified: verified, reuseEnabled: true,
  settingsUrl: 'chrome://inspect/#remote-debugging',
});

function fixture() {
  const requests: { action: string; signal: AbortSignal; resolve: (value: BrowserConnectionStatus) => void; reject: (error: Error) => void }[] = [];
  const timers: { callback: () => void; delay: number; cleared: boolean }[] = [];
  const request = (action: string, signal: AbortSignal) => new Promise<BrowserConnectionStatus>((resolve, reject) => requests.push({ action, signal, resolve, reject }));
  const state = createBrowserConnectionState({ read: signal => request('read', signal), change: (action, signal) => request(action, signal) }, {
    set: ((callback: () => void, delay: number) => { timers.push({ callback, delay, cleared: false }); return timers.length; }) as unknown as typeof setTimeout,
    clear: ((id: number) => { if (timers[id - 1]) timers[id - 1].cleared = true; }) as unknown as typeof clearTimeout,
  });
  return { state, requests, timers };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('两个可见入口共用探测，最后一个入口关闭后取消请求并隔离迟到结果', async () => {
  const f = fixture(), settings = Symbol(), popover = Symbol();
  f.state.activate(settings);
  f.state.activate(popover);
  assert.equal(f.requests.length, 1);
  f.state.deactivate(settings);
  assert.equal(f.requests[0].signal.aborted, false);
  f.state.deactivate(popover);
  assert.equal(f.requests[0].signal.aborted, true);
  f.requests[0].resolve(status('connected', true));
  await flush();
  assert.equal(f.state.status.value, undefined);
  assert.equal(f.state.busy.value, '');
});

test('连接动作取消旧GET，重复点击不重发，旧响应不能覆盖新连接结果', async () => {
  const f = fixture(), viewer = Symbol();
  f.state.activate(viewer);
  const connecting = f.state.act('connect');
  await f.state.act('connect');
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(f.requests[1].action, 'connect');
  f.requests[1].resolve(status('connected', true));
  await connecting;
  f.requests[0].resolve(status('setup_required'));
  await flush();
  assert.equal(f.state.status.value?.phase, 'connected');
  assert.equal(f.state.status.value?.connectionVerified, true);
  assert.equal(f.timers.length, 1);
  assert.equal(f.timers[0].delay, 10_000, '已连接以低频检测失效，不持续短轮询');
  f.state.deactivate(viewer);
  assert.equal(f.timers[0].cleared, true);
});

test('已连接且可见时低频刷新，连接失效后清除验证状态并停止轮询', async () => {
  const f = fixture(), viewer = Symbol();
  f.state.activate(viewer);
  f.requests[0].resolve(status('connected', true));
  await flush();
  assert.equal(f.timers[0].delay, 10_000);
  f.timers[0].callback();
  f.requests[1].resolve(status('error'));
  await flush();
  assert.equal(f.state.status.value?.phase, 'error');
  assert.equal(f.state.status.value?.connectionVerified, false);
  assert.equal(f.timers.length, 1, '连接失效后不再安排后台探测');
  f.state.deactivate(viewer);
});

test('后台重启期间的读取错误会自动重试，卡片回显恢复状态', async () => {
  const f = fixture(), viewer = Symbol();
  f.state.activate(viewer);
  f.requests[0].reject(new Error('后端正在重启'));
  await flush();
  assert.equal(f.state.error.value, '后端正在重启');
  assert.equal(f.timers[0].delay, 5000);
  f.timers[0].callback();
  f.requests[1].resolve(status('reconnecting'));
  await flush();
  assert.equal(f.state.error.value, '');
  assert.equal(f.timers[1].delay, 1500);
  f.timers[1].callback();
  f.requests[2].resolve(status('connected', true));
  await flush();
  assert.equal(f.state.status.value?.connectionVerified, true);
  assert.equal(f.timers[2].delay, 10_000);
  f.state.deactivate(viewer);
});

test('仅可见且等待授权时短轮询；关闭卡片停止轮询，再打开回读最新状态', async () => {
  const f = fixture(), viewer = Symbol();
  f.state.activate(viewer);
  f.requests[0].resolve(status('connecting'));
  await flush();
  assert.equal(f.timers[0].delay, 1500);
  f.timers[0].callback();
  assert.equal(f.requests.length, 2);
  f.state.deactivate(viewer);
  assert.equal(f.requests[1].signal.aborted, true);
  f.requests[1].resolve(status('connected', true));
  await flush();
  assert.equal(f.state.status.value?.phase, 'connecting');
  f.state.activate(viewer);
  f.requests[2].resolve(status('ready'));
  await flush();
  assert.equal(f.state.status.value?.phase, 'ready');
  assert.equal(f.timers.length, 1, 'ready状态不新增短轮询');
  f.state.deactivate(viewer);
});

test('关闭等待授权的入口清除已安排的轮询，动作失败后可重试', async () => {
  const f = fixture(), viewer = Symbol();
  f.state.activate(viewer);
  f.requests[0].resolve(status('connecting'));
  await flush();
  f.state.deactivate(viewer);
  assert.equal(f.timers[0].cleared, true);
  f.state.activate(viewer);
  f.requests[1].resolve(status('ready'));
  await flush();
  const failed = f.state.act('connect');
  f.requests[2].reject(new Error('Chrome 尚未允许连接'));
  await assert.rejects(failed, /尚未允许/);
  assert.equal(f.state.error.value, 'Chrome 尚未允许连接');
  assert.equal(f.state.busy.value, '');
  const retry = f.state.act('connect');
  f.requests[3].resolve(status('connected', true));
  await retry;
  assert.equal(f.state.error.value, '');
  f.state.deactivate(viewer);
});

test('组件仅在handshake已验证且无读取错误时显示连接成功，连接中不能重复提交', () => {
  const source = fs.readFileSync(new URL('../src/features/browser-connection/ChromeConnectionCard.vue', import.meta.url), 'utf8');
  const script = source.split('<script setup lang="ts">')[1].split('</script>')[0].replace(/^import .+;$/gm, '');
  const code = ts.transpileModule(script + '\n;({ verified, label, labelType, canConnect, connectLabel });', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const connection = { status: shallowRef(status('connected')), busy: shallowRef(''), error: shallowRef(''), refresh() {}, act() {} };
  const c = runInNewContext(code, { computed, defineProps: () => ({}), withDefaults: (_: unknown, defaults: unknown) => defaults,
    useBrowserConnection: () => connection, ElMessage: { error() {} } });
  assert.equal(c.verified.value, false);
  assert.equal(c.labelType.value, 'info');
  connection.status.value = status('connected', true);
  assert.equal(c.verified.value, true);
  assert.equal(c.labelType.value, 'success');
  connection.status.value = status('error');
  assert.equal(c.verified.value, false);
  assert.equal(c.labelType.value, 'warning');
  connection.status.value = status('connected', true);
  connection.error.value = '状态读取失败';
  assert.equal(c.verified.value, false);
  assert.equal(c.label.value, '连接状态待确认');
  connection.error.value = '';
  connection.status.value = status('connecting');
  assert.equal(c.canConnect.value, false);
  assert.equal(c.connectLabel.value, '等待 Chrome 允许');
  connection.status.value = { ...status('ready'), toolAvailable: false, chromeAvailable: true };
  assert.equal(c.canConnect.value, true, '浏览器连接不依赖自动化工具');
  assert.equal(c.verified.value, false);
  connection.status.value = { ...status('unavailable'), toolAvailable: true, chromeAvailable: true };
  assert.equal(c.canConnect.value, false, '不支持的平台仍不能连接');

});

test('API只访问固定同源浏览器路由，POST不传配置或调试端点并保留取消信号', async t => {
  const previous = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(status('ready')), { headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = previous; });
  const signal = new AbortController().signal;
  await readBrowserConnection(signal);
  await changeBrowserConnection('open-settings', signal);
  await changeBrowserConnection('connect', signal);
  assert.deepEqual(calls.map(call => call.url), ['/api/browser/connection', '/api/browser/connection/open-settings', '/api/browser/connection/connect']);
  assert.equal(calls[0].init?.signal, signal);
  assert.equal(calls[1].init?.method, 'POST');
  assert.equal(calls[1].init?.body, '{}');
  assert.equal(calls[1].init?.signal, signal);
});

test('默认计时器在浏览器中以全局 this 调用，连接成功后安排轮询不抛 Illegal invocation', async () => {
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  const scheduled: number[] = [];
  // 模拟浏览器原生计时器：this 不是全局对象时抛 TypeError: Illegal invocation。
  globalThis.setTimeout = function (this: unknown, _handler: () => void, delay?: number) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    scheduled.push(delay ?? 0);
    return scheduled.length as unknown as ReturnType<typeof setTimeout>;
  } as typeof setTimeout;
  globalThis.clearTimeout = function (this: unknown) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
  } as typeof clearTimeout;
  try {
    const state = createBrowserConnectionState({ read: async () => status('ready'), change: async () => status('connecting') });
    const viewer = Symbol();
    state.activate(viewer);
    await flush();
    await state.act('connect');
    assert.equal(state.status.value?.phase, 'connecting');
    assert.deepEqual(scheduled, [1500]);
    state.deactivate(viewer);
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
});
