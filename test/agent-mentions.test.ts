import confluence from '../plugins/confluence/frontend.js';
import { integrationCatalog } from '../shared/integration-plugins.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { effectScope, nextTick, shallowRef } from 'vue';
import { shouldPrioritizeSkillMentions, useAgentMentions } from '../src/features/agent-workbench/useAgentMentions.js';

test('@apex 有 Skill 命中时优先展示 Skills', () => {
  assert.equal(shouldPrioritizeSkillMentions('apex'), true);
  assert.equal(shouldPrioritizeSkillMentions('hardcode'), true);
  assert.equal(shouldPrioritizeSkillMentions(''), false);
});

test('明确业务查询仍优先展示 Jira 和业务上下文', () => {
  assert.equal(shouldPrioritizeSkillMentions('jira'), false);
  assert.equal(shouldPrioritizeSkillMentions('项目:apex'), false);
  assert.equal(shouldPrioritizeSkillMentions('接口'), false);
  assert.equal(shouldPrioritizeSkillMentions('合入:REQ-008'), false);
  assert.equal(shouldPrioritizeSkillMentions('APEX-263'), false);
  assert.equal(shouldPrioritizeSkillMentions('REQ-CU-021'), false);
  assert.equal(shouldPrioritizeSkillMentions('文档:技术方案'), false);
  assert.equal(shouldPrioritizeSkillMentions('confluence:需求'), false);
});

test('明确文档查询使用当前工作区范围，选择后写入可由后端解析的 Confluence 引用', async () => {
  const original = globalThis.fetch;
  const requests: string[] = [];
  const reference = 'confluence:https%3A%2F%2Fdocs.example.test/42';
  globalThis.fetch = async input => {
    requests.push(String(input));
    return Response.json({ pages: [{ reference, title: '接口 L001', spaceKey: 'SOP', version: 3 }] });
  };
  const scope = effectScope();
  const draft = shallowRef('');
  const mentions = scope.run(() => useAgentMentions(draft, () => ({ workspacePath: '/selected-project', provider: 'codex', modes: [] }), () => false, () => {}, shallowRef([{...integrationCatalog.find(item => item.id === 'confluence')!.mention!, search: confluence.mentions}])) )!;
  try {
    draft.value = '@文档:接口';
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 220));
    assert.equal(requests.length, 1);
    const params = new URL(requests[0], 'http://localhost').searchParams;
    assert.equal(params.get('workspacePath'), '/selected-project');
    assert.equal(params.get('q'), '接口');
    assert.equal(mentions.options.value[0].label, '接口 L001');
    mentions.select(mentions.options.value[0]);
    assert.equal(draft.value, `@${reference} `);
  } finally { scope.stop(); globalThis.fetch = original; }
});

test('输入法确认键不选中 @ 候选，合成结束后的 Enter 仍正常选择', async () => {
  const scope = effectScope();
  const draft = shallowRef('');
  const selected: string[] = [];
  const mentions = scope.run(() => useAgentMentions(draft, () => ({ workspacePath: '', provider: 'codex',
    modes: ['agent', 'ask'], selectedMode: 'agent' }), () => false, mode => selected.push(mode), shallowRef([])))!;
  try {
    draft.value = '@';
    await nextTick();
    for (const input of [{ isComposing: true, keyCode: 13 }, { isComposing: false, keyCode: 229 }]) {
      let prevented = false;
      const event = { key: 'Enter', ...input, preventDefault() { prevented = true; } } as KeyboardEvent;
      assert.equal(mentions.handleKeydown(event), false);
      assert.equal(prevented, false);
      assert.equal(draft.value, '@');
      assert.deepEqual(selected, []);
    }
    assert.equal(mentions.handleKeydown({ key: 'Enter', isComposing: false, keyCode: 13, preventDefault() {} } as KeyboardEvent), true);
    assert.deepEqual(selected, ['agent']);
    assert.equal(draft.value, '');
  } finally { scope.stop(); }
});
