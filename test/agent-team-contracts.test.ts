import test from 'node:test';
import assert from 'node:assert/strict';
import { canConfirmTeamPlan, ownershipPatternsOverlap, readTaskPlan, taskPlanSchema, technicalDesignSchema,
  requirementBriefSchema, transformSpecSchema, validatePlanOwnership } from '../shared/agent-task-plan.js';
import { defaultTeamProfileConfig, profileConfigSchema, teamModelChoiceSchema, teamRoleMetadata, canRetryTeamReviewWithCodex, type TeamTask } from '../shared/agent-team.js';
import { assertPlanRepairScope } from '../server/agent-team-coordinator.js';

const plan = () => ({ templateId: 'engineering', reason: '后端修复', risk: 'low',
  acceptanceCriteria: [{ id: 'AC-1', text: '返回正确计算', source: '用户原话' }], allowedPaths: ['server/**'], needsAnalyst: false,
  needsArchitect: false, questions: [], risks: [], ownership: [], shared: [] });

test('计划格式修复保留阻断问题，兼容问题上多余的to但不能删除、改写或取消阻断', () => {
  const original = { ...plan(), questions: [{ id: 'Q-1', text: '请确认查询范围', blocking: true, to: 'user' }] };
  const corrected = taskPlanSchema.parse({ ...original, questions: [{ id: 'Q-1', text: '请确认查询范围', blocking: true }] });
  assert.doesNotThrow(() => assertPlanRepairScope(original, corrected));
  for (const questions of [[], [{ ...corrected.questions[0], blocking: false }], [{ ...corrected.questions[0], text: '已确认查询范围' }]]) {
    assert.throws(() => assertPlanRepairScope(original, { ...corrected, questions }), /阻断问题/);
  }
  const missingId = { ...original, questions: [{ text: '请确认查询范围', blocking: true, to: 'user' }] };
  assert.doesNotThrow(() => assertPlanRepairScope(missingId, corrected));
  assert.throws(() => assertPlanRepairScope(missingId, { ...corrected, questions: [] }), /阻断问题/);
});

test('计划格式修复保留真实验收、来源与审查阶段，仅允许调整明确推断的额外审查', () => {
  const criteria = [
    { id: 'AC-1', text: '读取当前代码并提供证据', source: '用户原话', stage: 'verify' },
    { id: 'AC-2', text: '独立复核证据', source: '用户原话：要求独立复核', stage: 'review' },
  ];
  const original = { ...plan(), templateId: 'diagnosis', acceptanceCriteria: criteria };
  const corrected = taskPlanSchema.parse({ ...original, templateId: 'verification' });
  assert.doesNotThrow(() => assertPlanRepairScope(original, corrected));
  assert.throws(() => assertPlanRepairScope(original, { ...corrected, acceptanceCriteria: corrected.acceptanceCriteria.slice(0, 1) }), /原验收要求/);
  assert.throws(() => assertPlanRepairScope(original, { ...corrected, acceptanceCriteria: corrected.acceptanceCriteria.map(item => ({ ...item, stage: 'verify' })) }), /原验收要求/);
  assert.throws(() => assertPlanRepairScope(original, { ...corrected, acceptanceCriteria: corrected.acceptanceCriteria.map(item => ({ ...item, source: '推断' })) }), /原验收要求/);
  const inferred = { ...original, acceptanceCriteria: [criteria[0], { ...criteria[1], source: '推断：模型额外安排审查' }] };
  const diagnosis = taskPlanSchema.parse({ ...inferred, acceptanceCriteria: [criteria[0]] });
  assert.doesNotThrow(() => assertPlanRepairScope(inferred, diagnosis));
  assert.doesNotThrow(() => assertPlanRepairScope(inferred, { ...diagnosis, acceptanceCriteria: [diagnosis.acceptanceCriteria[0], { ...corrected.acceptanceCriteria[1], source: '推断：模型额外安排审查', stage: 'verify' }] }));
  assert.throws(() => assertPlanRepairScope({ ...original, acceptanceCriteria: [{ text: '保留可读要求', source: '用户原话', stage: 'invalid' }] }, diagnosis), /原验收要求/);
});

test('计划格式修复不改变合法路径、文件归属或共享范围，也不将只读流程改为实现', () => {
  const original = { ...plan(), templateId: 'diagnosis', allowedPaths: ['server/**'],
    ownership: [{ owner: 'engineer', paths: ['server/**'] }], shared: [{ path: 'server/contract.ts', owner: 'engineer', consumers: ['frontend'] }],
    acceptanceCriteria: [{ id: 'AC-1', text: '独立核对证据', source: '用户原话', stage: 'review' }] };
  const corrected = taskPlanSchema.parse({ ...original, templateId: 'verification' });
  assert.doesNotThrow(() => assertPlanRepairScope(original, corrected));
  assert.throws(() => assertPlanRepairScope(original, { ...corrected, allowedPaths: [] }), /allowedPaths/);
  assert.throws(() => assertPlanRepairScope(original, { ...corrected, allowedPaths: ['**'] }), /allowedPaths/);
  assert.throws(() => assertPlanRepairScope(original, { ...corrected, ownership: [] }), /ownership/);
  assert.throws(() => assertPlanRepairScope(original, { ...corrected, shared: [] }), /shared/);
  assert.throws(() => assertPlanRepairScope(original, { ...corrected, templateId: 'engineering' }), /原执行模板/);
});

test('Codex 审查恢复入口允许等待计划中的历史受阻审查，不恢复旧候选或已关闭任务', () => {
  const task: Pick<TeamTask, 'state' | 'round' | 'nodes'> = { state: 'blocked', round: 1, nodes: [{
    id: 'review-1', stage: 'review', profileId: 'reviewer', status: 'blocked', dependencies: [], attempt: 1, round: 1, createdAt: '', updatedAt: '',
  }] };
  assert.equal(canRetryTeamReviewWithCodex(task), true);
  assert.equal(canRetryTeamReviewWithCodex({ ...task, state: 'awaiting_plan', round: 2 }), true);
  assert.equal(canRetryTeamReviewWithCodex({ ...task, round: 2, nodes: [...task.nodes, { ...task.nodes[0], id: 'new-review', round: 2, status: 'completed' }] }), false);
  for (const state of ['cancelled', 'taken_over', 'accepted', 'running', 'awaiting_acceptance'] as const) {
    assert.equal(canRetryTeamReviewWithCodex({ ...task, state }), false);
  }
  assert.equal(canRetryTeamReviewWithCodex(task, { ...task.nodes[0], stage: 'implement' }), false);
  assert.equal(canRetryTeamReviewWithCodex(undefined), false);
});

test('计划严格校验来源、唯一标识、相对路径与阻断问题，不从普通文字当作计划', () => {
  const value = taskPlanSchema.parse(plan());
  assert.equal(canConfirmTeamPlan(value), true);
  assert.equal(canConfirmTeamPlan({ ...value, questions: [{ id: 'Q-1', text: '业务范围？', blocking: true }] }), false);
  for (const mutate of [
    (v: ReturnType<typeof plan>) => { (v.acceptanceCriteria[0] as { source?: string }).source = undefined; },
    (v: ReturnType<typeof plan>) => { v.acceptanceCriteria.push({ ...v.acceptanceCriteria[0] }); },
    (v: ReturnType<typeof plan>) => { v.allowedPaths = ['../secret']; },
    (v: ReturnType<typeof plan>) => { v.allowedPaths = ['\\\\server\\share']; },
    (v: ReturnType<typeof plan>) => { v.allowedPaths = ['C:relative']; },
  ]) {
    const value = plan(); mutate(value);
    assert.equal(taskPlanSchema.safeParse(value).success, false);
  }
  assert.equal(taskPlanSchema.safeParse({ ...plan(), model: 'auto' }).success, false);
  assert.throws(() => readTaskPlan('我已计划完成'), /delivery-report/);
  assert.deepEqual(readTaskPlan(`\`\`\`delivery-report\n${JSON.stringify({ version: 1, taskPlan: plan() })}\n\`\`\``), value);
  const legacyPlan = { ...plan(), questions: [{ to: 'user', text: '项目目录？', blocking: true }] };
  assert.equal(taskPlanSchema.safeParse(legacyPlan).success, false);
  assert.deepEqual(readTaskPlan(`\`\`\`delivery-report\n${JSON.stringify({ version: 1, taskPlan: legacyPlan })}\n\`\`\``).questions,
    [{ id: 'Q-1', text: '项目目录？', blocking: true }]);
});

test('并行文件归属拒绝重叠或缺失负责人，批量规则保留例外与机器残留检查', () => {
  assert.equal(ownershipPatternsOverlap('src/**', 'src/components/**'), true);
  assert.equal(ownershipPatternsOverlap('src/**/*.vue', 'src/**/*.ts'), false);
  assert.equal(ownershipPatternsOverlap('server/**', 'src/**'), false);
  const ownership = [{ owner: 'engineer', paths: ['server/**', 'shared/**'] }, { owner: 'frontend', paths: ['src/**'] }];
  const value = { ...plan(), templateId: 'complex_delivery_parallel', ownership,
    shared: [{ path: 'shared/contract.ts', owner: 'engineer', consumers: ['frontend'] }] };
  assert.equal(taskPlanSchema.safeParse(value).success, true);
  assert.equal(taskPlanSchema.safeParse({ ...value, ownership: [{ owner: 'engineer', paths: ['src/**'] }, ownership[1]] }).success, false);
  assert.equal(taskPlanSchema.safeParse({ ...value, ownership: ownership.slice(0, 1) }).success, false);
  assert.ok(validatePlanOwnership({ ownership, shared: [{ path: 'shared/contract.ts', owner: 'frontend', consumers: ['engineer'] }] }).length);
  assert.equal(taskPlanSchema.safeParse({ ...plan(), templateId: 'batch' }).success, false);
  assert.equal(transformSpecSchema.safeParse({ rule: '替换旧API', examples: [{ before: 'old(', after: 'new(' }], include: ['src/**'],
    exclude: ['src/legacy/**'], knownExceptions: ['src/legacy/a.ts'], checks: ['npm test'], residual: { kind: 'literal', pattern: 'old(' } }).success, true);
  assert.equal(transformSpecSchema.safeParse({ rule: '规则', examples: [{ before: 'a', after: 'b' }], include: ['src/**'],
    residual: { kind: 'regex', pattern: '[' } }).success, false);
});

test('资料事实必须带来源，设计任务与共享文件严格声明，岗位权限和审查路由不能被编辑绕过', () => {
  assert.equal(requirementBriefSchema.safeParse({ facts: [{ text: '没有来源' }], inferences: [], gaps: [], acceptanceCriteria: [], sources: [] }).success, false);
  assert.equal(technicalDesignSchema.safeParse({ decisions: [], contracts: [], tasks: [{ id: 'T-1', profileId: 'engineer', summary: '修复',
    paths: ['server/**'], dependsOn: [], acceptanceIds: ['AC-1'] }], sharedFiles: [], risks: [], rollback: [] }).success, true);
  const config = defaultTeamProfileConfig();
  assert.equal(config.profiles.length, 10);
  assert.equal(config.options.autoStartLowRisk, false);
  assert.equal(config.profiles.find(item => item.id === 'verifier')?.mode, 'agent');
  for (const effort of ['', 'unsupported']) {
    const bad = structuredClone(config); (bad.profiles[0] as { reasoningEffort: string }).reasoningEffort = effort;
    assert.equal(profileConfigSchema.safeParse(bad).success, false);
  }
  for (const effort of ['max', 'ultra'] as const) {
    const supported = structuredClone(config); supported.profiles[0].reasoningEffort = effort;
    assert.equal(profileConfigSchema.safeParse(supported).success, true);
    assert.equal(teamModelChoiceSchema.safeParse({ provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: effort }).success, true);
  }
  assert.equal(teamModelChoiceSchema.safeParse({ provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: '' }).success, false);
  assert.equal(teamModelChoiceSchema.safeParse({ provider: 'cursor', model: 'composer-2.5', reasoningEffort: '' }).success, true);
  assert.ok(config.profiles.every(profile => profile.mode === 'agent' && profile.accessMode === 'full'));
  const readOnlyLeader = structuredClone(config); readOnlyLeader.profiles[0].mode = 'ask';
  assert.equal(profileConfigSchema.safeParse(readOnlyLeader).success, false);
  const restrictedProfile = structuredClone(config); restrictedProfile.profiles[0].accessMode = 'workspace';
  assert.equal(profileConfigSchema.safeParse(restrictedProfile).success, false, '岗位默认完全访问，任务可显式选择工作区权限');
  const duplicate = structuredClone(config); duplicate.profiles[1] = { ...duplicate.profiles[0] };
  assert.equal(profileConfigSchema.safeParse(duplicate).success, false);
  const selfReview = structuredClone(config); selfReview.reviewRouting.codex = { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high' };
  assert.equal(profileConfigSchema.safeParse(selfReview).success, false);
  Object.assign(selfReview.profiles.find(item => item.id === 'reviewer')!, selfReview.reviewRouting.codex);
  assert.equal(profileConfigSchema.safeParse(selfReview).success, true, '允许独立 Codex 审查，岗位与路由仍须一致');
  const ignoredReviewerChange = structuredClone(config); ignoredReviewerChange.profiles.find(item => item.id === 'reviewer')!.model = 'different';
  assert.equal(profileConfigSchema.safeParse(ignoredReviewerChange).success, false);
  assert.equal(teamRoleMetadata.reporter.mode, 'agent');
});
