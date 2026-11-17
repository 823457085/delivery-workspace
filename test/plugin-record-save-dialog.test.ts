import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { parse } from 'vue/compiler-sfc';
import { computed, effectScope, nextTick, ref, watch } from 'vue';

// Exercise the actual setup script with real Vue watchers; no DOM or business data writes.
const source = parse(fs.readFileSync(new URL('../src/features/custom-plugins/PluginRecordSaveDialog.vue', import.meta.url), 'utf8')).descriptor.scriptSetup!.content;
const tree = ts.createSourceFile('dialog.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const code = ts.transpileModule(tree.statements.filter(n => !ts.isImportDeclaration(n)).map(n => n.getText(tree)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function plugin(id: string, storage = 'private', grants = ['storage.write'], enabled = true) {
  return { enabled, grants, manifest: { id, name: id, version: '1.0.0', page: { kind: 'records' }, records: { storage, fields: [
    { key: 'title', type: 'text', required: true, maxLength: 160 },
    { key: 'details', type: 'textarea', maxLength: 8000 },
  ] } } };
}
function mount(visible: boolean, initialPluginId = '') {
  const open = ref(visible), scope = effectScope(), requests: { action: string; body?: any }[] = [], emitted: any[] = [];
  let available = [plugin('notes'), plugin('todos', 'workspace.todos', ['workspace.todos.write'])];
  const dependencies = {
    computed, ref, watch, defineProps: () => ({ initialPluginId, initialValues: { title: '会话结论', details: '待确认内容' } }),
    defineModel: () => open, defineEmits: () => (...args: any[]) => emitted.push(args),
    useRouter: () => ({ push() {} }), useQueryClient: () => ({ invalidateQueries: async () => {} }),
    customPluginsQueryKey: ['custom-plugins'], ElMessage: { error(message: string) { throw new Error(message); }, success() {} },
    pluginRequest: async (action = '', body?: any) => {
      requests.push({ action, body });
      if (!action) return { plugins: available };
      if (action.endsWith('/save')) return { id: 'record-1', values: body.values };
      return { items: [] };
    },
  };
  const state = scope.run(() => new Function(...Object.keys(dependencies), `${code}\nreturn { writablePlugins, selectedPluginId, form, loading, submit };`)(...Object.values(dependencies)))!;
  return { open, state, requests, emitted, setAvailable(value: typeof available) { available = value; }, close() { scope.stop(); } };
}
async function settled() { await nextTick(); await new Promise(resolve => setImmediate(resolve)); }

test('首次以打开状态挂载会加载台账并预填，只有确认提交才写入', async () => {
  const view = mount(true, 'todos');
  try {
    await settled();
    assert.equal(view.requests.length, 1);
    assert.equal(view.requests[0].action, '');
    assert.equal(view.state.loading.value, false);
    assert.equal(view.state.selectedPluginId.value, 'todos');
    assert.deepEqual(view.state.form.value, { title: '会话结论', details: '待确认内容' });
    await view.state.submit();
    assert.equal(view.requests[1].action, 'todos/save');
    assert.equal(view.requests[1].body.values.title, '会话结论');
    assert.equal(view.emitted[0][0], 'saved');
    assert.equal(view.open.value, false);
  } finally { view.close(); }
});

test('保持挂载的弹窗关闭时不加载，打开及再次打开均读取当前授权', async () => {
  const view = mount(false);
  try {
    await settled(); assert.equal(view.requests.length, 0);
    view.open.value = true; await settled();
    assert.equal(view.state.writablePlugins.value.length, 2);
    view.open.value = false; await settled();
    view.setAvailable([plugin('notes', 'private', ['storage.read'])]);
    view.open.value = true; await settled();
    assert.equal(view.requests.length, 2);
    assert.equal(view.state.writablePlugins.value.length, 0);
    assert.equal(view.state.selectedPluginId.value, '');
    await view.state.submit(); assert.equal(view.requests.length, 2);
  } finally { view.close(); }
});

test('停用、异常和错误存储域的授权不能成为写入目标', async () => {
  const view = mount(false);
  try {
    view.setAvailable([
      plugin('disabled', 'private', ['storage.write'], false),
      { ...plugin('broken'), error: '校验失败' } as any,
      plugin('wrong-private', 'private', ['workspace.todos.write']),
      plugin('wrong-todos', 'workspace.todos', ['storage.write']),
      plugin('allowed'),
    ]);
    view.open.value = true; await settled();
    assert.deepEqual(view.state.writablePlugins.value.map((p: any) => p.manifest.id), ['allowed']);
  } finally { view.close(); }
});
