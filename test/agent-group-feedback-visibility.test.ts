/** 加载群聊组件真实 recentTurns 声明，验证折叠历史后仍能看到当前失败和并行进展。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { computed, shallowRef, type ComputedRef } from 'vue';
import type { AgentRun } from '../shared/agent-runtime.js';
import type { GroupRoom, GroupRound, GroupTurn } from '../shared/agent-group-chat.js';
import type { TeamNode } from '../shared/agent-team.js';
import { groupChatPresentation, recentGroupTurns, type GroupTurnPresentation } from '../src/features/agent-workbench/group-chat-progress.js';
import { groupChatSummaries } from '../src/features/agent-workbench/group-chat-summary.js';
import { groupRoundReply } from '../src/features/agent-workbench/group-chat-replies.js';
import type { groupChatMessages } from '../src/features/agent-workbench/group-chat-messages.js';

const at = '2026-11-05T10:00:00.000Z', later = '2026-11-05T10:05:00.000Z';
function run(id: string, status: AgentRun['status'], extra: Partial<AgentRun> = {}): AgentRun {
  return { id, provider: 'codex', mode: 'agent', accessMode: 'workspace', model: 'fixture', reasoningEffort: '',
    objective: '本轮目标 L001', workspacePath: '/fixture', branch: '', headSha: '', status,
    sessionId: '', pid: null, result: '', error: '', events: [], createdAt: at, updatedAt: at, ...extra };
}
function turn(id: string, status: GroupTurn['status'], extra: Partial<GroupTurn> = {}): GroupTurn {
  return { id, runId: id, member: { id, name: `成员 ${id}`, capability: 'read', instructions: '本轮职责', enabled: true },
    attempt: 1, status, result: '', error: '', updatedAt: at, ...extra };
}
function round(id: string, turns: GroupTurn[], extra: Partial<GroupRound> = {}): GroupRound {
  return { id, requestId: id, requestHash: id, text: '本轮目标 L001', attachmentIds: [], accessMode: 'workspace',
    state: 'running', turns, createdAt: at, updatedAt: at, ...extra };
}
type SummaryTask = NonNullable<Parameters<typeof groupChatSummaries>[2]>[number];
function fixture(rounds: GroupRound[], initialRuns: AgentRun[], tasks: SummaryTask[] = []) {
  const source = readFileSync(new URL('../src/features/agent-workbench/AgentGroupChat.vue', import.meta.url), 'utf8')
    .match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
  const tree = ts.createSourceFile('AgentGroupChat.ts', source, ts.ScriptTarget.Latest, true);
  const declarations = tree.statements.flatMap(statement => ts.isVariableStatement(statement)
    ? [...statement.declarationList.declarations].filter(declaration => declaration.name.getText(tree) === 'recentTurns') : []);
  assert.equal(declarations.length, 1, '必须执行组件真实 recentTurns 声明');
  const code = ts.transpileModule(`const ${declarations[0]!.getText(tree)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const retryCode = ts.transpileModule(tree.statements.filter(statement => ts.isFunctionDeclaration(statement)
    && ['runFor', 'needsTrust', 'canRetry'].includes(statement.name?.text || '')).map(statement => statement.getText(tree)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const room = shallowRef<GroupRoom>({ id: 'group', title: '群聊', workspacePath: '/fixture', executionPath: '/fixture',
    paused: false, cursorTrustPaths: [], rounds, createdAt: at, updatedAt: at });
  const runs = shallowRef(initialRuns);
  const collaborationMessages = shallowRef<ReturnType<typeof groupChatMessages>>([]);
  const summaries = computed(() => groupChatSummaries(room.value, runs.value, tasks));
  const presentation = computed(() => groupChatPresentation(room.value, runs.value, summaries.value));
  const summaryByTurn = computed(() => new Map(summaries.value.flatMap(summary => summary.members.map(member => [member.turn.id, member] as const))));
  const roundReply = (id: string) => groupRoundReply(room.value.rounds.find(round => round.id === id), runs.value);
  const deliveredRounds = shallowRef(new Set<string>());
  const finalDelivery = (id: string) => deliveredRounds.value.has(id) ? { text: '本轮统一交付结论' } : undefined;
  const pendingLogin = shallowRef(false), collaborationTasks = shallowRef(tasks);
  const dependencies = { computed, room, runs, pendingLogin, collaborationTasks, presentation, collaborationMessages, summaryByTurn, roundReply, finalDelivery, recentGroupTurns };
  const recentTurns = new Function(...Object.keys(dependencies), `${code}\nreturn recentTurns;`)(...Object.values(dependencies)) as ComputedRef<GroupTurnPresentation[]>;
  const canRetry = new Function(...Object.keys(dependencies), `${retryCode}\nreturn canRetry;`)(...Object.values(dependencies)) as (turn: GroupTurn) => boolean;
  return { room, runs, summaries, recentTurns, roundReply, deliveredRounds, canRetry, pendingLogin, collaborationTasks, ids: () => recentTurns.value.map(item => item.turn.id) };
}

test('原模型重试只针对当前已停止的失败或中断成员，完成、历史、运行中及信任故障不显示普通重试', () => {
  const current = turn('current', 'failed'), old = turn('old', 'failed');
  const f = fixture([round('old-round', [old]), round('latest-round', [current])], [run('old', 'failed'), run('current', 'failed')]);
  assert.equal(f.canRetry(current), true); assert.equal(f.canRetry(old), false);
  for (const status of ['queued', 'running', 'completed', 'cancelled'] as const) {
    f.runs.value = [run('current', status)]; assert.equal(f.canRetry(current), false, status);
  }
  f.runs.value = [run('current', 'interrupted')]; assert.equal(f.canRetry(current), false);
  const recovery: NonNullable<AgentRun['recovery']> = { previousStatus: 'running', previousPid: 123, state: 'completed', checkedAt: at, message: '已确认停止' };
  f.runs.value = [run('current', 'interrupted', { recovery })]; assert.equal(f.canRetry(current), true);
  for (const state of ['active', 'pending', 'needs-review'] as const) {
    f.runs.value = [run('current', 'interrupted', { recovery: { ...recovery, state } })]; assert.equal(f.canRetry(current), false, state);
  }
  f.runs.value = [run('current', 'failed', { pid: 123 })]; assert.equal(f.canRetry(current), false);
  f.runs.value = [run('current', 'failed', { provider: 'cursor', error: '当前工作区尚未信任' })]; assert.equal(f.canRetry(current), false);
  f.runs.value = [run('current', 'failed')];
  f.pendingLogin.value = true; assert.equal(f.canRetry(current), false);
  f.pendingLogin.value = false;
  f.room.value = { ...f.room.value, rounds: [round('cancelled', [current], { state: 'cancelled' })] };
  assert.equal(f.canRetry(current), false);
});

test('自动团队仅当前轮受阻节点可重试，已完成节点和旧运行不提供入口', () => {
  const current = turn('review', 'failed');
  const node: TeamNode = { id: current.id, runId: current.runId, round: 1, profileId: 'reviewer', stage: 'review', status: 'blocked',
    dependencies: [], attempt: 1, createdAt: at, updatedAt: at };
  const value = round('current', [current], { automatic: { taskId: 'task', inputs: [], config: { revision: 1, name: '团队', members: [current.member] } } });
  const task: SummaryTask = { id: 'task', round: 1, state: 'waiting_input', nodes: [node] };
  const f = fixture([value], [run(current.runId, 'failed')], [task]);
  assert.equal(f.canRetry(current), true);
  for (const patch of [{ state: 'completed' as const }, { state: 'awaiting_acceptance' as const }, { state: 'cancelled' as const }, { round: 2 },
    { nodes: [{ ...node, status: 'completed' as const }] }, { nodes: [{ ...node, runId: 'new-run' }] }]) {
    f.collaborationTasks.value = [{ ...task, ...patch }]; assert.equal(f.canRetry(current), false);
  }
});

test('并行成员 A 失败、B 运行中时都保持常显，轮询读取当前错误原文和运行对象', () => {
  const a = run('a', 'failed', { error: '当前错误 L001\n[原始记录](/api/evidence)' });
  const b = run('b', 'running');
  const f = fixture([round('current', [turn('a', 'failed'), turn('b', 'running')])], [a, b]);
  assert.deepEqual(f.ids(), ['a', 'b']);
  assert.equal(f.recentTurns.value[0]!.run, a);
  assert.equal(f.recentTurns.value[0]!.run!.error, a.error);
  const fresh = { ...a, error: '最新错误 L002', updatedAt: later };
  f.runs.value = [fresh, { ...b, result: '正在检查 L003', updatedAt: later }];
  assert.deepEqual(f.ids(), ['a', 'b']);
  assert.equal(f.recentTurns.value[0]!.run, fresh);
});

test('同任务中 current=false 的历史失败不重新常显，当前并行进展仍可见', () => {
  const turns = [turn('old', 'failed'), turn('active', 'running')];
  const nodes: TeamNode[] = turns.map((item, index) => ({ id: item.id, runId: item.runId,
    round: index, profileId: 'leader', stage: 'plan', status: index ? 'running' : 'blocked',
    dependencies: [], attempt: 1, createdAt: at, updatedAt: at }));
  const value = round('current', turns, { automatic: { taskId: 'task', inputs: [],
    config: { revision: 1, name: '原团队', members: turns.map(item => item.member) } } });
  const f = fixture([value], [run('old', 'failed', { error: '历史错误 L010' }), run('active', 'running')],
    [{ id: 'task', round: 1, state: 'running', nodes }]);
  assert.equal(f.summaries.value[0]!.members[0]!.current, false);
  assert.deepEqual(f.ids(), ['active']);
  assert.equal(f.summaries.value[0]!.members[0]!.run!.error, '历史错误 L010', '历史原文仍保留');
});

test('新用户轮次开始后不将旧轮失败带入末尾反馈', () => {
  const previous = round('previous', [turn('old', 'failed')], { state: 'failed' });
  const current = round('current', [turn('new', 'running')], { createdAt: later, updatedAt: later });
  const f = fixture([previous, current], [run('old', 'failed', { error: '旧轮错误 L020' }),
    run('new', 'running', { createdAt: later, updatedAt: later })]);
  assert.deepEqual(f.ids(), ['new']);
});

test('单成员正文已由直接回复显示时，各运行状态均不重复添加末尾反馈', () => {
  const text = '本轮原文 L030\n\n- [核对记录](/api/evidence)';
  for (const status of ['completed', 'failed', 'interrupted', 'running'] as const) {
    const f = fixture([round('direct', [turn('only', status)])], [run('only', status, { result: text })]);
    assert.equal(f.roundReply('direct'), text);
    assert.deepEqual(f.ids(), [], `${status} 状态只在直接回复处展示一次`);
  }
});

test('统一汇报生成后不再把成员历史结论放到末尾，新一轮活动仍可见', () => {
  const f = fixture([round('done', [turn('verify', 'completed'), turn('review', 'completed')], { state: 'completed' })],
    [run('verify', 'completed', { result: '验证完成，等待审查' }), run('review', 'completed', { result: '审查批准', createdAt: later, updatedAt: later })]);
  assert.deepEqual(f.ids(), ['review']);
  f.deliveredRounds.value = new Set(['done']);
  assert.deepEqual(f.ids(), [], '收尾只有统一汇报，逐岗原文仍在执行记录中');
  f.room.value = { ...f.room.value, rounds: [...f.room.value.rounds, round('next', [turn('active', 'running')], { createdAt: later, updatedAt: later })] };
  f.runs.value = [...f.runs.value, run('active', 'running', { createdAt: later, updatedAt: later })];
  assert.deepEqual(f.ids(), ['active'], '旧轮收尾不能隐藏新轮实际进度');
});

test('缺少 runId 的失败、中断和运行中成员按 turn.id 保留，重复候选只显示一次', () => {
  const turns = [turn('failed', 'failed', { runId: '', error: '派发失败 L040' }),
    turn('interrupted', 'interrupted', { runId: '', error: '派发中断 L041' }), turn('active', 'running', { runId: '' })];
  const f = fixture([round('current', turns)], []);
  assert.deepEqual(f.ids(), ['failed', 'interrupted', 'active']);
  const failed = run('failed', 'failed', { error: '执行失败 L042' });
  const deduplicated = fixture([round('single-failure', [turn('failed', 'failed')], { state: 'failed' })], [failed]);
  assert.deepEqual(deduplicated.ids(), ['failed'], '同一失败同时属于 attention 和 latest 时只显示一次');
});

test('协调回复较新时，CLI 已完成但结果接收受阻的原成员仍常显且保留阻塞原文', () => {
  const turns = [turn('engineer', 'completed'), turn('leader', 'completed')];
  const value = round('current', turns, { state: 'failed', automatic: { taskId: 'task', inputs: [],
    config: { revision: 1, name: '本轮团队', members: turns.map(item => item.member) } } });
  const error = '改动超出允许范围（未自动回滚）：.local/logs/pm2-out.log';
  const nodes: TeamNode[] = turns.map((item, index) => ({ id: item.id, runId: item.runId,
    round: 0, profileId: index ? 'leader' : 'engineer', stage: index ? 'plan' : 'implement', status: index ? 'completed' : 'blocked',
    dependencies: [], attempt: index ? 1 : 4, error: index ? '' : error, createdAt: at, updatedAt: later }));
  const f = fixture([value], [run('engineer', 'completed', { result: '本轮结果已保存' }),
    run('leader', 'completed', { result: '已核对，当前仍有阻塞', createdAt: later })], [{ id: 'task', round: 0, state: 'blocked', nodes }]);
  assert.ok(f.ids().includes('engineer'));
  const engineer = f.recentTurns.value.find(item => item.turn.id === 'engineer')!;
  assert.equal(engineer.label, '结果接收受阻');
  assert.equal(engineer.reason, error);
  assert.equal(engineer.run?.result, '本轮结果已保存');
});
