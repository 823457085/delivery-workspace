import test from 'node:test';
import assert from 'node:assert/strict';
import { reactive } from 'vue';
import type { AgentRun } from '../shared/agent-runtime.js';
import { groupTeamMembers, type GroupMember, type GroupRoom, type GroupRound, type GroupTurn } from '../shared/agent-group-chat.js';
import type { TeamNode } from '../shared/agent-team.js';
import { emptyRequirementProgress } from '../shared/requirement-development.js';
import { emptyDeliveryEvidence } from '../shared/delivery-acceptance.js';
import { groupChatSummaries, groupMemberSummary } from '../src/features/agent-workbench/group-chat-summary.js';

const at = '2026-11-04T09:00:00.000Z';
const report = (value: object) => '```delivery-report\n' + JSON.stringify({ version: 1, ...value }) + '\n```';
function run(id: string, result = '', options: Partial<AgentRun> = {}): AgentRun {
  return { id, provider: 'codex', mode: 'agent', accessMode: 'workspace', model: 'fixture', reasoningEffort: '', objective: '原始任务 L001',
    workspacePath: '/same/project', branch: 'feature/fixture', headSha: 'fixture', status: 'completed', sessionId: 'same-session', pid: null,
    result, error: '', events: [], createdAt: at, updatedAt: at, ...options };
}
function turn(id: string, capability: GroupMember['capability'], options: Partial<GroupTurn> = {}): GroupTurn {
  return { id, runId: id, member: { id, name: `自定义成员 ${id}`, capability, instructions: '原始职责 L002', enabled: true },
    attempt: 1, status: 'completed', result: '', error: '', updatedAt: at, ...options };
}
function round(id: string, turns: GroupTurn[], options: Partial<GroupRound> = {}): GroupRound {
  return { id, requestId: id, requestHash: id, text: '用户本轮目标 L003', attachmentIds: [], accessMode: 'workspace',
    state: 'completed', turns, createdAt: at, updatedAt: at, ...options };
}
function room(...rounds: GroupRound[]): GroupRoom {
  return { id: 'room', title: '原始团队 L004', workspacePath: '/same/project', executionPath: '/same/project',
    paused: false, cursorTrustPaths: [], rounds, createdAt: at, updatedAt: at };
}
function completeProgress() {
  const progress = emptyRequirementProgress();
  for (const item of Object.values(progress.stages)) { item.status = 'completed'; item.evidence = '来源记录 L005'; }
  return progress;
}

test('实际成员正在重试时优先显示运行中，同时保留尚未解决的历史失败证据', () => {
  const turns = [turn('old-coordinator', 'read'), turn('engineer', 'write')];
  const value = room(round('retry', turns, { state: 'running', automatic: { taskId: 'task', config: { revision: 1, name: '团队', members: turns.map(item => item.member) }, inputs: [] } }));
  const nodes = turns.map((item, index) => ({ id: item.id, round: 0, runId: item.runId, profileId: index ? 'engineer' : 'leader', stage: 'execute',
    status: index ? 'running' : 'blocked', dependencies: [], attempt: 1, createdAt: at, updatedAt: at } as TeamNode));
  const summary = groupChatSummaries(value, [run('old-coordinator', '', { status: 'failed', error: '旧协调失败 L990' }),
    run('engineer', '', { status: 'running' })], [{ id: 'task', round: 0, state: 'running', nodes }])[0];
  assert.equal(summary.status, 'running'); assert.equal(summary.ready, false);
  assert.ok(summary.blockers.some(item => item.text === '旧协调失败 L990'));
  assert.equal(summary.members[1].summary, '');
});

test('同轮旧协调失败被新协调接替后只保留为历史，不污染当前任务标题', () => {
  const turns = [turn('old-coordinator', 'read'), turn('new-coordinator', 'read')];
  const value = room(round('current', turns, { automatic: { taskId: 'task', config: { revision: 1, name: '团队', members: turns.map(item => item.member) }, inputs: [] } }));
  const nodes = turns.map((item, index) => ({ id: item.id, round: 0, runId: item.runId, profileId: 'leader', stage: 'plan', purpose: 'coordinate',
    status: index ? 'completed' : 'blocked', dependencies: [], attempt: 1, createdAt: at, updatedAt: at } as TeamNode));
  const summary = groupChatSummaries(value, [run('old-coordinator', '', { status: 'failed', error: '旧额度阻塞 L991' }),
    run('new-coordinator', '已完成本次协调 L992')], [{ id: 'task', round: 0, state: 'completed', nodes }])[0];
  assert.equal(summary.members[0].current, false); assert.equal(summary.members[1].current, true);
  assert.equal(summary.status, 'returned'); assert.equal(summary.blockers.length, 0);
  assert.equal(summary.members[0].run?.error, '旧额度阻塞 L991');
});

test('本岗摘要保留原始文字，只从当前职责字段提取，不重复全局阶段表', () => {
  const text = '原始问答 L123\n第二行保持原文';
  assert.equal(groupMemberSummary(text, 'read'), text);
  assert.equal(groupMemberSummary(report({ conversationReply: { text } }), 'read'), text);
  assert.equal(groupMemberSummary(report({ taskPlan: { reason: '本轮分工理由 L234' } }), 'read'), '本轮分工理由 L234');
  assert.equal(groupMemberSummary(report({ taskResult: { summary: '本岗原始摘要 L345' } }), 'write'), '本岗原始摘要 L345');
  assert.equal(groupMemberSummary(report({ diagnosis: { summary: '本岗诊断 L456' } }), 'read'), '本岗诊断 L456');
  assert.equal(groupMemberSummary(report({ jiraHandoff: { conclusion: '交接结论 L567' } }), 'read'), '交接结论 L567');
  const progress = completeProgress(), evidence = emptyDeliveryEvidence();
  progress.stages.design.evidence = '本岗方案路径 L678'; progress.stages.development.evidence = '本岗开发证据 L789';
  evidence.tests = { status: 'failed', evidence: '只读了前序日志，未自行执行 L890', sha: '' };
  const source = report({ requirementProgress: progress, validationEvidence: evidence });
  assert.equal(groupMemberSummary(source, 'write'), '本岗方案路径 L678\n本岗开发证据 L789');
  assert.equal(groupMemberSummary(source, 'verify'), evidence.tests.evidence);
  assert.equal(groupMemberSummary(source, 'review'), '', '审查不能把抄录的前序验证字段当成本岗测试成果');
  assert.equal(groupMemberSummary(source, 'read'), '', '无局部摘要的全局阶段表由团队汇总消费');
});

test('每个用户轮次只选末位真实全局报告，早期角色报告不能顶替末位回复', () => {
  const first = round('first', [turn('implement', 'write'), turn('reporter', 'read')]);
  const second = round('second', [turn('second-implement', 'write'), turn('second-reporter', 'read')]);
  const progress = completeProgress();
  const runs = [run('implement', report({ requirementProgress: progress })), run('reporter', report({ requirementProgress: progress })),
    run('second-implement', report({ requirementProgress: progress })), run('second-reporter', '本轮只有普通交接文本 L999')];
  const summaries = groupChatSummaries(room(first, second), runs);
  assert.equal(summaries.length, 2);
  assert.equal(summaries[0].report?.run, runs[1]);
  assert.equal(summaries[0].report?.turn, first.turns[1]);
  assert.deepEqual(JSON.parse(summaries[0].report!.source).requirementProgress, progress);
  assert.equal(summaries[1].report, undefined);
  assert.equal(summaries[0].status, 'returned', '报告已返回也不能宣称开发已验收');
  assert.equal(groupChatSummaries(undefined, runs).length, 0);
});

test('末位乐观报告不能覆盖验证或审查的明确失败，原文与真实运行身份不变', () => {
  const current = round('current', [turn('implement', 'write'), turn('qa', 'verify'), turn('audit', 'review'), turn('reporter', 'read')]);
  const evidence = emptyDeliveryEvidence();
  evidence.tests = { status: 'failed', evidence: '退出 1，4 项失败，原日志 L101', sha: '' };
  const runs = [run('implement', report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '实现者自报完成' } })),
    run('qa', report({ validationEvidence: evidence, taskResult: { role: 'verifier', status: 'failed', summary: '验证未通过 L102' } })),
    run('audit', report({ taskResult: { role: 'reviewer', status: 'succeeded', verdict: 'changes_requested', summary: '审查要求修改 L103',
      findings: [{ id: 'F-1', severity: 'major', file: 'src/a.ts', problem: '保留问题原文 L104' }] } })),
    run('reporter', report({ requirementProgress: completeProgress() }))];
  const value = room(current), before = structuredClone({ value, runs });
  const summary = groupChatSummaries(value, runs)[0];
  assert.equal(summary.status, 'blocked');
  assert.ok(summary.blockers.some(item => item.text.includes('退出 1，4 项失败，原日志 L101') && item.run === runs[1]));
  assert.ok(summary.blockers.some(item => item.text === '保留问题原文 L104' && item.turn === current.turns[2]));
  assert.equal(summary.members[1].outcome?.state, 'failed');
  assert.equal(summary.members[2].outcome?.state, 'failed');
  assert.deepEqual(JSON.parse(summary.report!.source).requirementProgress, completeProgress(), '全局报告原状态不被前端改写');
  assert.deepEqual({ value, runs }, before);
});

test('未开始、运行中和结果保存中均不形成最终完成，不能拿前序报告补全末位记录', () => {
  for (const state of ['pending', 'running', 'saving'] as const) {
    const value = room(round('current', [turn('first', 'read'), turn('last', 'write', { status: state === 'pending' ? 'pending' : state === 'saving' ? 'completed' : state })]));
    const runs = [run('first', report({ requirementProgress: completeProgress() }))];
    if (state !== 'pending') runs.push(run('last', '', { status: state === 'saving' ? 'completed' : 'running', ...(state === 'saving' ? { resultReady: false } : {}) }));
    const summary = groupChatSummaries(value, runs)[0];
    assert.equal(summary.status, 'running');
    assert.equal(summary.report, undefined);
    assert.equal(summary.completed, 1);
    assert.equal(summary.members[1].state, state);
  }
});

test('流式文字或前序汇报已返回时，仍需等整轮结束和所有当前结果保存后才显示汇总', () => {
  for (const state of ['pending', 'queued', 'running', 'saving'] as const) {
    const last = turn('last', 'read', { status: state === 'saving' ? 'completed' : state });
    const current = round('current', [turn('first', 'read'), last]);
    const runs = [run('first', '首位已完成 L701')];
    if (state !== 'pending') runs.push(run('last', '已经收到流式文字 L702', {
      status: state === 'saving' ? 'completed' : state, ...(state === 'saving' ? { resultReady: false } : {}),
    }));
    assert.equal(groupChatSummaries(room(current), runs)[0].ready, false, state);
  }
  const current = round('current', [turn('first', 'read'), turn('last', 'read')]);
  const runs = [run('first', '首位已完成 L701'), run('last', '末位已完成 L703')];
  for (const state of ['queued', 'running'] as const) {
    current.state = state;
    assert.equal(groupChatSummaries(room(current), runs)[0].ready, false, '整轮终态尚未保存');
  }
  current.state = 'completed';
  assert.equal(groupChatSummaries(room(current), runs)[0].ready, true);
  current.turns[1].result = '旧尝试的结果 L704';
  runs[1].result = '';
  assert.equal(groupChatSummaries(room(current), runs)[0].ready, false, '新运行空结果不能回退旧 turn.result');
});

test('已有失败不覆盖后续成员尚未完成的事实，失败轮也要等当前成员全部停止', () => {
  for (const state of ['pending', 'queued', 'running', 'saving'] as const) {
    const current = round('current', [turn('first', 'read'), turn('last', 'read', {
      status: state === 'saving' ? 'completed' : state,
    })], { state: 'failed' });
    const runs = [run('first', '首位失败说明 L705', { status: 'failed', error: '真实失败 L706' })];
    if (state !== 'pending') runs.push(run('last', '后续成员已返回部分文字 L707', {
      status: state === 'saving' ? 'completed' : state, ...(state === 'saving' ? { resultReady: false } : {}),
    }));
    const summary = groupChatSummaries(room(current), runs)[0];
    assert.equal(summary.status, 'blocked');
    assert.equal(summary.ready, false, state);
  }
  const current = round('current', [turn('first', 'read'), turn('last', 'read')], { state: 'failed' });
  assert.equal(groupChatSummaries(room(current), [run('first', '首位失败说明 L705', { status: 'failed', error: '真实失败 L706' }),
    run('last', '后续成员已停止 L708', { status: 'cancelled' })])[0].ready, true);
});

test('自动计划结束但任务仍活跃或真实运行尚未停止时，不显示最终汇总', () => {
  const captain = turn('captain', 'read');
  const current = round('current', [captain], { automatic: { taskId: 'task',
    config: { revision: 1, name: '冻结团队', members: [captain.member] }, inputs: [] } });
  const node: TeamNode = { id: captain.id, runId: captain.runId, round: 0, profileId: 'leader', stage: 'plan',
    status: 'completed', dependencies: [], attempt: 1, createdAt: at, updatedAt: at };
  const runs = [run(captain.runId, '计划或中间说明 L709')];
  for (const state of ['planning', 'awaiting_plan', 'running', 'waiting_input'] as const) {
    assert.equal(groupChatSummaries(room(current), runs, [{ id: 'task', round: 0, state, nodes: [node] }])[0].ready,
      false, state);
  }
  current.state = 'failed';
  node.status = 'blocked';
  runs[0].status = 'running';
  let summary = groupChatSummaries(room(current), runs, [{ id: 'task', round: 0, state: 'blocked', nodes: [node] }])[0];
  assert.equal(summary.members[0].state, 'failed', '节点状态可以先被覆盖为失败');
  assert.equal(summary.ready, false, '仍须核对实际运行是否停止');
  runs[0].status = 'completed'; runs[0].resultReady = false;
  summary = groupChatSummaries(room(current), runs, [{ id: 'task', round: 0, state: 'blocked', nodes: [node] }])[0];
  assert.equal(summary.ready, false, '失败节点的真实运行也须等结果保存');
  runs[0].resultReady = true;
  assert.equal(groupChatSummaries(room(current), runs, [{ id: 'task', round: 0, state: 'blocked', nodes: [node] }])[0].ready, true);
});

test('仅当前无真实错误且结果保存完成的 waiting_input 岗位视为正常等待回复', () => {
  const captain = turn('captain', 'read');
  const value = room(round('current', [captain], { state: 'running', automatic: { taskId: 'task',
    config: { revision: 1, name: '冻结团队', members: [captain.member] }, inputs: [] } }));
  const node: TeamNode = { id: captain.id, runId: captain.runId, round: 0, profileId: 'leader', stage: 'plan',
    status: 'waiting_input', dependencies: [], attempt: 1, reason: '启动时备用模型理由', createdAt: at, updatedAt: at };
  const source = run(captain.runId, '是否允许在原范围内继续？', { resultReady: true });
  const read = () => groupChatSummaries(value, [source], [{ id: 'task', round: 0, state: 'waiting_input', nodes: [node] }])[0];
  assert.equal(read().members[0].waitingForInput, true);
  assert.equal(read().status, 'running'); assert.equal(read().ready, false); assert.deepEqual(read().blockers, []);
  node.error = '宿主拒收真实错误 L709';
  assert.equal(read().members[0].waitingForInput, undefined);
  assert.equal(read().members[0].state, 'failed'); assert.equal(read().blockers[0].text, node.error);
  node.error = undefined; source.error = '运行真实错误 L710';
  assert.equal(read().members[0].waitingForInput, undefined); assert.equal(read().blockers[0].text, source.error);
  source.error = ''; source.resultReady = false;
  assert.equal(read().members[0].waitingForInput, undefined);
  source.resultReady = true; node.round = -1;
  assert.equal(read().members[0].waitingForInput, undefined); assert.equal(read().members[0].current, false);
});

test('取消轮次仍等真实运行停止，空轮与没有实际结果的完成轮不显示汇总', () => {
  const current = round('current', [turn('member', 'read', { status: 'cancelled' })], { state: 'cancelled' });
  const memberRun = run('member', '取消前的部分说明 L710', { status: 'running' });
  assert.equal(groupChatSummaries(room(current), [memberRun])[0].ready, false);
  memberRun.status = 'cancelled';
  assert.equal(groupChatSummaries(room(current), [memberRun])[0].ready, true);
  assert.equal(groupChatSummaries(room(round('empty', [])), [])[0].ready, false);
  assert.equal(groupChatSummaries(room(round('missing', [turn('member', 'read')])), [run('member', '')])[0].ready, false);
});

test('当前重试只读当前run，旧备用失败和旧turn结果不覆盖空的新执行或已成功的新汇报', () => {
  const binding = { provider: 'codex' as const, model: 'fixture', reasoningEffort: '' as const };
  const currentTurn = turn('qa', 'verify', { runId: 'retry', attempt: 2, error: '旧发言错误 L201', result: report({ taskResult: { role: 'verifier', status: 'failed', summary: '旧失败' } }),
    fallbacks: [{ from: binding, to: binding, reason: '原额度失败', runId: 'old', at }] });
  const value = room(round('current', [currentTurn]));
  const previous = run('old', report({ taskResult: { role: 'verifier', status: 'failed', summary: '旧备用失败 L202' } }), { status: 'failed', error: '旧运行错误 L203' });
  const retry = run('retry', '', { status: 'running' });
  let summary = groupChatSummaries(value, [previous, retry])[0];
  assert.equal(summary.status, 'running'); assert.equal(summary.blockers.length, 0); assert.equal(summary.members[0].summary, '');
  retry.status = 'completed'; retry.result = report({ taskResult: { role: 'verifier', status: 'succeeded', summary: '重试后结果 L204' } });
  summary = groupChatSummaries(value, [previous, retry])[0];
  assert.equal(summary.status, 'returned'); assert.equal(summary.blockers.length, 0);
  assert.equal(summary.members[0].run, retry); assert.equal(summary.members[0].summary, '重试后结果 L204');
  assert.equal(previous.error, '旧运行错误 L203');
});

test('自动团队按宿主当前round判定有效节点，保留历史及同名多节点，不凭中文名猜协调者', () => {
  const captain = turn('captain-node', 'read'), oldQa = turn('old-qa', 'verify'), qa = turn('qa', 'verify'), otherQa = turn('other-qa', 'verify');
  for (const item of [oldQa, qa, otherQa]) item.member = { ...item.member, id: 'same-custom-qa', name: '同名测试' };
  const current = round('current', [captain, oldQa, qa, otherQa], { automatic: { taskId: 'task', config: { revision: 1, name: '冻结团队', members: [captain.member, qa.member] }, inputs: [] } });
  const failure = report({ taskResult: { role: 'verifier', status: 'failed', summary: '旧轮失败 L301' } });
  const success = report({ taskResult: { role: 'verifier', status: 'succeeded', summary: '本轮复测已汇报 L302' } });
  const runs = [run(captain.runId, '', { team: { taskId: 'task', nodeId: captain.id, profileId: 'leader', stageKey: 'key', profileRevision: 1 } }),
    run(oldQa.runId, failure), run(qa.runId, success), run(otherQa.runId, success)];
  const node = (id: string, round: number): TeamNode => ({ id, round, runId: id, profileId: 'verifier', stage: 'verify',
    status: 'completed', dependencies: [], attempt: 1, createdAt: at, updatedAt: at });
  const task = { id: 'task', round: 1, state: 'completed' as const, nodes: [node(captain.id, 0), node(oldQa.id, 0), node(qa.id, 1), node(otherQa.id, 1)] };
  const summary = groupChatSummaries(room(current), runs, [task])[0];
  assert.equal(summary.members.length, 4); assert.deepEqual(summary.members.map(item => item.current), [false, false, true, true]);
  assert.equal(summary.total, 2); assert.equal(summary.status, 'returned'); assert.equal(summary.blockers.length, 0);
  assert.equal(summary.ready, true, '旧轮空报告不阻塞当前轮已保存的成功结果');
  assert.equal(summary.coordinator?.turn, captain);
});

test('Vue响应式自动群聊保留负责人问候原文，成员快照不随嵌套配置变化', () => {
  const text = '你好！原始回复 L601\n第二行保持原文';
  const captain = turn('captain-node', 'read');
  captain.member.binding = { provider: 'codex', model: 'fixture', reasoningEffort: '' };
  const value = reactive(room(round('current', [captain], { automatic: { taskId: 'task',
    config: { revision: 1, name: '冻结团队', members: [captain.member] }, inputs: [] } })));
  const node: TeamNode = { id: captain.id, round: 0, runId: captain.runId, profileId: 'leader', stage: 'plan',
    status: 'completed', dependencies: [], attempt: 1, createdAt: at, updatedAt: at };
  const tasks = reactive([{ id: 'task', round: 0, state: 'completed' as const, nodes: [node] }]);
  const runs = reactive([run(captain.runId, report({ conversationReply: { text, resumeWorkflow: false } }), {
    mode: 'ask', team: { taskId: 'task', nodeId: captain.id, profileId: 'leader', stageKey: 'key', profileRevision: 1 } })]);
  const summary = groupChatSummaries(value, runs, tasks)[0];
  assert.equal(summary.members.length, 1);
  assert.equal(summary.members[0].summary, text);
  assert.equal(summary.members[0].hasLocalSummary, true);
  assert.equal(summary.coordinator, summary.members[0]);
  assert.equal(summary.status, 'returned');
  const config = value.rounds[0].automatic!.config, frozen = groupTeamMembers(config);
  config.members[0].binding!.model = 'changed-model';
  config.members[0].instructions = '变更后的职责';
  assert.equal(frozen.leader!.binding!.model, 'fixture');
  assert.equal(frozen.leader!.instructions, '原始职责 L002');
});

test('保存的验收失败或重大审查发现不能因taskResult自报succeeded被遗漏', () => {
  const current = round('current', [turn('qa', 'verify'), turn('audit', 'review')]);
  const runs = [run('qa', report({ taskResult: { role: 'verifier', status: 'succeeded', summary: '部分检查完成',
    acceptance: [{ id: 'AC-1', status: 'failed', evidence: '明确失败 L401' }] } })),
    run('audit', report({ taskResult: { role: 'reviewer', status: 'succeeded', verdict: 'approved',
      findings: [{ id: 'F-1', severity: 'blocker', file: 'src/a.ts', problem: '重大问题 L402' }] } }))];
  const summary = groupChatSummaries(room(current), runs)[0];
  assert.equal(summary.status, 'blocked');
  assert.ok(summary.blockers.some(item => item.text.includes('明确失败 L401')));
  assert.ok(summary.blockers.some(item => item.text === '重大问题 L402'));
});

test('取消和空记录保持原始边界，无效或重复报告不会被当作有效全局交付', () => {
  const first = round('first', [], { state: 'cancelled' });
  const second = round('second', [turn('last', 'read')]);
  const source = report({ requirementProgress: completeProgress() });
  const summaries = groupChatSummaries(room(first, second), [run('last', source + '\n' + source)]);
  assert.equal(summaries[0].status, 'cancelled'); assert.equal(summaries[0].coordinator, undefined);
  assert.equal(summaries[1].report, undefined);
  assert.equal(groupChatSummaries(room(round('empty', [])), [])[0].status, 'running');
});

test('CLI完成但没有保存任何结果时保留明确缺项，不称成员已汇报或开发完成', () => {
  const value = room(round('current', [turn('last', 'read')]));
  const summary = groupChatSummaries(value, [run('last', '')])[0];
  assert.equal(summary.status, 'blocked');
  assert.equal(summary.report, undefined);
  assert.equal(summary.members[0].hasLocalSummary, false);
  assert.equal(summary.members[0].outcome?.label, '缺少汇报结果');
  assert.equal(summary.blockers[0].text, '该岗位尚未保存结果');
  assert.doesNotMatch(summary.headline, /完成|已返回/);
});

test('旧群定向询问只读成员不冒充负责人，只有明确leader成员提供负责人元数据', () => {
  const reporter = turn('reporter', 'read'), analyst = turn('analyst', 'read');
  assert.equal(groupChatSummaries(room(round('direct', [reporter, analyst])), [run('reporter', '交付说明'), run('analyst', '分析说明')])[0].coordinator, undefined);
  const leader = turn('leader', 'read');
  const summary = groupChatSummaries(room(round('with-leader', [reporter, leader])), [run('reporter', '交付说明'), run('leader', '负责人说明')])[0];
  assert.equal(summary.coordinator?.turn, leader);
});

test('自动同轮已跳过的失败审查保留历史但不阻塞后续有效成功节点', () => {
  const oldReview = turn('old-review', 'review'), currentReview = turn('current-review', 'review');
  const current = round('current', [oldReview, currentReview], { automatic: { taskId: 'task',
    config: { revision: 1, name: '冻结团队', members: [currentReview.member] }, inputs: [] } });
  const node = (id: string, status: TeamNode['status']): TeamNode => ({ id, round: 1, runId: id, profileId: 'reviewer', stage: 'review',
    status, dependencies: [], attempt: 1, createdAt: at, updatedAt: at });
  const runs = [run('old-review', report({ taskResult: { role: 'reviewer', status: 'failed', verdict: 'changes_requested', summary: '已被跳过的旧失败' } })),
    run('current-review', report({ taskResult: { role: 'reviewer', status: 'succeeded', verdict: 'approved', summary: '当前审查已返回' } }))];
  const summary = groupChatSummaries(room(current), runs, [{ id: 'task', round: 1, state: 'completed',
    nodes: [node('old-review', 'skipped'), node('current-review', 'completed')] }])[0];
  assert.equal(summary.members.length, 2);
  assert.equal(summary.members[0].state, 'cancelled');
  assert.equal(summary.members[0].current, false);
  assert.equal(summary.members[0].summary, '已被跳过的旧失败');
  assert.equal(summary.total, 1);
  assert.equal(summary.blockers.length, 0);
  assert.equal(summary.status, 'returned');
  assert.equal(summary.ready, true, '已跳过的旧失败不阻塞当前有效节点的完成汇总');
});

test('明确非零自测退出码覆盖乐观状态，零值和null或未知退出码不推断失败', () => {
  const value = room(round('current', [turn('implement', 'write')]));
  const result = (selfTests: unknown[]) => report({ taskResult: { role: 'implementer', status: 'succeeded', summary: '成员自报完成', selfTests } });
  let summary = groupChatSummaries(value, [run('implement', result([{ command: 'npm run check L501', exitCode: 2 }]))])[0];
  assert.equal(summary.status, 'blocked');
  assert.equal(summary.members[0].outcome?.state, 'failed');
  assert.ok(summary.blockers.some(item => item.text === 'npm run check L501：退出码 2'));
  summary = groupChatSummaries(value, [run('implement', result([{ command: '通过命令', exitCode: 0 },
    { command: '未取得退出码 L502', exitCode: null }, { command: '未知退出码 L503', exitCode: 'unknown' }]))])[0];
  assert.equal(summary.status, 'returned');
  assert.equal(summary.members[0].outcome?.state, 'returned');
  assert.equal(summary.blockers.length, 0);
});
