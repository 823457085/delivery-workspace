import test from 'node:test';
import assert from 'node:assert/strict';
import { teamDeliveryMessage } from '../server/agent-team-delivery.js';
import { defaultTeamProfileConfig, type TeamTask, type TeamNode } from '../shared/agent-team.js';
import { emptyDeliveryEvidence } from '../shared/delivery-acceptance.js';

const now = '2026-10-30T08:00:00.000Z';
const report = (value: object) => `\`\`\`delivery-report\n${JSON.stringify({ version: 1, ...value })}\n\`\`\``;
const node = (stage: TeamNode['stage'], value: object, extra: Partial<TeamNode> = {}): TeamNode => ({
  id: stage, profileId: stage === 'implement' ? 'engineer' : stage === 'review' ? 'reviewer' : 'verifier', stage,
  status: 'completed', dependencies: [], attempt: 1, round: 0, createdAt: now, updatedAt: now, runId: `${stage}-run`, result: report(value), ...extra,
});
function task(): TeamTask & { candidateEvidenceAt?: string } {
  return { id: 'task', parentConversationId: 'chat', sourceWorkspacePath: '/project', workspacePath: '/candidate',
    objective: '修复排序', attachmentIds: [], profileConfig: defaultTeamProfileConfig(), state: 'completed', round: 0, maxRounds: 2,
    planRevision: 1, createdAt: now, updatedAt: now, candidateEvidenceAt: now, interactionMode: 'chat',
    chat: { messages: [], pendingInputs: [], workspaceBound: true },
    plan: { templateId: 'engineering', reason: '用户要求', risk: 'low', acceptanceCriteria: [{ id: 'AC-1', text: '排序符合要求', source: '用户' }],
      allowedPaths: [], needsAnalyst: false, needsArchitect: false, questions: [], risks: [], ownership: [], shared: [] },
    nodes: [node('implement', { taskResult: { role: 'implementer', status: 'succeeded', summary: '已修复排序。' } }),
      node('verify', { taskResult: { role: 'verifier', status: 'succeeded', summary: '定向测试通过', acceptance: [{ id: 'AC-1', status: 'passed', evidence: '3 个排序场景通过' }] },
        validationEvidence: { ...emptyDeliveryEvidence(), tests: { status: 'passed', evidence: '运行排序测试：3 项通过', sha: '' } } }),
      node('review', { taskResult: { role: 'reviewer', status: 'succeeded', verdict: 'approved', summary: '核对完成' } })],
  };
}

test('统一收尾保留实际证据与候选位置，不把定向测试冒充浏览器和远端验收', () => {
  const summary = teamDeliveryMessage(task())!;
  assert.equal(summary.kind, 'delivery');
  assert.match(summary.text, /已修复排序/);
  assert.match(summary.text, /成果位置：\/candidate/);
  assert.match(summary.text, /3 个排序场景通过/);
  assert.match(summary.text, /测试 \/ 检查：通过。运行排序测试：3 项通过/);
  assert.match(summary.text, /浏览器验证：未验证/);
  assert.match(summary.text, /远端提交：未验证/);
  assert.match(summary.text, /部署验证：未验证/);
  assert.doesNotMatch(summary.text, /人工验收通过/);
});

test('状态回读时间变化不重复交付消息，真实证据重跑得到新的交付标识', () => {
  const value = task(), first = teamDeliveryMessage(value)!;
  value.candidateEvidenceAt = '2026-10-30T08:10:00.000Z';
  assert.equal(teamDeliveryMessage(value)!.id, first.id);
  value.nodes[1].attempt += 1; value.nodes[1].runId = 'reverified';
  assert.notEqual(teamDeliveryMessage(value)!.id, first.id);
});

test('仅核对构建的交付保留build证据并优先展示，不把未运行测试写成通过', () => {
  const value = task();
  value.plan!.templateId = 'verification';
  value.nodes = value.nodes.filter(item => item.stage !== 'implement');
  value.nodes[0].result = report({ taskResult: { role: 'verifier', status: 'succeeded',
    summary: '等待审查', acceptance: [{ id: 'AC-1', status: 'passed', evidence: '原目录构建通过' }] },
    validationEvidence: { ...emptyDeliveryEvidence(), build: { status: 'passed', evidence: '原目录 pnpm build 退出码 0，dist/index.html 存在。',
      log: '.delivery-artifacts/build.log', sha: 'a'.repeat(64) } } });
  const summary = teamDeliveryMessage(value)!;
  assert.match(summary.text, /^构建检查已通过，独立审查已完成。/);
  assert.match(summary.text, /验证情况：\n- 构建：通过。原目录 pnpm build 退出码 0/);
  assert.match(summary.text, /测试 \/ 检查：未验证/);
  assert.doesNotMatch(summary.text, /测试 \/ 检查：通过|等待审查/);
});

test('未完成、审查阻塞或只有旧轮结果时不生成完成汇总', () => {
  const value = task();
  value.state = 'blocked'; assert.equal(teamDeliveryMessage(value), undefined);
  value.state = 'completed'; value.candidateEvidenceAt = undefined; assert.equal(teamDeliveryMessage(value), undefined);
  value.candidateEvidenceAt = now;
  value.nodes[2].result = report({ taskResult: { role: 'reviewer', status: 'blocked', verdict: 'blocked', blockers: ['缺少上下文'] } });
  assert.equal(teamDeliveryMessage(value), undefined);
  value.nodes[2] = task().nodes[2]; value.round = 1;
  assert.equal(teamDeliveryMessage(value), undefined);
});

test('诊断交付说明未修复并列出未核实范围，不借用旧轮实施摘要', () => {
  const value = task();
  value.nodes = [node('diagnose', {}, { profileId: 'engineer' }), { ...value.nodes[0], round: -1 }];
  value.diagnosis = { summary: '排序使用了旧字段', rootCause: '字段映射错误', evidence: ['src/order.ts'], unverified: ['真实接口响应'], suggestions: ['核对后修正字段'] };
  const summary = teamDeliveryMessage(value)!;
  assert.match(summary.text, /排序使用了旧字段/);
  assert.match(summary.text, /未据此认定修复或验证通过/);
  assert.match(summary.text, /尚未核实：\n- 真实接口响应/);
  assert.doesNotMatch(summary.text, /已修复排序/);
});

test('审查阶段验收取独立复审证据，不能重复展示验证时的未执行或提前完成', () => {
  const value = task();
  value.plan!.acceptanceCriteria.push({ id: 'AC-3', text: '完成正式复审', source: '用户', stage: 'review' });
  value.nodes[1].result = report({ taskResult: { role: 'verifier', status: 'succeeded', acceptance: [
    { id: 'AC-1', status: 'passed', evidence: '回归通过' }, { id: 'AC-3', status: 'not_run', evidence: '等待正式复审' },
  ] }, validationEvidence: emptyDeliveryEvidence() });
  assert.equal(teamDeliveryMessage(value), undefined, '批准但遗漏审查验收不能生成完成消息');
  value.nodes[2].result = report({ taskResult: { role: 'reviewer', status: 'succeeded', verdict: 'approved',
    acceptance: [{ id: 'AC-3', status: 'passed', evidence: '已独立核对候选与修复日志' }] } });
  const summary = teamDeliveryMessage(value)!;
  assert.match(summary.text, /完成正式复审：通过。已独立核对候选与修复日志/);
  assert.doesNotMatch(summary.text, /等待正式复审|完成正式复审：未执行/);
});

test('完成汇报使用最终状态，不把验证时等待审查的阶段文字继续当作结论', () => {
  const value = task();
  value.plan!.templateId = 'verification';
  value.nodes = value.nodes.filter(item => item.stage !== 'implement');
  value.nodes[0].result = report({ taskResult: { role: 'verifier', status: 'succeeded',
    summary: '测试已通过，正式独立审查尚待派发，整体交付尚不能宣称完成。',
    acceptance: [{ id: 'AC-1', status: 'passed', evidence: '隔离副本检查通过；未在原目录作为 cwd 执行构建。' }] },
    validationEvidence: { ...emptyDeliveryEvidence(), tests: { status: 'passed', evidence: '定向检查 7 项通过', sha: '' } } });
  const summary = teamDeliveryMessage(value)!;
  assert.match(summary.text, /^本轮验证与独立审查均已通过。/);
  assert.match(summary.text, /定向检查 7 项通过/);
  assert.match(summary.text, /独立审查：1 项通过/);
  assert.doesNotMatch(summary.text, /尚待派发|尚不能宣称完成/);
  assert.match(summary.text, /隔离副本检查通过；未在原目录作为 cwd 执行构建。/, '具体执行位置与证据边界不能省略');
  assert.match(value.nodes[0].result!, /尚待派发/, '历史原始证据仍保留原文');
});
