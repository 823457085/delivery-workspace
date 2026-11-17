import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

test('工作区会话发送不再依赖已移走的分支查询，附件等待仍阻止发送', () => {
  const source = readFileSync(new URL('../src/features/agent-workbench/AgentNewConversation.vue', import.meta.url), 'utf8').match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
  const tree = ts.createSourceFile('AgentNewConversation.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const node = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'submit')!;
  const code = ts.transpileModule(node.getText(tree), {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const props = {canStart:true, attachmentDraft:{pending:true}};
  let sends=0;
  const submit = new Function('props','emit',`${code}\nreturn submit;`)(props,()=>sends++);
  submit();assert.equal(sends,0);
  props.attachmentDraft.pending=false;submit();assert.equal(sends,1);
  props.canStart=false;submit();assert.equal(sends,1);
});
