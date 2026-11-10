/** 用真实报告聚合与展示函数验证来源、失败边界和历史隔离。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import type { AgentRun } from '../shared/agent-runtime.js';
import type { GroupMember, GroupRoom, GroupTurn } from '../shared/agent-group-chat.js';
import { emptyDeliveryEvidence } from '../shared/delivery-acceptance.js';
import { emptyRequirementProgress } from '../shared/requirement-development.js';
import { groupChatSummaries } from '../src/features/agent-workbench/group-chat-summary.js';
import { groupMemberFeedback, groupSummaryPresentation } from '../src/features/agent-workbench/group-summary-presentation.js';

const at = '2026-11-04T09:00:00.000Z';
const report = (value: object) => '```delivery-report\n' + JSON.stringify({ version: 1, ...value }) + '\n```';
function evidence(tests: 'passed' | 'failed' | 'pending' = 'failed', browser: 'passed' | 'failed' | 'pending' = 'failed', prefix = '原始证据 L123') {
  const value = emptyDeliveryEvidence();
  value.tests = { status: tests, evidence: `${prefix} 测试`, sha: '' };
  value.browser = { status: browser, evidence: `${prefix} 页面`, sha: '' };
  return value;
}
function fixture(items: { id: string; capability: GroupMember['capability']; result?: string }[]) {
  const turns: GroupTurn[] = items.map(item => ({ id: item.id, runId: item.id, member: { id: item.id,
    name: `成员 ${item.id}`, instructions: '原始职责', capability: item.capability, enabled: true },
    attempt: 1, status: 'completed', result: '', error: '', updatedAt: at }));
  const runs: AgentRun[] = items.map(item => ({ id: item.id, provider: 'codex', mode: 'agent', accessMode: 'workspace',
    model: 'fixture', reasoningEffort: '', objective: '原始目标', workspacePath: '/fixture', branch: 'feature/fixture', headSha: 'fixture',
    status: 'completed', sessionId: item.id, pid: null, result: item.result || '', error: '', events: [], createdAt: at, updatedAt: at }));
  const room: GroupRoom = { id: 'room', title: '团队任务', workspacePath: '/fixture', executionPath: '/fixture',
    paused: false, cursorTrustPaths: [], createdAt: at, updatedAt: at, rounds: [{ id: 'round', requestId: 'round', requestHash: 'round',
      text: '用户目标', attachmentIds: [], accessMode: 'workspace', state: 'completed', turns, createdAt: at, updatedAt: at }] };
  return { room, runs, turns, summary: () => groupChatSummaries(room, runs)[0] };
}

test('页面无法连接与自动检查失败分开说明，报告保存成功不冒充业务验证通过', () => {
  const validation = evidence('failed', 'pending');
  validation.browser.evidence = '已访问指定入口，返回 net::ERR_CONNECTION_REFUSED，七项页面验收未执行。';
  const rawSummary = '报告已原子保存并回读，curl退出7，七项业务复测均为not_run，dirty基线已检查。';
  const result = report({ taskResult: { role: 'verifier', status: 'blocked', summary: rawSummary,
    acceptance: [{ id: 'AC-1', status: 'not_run' }, { id: 'AC-10', status: 'passed', evidence: '报告已保存并回读' }],
    blockers: ['指定入口http://127.0.0.1:51083/不可用。', '原文件及完整历史请求归档尚未恢复。'] }, validationEvidence: validation });
  const f = fixture([{ id: 'qa', capability: 'verify', result }]);
  const before = structuredClone({ room: f.room, runs: f.runs });
  const member = f.summary().members[0], feedback = groupMemberFeedback(member)!;
  assert.equal(feedback.title, '业务验证还没完成');
  assert.equal(feedback.statusLabel, '页面未测 · 自动检查未通过');
  assert.match(feedback.checks.find(check => check.title === '页面操作')!.detail, /无法连接.*还没有验证结果/);
  assert.match(feedback.checks.find(check => check.title === '自动检查')!.detail, /未通过/);
  assert.ok(feedback.checks.some(check => check.title === '测试准备'));
  assert.doesNotMatch(JSON.stringify(feedback), /curl|not_run|dirty|原子|51083|ERR_CONNECTION/);
  assert.match(feedback.nextStep, /恢复.*页面.*排查.*自动检查/);
  assert.equal(member.summary, rawSummary);
  assert.equal(member.outcome?.state, 'failed');
  assert.match(groupSummaryPresentation(f.summary()).roleDigests[0].summary, /页面操作：测试页面无法连接/);
  assert.deepEqual({ room: f.room, runs: f.runs }, before);
});

test('仅环境阻塞不显示测试失败，实际验收失败仍明确保留', () => {
  const validation = evidence('passed', 'pending');
  validation.browser.evidence = '浏览器拒绝连接，业务页面未加载。';
  const f = fixture([{ id: 'qa', capability: 'verify', result: report({ validationEvidence: validation,
    taskResult: { role: 'verifier', status: 'blocked', blockers: ['测试页面无法连接。'] } }) }]);
  const feedback = groupMemberFeedback(f.summary().members[0])!;
  assert.equal(feedback.statusLabel, '等待测试环境');
  assert.match(feedback.checks.find(check => check.title === '自动检查')!.detail, /已通过/);
  f.runs[0].result = report({ validationEvidence: validation, taskResult: { role: 'verifier', status: 'blocked',
    acceptance: [{ id: 'AC-1', status: 'failed' }] } });
  const failed = groupMemberFeedback(f.summary().members[0])!;
  assert.equal(failed.statusLabel, '页面未测 · 验收有未通过项');
  assert.ok(failed.checks.some(check => check.title === '验收检查'));
});

test('重试空结果、运行中和已解决的环境故障不复活旧阻塞', () => {
  const validation = evidence('passed', 'pending');
  validation.browser.evidence = '先前 ERR_CONNECTION_REFUSED 已解决。';
  const blocked = report({ validationEvidence: validation, taskResult: { role: 'verifier', status: 'blocked' } });
  const f = fixture([{ id: 'qa', capability: 'verify', result: blocked }]);
  assert.equal(groupMemberFeedback(f.summary().members[0]), undefined);
  validation.browser.status = 'passed';
  f.runs[0].result = report({ validationEvidence: validation, taskResult: { role: 'verifier', status: 'succeeded',
    summary: '首次连接拒绝后已恢复，实际验证已通过。', blockers: ['旧入口不可用'] } });
  assert.equal(groupMemberFeedback(f.summary().members[0]), undefined);
  f.turns[0].result = blocked;
  f.runs[0].result = '';
  f.runs[0].status = 'running';
  assert.equal(groupMemberFeedback(f.summary().members[0]), undefined);
  f.runs[0].result = blocked;
  assert.equal(groupMemberFeedback(f.summary().members[0]), undefined);
});

test('连接探测命令退出非零不冒充自动测试失败，也不解释被否定的环境故障', () => {
  const validation = evidence('pending', 'pending');
  validation.browser.evidence = '测试页面无法连接。';
  const f = fixture([{ id: 'qa', capability: 'verify', result: report({ validationEvidence: validation,
    taskResult: { role: 'verifier', status: 'blocked', selfTests: [{ command: 'curl -I http://127.0.0.1:51083/', exitCode: 7 }] } }) }]);
  const feedback = groupMemberFeedback(f.summary().members[0])!;
  assert.equal(feedback.statusLabel, '页面未测 · 检查未通过');
  assert.match(feedback.checks.find(check => check.title === '自动检查')!.detail, /尚无.*明确结论/);
  assert.ok(feedback.checks.some(check => check.title === '其他检查'));
  validation.browser.evidence = '未发现入口不可用，本轮因其他原因暂停。';
  f.runs[0].result = report({ validationEvidence: validation, taskResult: { role: 'verifier', status: 'blocked' } });
  assert.equal(groupMemberFeedback(f.summary().members[0]), undefined);
});

test('无 taskResult 的需求验证也展示业务结果，技术记录保留原文且不误报登录失效', () => {
  const validation = evidence('failed', 'pending');
  validation.tests.evidence = 'npm run i18n-test退出0；随包校验退出1，产物缺APEX2XCH0009，详见command-results.json。';
  validation.browser.evidence = '已打开国家配置页，表单部分交互已测。随后cgWindowNotFound，The browser access host is unavailable。服务已恢复并保留，最终HTTP 200。';
  const delivery = { goal: '维护国家预授权规则', scenarios: [
    { name: 'AC-1：国家列表表头位置', status: 'passed', evidence: '实测顺序正确，真实记录0/1尚未核实' },
    { name: 'AC-2：新增字段默认值和选项切换', status: 'passed', evidence: '切换正确，未提交新增请求' },
    { name: '编辑回显和保存刷新回读', status: 'blocked', evidence: '浏览器工具中断，未测完' },
    { name: 'AC-4：301000备注和真实扣款边界', status: 'not_run', evidence: '缺少真实活动样本' },
    { name: 'AC-5：i18n-test构建词条完整性', status: 'failed', evidence: '中文产物缺APEX2XCH0009' },
  ], i18n: { status: 'blocked', xlsx: '/fixture/import.xlsx', evidence: '远端资源和构建产物仍缺词条' },
  api: { status: 'blocked', evidence: '无认证请求返回-902，不能证明现有会话过期' }, previews: [], nextStep: '恢复cgWindowNotFound后补齐test/pre词条' };
  const f = fixture([{ id: 'qa', capability: 'verify', result: report({ requirementDelivery: delivery, validationEvidence: validation }) }]);
  f.room.source = { taskId: 'fixture', workflow: 'requirement', title: '需求开发', issueKey: 'OPAY-797', issueUrl: '', projects: [] };
  const before = structuredClone({ room: f.room, runs: f.runs });
  const summary = f.summary(), feedback = groupMemberFeedback(summary.members[0])!;
  assert.match(feedback.checks.find(check => check.title === '已验证')!.detail, /国家列表表头位置.*新增字段默认值/);
  assert.match(feedback.checks.find(check => check.title === '还没验证')!.detail, /打开编辑页面查看内容.*另有1项业务检查/);
  assert.match(feedback.checks.find(check => check.title === '未通过')!.detail, /页面文字尚未准备齐/);
  assert.match(feedback.checks.find(check => check.title === '中断原因')!.detail, /无法操作浏览器窗口/);
  assert.match(feedback.title, /还没完成/);
  assert.doesNotMatch(JSON.stringify(feedback), /退出|\.json|cgWindow|HTTP|APEX2X|i18n|test\/pre|301000|登录.*过期|重新登录/);
  const view = groupSummaryPresentation(summary);
  assert.equal(view.nextStep, feedback.nextStep);
  assert.equal(view.requirement?.checkDetails[0].evidence, validation.tests.evidence);
  assert.deepEqual(view.requirement?.scenarios, delivery.scenarios);
  assert.deepEqual({ room: f.room, runs: f.runs }, before);
});

test('模拟数据通过仍说明真实接口未测，多个失败不被多语言问题覆盖', () => {
  const delivery = { goal: '编辑配置', scenarios: [
    { name: '保存并重新打开', status: 'passed', evidence: '仅用模拟数据验证' },
    { name: '多语言词条', status: 'failed', evidence: '缺少文字' },
    { name: '切换记录后内容错误', status: 'failed', evidence: '出现上一条记录内容' },
  ], i18n: { status: 'blocked', xlsx: '', evidence: '缺少文字' }, api: { status: 'mock_only', evidence: '只测试模拟数据' }, previews: [], nextStep: '' };
  const f = fixture([{ id: 'qa', capability: 'verify', result: report({ requirementDelivery: delivery }) }]);
  const feedback = groupMemberFeedback(f.summary().members[0])!;
  assert.match(feedback.checks.find(check => check.title === '已验证')!.detail, /模拟数据/);
  assert.match(feedback.checks.find(check => check.title === '未通过')!.detail, /页面文字.*切换记录后内容错误/);
  assert.match(feedback.checks.find(check => check.title === '接口验证')!.detail, /真实接口尚未验证/);
  assert.match(feedback.title, /还没完成/);
  f.turns[0].result = f.runs[0].result;
  f.runs[0].result = '';
  f.runs[0].status = 'running';
  assert.equal(groupMemberFeedback(f.summary().members[0]), undefined);
});

test('缺少业务下一步时不把失败日志当作建议，原始验证记录仍保留', () => {
  const progress = emptyRequirementProgress();
  const technical = 'AC-5未通过：npm run i18n-test退出0，构建后消息校验退出1，详见ac-verification.json。';
  progress.stages.verification = { status: 'blocked', evidence: technical };
  const f = fixture([{ id: 'qa', capability: 'verify', result: report({ requirementProgress: progress, validationEvidence: evidence() }) }]);
  f.room.source = { taskId: 'fixture', workflow: 'requirement', title: '需求开发', issueKey: 'OPAY-797', issueUrl: '', projects: [] };
  const view = groupSummaryPresentation(f.summary());
  assert.doesNotMatch(view.nextStep, /AC-5|npm|退出|\.json/);
  assert.match(view.nextStep, /修改|检查/);
  assert.equal(view.requirement?.stages.find(stage => stage.key === 'verification')?.evidence, technical);
});

test('七条重复岗位证据合并为两类检查，保留每个来源及原文，不修改原状态', () => {
  const progress = emptyRequirementProgress();
  progress.stages.verification = { status: 'blocked', evidence: '验证阶段仍有未通过项，原始说明 L101' };
  const f = fixture([
    { id: 'qa', capability: 'verify', result: report({ validationEvidence: evidence('failed', 'failed', '验证原文 L102') }) },
    { id: 'audit', capability: 'review', result: report({ validationEvidence: evidence('failed', 'failed', '引用验证 L103') }) },
    { id: 'reporter', capability: 'read', result: report({ requirementProgress: progress, validationEvidence: evidence('failed', 'failed', '汇总原文 L104') }) },
  ]);
  const summary = f.summary(), before = structuredClone({ room: f.room, runs: f.runs });
  assert.equal(summary.blockers.length, 7);
  const view = groupSummaryPresentation(summary);
  assert.deepEqual(view.checks.map(check => check.kind), ['tests', 'browser']);
  assert.deepEqual(view.checks.map(check => check.sources.length), [3, 3]);
  for (const check of view.checks) {
    assert.equal(check.sources[0].member.run, f.runs[0]);
    assert.deepEqual(check.sources.map(source => source.member.turn.id).sort(), ['audit', 'qa', 'reporter']);
    assert.ok(check.sources.every(source => source.evidence.includes('原文') || source.evidence.includes('引用验证')));
  }
  assert.equal(view.failed.length, 2);
  assert.equal(summary.blockers.length, 7);
  assert.deepEqual({ room: f.room, runs: f.runs }, before);
});

test('后序成员自报通过不能覆盖真实验证失败', () => {
  const f = fixture([
    { id: 'qa', capability: 'verify', result: report({ validationEvidence: evidence('failed', 'passed', '失败原文 L201') }) },
    { id: 'reporter', capability: 'read', result: report({ validationEvidence: evidence('passed', 'passed', '后序通过 L202') }) },
  ]);
  const summary = f.summary(), view = groupSummaryPresentation(summary);
  assert.equal(summary.status, 'blocked');
  assert.equal(view.checks.find(check => check.kind === 'tests')?.status, 'failed');
  assert.match(view.headline, /暂时不能验收/);
  assert.equal(view.checks[0].sources[0].member.run, f.runs[0]);
});

test('当前重试空结果不回退旧 turn.result，不复活旧失败', () => {
  const f = fixture([{ id: 'qa', capability: 'verify' }]);
  f.turns[0].result = report({ validationEvidence: evidence('failed', 'failed', '旧结果 L301') });
  f.runs[0].status = 'running';
  const view = groupSummaryPresentation(f.summary());
  assert.equal(view.checks.length, 0);
  assert.equal(view.findings.length, 0);
  assert.match(view.headline, /还在处理/);
});

test('不纳入自动协作旧轮或已跳过节点的报告', () => {
  const f = fixture([
    { id: 'old-qa', capability: 'verify', result: report({ validationEvidence: evidence('failed', 'failed', '旧轮失败 L401') }) },
    { id: 'qa', capability: 'verify', result: report({ validationEvidence: evidence('passed', 'passed', '本轮通过 L402') }) },
  ]);
  const summary = f.summary();
  summary.members[0].current = false;
  summary.status = 'returned';
  const view = groupSummaryPresentation(summary);
  assert.equal(view.failed.length, 0);
  assert.ok(view.checks.every(check => check.status === 'passed' && check.sources.length === 1));
  assert.ok(view.checks.every(check => check.sources[0].member.turn.id === 'qa'));
});

test('远端与部署未执行不计为失败，也不从已解决的环境错误关键词推断缺陷', () => {
  const checked = evidence('passed', 'passed', '首次缺少 eslint 导致退出 2，修复依赖后重跑退出 0 并通过 L501');
  checked.remote.evidence = '按原任务约束不提交或推送';
  checked.deployment.evidence = '未执行部署';
  const f = fixture([{ id: 'qa', capability: 'verify', result: report({ validationEvidence: checked }) }]);
  const view = groupSummaryPresentation(f.summary());
  assert.equal(view.failed.length, 0);
  assert.deepEqual(view.checks.map(check => check.kind), ['tests', 'browser']);
  assert.ok(view.checks.every(check => check.status === 'passed'));
  assert.doesNotMatch(view.headline, /已完成交付|交付完成|验收通过/);
});

test('无明确验收结论时保持待确认，不因成员运行完成宣称交付成功', () => {
  const f = fixture([{ id: 'member', capability: 'read', result: '成员普通回复 L601' }]);
  const view = groupSummaryPresentation(f.summary());
  assert.match(view.headline, /还需确认/);
  assert.equal(view.checks.length, 0);
  assert.equal(view.findings.length, 0);
});

test('结构化审查问题及建议保留原文与真实来源，同问题引用合并', () => {
  const finding = { id: 'F-1', severity: 'major', file: 'src/a.vue', line: 12,
    problem: '接口返回 L000509 被改写，原始问题 L701', expectation: '原样展示返回字段 L702' };
  const result = report({ taskResult: { role: 'reviewer', status: 'failed', verdict: 'changes_requested', findings: [finding] } });
  const f = fixture([{ id: 'audit', capability: 'review', result }, { id: 'audit-2', capability: 'review', result }]);
  const view = groupSummaryPresentation(f.summary());
  assert.equal(view.findings.length, 1);
  assert.equal(view.findings[0].problem, finding.problem);
  assert.equal(view.findings[0].expectation, finding.expectation);
  assert.deepEqual(view.findings[0].members.map(member => member.run), f.runs);
});

test('前序阻塞而后续成员 pending 时提示处理阻塞，不建议无限等待', () => {
  const f = fixture([{ id: 'qa', capability: 'verify', result: report({ validationEvidence: evidence() }) },
    { id: 'reporter', capability: 'read' }]);
  f.runs[1].status = 'queued';
  f.turns[1].status = 'pending';
  const summary = f.summary();
  assert.equal(summary.status, 'blocked');
  const view = groupSummaryPresentation(summary);
  assert.match(view.headline, /暂时不能验收|还没完成/);
  assert.doesNotMatch(view.nextStep, /等待当前成员完成/);
});


test('真实验证通过不被实现者早期未验证或交付整理未复跑的状态覆盖', () => {
  const f = fixture([
    { id: 'implementer', capability: 'write', result: report({ validationEvidence: evidence('pending', 'pending', '早期未验证 L801') }) },
    { id: 'qa', capability: 'verify', result: report({ validationEvidence: evidence('passed', 'passed', '验证已通过 L802') }) },
    { id: 'reporter', capability: 'read', result: report({ validationEvidence: evidence('pending', 'pending', '整理成员未复跑 L803') }) },
  ]);
  const view = groupSummaryPresentation(f.summary());
  assert.ok(view.checks.every(check => check.status === 'passed'));
  assert.ok(view.checks.every(check => check.sources.length === 3 && check.sources[0].member.run === f.runs[1]));
});


function progressWith(values: { verification?: string; development?: string; design?: string }) {
  const value = emptyRequirementProgress();
  if (values.verification) value.stages.verification = { status: 'blocked', evidence: values.verification };
  if (values.development) value.stages.development = { status: 'in_progress', evidence: values.development };
  if (values.design) value.stages.design = { status: 'in_progress', evidence: values.design };
  return value;
}

test('VMS 明确问题转换为普通话影响和建议，账户隔离保持未确认，不改写原报告', () => {
  const qa = progressWith({ verification: '本轮验证执行完毕，但候选存在接口文案转换、英文回退缺项、灰度直接链接展示和分类分页覆盖问题，需要实现成员处理后复验。' });
  const audit = progressWith({ development: '审查结论为不通过。阻断项：新增词条撞号，导入表含这些 key 会覆盖平台文案；暂拟账户参数 channel/account_type 未经后端确认，可能导致流水和报表混入其他账户数据。',
    design: '审查发现与实际代码不符。' });
  const f = fixture([{ id: 'qa', capability: 'verify', result: report({ requirementProgress: qa, validationEvidence: evidence() }) },
    { id: 'audit', capability: 'review', result: report({ requirementProgress: audit }) }]);
  const before = structuredClone({ room: f.room, runs: f.runs }), view = groupSummaryPresentation(f.summary());
  const byId = new Map(view.issues.map(issue => [issue.id, issue]));
  for (const id of ['original-text', 'missing-translations', 'feature-toggle', 'list-refresh', 'translation-file', 'account-filter', 'design']) {
    assert.ok(byId.has(id), id);
    assert.ok(byId.get(id)!.title && byId.get(id)!.impact && byId.get(id)!.action);
    assert.ok(byId.get(id)!.sources.some(member => f.runs.includes(member.run!)));
  }
  const account = byId.get('account-filter')!;
  assert.match(account.title, /还没有确认/);
  assert.match(account.impact, /不能.*断定/);
  assert.doesNotMatch(account.title + account.action, /已经混|已混账|发生.*混/);
  assert.doesNotMatch(view.issues.map(issue => issue.title).join(''), /本次新增/);
  assert.deepEqual({ room: f.room, runs: f.runs }, before);
});

test('APEX 明确审查问题生成普通话问题、影响与处理建议', () => {
  const audit = progressWith({ development: '审查不通过。必须修改：1）初始状态；2）收单行按名称匹配导致 L 码被替换，未确认的收单行回退为猜测值；3）列表列顺序；4）新模式记录的编辑路径：必填无法保存。',
    design: '方案中写的初始显示与 PRD 和原型不符。' });
  const f = fixture([{ id: 'audit', capability: 'review', result: report({ requirementProgress: audit, validationEvidence: evidence() }) }]);
  const issues = groupSummaryPresentation(f.summary()).issues;
  assert.deepEqual(issues.map(issue => issue.id).sort(), ['original-text', 'initial-state', 'option-matching', 'record-editing', 'column-order', 'design'].sort());
  for (const issue of issues) {
    assert.ok(issue.impact && issue.action);
    assert.equal(issue.sources[0].run, f.runs[0]);
    assert.doesNotMatch(issue.title + issue.impact + issue.action, /payment-account|\.vue|check:ci|mock|L\s*码|PRD|key=/);
  }
});

test('混合验证日志、普通说明和未明确退回的审查阶段，不按关键词生成产品问题', () => {
  const longLog = '首次缺少 eslint，退出 2，之后重跑退出 0；旧报告曾写初始状态、L码被翻译和分类分页覆盖问题，现已验证通过。';
  const qa = progressWith({ verification: longLog });
  const audit = progressWith({ development: '已核对初始状态、列表列顺序，未发现差异。' });
  const f = fixture([{ id: 'qa', capability: 'verify', result: report({ requirementProgress: qa, validationEvidence: evidence('passed', 'passed', longLog) }) },
    { id: 'audit', capability: 'review', result: report({ requirementProgress: audit }) }]);
  assert.deepEqual(groupSummaryPresentation(f.summary()).issues, []);
});

test('已解决或否定的问题断言不生成普通话问题', () => {
  const audit = progressWith({ development: '审查不通过。未发现初始状态问题；列表列顺序已修复；接口文案转换已解决；不存在英文回退缺项；灰度直接链接展示问题不再出现。' });
  const f = fixture([{ id: 'audit', capability: 'review', result: report({ requirementProgress: audit }) }]);
  assert.deepEqual(groupSummaryPresentation(f.summary()).issues, []);
});

test('说明某项已经符合需求或无需修改时，不将技术主题误判为缺陷', () => {
  const audit = progressWith({ development: '审查不通过。列表列顺序与需求一致；初始状态已符合需求；无需修改新模式记录的编辑路径。' });
  const f = fixture([{ id: 'audit', capability: 'review', result: report({ requirementProgress: audit }) }]);
  assert.deepEqual(groupSummaryPresentation(f.summary()).issues, []);
});

test('空重试与非当前自动轮的明确问题不进入普通话汇报', () => {
  const audit = progressWith({ development: '审查不通过。必须修改初始状态。' });
  const source = report({ requirementProgress: audit });
  const retry = fixture([{ id: 'audit', capability: 'review' }]);
  retry.turns[0].result = source; retry.runs[0].status = 'running';
  assert.deepEqual(groupSummaryPresentation(retry.summary()).issues, []);
  const old = fixture([{ id: 'audit', capability: 'review', result: source }]);
  const summary = old.summary(); summary.members[0].current = false;
  assert.deepEqual(groupSummaryPresentation(summary).issues, []);
});

test('结构化严重问题可以解释，轻微问题和相同问题的重复引用不新增问题项', () => {
  const taskResult = { role: 'reviewer', status: 'failed', verdict: 'changes_requested', findings: [
    { id: 'F-1', severity: 'major', problem: '初始状态与需求不符', expectation: '修正初始选项' },
    { id: 'F-2', severity: 'minor', problem: '列表列顺序说明措辞', expectation: '优化文案' },
  ] };
  const source = report({ taskResult });
  const f = fixture([{ id: 'a', capability: 'review', result: source }, { id: 'b', capability: 'review', result: source }]);
  const view = groupSummaryPresentation(f.summary());
  assert.deepEqual(view.issues.map(issue => issue.id), ['initial-state']);
  assert.deepEqual(view.issues[0].sources.map(member => member.run), f.runs);
});

test('自由问答与复核轮次自动提炼汇总结论、核心要点、下一步建议与各岗位精简结论', () => {
  const leadMd = '我先只读核对当前工作区和历史轮次，确认 PC 项目范围。\n\n**核对结论：PC 项目本轮没有改，PRD 中有 PC 端说明，但 Jira VMS-748 是 APP 端单。**\n\n1. **本轮实际改动范围**：仅修改了 VMS 仓库，PC 仓库未产生任何代码改动。\n2. **PRD 中的 PC 说明**：PRD 包含 PC 端流水筛选项与导出表头说明。\n3. **未改 PC 项目的依据**：VMS-748 标题限定为 APP 开发。\n\n### 下一步建议\n- 若只需交付 VMS-748：当前只改 VMS 仓库符合 Jira 范围。\n- 若本次还需同步改 PC：请提供 PC 对应子任务单号。';
  const feMd = '我先检查工作区与仓库目录。\n\n结论：**PC 的项目没有改。**\n\n1. **PRD 中确实有 PC 项目的说明**。\n2. **当前工作区只改了 VMS 项目**。';
  const f = fixture([
    { id: 'lead', capability: 'read', result: leadMd },
    { id: 'fe', capability: 'write', result: feMd },
  ]);
  const view = groupSummaryPresentation(f.summary());
  assert.match(view.overview, /PC 项目本轮没有改/);
  assert.equal(view.summaryPoints.length, 3);
  assert.equal(view.summaryPoints[0].title, '本轮实际改动范围');
  assert.match(view.nextStep, /若只需交付 VMS-748/);
  assert.equal(view.roleDigests.length, 2);
  assert.doesNotMatch(view.roleDigests[0].summary, /我先只读核对/);
  assert.match(view.roleDigests[0].summary, /PC 项目本轮没有改/);
});


test('需求群聊按业务场景和实际产物汇报，验证失败不能被交接改写为通过', () => {
  const delivery = { goal: '运营可按国家维护 Nayax 增量预授权扣款规则',
    scenarios: [{ name: '编辑规则后保存并重新进入', status: 'failed', evidence: '重新进入后仍显示旧值' }],
    i18n: { status: 'ready', xlsx: '/fixture/tempdocs/i18n-import.xlsx', evidence: '导入表已检查，尚未上传' },
    previews: [{ project: '管理台', url: 'http://127.0.0.1:5173/country', mode: 'mock', evidence: '已打开业务入口，保存回读使用 Mock' }],
    nextStep: '前端修正保存回读，测试重新打开编辑页' };
  const progress = emptyRequirementProgress();
  progress.stages.design = { status: 'in_progress', evidence: '方案正在核对版本' };
  const f = fixture([
    { id: 'qa', capability: 'verify', result: report({ requirementDelivery: delivery }) },
    { id: 'reporter', capability: 'read', result: report({ requirementProgress: progress, requirementDelivery: {
      ...delivery, scenarios: [{ ...delivery.scenarios[0], status: 'passed', evidence: '仅引用实现者结果' }],
      previews: [{ ...delivery.previews[0], url: 'http://127.0.0.1:5174/guessed' }],
    } }) },
  ]);
  f.room.source = { taskId: 'fixture', workflow: 'requirement', title: '需求开发 · OPAY-797', issueKey: 'OPAY-797', issueUrl: '', projects: [] };
  const view = groupSummaryPresentation(f.summary());
  assert.match(view.headline, /暂时不能验收/);
  assert.equal(view.requirement?.goal, delivery.goal);
  assert.deepEqual(view.requirement?.scenarios, delivery.scenarios);
  assert.deepEqual(view.requirement?.previews, delivery.previews);
  assert.equal(view.requirement?.i18n?.xlsx, delivery.i18n.xlsx);
  assert.equal(view.requirement?.stages.find(stage => stage.key === 'design')?.status, '进行中');
  assert.equal(view.requirement?.stages.find(stage => stage.key === 'intake')?.status, '未记录');
  assert.equal(view.overview, '');
  assert.deepEqual(view.summaryPoints, []);
});

test('同一岗位只取当前最后记录，旧验证失败和多次负责人回复不堆进当前汇总', () => {
  const f = fixture([
    { id: 'old-fe', capability: 'write', result: report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '历史实现说明' } }) },
    { id: 'old-qa', capability: 'verify', result: report({ validationEvidence: evidence('failed', 'failed', '历史测试失败') }) },
    { id: 'answer', capability: 'read', result: report({ answer: '历史范围问答' }) },
    { id: 'fe', capability: 'write', result: report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '当前只修改四处类型注解。' } }) },
    { id: 'qa', capability: 'verify', result: report({ validationEvidence: evidence('passed', 'pending', '当前构建通过，页面未测') }) },
    { id: 'coordinate', capability: 'read', result: report({ coordinationReply: { action: 'retry', targetNodeId: 'audit', text: '此前请求重试审查。' } }) },
    { id: 'leader', capability: 'read', result: report({ conversationReply: { text: '当前仍需确认原目录结果。' } }) },
    { id: 'audit', capability: 'review', result: '' },
  ]);
  for (const index of [0, 3]) f.turns[index].member.id = 'frontend';
  for (const index of [1, 4]) f.turns[index].member.id = 'verifier';
  for (const index of [2, 5, 6]) f.turns[index].member.id = 'leader';
  f.runs[7].status = 'failed'; f.runs[7].error = '审查报告格式无法确认，尚未完成独立审查。';
  const before = structuredClone({ room: f.room, runs: f.runs });
  const summary = f.summary();
  summary.members[0].current = false; summary.members[1].current = false;
  const view = groupSummaryPresentation(summary);
  assert.deepEqual(view.records.map(member => member.turn.id), ['fe', 'qa', 'leader', 'audit']);
  assert.equal(view.roleDigests.filter(role => role.id === 'leader').length, 1);
  assert.equal(view.failed.length, 0);
  assert.deepEqual(view.checks.map(check => check.status), ['passed', 'pending']);
  assert.deepEqual(view.blockers.map(item => item.text), [f.runs[7].error]);
  assert.match(view.headline, /还没完成/);
  assert.doesNotMatch(JSON.stringify(view.summaryPoints) + view.overview + view.roleDigests.map(role => role.summary).join(''), /历史实现|历史测试|历史范围|此前请求|coordinationReply|targetNodeId/);
  assert.deepEqual({ room: f.room, runs: f.runs }, before);
});

test('answer与coordinationReply只显示原始明确文本，taskPlan和未知JSON不成为结论', () => {
  for (const payload of [{ answer: '原文 L123：只核对，没有重新执行。' },
    { coordinationReply: { action: 'observe', text: '原文 L123：只核对，没有重新执行。' } }]) {
    const f = fixture([{ id: 'leader', capability: 'read', result: report(payload) }]);
    const view = groupSummaryPresentation(f.summary());
    assert.equal(view.roleDigests[0].summary, '原文 L123：只核对，没有重新执行。');
    assert.match(view.overview, /只核对，没有重新执行/);
    assert.doesNotMatch(view.overview, /version|answer|coordinationReply|observe/);
  }
  for (const result of [report({ taskPlan: { reason: '这是尚未执行的计划。' } }), report({ internal: { command: 'do-it' } }),
    '{"version":1,"answer":"未通过协议校验"}', '```delivery-report\n{"version":1,"taskPlan":']) {
    const view = groupSummaryPresentation(fixture([{ id: 'leader', capability: 'read', result }]).summary());
    assert.deepEqual(view.roleDigests, []);
    assert.equal(view.overview, '');
    assert.deepEqual(view.summaryPoints, []);
  }
});

test('同岗当前重试未返回时不回退旧成功或携带的过期报告', () => {
  const result = report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '历史完成，不属于当前重试' }, validationEvidence: evidence('passed', 'passed') });
  const f = fixture([{ id: 'old', capability: 'write', result }, { id: 'retry', capability: 'write', result }]);
  f.turns.forEach(turn => { turn.member.id = 'frontend'; });
  f.runs[1].status = 'running';
  const summary = f.summary(); summary.members[0].current = false;
  const view = groupSummaryPresentation(summary);
  assert.deepEqual(view.records.map(member => member.turn.id), ['retry']);
  assert.deepEqual(view.checks, []);
  assert.equal(view.roleDigests.length, 1);
  assert.equal(view.roleDigests[0].statusLabel, '处理中');
  assert.equal(view.roleDigests[0].state, undefined);
  assert.match(view.roleDigests[0].summary, /正在处理.*尚未返回/);
  assert.doesNotMatch(view.overview + view.roleDigests[0].summary, /历史完成/);
});

test('同岗仍有效的独立节点失败不被最新成功结论抹掉', () => {
  const f = fixture([
    { id: 'qa-a', capability: 'verify', result: report({ validationEvidence: evidence('failed', 'pending', '项目A检查失败') }) },
    { id: 'qa-b', capability: 'verify', result: report({ validationEvidence: evidence('passed', 'pending', '项目B检查通过') }) },
  ]);
  f.turns.forEach(turn => { turn.member.id = 'verifier'; });
  const view = groupSummaryPresentation(f.summary());
  assert.equal(view.failed[0].status, 'failed');
  assert.ok(view.blockers.some(item => item.text.includes('项目A检查失败')));
  assert.match(view.headline, /暂时不能验收/);
});

test('汇总组件正文展示统一结果和真实阻塞，当前岗位原文默认折叠且不显示协议JSON', async () => {
  const server = await createServer({ configFile: false, plugins: [vue()], appType: 'custom',
    server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const { default: Summary } = await server.ssrLoadModule('/src/features/agent-workbench/AgentGroupSummary.vue');
    const f = fixture([
      { id: 'fe', capability: 'write', result: report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '原实现结论 L456，保留字段内容。' } }) },
      { id: 'qa', capability: 'verify', result: report({ validationEvidence: evidence('passed', 'pending') }) },
      { id: 'leader', capability: 'read', result: report({ coordinationReply: { action: 'observe', text: '协调原文：尚未重新执行。' } }) },
      { id: 'audit', capability: 'review', result: '' },
    ]);
    f.runs[3].status = 'failed'; f.runs[3].error = '审查返回格式无效，当前受阻。';
    const html = await renderToString(createSSRApp({ render: () => h(Summary, { summary: f.summary() }) }));
    const [main, details] = html.split('<details class="result-full"');
    assert.match(main, /当前实现结果/);
    assert.match(main, /原实现结论 L456，保留字段内容/);
    assert.match(main, /当前待处理项.*审查返回格式无效/s);
    assert.match(main, /还没确认结果/);
    assert.doesNotMatch(main, /各岗位结论汇总|协调原文/);
    assert.ok(details);
    assert.doesNotMatch(details.split('>')[0], /\bopen\b/);
    assert.match(details, /各岗位结论摘要.*协调原文：尚未重新执行/s);
    assert.doesNotMatch(html, /coordinationReply|targetNodeId|&quot;version&quot;/);
  } finally { await server.close(); }
});
