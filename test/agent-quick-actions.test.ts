import assert from 'node:assert/strict';
import test from 'node:test';
import { catchupQuickPrompt, deliveryJobQuickPrompt, interfaceQuickPrompt, jiraQuickPrompt, knowledgeFileQuickPrompt,
  knowledgeMatchQuickPrompt, knowledgeSkillQuickPrompt, mergeQuickPrompt, workflowQuickPrompt } from '../src/features/agent-workbench/agent-quick-actions.js';
import { agentWorkflowRunAction } from '../src/features/agent-workbench/agent-workflow-actions.js';

test('业务草稿用自然中文保留任务标识和只查看的意图', () => {
  assert.match(jiraQuickPrompt({ key: 'APEX-263' }), /Jira 事项 APEX-263.*先只查看/);
  const page = { id: 'monitoring', title: '监控', menu: '运营', routes: [], operations: [] };
  assert.match(interfaceQuickPrompt({ page }), /「监控」[\s\S]*接口页编号：monitoring/);
  assert.match(deliveryJobQuickPrompt({ id: 'job-1', issueKey: 'APEX-263' }), /Jira 事项 APEX-263.*先只查看/);
  assert.match(catchupQuickPrompt({ id: 'REQ-027' }, 'APEX-263'), /追平任务 REQ-027（Jira APEX-263）.*先只查看/);
  assert.match(mergeQuickPrompt({ requirementId: 'REQ-027' }), /未经我明确确认不要执行合入/);
  assert.match(knowledgeFileQuickPrompt('src/app/main.ts'), /^@src\/app\/main\.ts\n/);
  assert.match(knowledgeFileQuickPrompt('docs/API 说明.md'), /^@"docs\/API 说明\.md"\n/);
  assert.match(knowledgeMatchQuickPrompt({ path: 'src/app/main.ts', line: 27 }), /第 27 行/);
  assert.match(knowledgeMatchQuickPrompt({ path: 'src/app/main.ts', line: 27 }, { branch: 'feature/demo', headSha: '1234567890abcdef' }),
    /检索时的版本：feature\/demo，提交 1234567890ab/);
  assert.match(knowledgeSkillQuickPrompt({ invocation: 'hardcode-i18n-scanner' }), /^\$hardcode-i18n-scanner\n/);
  assert.match(workflowQuickPrompt({ runId: 'run-1', requirement: { id: 'REQ-027' }, status: 'suspended' } as Parameters<typeof workflowQuickPrompt>[0]), /未经我确认不要执行外部写操作/);
});

test('Agent 工作流动作只映射 Mastra 暂停门禁', () => {
  assert.deepEqual(agentWorkflowRunAction({ status: 'suspended', gate: { kind: 'review', title: '', reason: '' } }),
    { kind: 'resume', value: 'approve', label: '批准继续' });
  assert.deepEqual(agentWorkflowRunAction({ status: 'suspended', gate: { kind: 'evidence', title: '', reason: '' } }),
    { kind: 'resume', value: 'retest', label: '补测继续' });
  assert.deepEqual(agentWorkflowRunAction({ status: 'suspended', gate: { kind: 'conflict', title: '', reason: '' } }),
    { kind: 'rework', label: '重新预演' });
  assert.equal(agentWorkflowRunAction({ status: 'running', gate: null }), null);
});

test('Agent 快捷动作不把外部标题或结果当成会话指令', () => {
  const prompt = deliveryJobQuickPrompt({ id: 'job-1', issueKey: '' });
  assert.match(prompt, /交付任务 job-1.*先只查看/);
});
