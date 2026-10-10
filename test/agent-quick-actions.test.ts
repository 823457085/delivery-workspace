import assert from 'node:assert/strict';
import test from 'node:test';
import { catchupQuickPrompt, deliveryJobQuickPrompt, interfaceQuickPrompt, jiraQuickPrompt, knowledgeFileQuickPrompt,
  knowledgeMatchQuickPrompt, knowledgeSkillQuickPrompt, mergeQuickPrompt, projectQuickPrompt, workflowQuickPrompt } from '../src/features/agent-workbench/agent-quick-actions.js';
import { agentWorkflowRunAction } from '../src/features/agent-workbench/agent-workflow-actions.js';

test('Agent 快捷动作只写入稳定引用和只读意图', () => {
  assert.equal(jiraQuickPrompt({ key: 'APEX-263' }), '@Jira:APEX-263 请检查该需求的当前实现范围、风险和下一步，先只读分析。');
  assert.match(projectQuickPrompt({ projectId: 'apex-admin' }), /^@项目:apex-admin .*先只读分析。$/);
  assert.match(interfaceQuickPrompt({ page: { id: 'monitoring' } } as Parameters<typeof interfaceQuickPrompt>[0]), /^@接口:monitoring /);
  assert.match(deliveryJobQuickPrompt({ id: 'job-1', issueKey: 'APEX-263' }), /^@Jira:APEX-263 /);
  assert.match(catchupQuickPrompt({ id: 'REQ-027' }), /^@合入:REQ-027 /);
  assert.match(mergeQuickPrompt({ requirementId: 'REQ-027' }), /未经我明确确认不要执行合入/);
  assert.equal(knowledgeFileQuickPrompt('src/app/main.ts'), '@src/app/main.ts 请读取这个文件，并结合当前问题给出结论。');
  assert.equal(knowledgeFileQuickPrompt('docs/API 说明.md'), '@"docs/API 说明.md" 请读取这个文件，并结合当前问题给出结论。');
  assert.equal(knowledgeMatchQuickPrompt({ path: 'src/app/main.ts', line: 27 }), '@src/app/main.ts 请读取这个文件，并结合当前问题给出结论。 重点查看第 27 行附近的内容。');
  assert.equal(knowledgeMatchQuickPrompt({ path: 'src/app/main.ts', line: 27 }, { branch: 'feature/demo', headSha: '1234567890abcdef' }),
    '@src/app/main.ts 请读取这个文件，并结合当前问题给出结论。 重点查看第 27 行附近的内容。 检索版本：feature/demo@1234567890ab。');
  assert.equal(knowledgeSkillQuickPrompt({ invocation: 'hardcode-i18n-scanner' }), '$hardcode-i18n-scanner 请按这个 Skill 处理当前任务。');
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
  assert.equal(prompt, '交付任务 job-1 请检查该交付任务的当前状态、失败原因和下一步，先只读分析。');
});
