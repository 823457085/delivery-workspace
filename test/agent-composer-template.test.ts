import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse } from 'vue/compiler-sfc';

function template(name: string) {
  const { descriptor, errors } = parse(fs.readFileSync(new URL(`../src/features/agent-workbench/${name}.vue`, import.meta.url), 'utf8'));
  assert.deepEqual(errors, []);
  return descriptor.template!.ast!;
}

function elements(node: any, tag: string): any[] {
  return [...(node.tag === tag ? [node] : []), ...(node.children || []).flatMap((child: any) => elements(child, tag))];
}

test('会话与新建页各自只有一个输入框，回复提示不重复挂载', () => {
  for (const name of ['AgentComposer', 'AgentNewConversation']) {
    assert.equal(elements(template(name), 'AgentPromptEditor').length, 1, `${name} must not mount competing draft editors`);
  }
  const composer = template('AgentComposer');
  const replies = elements(composer, 'div').filter(node => node.props.some((prop: any) => prop.name === 'class' && prop.value?.content === 'composer-reply'));
  assert.equal(replies.length, 1);
  assert.equal(elements(composer, 'AgentComposerPreflightBar').length, 1);
});

test('插件事项只在输入工具栏提供一个入口，不生成额外的未定位网格项', () => {
  const editor = template('AgentPromptEditor');
  const pickers = elements(editor, 'PluginContextPicker');
  assert.equal(pickers.length, 1);
  const toolbar = elements(editor, 'div').find(node => node.props.some((prop: any) => prop.name === 'class' && prop.value?.content === 'prompt-tools'));
  assert.ok(toolbar);
  assert.equal(elements(toolbar, 'PluginContextPicker')[0], pickers[0]);
});
