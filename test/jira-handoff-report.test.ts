/** 报告只是待确认草稿：缺少验证、普通文本或格式示例不能被推测为交接结果。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readJiraHandoffReport } from '../shared/jira-fix-handoff.js';
import { emptyRequirementProgress, readRequirementProgressReport } from '../shared/requirement-development.js';

const draft = { cause: '空值校验缺失，已补齐', impact: '商品编辑', suggestion: '回归空值和正常保存',
  conclusion: 'pnpm test 通过，证据 outputs/test.log；浏览器和真实后端未验证' };
const report = (value: unknown = { version: 1, jiraHandoff: draft }) => `本轮结果\n\n\`\`\`delivery-report\n${JSON.stringify(value)}\n\`\`\``;

test('单个顶层结构化报告保留四段草稿和未验证说明，不接受发布或验收字段', () => {
  assert.deepEqual(readJiraHandoffReport(report()), draft);
  assert.deepEqual(readJiraHandoffReport(report().replaceAll('\n', '\r\n')), draft);
  for (const value of [
    { version: 1, jiraHandoff: { ...draft, conclusion: '' } },
    { version: 1, jiraHandoff: { ...draft, cause: '【待开发确认】' } },
    { version: 1, jiraHandoff: { ...draft, impact: '长'.repeat(6001) } },
    { version: 1, jiraHandoff: { ...draft, transitionId: '21' } },
    { version: 1, jiraHandoff: draft, accepted: true },
    { version: 2, jiraHandoff: draft },
    { version: 1, requirementProgress: emptyRequirementProgress() },
  ]) assert.throws(() => readJiraHandoffReport(report(value)));
  assert.throws(() => readRequirementProgressReport(report()));
});

test('缺失、重复、不完整、引用和嵌套示例不自动导入', () => {
  const block = report().slice(report().indexOf('```delivery-report'));
  for (const value of [
    '问题原因：已修复；测试通过',
    `${block}\n${block}`,
    block.slice(0, -3),
    '```delivery-report\n{invalid}\n```',
    `格式字符串：${block}`,
    `\`\`\`\`markdown\n${block}\n\`\`\`\``,
    block.split('\n').map(line => `> ${line}`).join('\n'),
    block.split('\n').map(line => `    ${line}`).join('\n'),
    `1. 示例：\n${block.split('\n').map(line => `   ${line}`).join('\n')}`,
  ]) assert.throws(() => readJiraHandoffReport(value), /delivery-report/);
});
