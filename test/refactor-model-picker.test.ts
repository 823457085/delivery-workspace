import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { computed, effectScope, nextTick, reactive, watch } from 'vue';

test('重构入口切换相同模型ID的执行器时，清掉新执行器不支持的原生强度', async () => {
  const source = readFileSync(new URL('../src/features/refactor-control/RefactorLaunchDialog.vue', import.meta.url), 'utf8')
    .match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
  const tree = ts.createSourceFile('RefactorLaunchDialog.ts', source, ts.ScriptTarget.Latest, true);
  const watcher = tree.statements.find(node => ts.isExpressionStatement(node) && node.getText(tree).startsWith('watch([() => form.provider, () => form.model]'))!;
  const code = ts.transpileModule(watcher.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const form = reactive({ provider: 'codex', model: 'shared-model', reasoningEffort: 'high' });
  const model = computed(() => form.provider === 'codex'
    ? { id: 'shared-model', efforts: ['low', 'high'], defaultEffort: 'low' }
    : { id: 'shared-model' });
  const scope = effectScope();
  try {
    scope.run(() => new Function('watch', 'form', 'model', code)(watch, form, model));
    form.provider = 'antigravity';
    await nextTick();
    assert.equal(form.model, 'shared-model');
    assert.equal(form.reasoningEffort, '');
  } finally { scope.stop(); }
});
