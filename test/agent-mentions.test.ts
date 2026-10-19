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
});

test('输入法确认键不选中 @ 候选，合成结束后的 Enter 仍正常选择', async () => {
  const scope = effectScope();
  const draft = shallowRef('');
  const selected: string[] = [];
  const mentions = scope.run(() => useAgentMentions(draft, () => ({ workspacePath: '', provider: 'codex',
    modes: ['agent', 'ask'], selectedMode: 'agent' }), () => false, mode => selected.push(mode)))!;
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
