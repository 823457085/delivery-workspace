import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldPrioritizeSkillMentions } from '../src/features/agent-workbench/useAgentMentions.js';

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
