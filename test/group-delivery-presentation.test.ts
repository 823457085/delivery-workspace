/** 合成构建和审查报告用于验证正文事实与未确认范围。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { shallowRef } from 'vue';
import { readAgentDeliveryReport } from '../shared/delivery-report.js';
import { groupDeliveryOverview, groupDeliveryPresentation, type GroupDeliveryContext } from '../src/features/agent-workbench/group-delivery-presentation.js';

const original = JSON.parse(readFileSync(new URL('./fixtures/group-delivery-original-build.json', import.meta.url), 'utf8')) as GroupDeliveryContext;
const fixture = () => structuredClone(original);
function editReport(task: GroupDeliveryContext, stage: 'verify' | 'review', change: (report: Record<string, any>) => void) {
  const node = task.nodes.find(node => node.stage === stage)!;
  const report = readAgentDeliveryReport(node.result!) as Record<string, any>;
  change(report);
  node.result = '```delivery-report\n' + JSON.stringify(report) + '\n```';
}

test('只读复核优先呈现原问题的验证结果，正文不再列固定检查项', () => {
  const task = fixture(), before = structuredClone(task);
  const view = groupDeliveryPresentation(task), text = groupDeliveryOverview(task);
  assert.equal(view.buildStatus, 'passed'); assert.equal(view.buildPassed, true);
  assert.equal(view.reviewPassed, true); assert.equal(view.noFindings, true);
  assert.match(text, /^示例项目完成类型修复，本轮原目录构建通过。/);
  assert.doesNotMatch(text, /自动测试：|页面功能：|代码推送：|部署结果：|\/workspace|validationEvidence/);
  assert.deepEqual(task, before);
  assert.match(task.nodes[0].result!, /本节点未重新运行单元测试/);
});

test('通过的测试不能补出缺失或无证据的独立构建状态', () => {
  for (const build of [undefined, { status: 'passed', evidence: '' }]) {
    const task = fixture();
    editReport(task, 'verify', report => {
      report.validationEvidence.build = build;
      report.validationEvidence.tests = { status: 'passed', evidence: '已执行的自动测试通过', sha: '' };
      report.taskResult.summary = '';
    });
    const view = groupDeliveryPresentation({ ...task, state: 'completed' } as GroupDeliveryContext);
    assert.equal(view.buildPassed, false);
    assert.doesNotMatch(view.conclusion, /本地构建已经通过/);
  }
});

test('旧轮报告、当前未结束或已跳过的步骤不能冒充本轮验证和审查', () => {
  const old = fixture(); old.round += 1;
  const stale = groupDeliveryPresentation(old);
  assert.equal(stale.buildPassed, false); assert.equal(stale.reviewPassed, false);
  assert.doesNotMatch(stale.conclusion, /示例项目完成类型修复/);
  for (const status of ['running', 'blocked', 'skipped'] as const) {
    const task = fixture(); task.nodes.forEach(node => { node.status = status; });
    const view = groupDeliveryPresentation(task);
    assert.equal(view.buildPassed, false); assert.equal(view.reviewPassed, false);
    assert.doesNotMatch(view.conclusion, /示例项目完成类型修复|已经通过|没有发现需要继续修改/);
  }
});

test('审查须通过真实evaluateReview且findings为空，乐观summary不能覆盖未完成标准或问题', () => {
  for (const mutate of [
    (report: Record<string, any>) => { report.taskResult.verdict = 'changes_requested'; },
    (report: Record<string, any>) => { report.taskResult.acceptance = []; },
    (report: Record<string, any>) => { report.taskResult.acceptance[0].status = 'not_run'; },
    (report: Record<string, any>) => { report.taskResult.findings = [{ id: 'F-1', severity: 'minor', problem: '说明需要澄清' }]; },
  ]) {
    const task = fixture();
    editReport(task, 'review', report => { mutate(report); report.taskResult.summary = '没有任何问题，可以交付。'; });
    const view = groupDeliveryPresentation(task);
    assert.equal(view.noFindings, false);
    assert.doesNotMatch(view.conclusion, /没有发现需要继续修改|没有任何问题|可以交付/);
    assert.equal(view.buildPassed, true, '独立审查变化不改写已有构建事实');
  }
});

test('构建与自动测试失败单独保留，不能因任务完成或另一类通过隐藏失败', () => {
  const task = fixture();
  editReport(task, 'verify', report => {
    report.taskResult.status = 'failed';
    report.validationEvidence.build.status = 'failed';
    report.validationEvidence.build.evidence = '本次构建退出码1';
    report.validationEvidence.tests = { status: 'failed', evidence: '本次自动测试失败', sha: '' };
  });
  const view = groupDeliveryPresentation(task);
  assert.equal(view.buildStatus, 'failed'); assert.equal(view.buildPassed, false);
  assert.match(view.conclusion, /构建还没有通过/);
  assert.doesNotMatch(view.conclusion, /构建已经通过/);
});

test('只有诊断或普通回复不显示修复成功，也不按日志关键词推断构建事实', () => {
  const task = fixture();
  task.plan = { templateId: 'diagnosis', acceptanceCriteria: [] };
  task.nodes = [{ ...task.nodes[0], stage: 'diagnose', profileId: 'engineer', result: '问题已修复，pnpm build全部通过。' }];
  const diagnosis = groupDeliveryPresentation(task);
  assert.equal(diagnosis.diagnosisOnly, true); assert.equal(diagnosis.buildPassed, false);
  assert.equal(diagnosis.reviewPassed, false);
  assert.match(diagnosis.conclusion, /没有可确认的问题分析结论/);
  assert.doesNotMatch(diagnosis.conclusion, /问题已修复/);
  const invalid = fixture(); invalid.nodes.forEach(node => { node.result = '构建通过，代码没有问题。'; });
  assert.equal(groupDeliveryPresentation(invalid).buildPassed, false);
  assert.equal(groupDeliveryPresentation(invalid).noFindings, false);
});

test('最新验证结论补全实际改动和打包限制，批准的审查也展示具体意见', () => {
  const task = fixture();
  const summary = '已确认构建入口恢复。只保留一个校验脚本，专用测试文件已移除。测试打包因缺少示例翻译条目中止。';
  const finding = '单独执行校验时的失败提示容易让人误以为调用过打包。';
  task.nodes.push({ ...task.nodes[0], stage: 'implement', profileId: 'engineer',
    result: '```delivery-report\n' + JSON.stringify({ taskResult: { role: 'implementer', status: 'succeeded',
      summary: '已修复构建入口。' } }) + '\n```' });
  editReport(task, 'verify', report => {
    report.taskResult.summary = summary + '浏览器、真实业务接口及独立审查仍未验证。正式独立审查尚待宿主后续派发，整体交付尚不能据此宣称独立审查完成。';
    report.validationEvidence.remote = { status: 'failed', evidence: '远端语言包缺少示例条目', sha: '' };
  });
  editReport(task, 'review', report => {
    report.taskResult.findings = [{ id: 'F-1', severity: 'minor', problem: finding }];
  });
  const before = structuredClone(task), text = groupDeliveryOverview(task);
  assert.ok(text.startsWith(summary));
  assert.ok(text.includes(finding));
  assert.match(text, /浏览器、真实业务接口仍未验证。独立审查已通过/);
  assert.doesNotMatch(text, /代码推送|报告中仍有需要关注的意见|尚待派发|尚待宿主|不能据此宣称/);
  assert.deepEqual(task, before);
  editReport(task, 'verify', report => { report.taskResult.summary = ''; });
  assert.match(groupDeliveryOverview(task), /^已修复构建入口。/);
});

test('群聊实际finalDeliveryOverview按round关联任务，不从旧长报告或另一任务拼接正文', () => {
  const source = readFileSync(new URL('../src/features/agent-workbench/AgentGroupChat.vue', import.meta.url), 'utf8')
    .match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
  const tree = ts.createSourceFile('group.ts', source, ts.ScriptTarget.Latest, true);
  const fn = tree.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'finalDeliveryOverview')!;
  const code = ts.transpileModule(fn.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const current = { ...fixture(), id: 'current-task' }, old = { ...fixture(), id: 'old-task', round: 1 };
  const dependencies = { room: shallowRef({ rounds: [
    { id: 'current-round', automatic: { taskId: current.id } }, { id: 'old-round', automatic: { taskId: old.id } },
  ] }), collaborationTasks: shallowRef([old, current]), groupDeliveryOverview };
  const render = new Function(...Object.keys(dependencies), `${code}; return finalDeliveryOverview;`)(...Object.values(dependencies)) as (roundId: string) => string;
  assert.equal(render('current-round'), groupDeliveryOverview(current));
  assert.doesNotMatch(render('old-round'), /构建已经通过|没有发现需要继续修改/);
  assert.doesNotMatch(render('missing-round'), /构建已经通过/);
});

test('方案汇报先展示已记录的方案决定', () => {
  const task = fixture(); task.plan!.templateId = 'research_design';
  task.nodes = task.nodes.filter(node => node.stage === 'review');
  editReport(task, 'review', report => { report.taskResult.summary = '代码已复查。'; });
  const view = groupDeliveryPresentation(task);
  assert.equal(view.reviewPassed, true); assert.equal(view.buildPassed, false);
  assert.match(view.conclusion, /方案复查已通过/);
  assert.doesNotMatch(view.conclusion, /代码|构建已经通过/);
  task.nodes.push({ ...task.nodes[0], stage: 'architect', profileId: 'architect' });
  task.technicalDesign = { decisions: [{ id: 'D-1', decision: '复用现有验证入口。', reason: '避免新增执行路径。', source: '方案记录' }] };
  assert.match(groupDeliveryPresentation(task).conclusion, /^复用现有验证入口。/);
});

test('工作副本和原目录位置边界直接来自结构化路径，原目录结果不受影响', () => {
  const task = fixture(); task.workspacePath = '/workspace/team-copy';
  editReport(task, 'verify', report => { report.taskResult.summary = '参数类型修复已在工作副本验证。'; });
  const before = structuredClone(task), view = groupDeliveryPresentation(task), text = groupDeliveryOverview(task);
  assert.equal(view.buildPassed, true);
  assert.match(view.conclusion, /参数类型修复已在工作副本验证/);
  assert.equal(view.workspaceNotice, '结果保存在工作副本中，原项目尚未确认。');
  assert.match(text, /结果保存在工作副本中，原项目尚未确认/);
  assert.doesNotMatch(text, /\/workspace|本地构建已经通过/);
  assert.deepEqual(task, before);
  editReport(task, 'review', report => { report.taskResult.summary = '原项目已修复。'; });
  assert.doesNotMatch(groupDeliveryOverview(task), /原项目已修复/);
  task.nodes = before.nodes;
  task.workspacePath = task.sourceWorkspacePath;
  assert.equal(groupDeliveryPresentation(task).workspaceNotice, '');
  assert.equal(groupDeliveryPresentation(task).conclusion, view.conclusion);
});

test('诊断尚未确认事项原样保留在正文，不因通俗汇报丢失限制', () => {
  const task = fixture();
  task.plan = { templateId: 'diagnosis', acceptanceCriteria: [] };
  task.nodes = [{ ...task.nodes[0], stage: 'diagnose', profileId: 'engineer' }];
  task.diagnosis = { summary: '已定位到页面对接口文案进行了二次翻译。',
    unverified: ['原文 L901：尚未取得现场日志。', '接口实际返回仍未核对，不能判断已修复。'] };
  const before = structuredClone(task), view = groupDeliveryPresentation(task), text = groupDeliveryOverview(task);
  assert.deepEqual(view.unverified, task.diagnosis.unverified);
  assert.ok(text.startsWith(task.diagnosis.summary!));
  assert.match(text, /本轮只做了问题分析/);
  for (const item of task.diagnosis.unverified) assert.ok(text.includes(item));
  assert.equal(view.buildPassed, false); assert.equal(view.reviewPassed, false);
  assert.deepEqual(task, before);
});
