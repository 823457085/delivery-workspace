import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { computed, effectScope, reactive, ref, watch } from 'vue';

function fixture(selected = ['/repo/web']) {
  const source = readFileSync(new URL('../src/features/jira-dev/JiraDevProjectPicker.vue', import.meta.url), 'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1];
  const tree = ts.createSourceFile('picker.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const code = ts.transpileModule(tree.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(tree)).join('\n'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const props = reactive({ open: true, selected, candidates: [{ name: 'web', path: '/repo/web' }, { name: 'bff', path: '/repo/bff' }] });
  const emitted: { event: string; paths?: string[] }[] = [], warnings: string[] = [];
  let selection: { workspacePath: string } | null = null;
  const dependencies = { computed, ref, watch, defineProps: () => props,
    defineEmits: () => (event: string, paths?: string[]) => emitted.push({ event, paths }),
    useWorkspacePicker: () => ({ choose: async () => selection, error: ref('') }),
    ElMessage: { warning: (message: string) => warnings.push(message), error: () => {} } };
  const scope = effectScope();
  const state = scope.run(() => new Function(...Object.keys(dependencies), `${code}\nreturn {draft,search,options,browse,confirm};`)(...Object.values(dependencies)));
  return { state, props, emitted, warnings, choose: (path: string | null) => { selection = path ? { workspacePath: path } : null; }, close: () => scope.stop() };
}

test('项目多选窗口搜索不丢失已选项目，确认前不修改表单并回传完整选择', () => {
  const t = fixture();
  try {
    t.state.search.value = 'bff';
    assert.deepEqual(t.state.options.value.map((item: any) => item.path), ['/repo/bff']);
    t.state.draft.value.push('/repo/bff');
    assert.deepEqual([...t.props.selected], ['/repo/web']);
    assert.deepEqual(t.emitted, []);
    t.state.confirm();
    assert.deepEqual(t.emitted, [{ event: 'select', paths: ['/repo/web', '/repo/bff'] }, { event: 'close', paths: undefined }]);
    t.state.draft.value.pop();
    assert.equal(t.emitted[0].paths?.length, 2);
  } finally { t.close(); }
});

test('补充文件夹保留既有选择、去重、支持未扫描目录，并守住十项目上限与关闭边界', async () => {
  const t = fixture();
  try {
    t.choose('/repo/other');
    await t.state.browse();
    assert.deepEqual([...t.state.draft.value], ['/repo/web', '/repo/other']);
    assert.ok(t.state.options.value.some((item: any) => item.path === '/repo/other'));
    await t.state.browse();
    assert.equal(t.state.draft.value.length, 2);
    t.choose(null);
    await t.state.browse();
    assert.equal(t.state.draft.value.length, 2);
    t.state.draft.value = Array.from({ length: 10 }, (_, index) => `/repo/${index}`);
    t.choose('/repo/eleventh');
    await t.state.browse();
    assert.equal(t.state.draft.value.length, 10);
    assert.equal(t.warnings.length, 1);
    t.props.open = false;
    t.state.draft.value = [];
    await t.state.browse();
    assert.equal(t.state.draft.value.length, 0);
    assert.deepEqual(t.emitted, []);
  } finally { t.close(); }
});
