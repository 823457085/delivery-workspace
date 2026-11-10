/** Execute the real workspace UI actions and watchers with controlled HTTP responses. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { computed, effectScope, nextTick, reactive, shallowRef, watch } from 'vue';

function scriptCode(file: string, functions?: string[]) {
  const raw = fs.readFileSync(new URL(file, import.meta.url), 'utf8').match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
  const tree = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true);
  const body = tree.statements.filter(node => !ts.isImportDeclaration(node)
    && (!functions || ts.isFunctionDeclaration(node) && !!node.name && functions.includes(node.name.text)))
    .map(node => node.getText(tree)).join('\n');
  return ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
}

const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await nextTick(); };
const preview = (path = '/fixture/selected', extra = {}) => ({ path, revision: `preview:${path}`, eligible: true, canSchedule: true, ...extra });
function fixture() {
  const props = reactive({ path: '/fixture/selected', revision: 'git-revision', disabled: false });
  const events: { event: string; value: unknown }[] = [], messages: string[] = [], prompts: string[] = [];
  const requests: { url: string; init: any; resolve: (data: unknown, ok?: boolean) => void }[] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const unmount: (() => void)[] = [];
  let confirm = async (options: any): Promise<{ value: string }> => ({ value: options.inputPlaceholder });
  const dependencies = { computed, shallowRef, watch, defineProps: () => props,
    setInterval: (callback: () => void, delay: number) => { assert.equal(delay, 15_000); const id = ++timerId; timers.set(id, callback); return id; },
    clearInterval: (id: number) => { timers.delete(id); },
    defineEmits: () => (event: string, value: unknown) => events.push({ event, value }),
    onBeforeUnmount: (fn: () => void) => unmount.push(fn),
    ElMessage: { success: (message: string) => messages.push(message), error: (message: string) => messages.push(message) },
    ElMessageBox: { prompt: (message: string, _title: string, options: any) => { prompts.push(message); return confirm(options); } },
    fetch: (url: string, init: any = {}) => new Promise(resolve => requests.push({ url, init,
      resolve: (data, ok = true) => resolve({ ok, json: async () => data }) })) };
  const scope = effectScope();
  const state = scope.run(() => new Function(...Object.keys(dependencies),
    `${scriptCode('../src/features/project-inventory/ProjectWorkspaceActions.vue')}\nreturn { preview, loading, action, deleteAt, activeRule, canSave, scheduleOpen, submit };`)
    (...Object.values(dependencies)))!;
  return { props, state, requests, events, messages, prompts, timers, tick: () => { for (const callback of [...timers.values()]) callback(); },
    confirm: (value: typeof confirm) => { confirm = value; },
    async ready(data = preview()) { requests[0].resolve(data); await flush(); },
    close() { unmount.forEach(fn => fn()); scope.stop(); } };
}

test('删除必须确认目录名和绝对路径，取消不发删除请求；后端错误原文反馈', async () => {
  const f = fixture();
  try {
    await f.ready();
    f.confirm(async () => { throw 'cancel'; });
    await f.state.submit('delete');
    assert.equal(f.requests.length, 1);
    assert.equal(f.state.action.value, '');
    assert.ok(f.prompts[0].includes('/fixture/selected'));
    assert.ok(f.prompts[0].includes('无法恢复'));
    f.confirm(async options => {
      assert.equal(options.inputValidator('wrong'), '请输入完整且一致的目录名');
      assert.equal(options.inputValidator('selected'), true);
      return { value: 'selected' };
    });
    const removing = f.state.submit('delete');
    await flush();
    assert.equal(f.requests[1].url, '/api/projects/workspaces/delete');
    assert.equal(f.requests[1].init.headers['X-Delivery-Confirmed'], 'yes');
    assert.deepEqual(JSON.parse(f.requests[1].init.body), { path: '/fixture/selected', revision: 'preview:/fixture/selected', confirmName: 'selected' });
    f.requests[1].resolve({ message: 'L_WORKSPACE_BUSY' }, false);
    await removing;
    assert.deepEqual(f.messages, ['L_WORKSPACE_BUSY']);
    assert.equal(f.events.some(item => item.event === 'removed'), false);
    assert.equal(f.state.action.value, '');
  } finally { f.close(); }
});

test('为当前受阻工作区保存指定时间，重新读取后保留排程；取消不重复确认且发null', async () => {
  const f = fixture();
  const deadline = '2030-11-04T13:14:15.000Z';
  try {
    await f.ready(preview('/fixture/selected', { eligible: false, reason: '当前有未提交改动' }));
    f.state.deleteAt.value = new Date(deadline);
    assert.equal(f.state.canSave.value, true, '当前受阻只阻止立即删除，仍可设置未来日期');
    const saving = f.state.submit('schedule');
    await flush();
    assert.deepEqual(JSON.parse(f.requests[1].init.body), { path: '/fixture/selected', revision: 'preview:/fixture/selected', deleteAt: deadline, confirmName: 'selected' });
    const saved = preview('/fixture/selected', { rule: { path: '/fixture/selected', deleteAt: deadline, status: 'scheduled' } });
    f.requests[1].resolve(saved);
    await flush();
    assert.equal(f.requests[2].url, '/api/projects/workspaces?path=%2Ffixture%2Fselected');
    f.requests[2].resolve(saved);
    await saving;
    assert.equal(f.state.activeRule.value.deleteAt, deadline);
    const cancelling = f.state.submit('cancel');
    await flush();
    assert.deepEqual(JSON.parse(f.requests[3].init.body), { path: '/fixture/selected', revision: 'preview:/fixture/selected', deleteAt: null });
    assert.equal(f.prompts.length, 1);
    f.requests[3].resolve(preview());
    await flush(); f.requests[4].resolve(preview());
    await cancelling;
    assert.equal(f.state.activeRule.value, undefined);
    assert.equal(f.state.deleteAt.value, undefined);
    assert.deepEqual(f.messages, ['自动删除时间已保存', '已取消自动删除']);
  } finally { f.close(); }
});

test('切换工作区后迟到的预览不覆盖新选择，确认期间切换不对旧目录发请求', async () => {
  const f = fixture();
  try {
    f.props.path = '/fixture/next'; await nextTick();
    f.requests[1].resolve(preview('/fixture/next')); await flush();
    f.requests[0].resolve(preview()); await flush();
    assert.equal(f.state.preview.value.path, '/fixture/next');
    let accept!: () => void;
    f.confirm(options => new Promise(resolve => { accept = () => resolve({ value: options.inputPlaceholder }); }));
    const deleting = f.state.submit('delete');
    f.props.path = '/fixture/third'; await nextTick();
    f.requests[2].resolve(preview('/fixture/third')); await flush();
    accept(); await deleting;
    assert.equal(f.requests.some(item => item.init.method === 'POST'), false);
    assert.equal(f.state.preview.value.path, '/fixture/third');
  } finally { f.close(); }
});

test('结构保护阻止新增排程，但已不存在目录的已有排程仍可取消', async () => {
  const f = fixture();
  try {
    await f.ready(preview('/fixture/selected', { eligible: false, canSchedule: false }));
    f.state.deleteAt.value = new Date('2030-11-04T13:14:15.000Z');
    assert.equal(f.state.canSave.value, false);
    await f.state.submit('schedule');
    assert.equal(f.requests.length, 1);
    f.state.preview.value = preview('/fixture/selected', { revision: '', eligible: false, canSchedule: false,
      rule: { path: '/fixture/selected', deleteAt: '2030-11-04T13:14:15.000Z', status: 'blocked' } });
    const cancelling = f.state.submit('cancel');
    await flush();
    assert.deepEqual(JSON.parse(f.requests[1].init.body), { path: '/fixture/selected', revision: '', deleteAt: null });
    f.requests[1].resolve(preview()); await flush(); f.requests[2].resolve(preview()); await cancelling;
    assert.equal(f.state.activeRule.value, undefined);
  } finally { f.close(); }
});

test('删除成功事件只携带已确认目录，重复点击不产生第二个请求', async () => {
  const f = fixture();
  try {
    await f.ready();
    const removing = f.state.submit('delete');
    await flush();
    await f.state.submit('delete');
    assert.equal(f.requests.length, 2);
    f.requests[1].resolve({ path: '/fixture/selected', deleted: true });
    await removing;
    assert.deepEqual(f.events.filter(item => item.event === 'removed'), [{ event: 'removed', value: '/fixture/selected' }]);
  } finally { f.close(); }
});

test('删除所选工作区后选择同仓库下一项；最后一个被删则关闭抽屉；其他选择不被迟到事件切换', async () => {
  const first = { path: '/repo/one', projectId: 'same' }, next = { path: '/repo/two', projectId: 'same' };
  const gitProject = shallowRef<any>(first), gitDrawer = shallowRef(true), workspacePaths = new Map([['same', first.path]]);
  const activeWorkspacePath = shallowRef(first.path), selectedGroup = shallowRef({ workspaces: [first, next] });
  const dependencies = { gitProject, gitDrawer, workspacePaths, activeWorkspacePath, selectedGroup };
  const state = new Function(...Object.keys(dependencies),
    `${scriptCode('../src/features/project-inventory/ProjectInventory.vue', ['selectWorkspace', 'selectAfterRemoval'])}\nreturn { selectAfterRemoval };`)(...Object.values(dependencies));
  state.selectAfterRemoval(first.path, [first, next, { path: '/different', projectId: 'other' }]);
  assert.equal(gitProject.value.path, next.path);
  assert.equal(workspacePaths.get('same'), next.path);
  state.selectAfterRemoval(first.path, [next]);
  assert.equal(gitProject.value.path, next.path);
  state.selectAfterRemoval(next.path, [next, { path: '/different', projectId: 'other' }]);
  assert.equal(gitDrawer.value, false);
  assert.equal(gitProject.value, undefined);
  assert.equal(workspacePaths.has('same'), false);
});

test('仅已排程工作区低频回读；编辑、忙碌或加载时跳过，自动删除只通知一次且卸载停止', async () => {
  const f = fixture();
  const deadline = '2030-11-04T13:14:15.000Z';
  const rule = { path: '/fixture/selected', deleteAt: deadline, status: 'scheduled' };
  try {
    assert.equal(f.timers.size, 0);
    await f.ready(preview('/fixture/selected', { rule }));
    assert.equal(f.timers.size, 1);
    f.state.scheduleOpen.value = true;
    f.state.deleteAt.value = new Date('2031-11-04T13:14:15.000Z');
    f.tick(); assert.equal(f.requests.length, 1);
    f.state.scheduleOpen.value = false; f.state.action.value = 'schedule';
    f.tick(); assert.equal(f.requests.length, 1);
    f.state.action.value = ''; f.state.loading.value = true;
    f.tick(); assert.equal(f.requests.length, 1);
    f.state.loading.value = false;
    f.tick(); assert.equal(f.requests.length, 2);
    f.state.scheduleOpen.value = true;
    f.requests[1].resolve(preview('/fixture/selected', { rule })); await flush();
    assert.equal(f.state.deleteAt.value.toISOString(), '2031-11-04T13:14:15.000Z', '在途回读不覆盖刚打开的编辑值');
    f.state.scheduleOpen.value = false;
    f.tick();
    f.requests[2].resolve(preview('/fixture/selected', { rule: { ...rule, status: 'deleted' } })); await flush();
    assert.deepEqual(f.events.filter(item => item.event === 'removed'), [{ event: 'removed', value: '/fixture/selected' }]);
    assert.equal(f.timers.size, 0);
    f.state.preview.value = preview('/fixture/selected', { rule }); await flush();
    f.tick(); f.requests[3].resolve(preview('/fixture/selected', { rule: { ...rule, status: 'deleted' } })); await flush();
    assert.equal(f.events.filter(item => item.event === 'removed').length, 1);
    f.state.preview.value = preview('/fixture/selected', { rule }); await flush();
    assert.equal(f.timers.size, 1);
    f.close(); assert.equal(f.timers.size, 0);
    const count = f.requests.length; f.tick(); assert.equal(f.requests.length, count);
  } finally { f.close(); }
});
