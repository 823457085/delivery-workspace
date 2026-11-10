/** 验证报告只提供待核对事实；格式或证据不合规时不能推断通过，也不能破坏原业务报告。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyDeliveryEvidence, readDeliveryEvidenceReport, type DeliveryEvidence } from '../shared/delivery-acceptance.js';
import { emptyRequirementProgress, readRequirementProgressReport } from '../shared/requirement-development.js';
import { readJiraHandoffReport } from '../shared/jira-fix-handoff.js';

const report = (value: unknown) => `本轮结果\n\n\`\`\`delivery-report\n${JSON.stringify(value)}\n\`\`\``;
const checks = (): DeliveryEvidence => ({ ...emptyDeliveryEvidence(),
  tests: { status: 'passed', evidence: 'pnpm test：8/8；outputs/test.log；业务后端未验证', sha: '' },
  browser: { status: 'failed', evidence: '保存按钮无响应；outputs/browser.png', sha: '' },
  remote: { status: 'passed', evidence: 'git ls-remote origin feature/test 回读一致', sha: 'a'.repeat(40) },
  deployment: { status: 'pending', evidence: '没有部署授权，未执行部署', sha: '' },
});

test('验证事实独立读取，保留失败、未验证范围、日志截图和完整远端 SHA', () => {
  const value = { version: 1, validationEvidence: checks() };
  assert.deepEqual(readDeliveryEvidenceReport(report(value)), checks());
  assert.deepEqual(readDeliveryEvidenceReport(report({ ...value, requirementProgress: emptyRequirementProgress() })), checks());
  assert.deepEqual(readDeliveryEvidenceReport(report({ ...value, decision: 'accepted' })), checks(), '模型的验收结论不会覆盖验证事实');
  assert.deepEqual(readDeliveryEvidenceReport(report({ ...value, taskPlan: { templateId: 'engineering', steps: ['核验远端'], questions: [] },
    taskResult: { role: 'verifier', status: 'succeeded' } })), checks(), '同一报告的任务计划不能使有效验证证据丢失');
  const notApplicable = checks(); notApplicable.deployment = { status: 'not_applicable', evidence: '仅本地文档修正，不涉及部署', sha: '' };
  assert.equal(readDeliveryEvidenceReport(report({ ...value, validationEvidence: notApplicable }))?.deployment.status, 'not_applicable');
});

test('缺失或歧义报告、无证据通过、无理由不适用和短 SHA 均不预填', () => {
  const valid = { version: 1, validationEvidence: checks() };
  for (const invalid of [
    { version: 1 }, { ...valid, version: 2 },
    { ...valid, validationEvidence: { ...checks(), browser: undefined } },
    { ...valid, validationEvidence: { ...checks(), tests: { status: 'passed', evidence: '', sha: '' } } },
    { ...valid, validationEvidence: { ...checks(), tests: { status: 'not_applicable', evidence: '', sha: '' } } },
    { ...valid, validationEvidence: { ...checks(), remote: { ...checks().remote, sha: 'abc123' } } },
    { ...valid, validationEvidence: { ...checks(), tests: { ...checks().tests, evidence: 'x'.repeat(6001) } } },
  ]) assert.equal(readDeliveryEvidenceReport(report(invalid)), undefined);
  const block = report(valid);
  for (const invalid of ['测试通过', `${block}\n${block}`, block.slice(0, -3),
    '```delivery-report\n{invalid}\n```', block.split('\n').map(line => `> ${line}`).join('\n'),
    `\`\`\`\`markdown\n${block}\n\`\`\`\``]) assert.equal(readDeliveryEvidenceReport(invalid), undefined);
});

test('新旧报告均兼容进度和交接；坏验证字段只禁预填，不阻断合法业务数据', () => {
  const progress = emptyRequirementProgress();
  const handoff = { cause: '缺少边界校验', impact: '编辑表单', suggestion: '回归空值', conclusion: '测试通过，业务联调未验证' };
  for (const extra of [{}, { validationEvidence: checks() }, { validationEvidence: { status: 'passed' } }]) {
    assert.deepEqual(readRequirementProgressReport(report({ version: 1, requirementProgress: progress, ...extra })), progress);
    assert.deepEqual(readJiraHandoffReport(report({ version: 1, jiraHandoff: handoff, ...extra })), handoff);
  }
  assert.equal(readDeliveryEvidenceReport(report({ version: 1, jiraHandoff: handoff, validationEvidence: { status: 'passed' } })), undefined);
  assert.throws(() => readRequirementProgressReport(report({ version: 1, requirementProgress: progress, authorization: 'publish' })));
  assert.throws(() => readJiraHandoffReport(report({ version: 1, jiraHandoff: handoff, authorization: 'publish' })));
});
