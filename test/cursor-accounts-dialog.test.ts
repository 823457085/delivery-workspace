import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { computed, shallowRef, watch } from 'vue';
import { accountProviderLabels, accountProviders, desktopAccountProviders, trustedAccountLoginUrl, type AccountProvider, type CursorAccountsDashboard, type DesktopAccountSnapshot } from '../shared/cursor-accounts.js';

const source = await fs.readFile(new URL('../src/features/agent-workbench/CursorAccountsDialog.vue', import.meta.url), 'utf8');
const script = source.split('<script setup lang="ts">')[1].split('</script>')[0].replace(/^import .+;$/gm, '');
const code = ts.transpileModule(`${script}\n;({ open, provider, dashboard, desktop, desktopStatus, canOpenDesktop, openDesktop, syncing, loginUrl, loginHelp, accountAddHelp, operationTitle, canManage, canChange, canRestore, isCurrent, syncCurrent, load, act, cancel, managed, accountStatus, accountTitle, emptyDescription, providerChoices, usageCard, refreshState });`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const snapshot = (provider: AccountProvider, status: 'running' | 'cancelled' = 'running'): CursorAccountsDashboard => ({
  provider, available: false, accounts: [], current: null, activePids: [], pendingRecovery: false, blockedReason: '',
  checkedAt: 'fixture', operation: { id: 'fixture-operation', action: 'login', status, message: 'fixture', startedAt: 'fixture' },
});
const readySnapshot = (provider: AccountProvider): CursorAccountsDashboard => ({ ...snapshot(provider), available: true, operation: null });
const officialUrls = {
  cursor: 'https://cursor.com/loginDeepControl?challenge=fixture',
  codex: 'https://auth.openai.com/codex/device',
  claude: 'https://claude.com/cai/oauth/authorize?state=fixture',
};
const loginSnapshot = (provider: AccountProvider, id: string, loginUrl?: string,
  status: NonNullable<CursorAccountsDashboard['operation']>['status'] = 'running'): CursorAccountsDashboard => ({
  ...readySnapshot(provider), operation: { ...snapshot(provider).operation!, id, loginUrl, status },
});
function fixture(options: { popupBlocked?: boolean; runtimes?: unknown[]; usageCards?: unknown[]; manualDesktop?: boolean } = {}) {
  const requests: { url: string; init: RequestInit; resolve: (response: Response) => void }[] = [];
  const desktopRequests: typeof requests = [];
  const confirmations: string[] = [];
  const events: string[] = [];
  const popups: { closed: boolean; opener: unknown; document: { title: string; body: { textContent: string } };
    replacements: string[]; location: { replace: (url: string) => void }; close: () => void }[] = [];
  const timers: { callback: () => void; delay: number; cleared: boolean }[] = [];
  const returnListeners = new Map<string, () => void>();
  const document = {
    visibilityState: 'visible',
    addEventListener: (type: string, callback: () => void) => { returnListeners.set(type, callback); },
    removeEventListener: (type: string) => { returnListeners.delete(type); },
  };
  let cleanup = () => {};
  const component = runInNewContext(code, {
    computed, shallowRef, watch, accountProviderLabels, accountProviders, desktopAccountProviders, trustedAccountLoginUrl, AbortController,
    onBeforeUnmount: (callback: () => void) => { cleanup = callback; },
    defineEmits: () => (event: string) => { events.push(`emit:${event}`); },
    defineProps: () => ({ runtimes: options.runtimes || [], usageCards: options.usageCards || [] }),
    ElMessage: { error() {}, info() {}, success() {}, warning() {} },
    ElMessageBox: { confirm: async (message: string) => { confirmations.push(message); } },
    setTimeout: (callback: () => void, delay: number) => { timers.push({ callback, delay, cleared: false }); return timers.length; },
    clearTimeout: (id: number) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    document,
    window: { addEventListener: document.addEventListener, removeEventListener: document.removeEventListener,
      open: (url: string, target: string) => {
      events.push(`open:${url}:${target}`);
      if (options.popupBlocked) return null;
      const popup = {
        closed: false, opener: {} as unknown, document: { title: '', body: { textContent: '' } }, replacements: [] as string[],
        location: { replace: (value: string) => { popup.replacements.push(value); } },
        close: () => { popup.closed = true; },
      };
      popups.push(popup);
      return popup;
    } },
    fetch: (url: string, init: RequestInit) => new Promise<Response>(resolve => {
      if (url.includes('/desktop-accounts/')) {
        desktopRequests.push({ url, init, resolve });
        if (!options.manualDesktop) resolve(new Response(JSON.stringify({ provider: url.split('/')[4], installed: true, canOpen: true,
          status: 'unknown', message: '请在桌面端确认', checkedAt: 'fixture' }), { headers: { 'Content-Type': 'application/json' } }));
        return;
      }
      events.push(`fetch:${url}`); requests.push({ url, init, resolve });
    }),
  });
  const respond = async (index: number, body: CursorAccountsDashboard | { message: string }, status = 200) => {
    requests[index].resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
    await new Promise(resolve => setImmediate(resolve));
  };
  const respondDesktop = async (index: number, body: DesktopAccountSnapshot) => {
    desktopRequests[index].resolve(new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }));
    await new Promise(resolve => setImmediate(resolve));
  };
  return { component, requests, desktopRequests, respondDesktop, confirmations, events, popups, timers, respond, document, returnListeners,
    cleanup: () => { component.open.value = false; cleanup(); } };
}

test('快照不可用仍可取消在途登录，取消结果不会被此前GET响应覆盖', async () => {
  const f = fixture();
  try {
    f.component.open.value = true;
    await f.respond(0, snapshot('cursor'));
    const refresh = f.component.load(true);
    const cancel = f.component.cancel();
    assert.equal(f.requests[2]?.url, '/api/agent-runtimes/accounts/cursor/cancel');
    assert.equal(f.requests[1].init.signal?.aborted, true);
    assert.equal(JSON.parse(String(f.requests[2].init.body)).operationId, 'fixture-operation');
    await f.respond(2, snapshot('cursor', 'cancelled'));
    await cancel;
    await f.respond(1, snapshot('cursor'));
    await refresh;
    assert.equal(f.component.dashboard.value.operation.status, 'cancelled');
  } finally { f.cleanup(); }
});

test('切换账号平台和关闭窗口后，旧GET响应无法替换当前平台快照', async () => {
  const f = fixture();
  try {
    f.component.open.value = true;
    f.component.provider.value = 'codex';
    assert.equal(f.requests[0].init.signal?.aborted, true);
    await f.respond(1, snapshot('codex'));
    await f.respond(0, snapshot('cursor'));
    assert.equal(f.component.dashboard.value.provider, 'codex');
    const refresh = f.component.load(true);
    f.component.open.value = false;
    assert.equal(f.requests[2].init.signal?.aborted, true);
    await f.respond(2, snapshot('codex'));
    await refresh;
    assert.equal(f.component.dashboard.value, undefined);
  } finally { f.cleanup(); }
});

test('有运行中的CLI时三个平台仍可保存和添加账号，仅 Cursor 禁用切换与恢复', async () => {
  for (const provider of accountProviders) {
    const f = fixture();
    try {
      f.component.provider.value = provider;
      f.component.open.value = true;
      const ready = { ...readySnapshot(provider), activePids: [9214], current: { email: 'work@example.test', team: '', verified: true } };
      await f.respond(0, ready);
      assert.equal(f.component.canManage.value, true);
      assert.equal(f.component.canChange.value, provider !== 'cursor');
      assert.equal(f.component.canRestore.value, provider !== 'cursor');
      if (provider === 'cursor') {
        await f.component.act('use', 'work');
        await f.component.act('restore');
      }
      assert.equal(f.requests.length, 1);
      const save = f.component.syncCurrent();
      assert.equal(f.requests[1].url, `/api/agent-runtimes/accounts/${provider}?refresh=1`);
      await f.respond(1, ready);
      assert.equal(f.requests[2].url, `/api/agent-runtimes/accounts/${provider}/save`);
      await f.respond(2, ready);
      await save;
      const login = f.component.act('login', 'personal');
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.requests[3].url, `/api/agent-runtimes/accounts/${provider}/login`);
      assert.equal(f.confirmations.length, 0);
      await f.respond(3, { ...ready, operation: snapshot(provider).operation });
      await login;
      assert.equal(f.component.canManage.value, false);
    } finally { f.cleanup(); }
  }
});

test('登录POST跨平台切换后迟到，重新读取当前平台，不覆盖已完成的账号状态', async () => {
  const f = fixture();
  try {
    const ready = { ...snapshot('cursor'), available: true, operation: null };
    const completed = { ...ready, operation: { ...snapshot('cursor').operation!, status: 'succeeded' as const, message: '已保存新账号' } };
    f.component.open.value = true;
    await f.respond(0, ready);
    const login = f.component.act('login', 'personal');
    await new Promise(resolve => setImmediate(resolve));
    f.component.provider.value = 'codex';
    await f.respond(2, { ...snapshot('codex'), available: true, operation: null });
    f.component.provider.value = 'cursor';
    await f.respond(3, completed);
    await f.respond(1, { ...snapshot('cursor'), available: true });
    assert.equal(f.component.dashboard.value.operation.status, 'succeeded');
    assert.equal(f.requests[4].url, '/api/agent-runtimes/accounts/cursor');
    await f.respond(4, completed);
    await login;
    assert.equal(f.component.dashboard.value.operation.status, 'succeeded');
    assert.equal(f.component.canManage.value, true);
  } finally { f.cleanup(); }
});

test('点击官方登录同步创建窗口并自动生成唯一合法名称，无需输入或重复确认', async () => {
  for (const provider of accountProviders) {
    const f = fixture();
    try {
      f.component.provider.value = provider;
      f.component.open.value = true;
      const ready: CursorAccountsDashboard = {
        ...snapshot(provider), available: true, operation: null,
        accounts: [provider, `${provider}-2`].map(name => ({ name, email: `${name}@example.test`, team: '' })),
      };
      await f.respond(0, ready);
      const login = f.component.act('login');
      assert.equal(f.popups.length, 1);
      assert.equal(f.popups[0].opener, null);
      assert.deepEqual(f.events.slice(-2), ['open:about:blank:_blank', `fetch:/api/agent-runtimes/accounts/${provider}/login`]);
      assert.equal(f.requests[1].url, `/api/agent-runtimes/accounts/${provider}/login`);
      const submittedName = JSON.parse(String(f.requests[1].init.body)).name;
      assert.equal(submittedName, `${provider}-3`);
      assert.match(submittedName, /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/);
      assert.equal(ready.accounts.some(account => account.name === submittedName), false);
      assert.equal(f.confirmations.length, 0);
      await f.respond(1, {
        ...ready, operation: { ...snapshot(provider).operation!, status: 'succeeded', message: '已保存新账号' },
      });
      await login;
      assert.equal(f.popups[0].closed, true);
    } finally { f.cleanup(); }
  }
});

test('同步本机账号使用刷新后的当前账号并沿用匹配名称，重新登录沿用指定名称', async () => {
  const f = fixture();
  try {
    f.component.open.value = true;
    const ready: CursorAccountsDashboard = {
      ...snapshot('cursor'), available: true, operation: null,
      current: { email: 'Work@Example.test', team: 'Delivery', verified: true },
      accounts: [
        { name: 'other-team', email: 'work@example.test', team: 'Other' },
        { name: 'different-case-team', email: 'work@example.test', team: 'delivery' },
        { name: 'daily-work', email: 'WORK@example.test', team: 'Delivery' },
      ],
    };
    await f.respond(0, { ...ready, current: { email: 'stale@example.test', team: '', verified: false } });
    const save = f.component.syncCurrent();
    assert.equal(f.requests[1].url, '/api/agent-runtimes/accounts/cursor?refresh=1');
    assert.equal(f.requests.length, 2);
    await f.respond(1, ready);
    assert.equal(f.component.isCurrent(ready.accounts[0]), false);
    assert.equal(f.component.isCurrent(ready.accounts[1]), false);
    assert.equal(f.component.isCurrent(ready.accounts[2]), true);
    assert.equal(f.requests[2].url, '/api/agent-runtimes/accounts/cursor/save');
    assert.equal(JSON.parse(String(f.requests[2].init.body)).name, 'daily-work');
    await f.respond(2, ready);
    await save;
    const login = f.component.act('login', 'other-team');
    assert.equal(JSON.parse(String(f.requests[3].init.body)).name, 'other-team');
    await f.respond(3, loginSnapshot('cursor', 'relogin'));
    await login;
  } finally { f.cleanup(); }
});

test('同邮箱同团队名称按官方身份精确标记当前账号，同步只沿用匹配身份的内部名称', async () => {
  const f = fixture();
  try {
    f.component.open.value = true;
    const ready: CursorAccountsDashboard = {
      ...readySnapshot('cursor'),
      current: { email: 'work@example.test', team: 'Same team', verified: true,
        displayName: '当前官方姓名', identity: 'user:fixture|team:2' },
      accounts: [
        { name: 'cursor-1', email: 'work@example.test', team: 'Same team',
          displayName: '相同邮箱的其他团队', identity: 'user:fixture|team:1' },
        { name: 'cursor-2', email: 'work@example.test', team: 'Same team',
          displayName: '当前官方姓名', identity: 'user:fixture|team:2' },
      ],
    };
    await f.respond(0, ready);
    assert.deepEqual(ready.accounts.map(account => f.component.isCurrent(account)), [false, true]);
    assert.equal(f.component.isCurrent({ ...ready.accounts[1], identity: 'USER:fixture|team:2' }), false);
    assert.equal(f.component.isCurrent({ name: 'legacy', email: 'WORK@example.test', team: 'Same team' }), true);
    const sync = f.component.syncCurrent();
    await f.respond(1, ready);
    assert.equal(f.requests[2].url, '/api/agent-runtimes/accounts/cursor/save');
    assert.deepEqual(JSON.parse(String(f.requests[2].init.body)), { name: 'cursor-2' });
    await f.respond(2, ready);
    await sync;
  } finally { f.cleanup(); }
});

test('切换确认优先展示官方姓名并回退邮箱，POST始终使用内部ASCII名称', async () => {
  for (const displayName of ['李 测试', undefined]) {
    const f = fixture();
    try {
      f.component.open.value = true;
      const ready: CursorAccountsDashboard = {
        ...readySnapshot('cursor'),
        accounts: [{ name: 'cursor-2', email: 'official@example.test', team: 'Team', displayName }],
      };
      await f.respond(0, ready);
      const change = f.component.act('use', 'cursor-2');
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.confirmations.length, 1);
      assert.ok(f.confirmations[0].includes(`“${displayName || 'official@example.test'}”`));
      assert.equal(f.confirmations[0].includes('cursor-2'), false);
      assert.equal(f.requests[1].url, '/api/agent-runtimes/accounts/cursor/use');
      assert.deepEqual(JSON.parse(String(f.requests[1].init.body)), { name: 'cursor-2' });
      assert.equal(f.popups.length, 0);
      await f.respond(1, ready);
      await change;
    } finally { f.cleanup(); }
  }
});

test('占位窗口只接受本次POST绑定的登录ID与可信官方地址，已跳转窗口不随弹窗关闭', async () => {
  const f = fixture();
  try {
    f.component.open.value = true;
    await f.respond(0, readySnapshot('cursor'));
    const login = f.component.act('login');
    await f.respond(1, loginSnapshot('cursor', 'this-login'));
    await login;
    for (const [index, next] of [
      loginSnapshot('cursor', 'another-login', officialUrls.cursor),
      loginSnapshot('cursor', 'this-login', 'https://cursor.com.evil.test/loginDeepControl?challenge=fixture'),
      loginSnapshot('cursor', 'this-login', officialUrls.cursor),
    ].entries()) {
      const refresh = f.component.load();
      await f.respond(index + 2, next);
      await refresh;
      assert.deepEqual(f.popups[0].replacements, index === 2 ? [officialUrls.cursor] : []);
    }
    f.component.open.value = false;
    assert.equal(f.popups[0].closed, false);
  } finally { f.cleanup(); }
});

test('切平台关闭旧占位窗口，迟到的旧登录POST不能跳转或关闭新平台窗口', async () => {
  const f = fixture();
  try {
    f.component.open.value = true;
    await f.respond(0, readySnapshot('cursor'));
    const oldLogin = f.component.act('login');
    f.component.provider.value = 'codex';
    assert.equal(f.popups[0].closed, true);
    await f.respond(2, readySnapshot('codex'));
    const newLogin = f.component.act('login');
    assert.equal(f.popups.length, 2);
    await f.respond(1, loginSnapshot('cursor', 'old-login', officialUrls.cursor));
    await oldLogin;
    assert.deepEqual(f.popups[0].replacements, []);
    assert.deepEqual(f.popups[1].replacements, []);
    assert.equal(f.popups[1].closed, false);
    await f.respond(3, loginSnapshot('codex', 'new-login', officialUrls.codex));
    await newLogin;
    assert.deepEqual(f.popups[1].replacements, [officialUrls.codex]);
  } finally { f.cleanup(); }
});

test('关闭管理弹窗立即关闭未导航窗口，迟到登录地址不再自动打开', async () => {
  const f = fixture();
  try {
    f.component.open.value = true;
    await f.respond(0, readySnapshot('cursor'));
    const login = f.component.act('login');
    f.component.open.value = false;
    assert.equal(f.popups[0].closed, true);
    await f.respond(1, loginSnapshot('cursor', 'late-login', officialUrls.cursor));
    await login;
    assert.deepEqual(f.popups[0].replacements, []);
    assert.equal(f.requests.length, 2);
  } finally { f.cleanup(); }
});

test('取消登录、登录失败或POST失败均关闭未跳转窗口', async () => {
  for (const outcome of ['cancel', 'operation-failed', 'post-failed']) {
    const f = fixture();
    try {
      f.component.open.value = true;
      await f.respond(0, readySnapshot('cursor'));
      const login = f.component.act('login');
      if (outcome === 'post-failed') {
        await f.respond(1, { message: 'fixture login failed' }, 400);
        assert.equal(f.popups[0].closed, true);
        await f.respond(2, readySnapshot('cursor'));
        await login;
      } else {
        await f.respond(1, loginSnapshot('cursor', 'this-login'));
        await login;
        const action = outcome === 'cancel' ? f.component.cancel() : f.component.load();
        if (outcome === 'cancel') assert.equal(f.popups[0].closed, true);
        await f.respond(2, loginSnapshot('cursor', 'this-login', officialUrls.cursor,
          outcome === 'cancel' ? 'cancelled' : 'failed'));
        await action;
      }
      assert.equal(f.popups[0].closed, true);
      assert.deepEqual(f.popups[0].replacements, []);
    } finally { f.cleanup(); }
  }
});

test('浏览器拦截弹窗时保留可信官方登录链接供手动打开', async () => {
  const f = fixture({ popupBlocked: true });
  try {
    f.component.open.value = true;
    await f.respond(0, readySnapshot('cursor'));
    const login = f.component.act('login');
    assert.equal(f.popups.length, 0);
    assert.ok(f.events.includes('open:about:blank:_blank'));
    await f.respond(1, loginSnapshot('cursor', 'blocked-popup-login', officialUrls.cursor));
    await login;
    assert.equal(f.component.loginUrl.value, officialUrls.cursor);
    assert.equal(f.component.dashboard.value.operation.status, 'running');
  } finally { f.cleanup(); }
});

test('同步本机账号刷新失败不发送save，也不使用缓存的旧账号', async () => {
  const f = fixture();
  try {
    f.component.open.value = true;
    await f.respond(0, {
      ...readySnapshot('cursor'), current: { email: 'stale@example.test', team: '', verified: false },
    });
    const sync = f.component.syncCurrent();
    assert.equal(f.component.syncing.value, true);
    await f.respond(1, { message: 'fixture refresh failed' }, 400);
    await sync;
    assert.equal(f.component.syncing.value, false);
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests.some(request => request.init.method === 'POST'), false);
    assert.equal(f.popups.length, 0);
  } finally { f.cleanup(); }
});

test('运行中登录轮询503后继续安排重试，下次同ID可信地址仍能自动跳转', async () => {
  const f = fixture();
  try {
    f.component.open.value = true;
    await f.respond(0, readySnapshot('cursor'));
    const login = f.component.act('login');
    await f.respond(1, loginSnapshot('cursor', 'retry-login'));
    await login;
    const firstPoll = [...f.timers].reverse().find(timer => !timer.cleared)!;
    assert.equal(firstPoll.delay, 2_000);
    firstPoll.callback();
    await f.respond(2, { message: 'fixture temporarily unavailable' }, 503);
    assert.deepEqual(f.popups[0].replacements, []);
    assert.equal(f.popups[0].closed, false);
    const retry = [...f.timers].reverse().find(timer => !timer.cleared)!;
    assert.ok(retry);
    assert.notEqual(retry, firstPoll);
    assert.equal(retry.delay, 2_000);
    retry.callback();
    await f.respond(3, loginSnapshot('cursor', 'retry-login', officialUrls.cursor));
    assert.deepEqual(f.popups[0].replacements, [officialUrls.cursor]);
  } finally { f.cleanup(); }
});

test('账号读取失败与未登录分开显示；官方姓名原样保留，失败时不把空列表解释成没有账号', async () => {
  const f = fixture();
  try {
    f.component.open.value = true;
    await f.respond(0, { ...readySnapshot('cursor'), available: false, blockedReason: '接口原文 L1001' });
    assert.equal(f.component.accountStatus.value, '暂不可读取');
    assert.match(f.component.emptyDescription.value, /暂不能确认/);
    assert.equal(f.component.canManage.value, false);
    const refresh = f.component.load(true);
    await f.respond(1, { ...readySnapshot('cursor'), current: { email: 'name@example.test', displayName: 'Official Name L1002', team: 'Team L1003', verified: false } });
    await refresh;
    assert.equal(f.component.accountStatus.value, '本机记录待核验');
    assert.equal(f.component.accountTitle.value, 'Official Name L1002');
    assert.equal(f.component.canManage.value, true);
  } finally { f.cleanup(); }
});

test('Antigravity 等执行器展示真实连接，切换后中止旧账号读取，不能请求不支持的账号操作', async () => {
  const f = fixture({ runtimes: [{ provider: 'antigravity', label: 'Antigravity CLI', ready: true, authenticated: true }] });
  try {
    f.component.open.value = true;
    f.component.provider.value = 'antigravity';
    assert.equal(f.requests[0].init.signal?.aborted, true);
    assert.equal(f.component.managed.value, false);
    assert.equal(f.component.accountStatus.value, '登录已核验');
    assert.ok(f.component.providerChoices.value.some((item: any) => item.id === 'antigravity' && item.managed === false));
    await f.respond(0, readySnapshot('cursor'));
    assert.equal(f.component.dashboard.value, undefined);
    await f.component.act('login'); await f.component.act('restore'); await f.component.syncCurrent();
    assert.equal(f.component.canManage.value, false); assert.equal(f.component.canRestore.value, false);
    assert.equal(f.requests.length, 1);
  } finally { f.cleanup(); }
});

test('待恢复状态优先展示；额度沿用对应平台的真实快照，Codex 套餐不与 API 额度混用', async () => {
  const f = fixture({ usageCards: [{ key: 'codex-plan', label: 'Codex 套餐', usage: { available: false, message: '额度未知 L88' } },
    { key: 'codex-api', label: 'API', usage: { available: true } }] });
  try {
    f.component.provider.value = 'codex'; f.component.open.value = true;
    await f.respond(0, { ...readySnapshot('codex'), pendingRecovery: true, current: { email: 'name@example.test', team: '', verified: true } });
    assert.equal(f.component.accountStatus.value, '需要恢复');
    assert.equal(f.component.canManage.value, false); assert.equal(f.component.canRestore.value, true);
    assert.equal(f.component.usageCard.value.label, 'Codex 套餐');
    assert.equal(f.component.usageCard.value.usage.message, '额度未知 L88');
  } finally { f.cleanup(); }
});

test('打开面板同步执行器和额度，刷新受管账号同时更新账号快照，关闭后不重复刷新', async () => {
  const f = fixture();
  try {
    f.component.open.value = true;
    assert.equal(f.events.filter(event => event === 'emit:refresh').length, 1);
    await f.respond(0, readySnapshot('cursor'));
    f.component.refreshState();
    assert.equal(f.requests[1].url, '/api/agent-runtimes/accounts/cursor?refresh=1');
    assert.equal(f.events.filter(event => event === 'emit:refresh').length, 2);
    await f.respond(1, readySnapshot('cursor'));
    f.component.provider.value = 'antigravity';
    f.component.refreshState();
    assert.equal(f.requests.length, 2);
    assert.equal(f.events.filter(event => event === 'emit:refresh').length, 3);
    f.component.open.value = false;
    assert.equal(f.events.filter(event => event === 'emit:refresh').length, 3);
  } finally { f.cleanup(); }
});

test('登录状态独立于执行器准入，已登录但执行不可用仍显示登录已核验', () => {
  const f = fixture({ runtimes: [{ provider: 'kiro', label: 'Kiro CLI', ready: false, authenticated: true }] });
  try {
    f.component.provider.value = 'kiro';
    assert.equal(f.component.accountStatus.value, '登录已核验');
  } finally { f.cleanup(); }
});

test('从官方登录返回会重新检查，同一轮焦点和可见事件不会重复请求或重放登录', async () => {
  const f = fixture();
  try {
    f.component.provider.value = 'codex';
    f.component.open.value = true;
    await f.respond(0, loginSnapshot('codex', 'return-login', officialUrls.codex));
    assert.equal(f.component.operationTitle.value, '等待 Codex CLI 授权回传');
    f.document.visibilityState = 'hidden';
    f.returnListeners.get('visibilitychange')!();
    assert.equal(f.requests.length, 1);
    f.document.visibilityState = 'visible';
    f.returnListeners.get('visibilitychange')!();
    f.returnListeners.get('focus')!();
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[1].url, '/api/agent-runtimes/accounts/codex?refresh=1');
    const completed = loginSnapshot('codex', 'return-login', undefined, 'succeeded');
    completed.accounts = [{ name: 'new-account', email: 'new@example.test', team: 'pro' }];
    await f.respond(1, completed);
    assert.equal(f.component.dashboard.value.accounts[0].email, 'new@example.test');
    assert.equal(f.events.filter(event => event === 'emit:changed').length, 1);
    assert.equal(f.requests.some(request => request.init.method === 'POST'), false);
    assert.equal(f.popups.length, 0);
    assert.equal(f.timers.filter(timer => !timer.cleared).length, 0);
    f.component.open.value = false;
    assert.equal(f.returnListeners.size, 0);
  } finally { f.cleanup(); }
});

test('Codex旧账号已核验与新登录结果独立，授权提示和切换确认只描述CLI', async () => {
  const f = fixture();
  try {
    f.component.provider.value = 'codex';
    f.component.open.value = true;
    const current = { email: 'original@example.test', team: 'pro', verified: true };
    const running = { ...loginSnapshot('codex', 'new-cli-login', officialUrls.codex), current };
    await f.respond(0, running);
    assert.equal(f.component.accountStatus.value, '当前 CLI 登录已核验');
    assert.equal(f.component.operationTitle.value, '等待 Codex CLI 授权回传');
    assert.match(f.component.loginHelp.value, /Codex CLI.*回传.*核验/);
    assert.equal(f.component.accountAddHelp.value.includes('桌面'), false);
    const refresh = f.component.load();
    const failed = { ...loginSnapshot('codex', 'new-cli-login', undefined, 'failed'), current,
      accounts: [{ name: 'new-account', email: 'new@example.test', team: 'pro' }] };
    failed.operation!.message = '本次 CLI 登录失败';
    await f.respond(1, failed);
    await refresh;
    assert.equal(f.component.accountStatus.value, '当前 CLI 登录已核验');
    assert.equal(f.component.dashboard.value.operation.status, 'failed');
    assert.equal(f.component.dashboard.value.operation.message, '本次 CLI 登录失败');
    const change = f.component.act('use', 'new-account');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.confirmations[0], '将本机 Codex CLI 切换到“new@example.test”。');
    assert.equal(f.requests[2].url, '/api/agent-runtimes/accounts/codex/use');
    await f.respond(2, failed);
    await change;
    assert.equal(f.desktopRequests.some(request => request.init.method === 'POST'), false);
  } finally { f.cleanup(); }
});

test('返回页面发现本机当前账号变化时刷新上层状态，不自动保存或切换', async () => {
  const f = fixture();
  try {
    f.component.open.value = true;
    await f.respond(0, { ...readySnapshot('cursor'), current: { email: 'old@example.test', team: '', verified: true } });
    f.returnListeners.get('focus')!();
    await f.respond(1, { ...readySnapshot('cursor'), current: { email: 'new@example.test', team: '', verified: true } });
    assert.equal(f.component.accountTitle.value, 'new@example.test');
    assert.equal(f.events.filter(event => event === 'emit:changed').length, 1);
    f.returnListeners.get('focus')!();
    await f.respond(2, { ...readySnapshot('cursor'), current: { email: 'new@example.test', team: '', verified: true } });
    assert.equal(f.events.filter(event => event === 'emit:changed').length, 1);
    assert.equal(f.requests.some(request => request.init.method === 'POST'), false);
    f.component.provider.value = 'antigravity';
    f.returnListeners.get('focus')!();
    assert.equal(f.requests.length, 3);
  } finally { f.cleanup(); }
});

test('CLI不可用时桌面入口仍可用，打开应用不标成已登录，也不发起CLI登录', async () => {
  const f = fixture();
  try {
    f.component.provider.value = 'codex';
    f.component.open.value = true;
    await f.respond(0, { ...readySnapshot('codex'), available: false });
    assert.equal(f.component.canManage.value, false);
    assert.equal(f.component.canOpenDesktop.value, true);
    await f.component.openDesktop();
    assert.equal(f.desktopRequests.at(-1)?.url, '/api/agent-runtimes/desktop-accounts/codex/open');
    assert.equal(f.desktopRequests.at(-1)?.init.method, 'POST');
    assert.equal(f.component.desktopStatus.value, '待在桌面确认');
    assert.equal(f.requests.length, 1);
  } finally { f.cleanup(); }
});

test('CLI授权期间不并行开启桌面授权，部分成功保留已保存账号与未激活结果', async () => {
  const f = fixture();
  try {
    f.component.provider.value = 'codex';
    f.component.open.value = true;
    await f.respond(0, loginSnapshot('codex', 'login-both', officialUrls.codex));
    assert.equal(f.component.canOpenDesktop.value, false);
    await f.component.openDesktop();
    assert.equal(f.desktopRequests.some(request => request.init.method === 'POST'), false);
    const refresh = f.component.load();
    const partial = loginSnapshot('codex', 'login-both', undefined, 'partial');
    partial.operation!.savedAccountName = 'saved-new';
    partial.operation!.activation = { status: 'failed', message: '仍有任务运行，账号已保存，尚未切换' };
    partial.accounts = [{ name: 'saved-new', email: 'new@example.test', team: 'pro' }];
    await f.respond(1, partial);
    await refresh;
    assert.equal(f.component.dashboard.value.operation.savedAccountName, 'saved-new');
    assert.equal(f.component.canManage.value, true);
    assert.equal(f.requests.some(request => request.init.method === 'POST'), false);
    assert.equal(f.desktopRequests.some(request => request.init.method === 'POST'), false);
  } finally { f.cleanup(); }
});

test('桌面状态读取不会跨平台或在关闭后覆盖，缓存邮箱始终标记待确认', async () => {
  const f = fixture({ manualDesktop: true });
  const desktop = (provider: 'cursor' | 'codex'): DesktopAccountSnapshot => ({ provider, installed: true, canOpen: true,
    status: 'recorded', email: `${provider}@example.test`, checkedAt: 'fixture', message: '缓存记录' });
  try {
    f.component.open.value = true;
    f.component.provider.value = 'codex';
    assert.equal(f.desktopRequests[0].init.signal?.aborted, true);
    await f.respondDesktop(1, desktop('codex'));
    await f.respondDesktop(0, desktop('cursor'));
    assert.equal(f.component.desktop.value.provider, 'codex');
    assert.equal(f.component.desktopStatus.value, '本机记录待确认');
    f.component.open.value = false;
    assert.equal(f.component.desktop.value, undefined);
  } finally { f.cleanup(); }
});

test('桌面状态先返回时等待CLI初次读取，避免与已在途授权并行打开', async () => {
  const f = fixture({ manualDesktop: true });
  try {
    f.component.provider.value = 'codex';
    f.component.open.value = true;
    await f.respondDesktop(0, { provider: 'codex', installed: true, canOpen: true,
      status: 'unknown', checkedAt: 'fixture', message: '请在桌面端确认' });
    assert.equal(f.component.dashboard.value, undefined);
    assert.equal(f.component.canOpenDesktop.value, false);
    await f.component.openDesktop();
    assert.equal(f.desktopRequests.some(request => request.init.method === 'POST'), false);
    await f.respond(0, loginSnapshot('codex', 'existing-login', officialUrls.codex));
    assert.equal(f.component.canOpenDesktop.value, false);
    await f.component.openDesktop();
    assert.equal(f.desktopRequests.some(request => request.init.method === 'POST'), false);
  } finally { f.cleanup(); }
});

test('打开桌面请求未完成时不能启动CLI登录，返回后恢复账号操作', async () => {
  const f = fixture({ manualDesktop: true });
  const desktop: DesktopAccountSnapshot = { provider: 'codex', installed: true, canOpen: true,
    status: 'unknown', checkedAt: 'fixture', message: '请在桌面端确认' };
  try {
    f.component.provider.value = 'codex';
    f.component.open.value = true;
    await f.respond(0, readySnapshot('codex'));
    await f.respondDesktop(0, desktop);
    const opening = f.component.openDesktop();
    assert.equal(f.desktopRequests[1].init.method, 'POST');
    assert.equal(f.component.canManage.value, false);
    await f.component.act('login');
    assert.equal(f.requests.some(request => request.init.method === 'POST'), false);
    assert.equal(f.popups.length, 0);
    await f.respondDesktop(1, { ...desktop, opened: true });
    await opening;
    assert.equal(f.component.canManage.value, true);
  } finally { f.cleanup(); }
});
