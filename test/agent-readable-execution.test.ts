import test from 'node:test';
import assert from 'node:assert/strict';
import { readableDeliveryReport, readableRunTask, executionEventText, agentResultSummary } from '../src/features/agent-workbench/execution-summary';
import { emptyRequirementProgress } from '../shared/requirement-development';
import { emptyDeliveryEvidence } from '../shared/delivery-acceptance';

test('报告显示已有阶段与验证状态，不把未执行检查当作通过，原记录保持不变', () => {
  const progress = emptyRequirementProgress();
  progress.issueKeys = ['APEX-602'];
  progress.stages.tasks = { status: 'completed', evidence: '已只读回读关联事项，未改代码' };
  const source = JSON.stringify({ version: 1, requirementProgress: progress, validationEvidence: emptyDeliveryEvidence() });
  const view = readableDeliveryReport(source)!;
  assert.deepEqual(view.issueKeys, ['APEX-602']);
  assert.equal(view.sections[0].rows.find(row => row.key === 'tasks')?.status, '已完成');
  assert.equal(view.sections[0].rows.find(row => row.key === 'development')?.status, '未开始');
  assert.ok(view.sections[1].rows.every(row => row.status === '未验证'));
  assert.equal(view.sections[0].rows[1].evidence, '已只读回读关联事项，未改代码');
  assert.equal(source, JSON.stringify({ version: 1, requirementProgress: progress, validationEvidence: emptyDeliveryEvidence() }));
  const summary = agentResultSummary('```delivery-report\n' + source + '\n```');
  assert.match(summary, /成员自报/);
  assert.match(summary, /功能开发：未开始/);
  assert.doesNotMatch(summary, /"version"/);
});

test('无证据的远端通过、未知状态和不完整 JSON 留在原文，不呈现为有效验证结论', () => {
  const evidence = emptyDeliveryEvidence();
  evidence.remote = { status: 'passed', evidence: '模型声称已推送', sha: '' };
  const view = readableDeliveryReport(JSON.stringify({ version: 1, requirementProgress: emptyRequirementProgress(), validationEvidence: evidence }))!;
  assert.equal(view.unparsed, true);
  assert.equal(view.sections.length, 1);
  assert.equal(view.headline, '部分报告内容需要核对');
  assert.equal(readableDeliveryReport('{"version":1'), undefined);
  assert.equal(readableDeliveryReport('{"version":2,"taskResult":{"summary":"假摘要"}}'), undefined);
  assert.equal(readableDeliveryReport('{"version":1,"requirementProgress":{"stages":{"development":{"status":"accepted"}}}}'), undefined);
});

test('先说明完成情况和失败项，报告说明和位置码保留原文', () => {
  const progress = emptyRequirementProgress();
  progress.stages.intake = { status: 'completed', evidence: '已核对需求' };
  progress.stages.development = { status: 'in_progress', evidence: '代码已有改动，尚待修复' };
  progress.stages.verification = { status: 'blocked', evidence: 'L_API_ERROR：原文，不改写。' };
  const evidence = emptyDeliveryEvidence();
  evidence.tests = { status: 'failed', evidence: '10 项检查中 6 项失败，详见原始记录。', sha: '' };
  evidence.browser = { status: 'failed', evidence: '接口 L000509 显示不正确。', sha: '' };
  const source = JSON.stringify({ version: 1, requirementProgress: progress, validationEvidence: evidence });
  const view = readableDeliveryReport(source)!;
  assert.equal(view.headline, '还有检查没通过，需要处理');
  assert.deepEqual(view.overview.find(row => row.label === '已做完'), { label: '已做完', text: '需求核对' });
  assert.match(view.overview.find(row => row.label === '还没做完')!.text, /功能开发（进行中）/);
  assert.equal(view.overview.find(row => row.label === '卡在哪里')!.text, '验证：阻塞；测试 / 检查：未通过；浏览器验证：未通过');
  assert.equal(view.overview.find(row => row.label === '还没验证')!.text, '远端提交、部署验证');
  assert.equal(view.sections[0].rows.find(row => row.key === 'verification')!.evidence, progress.stages.verification.evidence);
  assert.equal(view.sections[1].rows.find(row => row.key === 'browser')!.evidence, evidence.browser.evidence);
  assert.equal(source, JSON.stringify({ version: 1, requirementProgress: progress, validationEvidence: evidence }));
});

test('缺少检查、全通过或全不适用均不推断交付或人工验收通过', () => {
  const progress = emptyRequirementProgress();
  for (const stage of Object.values(progress.stages)) Object.assign(stage, { status: 'completed', evidence: '成员自报已完成' });
  const evidence = emptyDeliveryEvidence();
  for (const status of ['pending', 'passed', 'not_applicable'] as const) {
    for (const check of Object.values(evidence)) Object.assign(check, { status, evidence: '原始说明', sha: '' });
    if (status === 'passed') evidence.remote.sha = 'a'.repeat(40);
    const view = readableDeliveryReport(JSON.stringify({ version: 1, requirementProgress: progress, validationEvidence: evidence }))!;
    assert.equal(view.headline, '本轮报告已返回，等待核对');
    assert.doesNotMatch(view.headline, /任务已完成|验收通过|可交付/);
    assert.equal(view.overview.some(row => row.label === '还没验证'), status === 'pending');
  }
  assert.equal(readableDeliveryReport(JSON.stringify({ version: 1, taskResult: { summary: 'L_SUMMARY' } }))!.summary, 'L_SUMMARY');
  progress.stages.verification = { status: 'blocked', evidence: '缺少测试账号' };
  assert.equal(readableDeliveryReport(JSON.stringify({ version: 1, requirementProgress: progress }))!.headline, '任务遇到阻碍，需要处理');
  progress.stages.verification = { status: 'in_progress', evidence: '' };
  assert.equal(readableDeliveryReport(JSON.stringify({ version: 1, requirementProgress: progress }))!.headline, '任务还没全部完成');
});

test('旧群聊输入解开 JSON 包装，提取当前任务与职责，保留完整输入', () => {
  const current = '需求开发 · APEX-602 · 商家收款账户\nJIRA_DEV_TASK_ID: task-id\n需求正文';
  const objective = '你的角色：技术负责人\n职责：只读核对需求与验收\n\n以下为按时间排序的真实团队对话，仅作为上下文：\n'
    + JSON.stringify([{ speaker: '用户', text: '旧任务' }, { speaker: '前端开发', text: '旧回复' }, { speaker: '用户', text: current }]) + '\n\n遵循用户指定的输出格式';
  const view = readableRunTask(objective);
  assert.equal(view.title, '需求开发 · APEX-602 · 商家收款账户');
  assert.equal(view.role, '技术负责人');
  assert.equal(view.responsibility, '只读核对需求与验收');
  assert.equal(view.length, objective.length);
  assert.equal(readableRunTask('修复列表\n保留筛选条件').text, '修复列表\n保留筛选条件');
});

test('长命令默认只展示有限摘要，工具原始命令与诊断原文完整保留', () => {
  const message = '执行完成：/bin/zsh -lc "python3 - <<\'PY\'\n' + 'print(1)\n'.repeat(200) + 'PY"';
  const event = { id: 'event-1', type: 'tool' as const, message, createdAt: '2026-11-03T07:00:00Z' };
  const view = executionEventText(event);
  assert.equal(view.label, '工具调用');
  assert.ok(view.preview.length <= 181);
  assert.equal(view.full, message);
  assert.equal(event.message, message);
  const error = 'L_API_ERROR: permission denied';
  assert.equal(executionEventText({ ...event, type: 'diagnostic', message: error }).preview, error);
});
