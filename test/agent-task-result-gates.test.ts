import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateImplementation, evaluateReview, evaluateVerification, readAgentTaskReport } from '../shared/agent-task-result.js';
import { deliveryAcceptanceInputSchema, deliveryEvidenceSchema, emptyDeliveryEvidence, readDeliveryEvidenceReport } from '../shared/delivery-acceptance.js';
import { planAcceptanceSchema } from '../shared/agent-task-plan.js';

const review = (fields: Record<string, unknown>) => `\`\`\`delivery-report\n${JSON.stringify({
  version: 1, taskResult: { role: 'reviewer', status: 'succeeded', verdict: 'approved', ...fields },
})}\n\`\`\``;

test('模型证据忽略额外build类别和元数据，正式状态原样保留且人工验收仍严格', () => {
  const canonical = emptyDeliveryEvidence();
  for (const item of Object.values(canonical)) item.evidence = '本项仍待单独核验';
  const modelEvidence = { ...canonical, tests: { ...canonical.tests, command: 'npm run build', log: '/fixture/build.log' },
    build: { status: 'passed', evidence: '构建通过', log: '/fixture/build.log', sha: '' }, metadata: { attempt: 1 } };
  const result = (validationEvidence: unknown) => `\`\`\`delivery-report\n${JSON.stringify({ version: 1, validationEvidence, workspacePath: '/fixture/project', taskPlan: null,
    taskResult: { role: 'verifier', status: 'succeeded', acceptance: [{ id: 'AC-1', status: 'passed', evidence: '本次目标已核对' }] },
  })}\n\`\`\``;
  const parsed = readAgentTaskReport(result(modelEvidence));
  assert.equal(parsed.evidenceError, undefined);
  assert.deepEqual(parsed.validationEvidence, canonical);
  assert.equal(parsed.validationEvidence!.tests.status, 'pending', 'build通过不能提升正式tests证据');
  assert.deepEqual(readDeliveryEvidenceReport(result(modelEvidence)), canonical, '交付证据回读使用相同模型边界');
  assert.deepEqual(evaluateVerification(result(modelEvidence), [{ id: 'AC-1' }]), evaluateVerification(result(canonical), [{ id: 'AC-1' }]));
  assert.equal(deliveryEvidenceSchema.safeParse(modelEvidence).success, false);
  const input = { recordId: 'agent:fixture', source: { runId: 'fixture', updatedAt: '2026-11-06T01:00:00Z' },
    checks: canonical, decision: 'pending', summary: '', expectedRevision: 0, authorization: 'record-delivery-acceptance' };
  assert.equal(deliveryAcceptanceInputSchema.safeParse(input).success, true);
  assert.equal(deliveryAcceptanceInputSchema.safeParse({ ...input, checks: modelEvidence }).success, false);
});

test('模型额外证据不能补齐或覆盖无效正式字段，错误定位具体字段', () => {
  const extra = { build: { status: 'passed', evidence: '构建通过', sha: '', log: '/fixture/build.log' } };
  const canonical = emptyDeliveryEvidence();
  const cases: [unknown, string][] = [
    [extra, 'validationEvidence.tests'],
    [{ ...canonical, ...extra, tests: undefined }, 'validationEvidence.tests'],
    [{ ...canonical, ...extra, tests: { ...canonical.tests, status: 'unknown' } }, 'validationEvidence.tests.status'],
    [{ ...canonical, ...extra, tests: { status: 'pending', sha: '' } }, 'validationEvidence.tests.evidence'],
    [{ ...canonical, ...extra, browser: { status: 'pending', evidence: '未执行' } }, 'validationEvidence.browser.sha'],
    [{ ...canonical, ...extra, tests: { status: 'passed', evidence: '', sha: '' } }, 'validationEvidence.tests.evidence'],
    [{ ...canonical, ...extra, remote: { status: 'passed', evidence: '回读成功', sha: 'abc1234', log: '/fixture/remote.log' } }, 'validationEvidence.remote.sha'],
    [{ ...canonical, ...extra, deployment: [] }, 'validationEvidence.deployment'],
    [null, 'validationEvidence'],
    [[], 'validationEvidence'],
  ];
  for (const [validationEvidence, field] of cases) {
    const result = `\`\`\`delivery-report\n${JSON.stringify({ version: 1, validationEvidence,
      taskResult: { role: 'verifier', status: 'succeeded', acceptance: [{ id: 'AC-1', status: 'passed', evidence: '业务通过' }] },
    })}\n\`\`\``;
    const parsed = readAgentTaskReport(result);
    assert.equal(parsed.validationEvidence, undefined);
    assert.ok(parsed.evidenceError?.startsWith(`${field} 无效：`), parsed.evidenceError);
    assert.equal(evaluateVerification(result, [{ id: 'AC-1' }]).outcome, 'blocked');
    assert.equal(readDeliveryEvidenceReport(result), undefined);
  }
});

test('额外证据类别明确failed或blocked时保留阻塞，不在投影时丢弃负面证据', () => {
  for (const status of ['failed', 'blocked']) {
    const result = `\`\`\`delivery-report\n${JSON.stringify({ version: 1,
      validationEvidence: { ...emptyDeliveryEvidence(), build: { status, evidence: '构建失败或前置条件未满足', log: '/fixture/build.log' } },
      taskResult: { role: 'verifier', status: 'succeeded', acceptance: [{ id: 'AC-1', status: 'passed', evidence: '原目标通过' }] },
    })}\n\`\`\``;
    const parsed = readAgentTaskReport(result);
    assert.equal(parsed.validationEvidence, undefined);
    assert.match(parsed.evidenceError!, /validationEvidence\.build\.status 无效/);
    assert.ok(parsed.evidenceError!.includes(`回报 ${status}`));
    assert.equal(evaluateVerification(result, [{ id: 'AC-1' }]).outcome, 'blocked');
    assert.equal(readDeliveryEvidenceReport(result), undefined);
  }
});

test('审查批准不能覆盖失败状态或尚未解除的阻塞原因', () => {
  assert.equal(evaluateReview(review({ status: 'failed' })).outcome, 'failed');
  assert.equal(evaluateReview(review({ status: 'blocked' })).outcome, 'blocked');
  const impeded = evaluateReview(review({ blockers: ['无法读取验证日志'] }));
  assert.equal(impeded.outcome, 'blocked');
  assert.match(impeded.reason, /无法读取验证日志/);
  assert.equal(evaluateReview(review({})).outcome, 'passed');
  assert.equal(evaluateReview(review({ blockers: [''] })).outcome, 'passed');
  assert.equal(evaluateReview(review({ verdict: 'changes_requested' })).outcome, 'failed');
  assert.equal(evaluateReview(review({ verdict: 'blocked' })).outcome, 'blocked');
});

test('部分验收兼容为未完成，不能误报缺少任务结果或绕过验证', () => {
  const taskResult = { role: 'implementer', status: 'succeeded', summary: '时间展示已实现，页面检查未完成',
    acceptance: [{ id: 'AC-4', status: 'partial', evidence: '静态检查通过，浏览器未运行' }],
    selfTests: [{ command: 'tsc --noEmit', exitCode: 0 }] };
  const result = (fields: object) => `\`\`\`delivery-report\n${JSON.stringify({ version: 1, ...fields })}\n\`\`\``;
  const implementation = result({ taskResult });
  assert.deepEqual(readAgentTaskReport(implementation).taskResult.acceptance,
    [{ ...taskResult.acceptance[0], status: 'not_run' }]);
  assert.equal(evaluateImplementation(implementation, [], true, []).outcome, 'passed');
  assert.equal(evaluateImplementation(implementation, [], false, [], [{ id: 'AC-4' }]).outcome, 'blocked');
  const verification = result({ taskResult: { ...taskResult, role: 'verifier' },
    validationEvidence: { ...emptyDeliveryEvidence(), tests: { status: 'passed', evidence: '静态检查通过', sha: '' } } });
  const checked = evaluateVerification(verification, [{ id: 'AC-4' }]);
  assert.equal(checked.outcome, 'blocked');
  assert.match(checked.reason, /AC-4（not_run）/);
  const invalid = result({ taskResult: { ...taskResult, acceptance: [{ id: 'AC-4', status: 'almost_done' }] } });
  assert.throws(() => readAgentTaskReport(invalid), /taskResult\.acceptance\[0\]\.status/);
  assert.equal(evaluateImplementation(invalid, [], true, []).outcome, 'blocked');
});

const stagedCriteria = [
  { id: 'AC-1', text: '年利率回归通过', stage: 'verify' as const },
  { id: 'AC-3', text: '对最终候选完成独立复审', stage: 'review' as const },
];
const stagedVerification = (reviewStatus = 'not_run', testStatus = 'passed', extra: object = {}) => `\`\`\`delivery-report\n${JSON.stringify({
  version: 1, validationEvidence: { ...emptyDeliveryEvidence(), tests: { status: 'passed', evidence: '50项回归通过', sha: '' } },
  taskResult: { role: 'verifier', status: 'succeeded', acceptance: [
    { id: 'AC-1', status: testStatus, evidence: '年利率往返测试通过' },
    { id: 'AC-3', status: reviewStatus, evidence: '交接材料可读取，正式reviewer复审尚未执行' },
  ], ...extra },
})}\n\`\`\``;

test('明确归属审查的未执行项不再与验证相互等待，历史计划仍保守处理', () => {
  assert.equal(evaluateVerification(stagedVerification(), stagedCriteria).outcome, 'passed');
  const legacy = stagedCriteria.map(({ stage: _stage, ...item }) => item);
  const checked = evaluateVerification(stagedVerification(), legacy);
  assert.equal(checked.outcome, 'blocked');
  assert.match(checked.reason, /AC-3（not_run）.*对最终候选完成独立复审/);
  assert.match(checked.reason, /正式reviewer复审尚未执行/);
  assert.equal(planAcceptanceSchema.parse({ ...stagedCriteria[1], source: '用户' }).stage, 'review');
  assert.equal(planAcceptanceSchema.safeParse({ ...stagedCriteria[1], source: '用户', stage: 'skip' }).success, false);
});

test('审查阶段标记不掩盖失败、真实阻塞、未完成业务测试和未知验收项', () => {
  assert.equal(evaluateVerification(stagedVerification('failed'), stagedCriteria).outcome, 'failed');
  assert.equal(evaluateVerification(stagedVerification('blocked'), stagedCriteria).outcome, 'blocked');
  assert.equal(evaluateVerification(stagedVerification('not_run', 'not_run'), stagedCriteria).outcome, 'blocked');
  assert.equal(evaluateVerification(stagedVerification('not_run', 'passed', { status: 'blocked', blockers: ['日志不可读取'] }), stagedCriteria).outcome, 'blocked');
  assert.equal(evaluateVerification(stagedVerification(), [stagedCriteria[0]]).outcome, 'blocked', '未知的not_run不能忽略');
  assert.equal(evaluateVerification(stagedVerification(), [...stagedCriteria, { id: 'AC-4' }]).outcome, 'blocked', '验证项不能缺失');
});

test('复审必须提供阶段验收证据，批准措辞和不适用均不能绕过', () => {
  const acceptance = (status: string, evidence = '独立读取最终diff、归档日志和利率回归') => [{ id: 'AC-3', status, evidence }];
  assert.equal(evaluateReview(review({}), stagedCriteria).outcome, 'blocked');
  for (const status of ['not_run', 'blocked', 'not_applicable']) {
    assert.equal(evaluateReview(review({ acceptance: acceptance(status) }), stagedCriteria).outcome, 'blocked');
  }
  assert.equal(evaluateReview(review({ acceptance: acceptance('failed') }), stagedCriteria).outcome, 'failed');
  assert.equal(evaluateReview(review({ acceptance: acceptance('passed', '') }), stagedCriteria).outcome, 'blocked');
  assert.equal(evaluateReview(review({ acceptance: acceptance('passed') }), stagedCriteria).outcome, 'passed');
});

test('无需代码改动的实现可以等待复审，但必须已有验证阶段证据与自测', () => {
  const report = readAgentTaskReport(stagedVerification());
  const implementation = (fields: object) => `\`\`\`delivery-report\n${JSON.stringify({ version: 1,
    taskResult: { ...report.taskResult, role: 'implementer', summary: '候选已满足代码要求', selfTests: [{ command: 'pnpm test', exitCode: 0 }], ...fields },
  })}\n\`\`\``;
  assert.equal(evaluateImplementation(implementation({}), [], false, [], stagedCriteria).outcome, 'passed');
  assert.equal(evaluateImplementation(implementation({ selfTests: [] }), [], false, [], stagedCriteria).outcome, 'blocked');
  assert.equal(evaluateImplementation(implementation({}), [], false, [], [{ id: 'missing' }]).outcome, 'blocked');
});

const additionalGateReport = (acceptance: object[] = [
  { id: 'AC-1', status: 'passed', evidence: '已确认范围的回归通过' },
  { id: 'AC-3', status: 'not_run', evidence: '等待独立审查' },
  { id: 'EXTRA-1', status: 'failed', evidence: 'L0001 原始失败输出' },
], extra: object = {}) => `\`\`\`delivery-report\n${JSON.stringify({ version: 1,
  validationEvidence: { ...emptyDeliveryEvidence(), tests: { status: 'failed', evidence: '附加脚本退出码1', sha: '' } },
  taskResult: { role: 'verifier', status: 'failed', summary: '确认范围通过，附加检查失败', blockers: ['附加检查需负责人核对'], acceptance },
  ...extra,
})}\n\`\`\``;

test('已确认验收全部通过而附加门禁失败时保留证据并要求诊断，不直接返工', () => {
  const outcome = evaluateVerification(additionalGateReport(), stagedCriteria);
  assert.equal(outcome.outcome, 'blocked'); assert.equal(outcome.requiresDiagnosis, true);
  assert.deepEqual(outcome.failedCriteria, [{ id: 'EXTRA-1', status: 'failed', evidence: 'L0001 原始失败输出' }]);
  for (const text of ['计划内验证项已通过', '确认范围通过，附加检查失败', '附加检查需负责人核对', 'L0001 原始失败输出']) assert.ok(outcome.reason.includes(text));
  const withoutReview = evaluateVerification(additionalGateReport([
    { id: 'AC-1', status: 'passed', evidence: '原验收回归通过' },
    { id: 'EXTRA-1', status: 'failed', evidence: '附加失败' },
  ]), stagedCriteria);
  assert.equal(withoutReview.outcome, 'blocked'); assert.equal(withoutReview.requiresDiagnosis, true, '省略后续审查项不影响验证阶段完整性');
});

test('计划验收已通过但仅汇总测试失败时也先诊断，不依赖额外失败ID', () => {
  const acceptance = [
    { id: 'AC-1', status: 'passed', evidence: '构建通过，改动仅四处类型注解' },
    { id: 'AC-3', status: 'not_run', evidence: '等待独立审查' },
  ];
  for (const status of ['succeeded', 'failed', 'blocked']) {
    const outcome = evaluateVerification(additionalGateReport(acceptance, {
      taskResult: { role: 'verifier', status, acceptance, blockers: [] },
    }), stagedCriteria);
    assert.equal(outcome.outcome, 'blocked'); assert.equal(outcome.requiresDiagnosis, true);
    assert.deepEqual(outcome.failedCriteria, [{ id: 'tests', status: 'failed', evidence: '附加脚本退出码1' }]);
    assert.match(outcome.reason, /附加脚本退出码1/);
  }
  const incomplete = [
    [], acceptance.filter(item => item.id !== 'AC-1'),
    acceptance.map(item => item.id === 'AC-1' ? { ...item, evidence: '' } : item),
    acceptance.map(item => item.id === 'AC-1' ? { ...item, status: 'not_run' } : item),
    [...acceptance, { ...acceptance[0] }],
  ];
  for (const items of incomplete) {
    const outcome = evaluateVerification(additionalGateReport(items), stagedCriteria);
    assert.equal(outcome.outcome, 'blocked'); assert.equal(outcome.requiresDiagnosis, undefined);
  }
  const noEvidence = evaluateVerification(additionalGateReport(acceptance, {
    validationEvidence: { ...emptyDeliveryEvidence(), tests: { status: 'failed', evidence: '', sha: '' } },
  }), stagedCriteria);
  assert.equal(noEvidence.outcome, 'blocked'); assert.equal(noEvidence.requiresDiagnosis, undefined);
  const actualFailure = evaluateVerification(additionalGateReport(acceptance.map(item => item.id === 'AC-1'
    ? { ...item, status: 'failed', evidence: '构建仍有TS7006' } : item)), stagedCriteria);
  assert.equal(actualFailure.outcome, 'failed'); assert.equal(actualFailure.requiresDiagnosis, undefined);
});

test('附加门禁诊断不能掩盖计划内失败，缺项、空证据与未完成状态不能进入诊断分支', () => {
  const accepted = [
    { id: 'AC-1', status: 'passed', evidence: '已验证' },
    { id: 'AC-3', status: 'not_run', evidence: '等待独立审查' },
    { id: 'EXTRA-1', status: 'failed', evidence: '附加失败' },
  ];
  for (const id of ['AC-1', 'AC-3']) {
    const outcome = evaluateVerification(additionalGateReport(accepted.map(item => item.id === id ? { ...item, status: 'failed' } : item)), stagedCriteria);
    assert.equal(outcome.outcome, 'failed'); assert.equal(outcome.requiresDiagnosis, undefined);
  }
  const invalid = [
    accepted.filter(item => item.id !== 'AC-1'),
    accepted.map(item => item.id === 'AC-1' ? { ...item, evidence: '' } : item),
    accepted.map(item => item.id === 'EXTRA-1' ? { ...item, evidence: '' } : item),
    ...['blocked', 'not_run', 'not_applicable'].map(status => accepted.map(item => item.id === 'AC-1' ? { ...item, status } : item)),
    accepted.map(item => item.id === 'AC-3' ? { ...item, status: 'blocked' } : item),
    [...accepted, { id: 'EXTRA-2', status: 'not_run', evidence: '尚未运行' }],
    [...accepted, { id: 'AC-1', status: 'passed', evidence: '重复条目' }],
  ];
  for (const acceptance of invalid) {
    const outcome = evaluateVerification(additionalGateReport(acceptance), stagedCriteria);
    assert.equal(outcome.outcome, 'blocked'); assert.equal(outcome.requiresDiagnosis, undefined);
  }
  for (const [result, criteria] of [
    [additionalGateReport(), []],
    [additionalGateReport(), [stagedCriteria[1]]],
    [additionalGateReport(undefined, { validationEvidence: {} }), stagedCriteria],
  ] as const) {
    const outcome = evaluateVerification(result, [...criteria]);
    assert.equal(outcome.outcome, 'blocked'); assert.equal(outcome.requiresDiagnosis, undefined);
  }
});
