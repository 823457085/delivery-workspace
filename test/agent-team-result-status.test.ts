import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRun } from '../shared/agent-runtime';
import type { TeamNode } from '../shared/agent-team';
import { emptyDeliveryEvidence } from '../shared/delivery-acceptance';
import { agentRunStatus } from '../src/features/agent-workbench/conversation';
import { summarizeRunExecution } from '../src/features/agent-workbench/execution-summary';
import { readableTeamReason, teamCheckStatus, teamNodeCheckStatus, teamRoundFeedback, teamRunCheckStatus, type TeamResultContext } from '../src/features/agent-workbench/team-result-status';

const at = '2026-11-06T06:00:00Z';
const criteria = [{ id: 'AC-1', text: '保留接口返回原文 L020', stage: 'verify' as const }];
function report(role: 'verifier' | 'reviewer' = 'verifier', overrides: Record<string, unknown> = {}, evidenceOverrides: Record<string, unknown> = {}) {
  return '```delivery-report\n' + JSON.stringify({ version: 1, taskResult: { role, status: 'succeeded', summary: '原始汇报 L020',
    acceptance: [{ id: 'AC-1', status: 'passed', evidence: '已核对 L020 原文' }], selfTests: [], findings: [], blockers: [],
    ...(role === 'reviewer' ? { verdict: 'approved' } : {}), ...overrides },
  validationEvidence: { ...emptyDeliveryEvidence(), tests: { status: 'passed', evidence: '定向检查通过', sha: '' }, ...evidenceOverrides } }) + '\n```';
}
function run(source = report(), overrides: Partial<AgentRun> = {}): AgentRun {
  return { id: 'run-current', provider: 'codex', mode: 'agent', accessMode: 'workspace', model: 'test', reasoningEffort: '', objective: '检查',
    workspacePath: '/fixture', branch: '', headSha: '', status: 'completed', resultReady: true, sessionId: '', pid: null,
    result: source, error: '', events: [], createdAt: at, updatedAt: at,
    team: { taskId: 'task', nodeId: 'verify', profileId: 'verifier', stageKey: 'task:verify:1', profileRevision: 1 }, ...overrides };
}
function node(overrides: Partial<TeamNode> = {}): TeamNode {
  return { id: 'verify', stage: 'verify', profileId: 'verifier', status: 'completed', dependencies: [], attempt: 1, round: 0,
    runId: 'run-current', result: report(), createdAt: at, updatedAt: at, ...overrides };
}
function context(nodes = [node()]): TeamResultContext {
  return { id: 'task', nodes, plan: { acceptanceCriteria: criteria } as TeamResultContext['plan'] };
}

test('运行正常退出仍保留截图场景的附加门禁失败和原文证据', () => {
  const source = report('verifier', { status: 'failed', summary: '原验收项已通过；额外全量门禁失败 L020',
    acceptance: [{ id: 'AC-1', status: 'passed', evidence: '定向验证通过' }, { id: 'GATE-TEST', status: 'failed', evidence: 'pnpm test：2 项失败，影响待诊断' }],
    selfTests: [{ command: 'pnpm test', exitCode: 1 }] }, { tests: { status: 'failed', evidence: '全量门禁有失败，未证明由本次修改引入', sha: '' } });
  const value = run(source), before = structuredClone(value);
  const status = summarizeRunExecution(value, Date.now(), context())[0];
  assert.equal(status.title, '运行已结束 · 验证未通过'); assert.equal(status.tone, 'danger');
  assert.match(status.detail, /原验收项已通过；额外全量门禁失败 L020/);
  assert.match(status.detail, /pnpm test：2 项失败，影响待诊断/); assert.doesNotMatch(status.detail, /\{"|delivery-report/);
  assert.equal(agentRunStatus(value).value, 'failed'); assert.deepEqual(value, before);
});

test('报告通过、验收项失败、真实受阻与缺少报告分别呈现', () => {
  assert.equal(teamRunCheckStatus(run(), context())?.label, '验证通过');
  assert.equal(teamRunCheckStatus(run(report('verifier', { acceptance: [{ id: 'AC-1', status: 'failed', evidence: 'L033 原始失败原因' }] })), context())?.label, '验证未通过');
  const extraGate = run(report('verifier', { status: 'failed', acceptance: [{ id: 'AC-1', status: 'passed', evidence: '原标准通过' },
    { id: 'GATE-EXTRA', status: 'failed', evidence: '附加门禁未通过 L099' }], selfTests: [{ command: 'targeted test', exitCode: 0 }] }));
  assert.equal(teamRunCheckStatus(extraGate, context())?.label, '验证未通过');
  assert.match(teamRunCheckStatus(extraGate, context())?.detail || '', /附加门禁未通过 L099/);
  const blocked = teamRunCheckStatus(run(report('verifier', { status: 'blocked', blockers: ['测试账号登录受阻 L045'] })), context());
  assert.equal(blocked?.label, '验证受阻'); assert.match(blocked?.detail || '', /测试账号登录受阻 L045/);
  for (const source of ['', '文字自称验证通过', '```delivery-report\n{"taskResult":']) {
    const value = teamRunCheckStatus(run(source), context());
    assert.equal(value?.label, '验证结果待核对'); assert.equal(value?.tone, 'muted');
  }
  assert.equal(teamRunCheckStatus(run(report('verifier', {}, { tests: { status: 'pending', evidence: '', sha: '' } })), context())?.value, 'unknown');
  assert.equal(teamRunCheckStatus(run(report('verifier', { acceptance: [{ id: 'AC-1', status: 'passed', evidence: '' }] })), context())?.value, 'unknown');
});

test('流式报告、结果保存与重启恢复不提前覆盖运行状态', () => {
  const source = report('verifier', { status: 'failed' });
  for (const state of ['running', 'queued'] as const) {
    const value = run(source, { status: state });
    assert.equal(teamRunCheckStatus(value, context()), undefined);
    assert.doesNotMatch(summarizeRunExecution(value)[0].title, /验证未通过|验证通过/);
  }
  const saving = run(source, { resultReady: false });
  assert.equal(teamRunCheckStatus(saving, context()), undefined);
  assert.equal(summarizeRunExecution(saving)[0].title, '正在保存结果');
  assert.equal(agentRunStatus(saving).label, '正在保存结果');
  const restarting = run(source, { pausedForEdit: true, resumeAfterWorkspaceRestart: true });
  assert.equal(teamRunCheckStatus(restarting, context()), undefined);
  assert.equal(summarizeRunExecution(restarting)[0].title, '会话已暂停');
});

test('日志详情与运行列表使用同一计划，合法等待审查的验收项不误标验证受阻', () => {
  const value = run(report('verifier', { acceptance: [{ id: 'AC-1', status: 'passed', evidence: '原验证证据' },
    { id: 'AC-REVIEW', status: 'not_run', evidence: '等待独立审查' }] }));
  const task = context();
  task.plan!.acceptanceCriteria = [...criteria, { id: 'AC-REVIEW', text: '独立审查', stage: 'review' }];
  assert.equal(summarizeRunExecution(value, Date.now(), task)[0].title, '运行已结束 · 验证通过');
  assert.equal(agentRunStatus(value, task).label, '运行已结束 · 验证通过');
  assert.notEqual(agentRunStatus(value).value, 'passed');
});

test('本次空报告不得使用节点旧报告或旧备用运行冒充结果', () => {
  const stale = node({ result: report('verifier', { status: 'failed' }) }), fresh = run('');
  assert.equal(teamNodeCheckStatus(stale, fresh, context([stale]))?.value, 'unknown');
  assert.equal(teamNodeCheckStatus(stale, run(report(), { id: 'old-fallback' }), context([stale])), undefined);
  assert.equal(teamNodeCheckStatus({ ...stale, status: 'running' }, run(), context([stale])), undefined);
});

test('审查按 verdict 和验收结论判定，普通 leader 回复不当作验证', () => {
  assert.equal(teamCheckStatus('reviewer', report('reviewer'), [])?.label, '审查通过');
  const rejected = teamCheckStatus('reviewer', report('reviewer', { verdict: 'changes_requested', findings: [{ id: 'F1', severity: 'major', file: 'a.vue', line: 2, problem: 'L034 原文问题', expectation: '原文建议' }] }));
  assert.equal(rejected?.label, '审查未通过'); assert.match(rejected?.detail || '', /L034 原文问题/);
  assert.equal(teamCheckStatus('reviewer', report('reviewer', { verdict: 'blocked', blockers: ['缺少候选版本'] }))?.label, '审查受阻');
  assert.equal(teamCheckStatus('reviewer', '已审查通过')?.value, 'unknown');
  const leader = run(report(), { team: { taskId: 'task', nodeId: 'leader', profileId: 'leader', stageKey: 'plan', profileRevision: 1 } });
  assert.equal(teamRunCheckStatus(leader), undefined);
  assert.equal(summarizeRunExecution(leader)[0].title, '已回复');
  assert.equal(summarizeRunExecution(leader)[0].tone, 'muted');
});

test('返工原因取独立字段原文，旧原因被覆盖时只标上一轮未通过结论', () => {
  const original = JSON.stringify({ reason: 'L020 接口结果不一致', findings: [{ file: 'a.vue', problem: '返回什么就展示什么', expectation: '保留 L 码' }] });
  assert.equal(readableTeamReason(original), 'L020 接口结果不一致\na.vue；返回什么就展示什么；保留 L 码');
  const rework = { ...node({ id: 'fix', stage: 'implement', profileId: 'engineer', round: 1, reason: '问题已回答，按原文继续' }), reworkReason: original };
  const task = { ...context([rework]), round: 1 };
  assert.equal(teamRoundFeedback(task)?.label, '返工原因'); assert.match(teamRoundFeedback(task)?.text || '', /L020 接口结果不一致/);
  const previous = node({ result: report('verifier', { status: 'failed', summary: '原验收项通过，全量门禁未通过' }, { tests: { status: 'failed', evidence: 'GATE-TEST 原始门禁证据', sha: '' } }) });
  const oldTask = { ...context([previous, node({ id: 'fix', stage: 'implement', profileId: 'engineer', round: 1, status: 'running', reason: '问题已回答，按原文继续' })]), round: 1 };
  const feedback = teamRoundFeedback(oldTask);
  assert.equal(feedback?.label, '上一轮未通过结论'); assert.match(feedback?.text || '', /GATE-TEST 原始门禁证据/);
  assert.doesNotMatch(feedback?.text || '', /问题已回答|\{"/);
  assert.equal(teamRoundFeedback({ ...context([node({ round: 1, status: 'running', reason: '用户重新计划' })]), round: 1 }), undefined);
});

test('新计划不能把历史通过改判失败，缺历史计划保持待核对', () => {
  const oldNode = node(), oldRun = run(), task = { ...context([oldNode]), round: 1 };
  task.plan!.acceptanceCriteria = [...criteria, { id: 'AC-NEW', text: '后来新增的验收项', stage: 'verify' }];
  assert.equal(teamRunCheckStatus(oldRun, task)?.value, 'unknown');
  assert.equal(teamNodeCheckStatus(oldNode, oldRun, task)?.value, 'unknown');
  assert.equal(teamRoundFeedback(task), undefined);
  const historical = { ...task, planHistory: [{ revision: 1, createdAt: '2026-11-06T05:00:00Z', plan: { acceptanceCriteria: criteria } as NonNullable<TeamResultContext['plan']> },
    { revision: 2, createdAt: '2026-11-06T07:00:00Z', plan: task.plan! }] };
  assert.equal(teamRunCheckStatus(oldRun, historical)?.label, '验证通过');
  assert.equal(teamNodeCheckStatus(oldNode, oldRun, historical)?.label, '验证通过');
  assert.equal(teamRoundFeedback(historical), undefined);
});
