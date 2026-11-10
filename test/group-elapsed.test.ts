import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRun } from '../shared/agent-runtime';
import type { GroupRound, GroupTurn } from '../shared/agent-group-chat';
import type { TeamNode } from '../shared/agent-team';
import { formatElapsedTime, groupRoundTiming } from '../src/features/agent-workbench/group-elapsed';

const start = Date.parse('2026-11-06T00:00:00.000Z');
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
function turn(id: string, extra: Partial<GroupTurn> = {}): GroupTurn {
  return { id, runId: id, attempt: 1, status: 'completed', result: '', error: '', updatedAt: at(10),
    member: { id, name: id, capability: 'read', instructions: 'fixture', enabled: true }, ...extra };
}
function round(turns: GroupTurn[], extra: Partial<GroupRound> = {}): GroupRound {
  return { id: 'round', requestId: 'request', requestHash: 'hash', text: '', attachmentIds: [], accessMode: 'workspace',
    turns, state: 'completed', createdAt: at(0), updatedAt: at(0), ...extra };
}
function run(id: string, extra: Partial<AgentRun> = {}): AgentRun {
  return { id, status: 'completed', createdAt: at(1), updatedAt: at(10), resultReady: true, ...extra } as AgentRun;
}
function node(id: string, extra: Partial<TeamNode> & { purpose?: string } = {}): TeamNode {
  return { id, runId: id, round: 0, profileId: 'leader', stage: 'plan', status: 'completed', attempt: 1, dependencies: [],
    createdAt: at(0), updatedAt: at(10), ...extra };
}
function automatic(turns: GroupTurn[], extra: Partial<GroupRound> = {}) {
  return round(turns, { automatic: { taskId: 'task', config: { name: 'fixture', revision: 1, members: [] }, inputs: [] }, ...extra });
}

test('时长按秒取整，支持分钟/小时及非法数值，不出现负数或 NaN', () => {
  assert.equal(formatElapsedTime(0), '0秒');
  assert.equal(formatElapsedTime(31 * 60_000 + 28_999), '31分钟 28秒');
  assert.equal(formatElapsedTime(3_723_000), '1小时 2分钟 3秒');
  for (const value of [-1000, Number.NaN, Infinity, -Infinity]) assert.equal(formatElapsedTime(value), '0秒');
});

test('本轮运行与结果落盘期间实时计时，不受其他群或历史轮次活动影响', () => {
  const value = round([turn('current')], { state: 'running' });
  assert.equal(groupRoundTiming(value, [run('current', { status: 'running' })])?.running, true);
  assert.equal(groupRoundTiming(value, [run('current', { resultReady: false })])?.running, true);
  assert.deepEqual(groupRoundTiming(value, [run('current'), run('other', { status: 'running', updatedAt: at(999) })]),
    { startedAt: start, endedAt: start + 10_000, running: false });
});

test('终态截止固定且并行成员用最大截止时间，不累加各自用时', () => {
  const value = round([turn('one'), turn('two')], { updatedAt: at(21) });
  const runs = [run('one', { updatedAt: at(15) }), run('two', { updatedAt: at(20) })];
  assert.deepEqual(groupRoundTiming(value, runs), { startedAt: start, endedAt: start + 21_000, running: false });
  assert.deepEqual(groupRoundTiming(value, runs), groupRoundTiming(value, structuredClone(runs)));
});

test('自动任务人工验收更新不推高时长，缺少运行记录时仍可使用节点结束时间', () => {
  const value = automatic([turn('one', { updatedAt: at(1000) })], { updatedAt: at(1000) });
  const task = { id: 'task', state: 'accepted' as const, nodes: [node('one', { finishedAt: at(30), updatedAt: at(1000) })] };
  assert.deepEqual(groupRoundTiming(value, [run('one', { updatedAt: at(25) })], task),
    { startedAt: start, endedAt: start + 30_000, running: false });
  assert.equal(groupRoundTiming(value, [], task)?.endedAt, start + 30_000);
  assert.equal(groupRoundTiming(value, [run('one', { updatedAt: at(1000) })], task)?.endedAt, start + 30_000);
});

test('自动任务只采用当前有效节点，跳过旧轮、已替代协调和无关任务', () => {
  const turns = [turn('old-round'), turn('old-leader'), turn('current'), turn('skipped')];
  const value = automatic(turns, { state: 'running' });
  const nodes = [node('old-round'), node('old-leader', { round: 1, purpose: 'coordinate' }),
    node('current', { round: 1, purpose: 'coordinate', finishedAt: at(20) }), node('skipped', { round: 1, status: 'skipped' })];
  const runs = [run('old-round', { status: 'running' }), run('old-leader', { status: 'running' }), run('current', { updatedAt: at(20) }), run('skipped', { status: 'running' }), run('other-task', { status: 'running' })];
  assert.deepEqual(groupRoundTiming(value, runs, { id: 'task', state: 'completed', nodes }),
    { startedAt: start, endedAt: start + 20_000, running: false });
});

test('暂停停止后冻结、当前进程未停仍计时，重试沿用同轮起点', () => {
  const value = round([turn('attempt-2', { runId: 'retry', status: 'pending', attempt: 2 })], { state: 'queued' });
  assert.equal(groupRoundTiming(value, [], undefined, true)?.running, false);
  assert.equal(groupRoundTiming(value, [run('retry', { status: 'running' })], undefined, true)?.running, true);
  assert.deepEqual(groupRoundTiming(value, [run('retry', { status: 'running', createdAt: at(600) })]),
    { startedAt: start, running: true });
  assert.deepEqual(groupRoundTiming(value, [run('retry', { updatedAt: at(660), createdAt: at(600) })]),
    { startedAt: start, endedAt: start + 660_000, running: false });
});

test('无运行记录的排队/派发可计时，等待输入、阻塞或登录时冻结', () => {
  const value = automatic([turn('pending', { status: 'pending' })], { state: 'running' });
  assert.equal(groupRoundTiming(value, [])?.running, true);
  assert.equal(groupRoundTiming(value, [run('pending', { status: 'running' })], { id: 'task', state: 'running', nodes: [] })?.running, true);
  for (const state of ['awaiting_plan', 'waiting_input', 'blocked', 'needs_decision', 'needs_reconciliation'] as const) {
    assert.equal(groupRoundTiming(value, [], { id: 'task', state, nodes: [] })?.running, false);
  }
  assert.equal(groupRoundTiming(value, [], { id: 'task', state: 'running', nodes: [], chat: { paused: true } })?.running, false);
  value.loginHandoff = { reason: 'login_required', turnId: 'pending', runId: 'pending', answered: false };
  assert.equal(groupRoundTiming(value, [])?.running, false);
});

test('自动任务阶段衔接仍计时，宿主当前轮次优先于旧节点的运行状态', () => {
  const value = automatic([turn('previous')], { state: 'running' });
  const runs = [run('previous')], nodes = [node('previous', { finishedAt: at(10) })];
  for (const state of ['planning', 'running'] as const) assert.equal(groupRoundTiming(value, runs, { id: 'task', state, nodes })?.running, true);
  assert.equal(groupRoundTiming(value, [run('previous', { status: 'running' })], { id: 'task', state: 'waiting_input', round: 1, nodes })?.running, false);
});

test('坏日期安全降级，缺失历史 run 使用成员时间，无负时长且不修改输入', () => {
  const value = round([turn('one', { updatedAt: at(25) })], { state: 'failed', updatedAt: 'invalid' });
  const before = structuredClone(value);
  assert.equal(groupRoundTiming(value, [])?.endedAt, start + 25_000);
  assert.deepEqual(value, before);
  assert.equal(groupRoundTiming({ ...value, createdAt: 'invalid' }, []), undefined);
  assert.deepEqual(groupRoundTiming(round([turn('one', { updatedAt: at(-5) })]), [run('one', { updatedAt: 'invalid' })]),
    { startedAt: start, endedAt: start, running: false });
});
