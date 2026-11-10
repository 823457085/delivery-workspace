import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AgentRun } from '../shared/agent-runtime.js';
import { groupRoomSchema } from '../shared/agent-group-chat.js';
import { groupChatPresentation, recentGroupTurns } from '../src/features/agent-workbench/group-chat-progress.js';
import { groupChatSummaries } from '../src/features/agent-workbench/group-chat-summary.js';

function fixture() {
  const now = new Date().toISOString();
  const room = groupRoomSchema.parse({ id: randomUUID(), title: '账户升级', workspacePath: '/fixture/web', executionPath: '/fixture/web', paused: false,
    rounds: [{ id: randomUUID(), requestId: 'request', requestHash: 'hash', text: '请实现账户升级', state: 'running', accessMode: 'workspace', createdAt: now, updatedAt: now,
      turns: ['技术负责人', '前端开发', '测试验证', '代码审查', '交付整理'].map((name, index) => ({ id: randomUUID(), runId: randomUUID(),
        member: { id: `member-${index}`, name, capability: index === 2 ? 'verify' : 'read', instructions: name, enabled: true,
          binding: { provider: 'codex', model: 'fixture-model', reasoningEffort: '' } }, attempt: 1, status: 'pending', updatedAt: now })) }], createdAt: now, updatedAt: now });
  const round = room.rounds[0]!;
  const run = (index: number, status: AgentRun['status'], options: Partial<AgentRun> = {}) => ({ id: round.turns[index]!.runId,
    status, result: '', error: '', resultReady: true, ...options } as AgentRun);
  return { room, round, run };
}

test('消息末尾显示实际运行，包括追问前已经开始的成员，不被较新的旧失败覆盖', () => {
  const { room, run } = fixture();
  const view = groupChatPresentation(room, [run(0, 'running', { createdAt: '2026-11-05T00:00:00Z' }),
    run(1, 'failed', { createdAt: '2026-11-05T00:01:00Z', error: '历史错误 L001' })]);
  const latest = recentGroupTurns(view.rounds[0].turns, '2026-11-05T00:02:00Z');
  assert.deepEqual(latest.map(item => item.turn.member.name), ['技术负责人']);
  assert.equal(view.active?.run?.status, 'running');
});

test('当前重试结束后保留本次最新回复，新的用户消息不会收到旧回复冒充反馈', () => {
  const { room, run } = fixture();
  const view = groupChatPresentation(room, [run(0, 'completed', { createdAt: '2026-11-05T00:00:00Z', result: '旧回复 L001' }),
    run(1, 'completed', { createdAt: '2026-11-05T00:03:00Z', result: '新回复 L002' })]);
  const latest = recentGroupTurns(view.rounds[0].turns, '2026-11-05T00:02:00Z');
  assert.equal(latest[0]?.run?.result, '新回复 L002');
  assert.deepEqual(recentGroupTurns(view.rounds[0].turns, '2026-11-05T00:04:00Z'), []);
});

test('并行成员与正在保存结果均保留末尾反馈，不提前显示为已回复', () => {
  const { room, run } = fixture();
  const view = groupChatPresentation(room, [run(0, 'running'), run(1, 'completed', { resultReady: false })]);
  const latest = recentGroupTurns(view.rounds[0].turns, '');
  assert.deepEqual(latest.map(item => item.state), ['running', 'saving']);
});

test('当前成员完整展示，四个未派发成员收起；顺序、内容和运行标识不变', () => {
  const { room, round, run } = fixture(), before = structuredClone(room);
  const view = groupChatPresentation(room, [run(0, 'running')]);
  assert.equal(view.status, '技术负责人正在处理');
  assert.equal(view.rounds[0]!.summary, '第 1/5 步 · 技术负责人正在处理');
  assert.deepEqual(view.rounds[0]!.started.map(item => item.turn.id), [round.turns[0]!.id]);
  assert.deepEqual(view.rounds[0]!.pending.map(item => [item.step, item.turn.member.name, item.label]),
    [[2, '前端开发', '待执行'], [3, '测试验证', '待执行'], [4, '代码审查', '待执行'], [5, '交付整理', '待执行']]);
  assert.deepEqual(room, before);
});

test('有运行记录的 queued 才显示排队中；无运行记录的准备与普通待执行分开', () => {
  const { room, round, run } = fixture();
  assert.equal(groupChatPresentation(room, [run(0, 'queued')]).rounds[0]!.focus?.label, '排队中');
  assert.equal(groupChatPresentation(room, []).rounds[0]!.focus?.label, '待执行');
  round.turns[0]!.status = 'queued';
  assert.equal(groupChatPresentation(room, []).rounds[0]!.focus?.label, '正在派发');
  round.turns[0]!.status = round.turns[1]!.status = 'completed'; round.turns[2]!.status = 'queued';
  assert.equal(groupChatPresentation(room, []).rounds[0]!.focus?.label, '准备验证副本');
});

test('接续后自动显示下一位的完整消息；完成记录、回复和结果保存状态保留', () => {
  const { room, run } = fixture();
  let view = groupChatPresentation(room, [run(0, 'completed', { result: '原始回复 L123' }), run(1, 'running')]);
  assert.equal(view.rounds[0]!.started.length, 2); assert.equal(view.rounds[0]!.pending.length, 3);
  assert.equal(view.rounds[0]!.summary, '第 2/5 步 · 前端开发正在处理');
  assert.equal(view.rounds[0]!.started[0]!.run?.result, '原始回复 L123');
  view = groupChatPresentation(room, [run(0, 'completed', { resultReady: false })]);
  assert.equal(view.rounds[0]!.focus?.label, '正在保存结果');
  assert.equal(view.status, '技术负责人正在保存结果');
});

test('用户暂停区分停止中与已暂停，不能把暂停当作前序执行失败', () => {
  const { room, run } = fixture(); room.paused = true;
  let view = groupChatPresentation(room, [run(0, 'running')]);
  assert.equal(view.status, '正在停止');
  assert.ok(view.rounds[0]!.pending.every(item => item.label === '已暂停'));
  view = groupChatPresentation(room, [run(0, 'interrupted', { error: '用户中断原文 L456' })]);
  assert.equal(view.status, '已暂停'); assert.equal(view.rounds[0]!.focus?.label, '已暂停');
  assert.ok(view.rounds[0]!.pending.every(item => item.label === '已暂停'));
});

test('工作台重启暂停显示等待续跑，恢复同一运行后切回正在处理', () => {
  const { room, round, run } = fixture();
  round.turns.splice(1);
  const stoppedForRestart = run(0, 'cancelled', { pausedForEdit: true, resumeAfterWorkspaceRestart: true });
  const waiting = groupChatPresentation(room, [stoppedForRestart]);
  assert.equal(waiting.awaitingRestart, true);
  assert.equal(waiting.status, '技术负责人等待重启后续跑');
  assert.match(waiting.hint, /自动续接原运行/);
  assert.equal(groupChatSummaries(room, [stoppedForRestart])[0]?.status, 'running');
  const running = groupChatPresentation(room, [run(0, 'running')]);
  assert.equal(running.awaitingRestart, false);
  assert.equal(running.status, '技术负责人正在处理');
});

test('前序失败后的成员显示被阻塞和具体原因；失败卡片及跨轮阻塞保持可见', () => {
  const { room, round, run } = fixture(); room.paused = true; round.state = 'failed';
  const next = structuredClone(round); next.id = randomUUID(); next.state = 'queued';
  next.turns.forEach(turn => { turn.id = randomUUID(); turn.runId = randomUUID(); }); room.rounds.push(next);
  const error = 'Cursor CLI 执行失败：当前工作区尚未信任 L789';
  const view = groupChatPresentation(room, [run(0, 'completed'), run(1, 'failed', { error })]);
  assert.equal(view.status, '被阻塞'); assert.equal(view.rounds[0]!.focus?.turn.member.name, '前端开发');
  assert.equal(view.rounds[0]!.started[1]!.run?.error, error);
  for (const roundView of view.rounds) for (const item of roundView.pending) { assert.equal(item.label, '被阻塞'); assert.ok(item.reason.includes(error)); }
});

test('重试等待派发时仍显示完整成员卡片，保留备用模型和原失败记录入口', () => {
  const { room, round } = fixture(); const turn = round.turns[0]!;
  turn.attempt = 2; turn.fallbacks = [{ from: turn.member.binding!, to: { ...turn.member.binding!, model: 'backup' }, reason: '原失败原因', runId: randomUUID(), at: new Date().toISOString() }];
  const view = groupChatPresentation(room, []);
  assert.equal(view.rounds[0]!.started.length, 1); assert.equal(view.rounds[0]!.pending.length, 4);
  assert.equal(view.rounds[0]!.started[0]!.turn.fallbacks?.[0]?.reason, '原失败原因');
});

test('实际运行已恢复时不沿用旧轮次的失败标题；后续仍暂停，当前运行结束后才能继续', () => {
  const { room, round, run } = fixture(); room.paused = true; round.state = 'failed';
  const view = groupChatPresentation(room, [run(0, 'completed'), run(1, 'running')]);
  assert.equal(view.status, '前端开发正在处理');
  assert.equal(view.rounds[0]!.focus?.step, 2);
  assert.ok(view.rounds[0]!.pending.every(item => item.label === '已暂停'));
  assert.equal(view.waitingForRun, true);
  assert.match(view.progressText, /1\/5.*前端开发正在处理/);
  assert.match(view.hint, /当前成员仍在执行.*后续步骤已暂停/);
  const finished = groupChatPresentation(room, [run(0, 'completed'), run(1, 'completed')]);
  assert.equal(finished.status, '已暂停'); assert.equal(finished.waitingForRun, false);
});

test('整轮完成、取消和空群保留终态；未执行就取消的成员不生成大消息', () => {
  const { room, round, run } = fixture();
  assert.equal(groupChatPresentation(undefined, []).status, '等待消息');
  round.state = 'completed'; round.turns.forEach(turn => turn.status = 'completed');
  let view = groupChatPresentation(room, []);
  assert.equal(view.status, '本轮完成'); assert.equal(view.rounds[0]!.pending.length, 0); assert.equal(view.rounds[0]!.focus, undefined);
  view = groupChatPresentation(room, [run(4, 'completed', { resultReady: false })]);
  assert.equal(view.rounds[0]!.focus?.label, '正在保存结果'); assert.notEqual(view.status, '本轮完成');
  round.state = 'cancelled'; round.turns.forEach(turn => turn.status = 'cancelled');
  view = groupChatPresentation(room, []);
  assert.equal(view.status, '已取消'); assert.equal(view.rounds[0]!.started.length, 0); assert.equal(view.rounds[0]!.pending.length, 5);
});

test('CLI 已回复但宿主拒收结果时，保留正文并展示真实阻塞及后续等待原因', () => {
  const { room, round, run } = fixture(), error = '改动超出允许范围（未自动回滚）：.local/logs/pm2-out.log、src/AgentGroupChat.vue';
  const member = round.turns[0]!;
  round.automatic = { taskId: 'task', inputs: [], config: { revision: 1, name: '本轮团队', members: round.turns.map(turn => turn.member) } };
  round.state = 'failed';
  const source = run(0, 'completed', { result: 'Jira 调整已生效，本轮只读核验。', createdAt: '2026-11-07T01:17:00Z' });
  const before = structuredClone({ room, source });
  for (const status of ['blocked', 'waiting_input', 'needs_reconciliation'] as const) {
    const summaries = groupChatSummaries(room, [source], [{ id: 'task', round: 0, state: 'blocked', nodes: [{
      id: member.id, runId: member.runId, stage: 'implement', profileId: 'engineer', status,
      dependencies: [], attempt: 4, round: 0, error, createdAt: room.createdAt, updatedAt: room.updatedAt,
    }] }]);
    const view = groupChatPresentation(room, [source], summaries);
    assert.equal(view.rounds[0]!.turns[0]!.state, 'failed', status);
    assert.equal(view.rounds[0]!.turns[0]!.label, '结果接收受阻', status);
    assert.equal(view.rounds[0]!.turns[0]!.reason, error, status);
    assert.equal(view.rounds[0]!.turns[0]!.run?.result, source.result, '已保存正文保持可读');
    assert.equal(view.rounds[0]!.pending[0]!.label, '被阻塞');
    assert.ok(view.rounds[0]!.pending[0]!.reason.includes(error));
    assert.equal(view.status, '被阻塞');
  }
  assert.deepEqual({ room, source }, before, '只修改展示投影，不伪造运行或工作流状态');
});

test('岗位成功提问后显示等待回复，不将启动时的备用理由显示为结果接收故障', () => {
  const { room, round, run } = fixture(), member = round.turns[0]!;
  round.turns.splice(1);
  round.automatic = { taskId: 'task', inputs: [], config: { revision: 1, name: '本轮团队', members: [member.member] } };
  const source = run(0, 'completed', { result: '```delivery-report\n' + JSON.stringify({ version: 1,
    taskPlan: { reason: '已完成恢复核对，等待审查配置调整的答复。', questions: [{ id: 'Q-1', text: '是否允许调整审查配置？', blocking: true }] },
    taskResult: { role: 'leader', status: 'blocked', summary: '剩余独立审查尚未执行。' },
  }) + '\n```' });
  const task = { id: 'task', round: 0, state: 'waiting_input' as const, nodes: [{
    id: member.id, runId: member.runId, stage: 'plan' as const, profileId: 'leader' as const, status: 'waiting_input' as const,
    dependencies: [], attempt: 1, round: 0, reason: '主模型不可用，使用备用：当前自动协作暂不支持此推理强度',
    createdAt: room.createdAt, updatedAt: room.updatedAt,
  }] };
  const before = structuredClone({ room, source, task });
  const summaries = groupChatSummaries(room, [source], [task]), view = groupChatPresentation(room, [source], summaries);
  assert.equal(summaries[0]!.members[0]!.waitingForInput, true);
  assert.equal(summaries[0]!.members[0]!.state, 'completed');
  assert.deepEqual(summaries[0]!.blockers, []);
  assert.equal(view.rounds[0]!.focus?.label, '等待回复');
  assert.equal(view.rounds[0]!.focus?.reason, '');
  assert.equal(view.status, '技术负责人等待回复');
  assert.equal(view.hint, '等待你的回复');
  assert.equal(view.active, undefined);
  assert.deepEqual({ room, source, task }, before);
});

test('工作流旧阻塞不覆盖正在运行、保存、重启续跑或不同重试身份', () => {
  const { room, round, run } = fixture(), member = round.turns[0]!;
  round.automatic = { taskId: 'task', inputs: [], config: { revision: 1, name: '本轮团队', members: round.turns.map(turn => turn.member) } };
  for (const options of [{ status: 'running' }, { status: 'queued' }, { status: 'completed', resultReady: false },
    { status: 'cancelled', pausedForEdit: true, resumeAfterWorkspaceRestart: true }] as const) {
    const source = run(0, options.status, options);
    const summaries = groupChatSummaries(room, [source], [{ id: 'task', round: 0, state: 'blocked', nodes: [{
      id: member.id, runId: member.runId, stage: 'implement', profileId: 'engineer', status: 'blocked',
      dependencies: [], attempt: 1, round: 0, error: '旧错误', createdAt: room.createdAt, updatedAt: room.updatedAt,
    }] }]);
    const view = groupChatPresentation(room, [source], summaries);
    assert.ok(['running', 'queued', 'saving'].includes(view.rounds[0]!.turns[0]!.state));
    assert.doesNotMatch(view.rounds[0]!.turns[0]!.reason, /旧错误/);
  }
  const source = run(0, 'completed', { result: '新重试结果' });
  const summaries = groupChatSummaries(room, [source], [{ id: 'task', round: 0, state: 'blocked', nodes: [{
    id: member.id, runId: 'old-run', stage: 'implement', profileId: 'engineer', status: 'blocked',
    dependencies: [], attempt: 1, round: 0, error: '旧错误', createdAt: room.createdAt, updatedAt: room.updatedAt,
  }] }]);
  assert.equal(groupChatPresentation(room, [source], summaries).rounds[0]!.turns[0]!.label, '已回复');
});
