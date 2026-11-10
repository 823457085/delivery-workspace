import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { effectScope, nextTick, shallowRef, watch } from 'vue';

test('切换项目立即清除旧分支，等候查询时不发送，迟到或失败的查询不串用分支', async () => {
  const source = readFileSync(new URL('../src/features/agent-workbench/AgentNewConversation.vue', import.meta.url), 'utf8')
    .match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
  const tree = ts.createSourceFile('AgentNewConversation.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const selected = tree.statements.filter(node => node.getText(tree).startsWith('watch(() => workspacePath.value,')
    || ts.isFunctionDeclaration(node) && node.name?.text === 'submit');
  const code = ts.transpileModule(selected.map(node => node.getText(tree)).join('\n'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const workspacePath = shallowRef('/project-a'), branch = shallowRef('old-branch');
  const branchOptions = shallowRef<string[]>([]), branchesLoading = shallowRef(false);
  const requests: { signal: AbortSignal; resolve: (body: unknown) => void; reject: (error: Error) => void }[] = [];
  const messages: string[] = [];
  let sends = 0;
  const dependencies = { watch, workspacePath, branch, branchOptions, branchesLoading,
    props: { canStart: true }, emit: () => sends++, ElMessage: { error: (message: string) => messages.push(message) },
    fetch: (_url: string, options: { signal: AbortSignal }) => new Promise((resolve, reject) => {
      requests.push({ signal: options.signal, resolve: body => resolve({ ok: true, json: async () => body }), reject });
    }) };
  const scope = effectScope();
  try {
    const submit = scope.run(() => new Function(...Object.keys(dependencies), `${code}\nreturn submit;`)(...Object.values(dependencies)))!;
    assert.equal(branch.value, '');
    assert.equal(branchesLoading.value, true);
    submit(); assert.equal(sends, 0);
    workspacePath.value = '/project-b'; await nextTick();
    assert.equal(requests[0].signal.aborted, true);
    requests[1].resolve({ current: 'branch-b', branches: ['branch-b'] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(branch.value, 'branch-b');
    assert.equal(branchesLoading.value, false);
    submit(); assert.equal(sends, 1);
    requests[0].resolve({ current: 'branch-a', branches: ['branch-a'] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(branch.value, 'branch-b');
    assert.deepEqual(branchOptions.value, ['branch-b']);
    workspacePath.value = '/project-c'; await nextTick();
    assert.equal(branch.value, '');
    submit(); assert.equal(sends, 1);
    requests[2].reject(new Error('分支读取失败'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(branch.value, '');
    assert.equal(branchesLoading.value, false);
    assert.deepEqual(messages, ['分支读取失败']);
    workspacePath.value = ''; await nextTick();
    assert.equal(branch.value, '');
    assert.equal(branchesLoading.value, false);
    submit(); assert.equal(sends, 2);
  } finally { scope.stop(); }
});
