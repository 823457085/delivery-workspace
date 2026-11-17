import assert from 'node:assert/strict';
import test from 'node:test';
import { computed, shallowRef } from 'vue';
import { AGENT_DELIVERY_WORKSPACES_STORAGE_KEY, createAgentDeliveryWorkspaceStore,
  normalizeAgentDeliveryWorkspaces, validateAgentDeliveryWorkspaces } from '../src/features/agent-workbench/useAgentDeliveryWorkspaces.js';

function memoryStorage(initial = '{}') {
  let value = initial;
  return { getItem: (_key: string) => value, setItem(key: string, next: string) {
    assert.equal(key, AGENT_DELIVERY_WORKSPACES_STORAGE_KEY); value = next;
  } };
}
const app = { path: '/work/app/i18n-gate', label: 'App' };
const pc = { path: '/work/pc/i18n-gate', label: 'PC' };

test('交付项目覆盖历史执行目录，多个视图同步并且按会话隔离', () => {
  const store = createAgentDeliveryWorkspaceStore(memoryStorage());
  const fallback = [{ path: '/old/apex', label: '' }];
  const defaults = shallowRef(fallback.map(item => item.path));
  const bound = shallowRef(false);
  const main = computed(() => store.resolve('first', defaults.value, bound.value));
  const sidebar = computed(() => store.resolve('first', defaults.value, bound.value));
  assert.deepEqual(main.value, fallback);
  store.save('first', [app, pc]);
  assert.deepEqual(main.value, [app, pc]);
  assert.deepEqual(sidebar.value, [app, pc]);
  assert.equal(store.get('second'), undefined);
  store.save('second', [pc]);
  assert.deepEqual(main.value, [app, pc]);
  defaults.value = [app.path, fallback[0].path];
  bound.value = true;
  assert.deepEqual(main.value, [app, ...fallback]);
  assert.deepEqual(sidebar.value, [app, ...fallback]);
  store.save('first', []);
  assert.deepEqual(sidebar.value, [{ path: app.path, label: '' }, ...fallback]);
});

test('本浏览器保存后可恢复，清空选择与恢复默认具有不同语义', () => {
  const storage = memoryStorage();
  const store = createAgentDeliveryWorkspaceStore(storage);
  store.save('first', [app, pc]);
  const recovered = createAgentDeliveryWorkspaceStore(storage);
  assert.deepEqual(recovered.get('first'), [app, pc]);
  recovered.save('first', []);
  assert.deepEqual(recovered.get('first'), []);
  recovered.reset('first');
  assert.equal(recovered.get('first'), undefined);
  assert.equal(createAgentDeliveryWorkspaceStore(storage).get('first'), undefined);
});

test('忽略损坏配置并保留其他会话，路径去重且名称按输入保留', () => {
  assert.equal(createAgentDeliveryWorkspaceStore(memoryStorage('{bad')).get('first'), undefined);
  const store = createAgentDeliveryWorkspaceStore(memoryStorage(JSON.stringify({ valid: [app], broken: [{ path: 'relative' }] })));
  assert.deepEqual(store.get('valid'), [app]);
  assert.equal(store.get('broken'), undefined);
  assert.deepEqual(normalizeAgentDeliveryWorkspaces([{ path: ` ${app.path} `, label: ' App ' }, app, pc]), [app, pc]);
  assert.throws(() => normalizeAgentDeliveryWorkspaces([{ path: 'relative', label: '' }]), /完整工作区路径/);
});

test('保存失败不改变已生效选择且不会谎报持久化成功', () => {
  const store = createAgentDeliveryWorkspaceStore({ getItem: () => JSON.stringify({ first: [app] }),
    setItem: () => { throw new Error('storage full'); } });
  assert.throws(() => store.save('first', [pc]), /storage full/);
  assert.deepEqual(store.get('first'), [app]);
  assert.throws(() => store.reset('first'), /storage full/);
  assert.deepEqual(store.get('first'), [app]);
  assert.throws(() => createAgentDeliveryWorkspaceStore(null).save('first', [app]), /尚未保存/);
});

test('保存前验证每个真实 Git 工作区，并使用标准目录去重', async () => {
  const calls: string[] = [];
  const rows = await validateAgentDeliveryWorkspaces([app, { ...app, path: '/work/app/i18n-gate/subdir' }, pc], async path => {
    calls.push(path);
    return { isGit: true, directory: path.includes('/app/') ? app.path : pc.path };
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(rows, [app, pc]);
});

test('任何工作区验证失败时整组不保存', async () => {
  const store = createAgentDeliveryWorkspaceStore(memoryStorage());
  store.save('first', [app]);
  await assert.rejects(async () => {
    const rows = await validateAgentDeliveryWorkspaces([app, pc], async path => ({ isGit: path === app.path, directory: path }));
    store.save('first', rows);
  }, /不是 Git 项目/);
  assert.deepEqual(store.get('first'), [app]);
  await assert.rejects(validateAgentDeliveryWorkspaces([app, pc], async () => { throw new Error('读取失败'); }), /读取失败/);
});
