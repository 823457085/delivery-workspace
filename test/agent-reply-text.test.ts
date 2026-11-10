import test from 'node:test';
import assert from 'node:assert/strict';
import { agentReplyText } from '../src/features/agent-workbench/execution-summary';

test('普通回复显示原始conversationReply.text，不把协议JSON当正文', () => {
  const text = '已只查本地。\n\n| 仓库 | 状态 |\n|---|---|\n| test | L020 |\n';
  const result = '```delivery-report\n' + JSON.stringify({ version: 1, conversationReply: { text, resumeWorkflow: false } }) + '\n```';
  assert.equal(agentReplyText(result), text);
  for (const original of ['普通回复 L020', result.slice(0, -3), result + '\n' + result,
    '```delivery-report\n' + JSON.stringify({ version: 1, taskPlan: { reason: '保留原报告' } }) + '\n```',
    '```delivery-report\n' + JSON.stringify({ version: 1, conversationReply: { text: '回答' }, questions: [{ text: '待确认' }] }) + '\n```']) {
    assert.equal(agentReplyText(original), original);
  }
});
