/** 执行中心只按正式群聊归属聚合，当前状态与原始错误不能被历史成员运行覆盖。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRun } from '../shared/agent-runtime';
import type { GroupRoomSummary } from '../shared/agent-group-chat';
import { defaultTeamProfileConfig, type TeamNode, type TeamTask } from '../shared/agent-team';
import type { Job } from '../shared/hub';
import { executionEntries, executionScope } from '../src/features/auto-delivery/execution-entries';

const first = '2026-11-05T10:00:00.000Z', current = '2026-11-05T11:00:00.000Z', last = '2026-11-05T12:00:00.000Z';
const profiles = defaultTeamProfileConfig();
function room(id = 'room', extra: Partial<GroupRoomSummary> = {}): GroupRoomSummary {
  return { id, title: '收款配置页面优化 L_ROOM_001', workspacePath: '/same/project', paused: false,
    state: 'running', createdAt: first, updatedAt: current, ...extra };
}
function run(id: string, extra: Partial<AgentRun> = {}): AgentRun {
  return { id, conversationId: `member-conversation:${id}`, provider: 'codex', mode: 'agent', accessMode: 'workspace',
    model: 'fixture', reasoningEffort: '', objective: `内部成员编号 ${id}`, workspacePath: '/same/project',
    branch: 'feature/fixture', headSha: '', status: 'completed', sessionId: `native-session:${id}`, pid: null,
    result: '', error: '', events: [], createdAt: first, updatedAt: first, ...extra };
}
function teamRun(id: string, taskId: string, nodeId = id, extra: Partial<AgentRun> = {}): AgentRun {
  return run(id, { team: { taskId, nodeId, stageKey: 'implement', profileId: 'frontend', profileRevision: 1,
    interactionMode: 'chat' }, ...extra });
}
function node(id: string, extra: Partial<TeamNode> = {}): TeamNode {
  return { id, runId: id, stage: 'implement', profileId: 'frontend', status: 'completed', dependencies: [],
    attempt: 1, round: 1, createdAt: current, updatedAt: current, ...extra };
}
function task(id = 'task', extra: Partial<TeamTask> = {}): TeamTask {
  return { id, groupRoomId: 'room', parentConversationId: `task-conversation:${id}`, sourceWorkspacePath: '/same/project',
    objective: '内部流程任务 L_TASK_001', attachmentIds: [], profileConfig: profiles, planRevision: 1,
    nodes: [], state: 'running', round: 1, maxRounds: null, createdAt: first, updatedAt: current, ...extra };
}
function job(id: string, extra: Partial<Job> = {}): Job {
  return { id, title: `自动化任务 ${id}`, issueKey: 'TASK-1', issueUrl: '', category: '', categoryLabel: '', model: '',
    status: 'completed', workspacePath: '/same/project', branch: 'feature/fixture', threadId: '', attempts: 1,
    createdAt: first, updatedAt: first, ...extra };
}
function assertGroup(row: ReturnType<typeof executionEntries>[number] | undefined, group: GroupRoomSummary) {
  assert.ok(row, '应显示该群聊');
  assert.equal(row.id, `group:${group.id}`);
  assert.equal(row.groupRoomId, group.id);
  assert.equal(row.source, '团队群聊');
  assert.equal(row.title, group.title, '原样保留业务群标题，不使用成员编号或旧会话标题');
}

test('自动群多个任务的几十条独立成员运行按 tasks.groupRoomId 归并为一条业务群记录', () => {
  const group = room('room', { title: '  商户收款方式 L_TITLE_101\n保留第二行与双空格  ' });
  const runs = Array.from({ length: 36 }, (_, index) => teamRun(`member-${index}`, index < 18 ? 'task-old' : 'task-current', `node-${index}`,
    { status: index === 35 ? 'running' : 'failed', error: index === 35 ? '' : `旧成员错误 L_${index}` }));
  const tasks = [task('task-old', { round: 0, state: 'completed', updatedAt: first }),
    task('task-current', { createdAt: current, nodes: [node('node-35', { runId: 'member-35', status: 'running' })] })];
  const titles = { room: '旧编号 0001', 'group:room': '旧编号 0002', 'member-conversation:member-35': '旧编号 0035' };
  const input = { runs, jobs: [] as Job[], titles, context: { rooms: [group], tasks } }, before = structuredClone(input);
  const rows = executionEntries(input.runs, input.jobs, input.titles, input.context);
  assert.equal(rows.length, 1);
  assertGroup(rows[0], group);
  assert.equal(executionScope(rows[0]!.status), 'active');
  assert.deepEqual(input, before, '群归并不得修改运行、任务、群标题或上下文');
});

test('顺序群仅凭 interactionMode=group 与 taskId=room.id 的明确归属聚合', () => {
  const group = room('sequential', { title: '顺序执行群 L_TITLE_201' });
  const runs = ['a', 'b', 'c'].map((id, index) => teamRun(id, group.id, id, {
    team: { taskId: group.id, nodeId: id, stageKey: 'group', profileId: 'frontend', profileRevision: 1, interactionMode: 'group' },
    status: index === 2 ? 'running' : 'completed', updatedAt: index === 2 ? current : first,
  }));
  const rows = executionEntries(runs, [], {}, { rooms: [group], tasks: [] });
  assert.equal(rows.length, 1);
  assertGroup(rows[0], group);
  assert.equal(executionScope(rows[0]!.status), 'active');
});

test('固定群当前运行中时不让旧失败覆盖状态，即使旧错误更晚回写', () => {
  const group = room('sequential', { state: 'running' });
  const oldError = '旧成员失败 L_FIXED_211';
  const binding = (nodeId: string): NonNullable<AgentRun['team']> => ({ taskId: group.id, nodeId, stageKey: 'group',
    profileId: 'frontend', profileRevision: 1, interactionMode: 'group' });
  const runs = [run('old-failed', { team: binding('old-node'), status: 'failed', error: oldError,
    createdAt: first, updatedAt: last }), run('current-running', { team: binding('current-node'), status: 'running',
    createdAt: current, updatedAt: current })];
  const rows = executionEntries(runs, [], {}, { rooms: [group], tasks: [] });
  assert.equal(rows.length, 1);
  assertGroup(rows[0], group);
  assert.equal(rows[0]!.status, 'running');
  assert.equal(rows[0]!.run?.id, 'current-running');
  assert.ok(!rows[0]!.summary.includes(oldError));
});

test('同 round 同岗位同 purpose 的旧协调或回答节点被新节点替代后，不遮盖新运行', () => {
  for (const purpose of ['coordinate', 'answer'] as const) {
    const error = `旧 ${purpose} 失败 L_SUPERSEDED_221`;
    const nodes = [
      { ...node('old-node', { runId: 'old-run', status: 'blocked', profileId: 'leader', stage: 'plan', error }), purpose },
      { ...node('new-node', { runId: 'new-run', status: 'running', profileId: 'leader', stage: 'plan' }), purpose },
    ];
    const group = room('room', { state: 'running' }), currentTask = task('task', { nodes });
    const runs = [teamRun('old-run', 'task', 'old-node', { status: 'failed', error, updatedAt: last }),
      teamRun('new-run', 'task', 'new-node', { status: 'running', createdAt: current, updatedAt: current })];
    const rows = executionEntries(runs, [], {}, { rooms: [group], tasks: [currentTask] });
    assert.equal(rows.length, 1);
    assertGroup(rows[0], group);
    assert.equal(rows[0]!.status, 'running', `${purpose} 的旧失败应仅保留为历史`);
    assert.equal(rows[0]!.run?.id, 'new-run');
    assert.ok(!rows[0]!.summary.includes(error));
  }
});

test('固定群新一轮排队且尚无当前 run 时，不展示旧失败为当前结果', () => {
  const group = room('sequential', { state: 'queued', updatedAt: current });
  const error = '上一轮失败 L_QUEUED_231';
  const previous = run('previous', { status: 'failed', error, createdAt: first, updatedAt: first,
    team: { taskId: group.id, nodeId: 'previous-node', stageKey: 'group', profileId: 'frontend', profileRevision: 1, interactionMode: 'group' } });
  const rows = executionEntries([previous], [], {}, { rooms: [group], tasks: [] });
  assert.equal(rows.length, 1);
  assertGroup(rows[0], group);
  assert.equal(rows[0]!.status, 'queued');
  assert.ok(!rows[0]!.summary.includes(error));
});

test('已取消或已完成群聊不被历史成员失败抢占当前状态和错误摘要', () => {
  for (const state of ['cancelled', 'completed'] as const) {
    const group = room('room', { state, updatedAt: current });
    const oldError = '旧轮失败 L_OLD_301：不得成为当前阻塞';
    const runs = [teamRun('old-failure', 'old-task', 'old-node', { status: 'failed', error: oldError, updatedAt: last }),
      teamRun('current-result', 'current-task', 'current-node', { status: state, createdAt: current, updatedAt: current,
        result: state === 'completed' ? '当前回复 L_RESULT_302' : '' })];
    const tasks = [task('old-task', { state: 'blocked', round: 0, updatedAt: first,
      nodes: [node('old-node', { runId: 'old-failure', status: 'blocked', round: 0, error: oldError })] }),
    task('current-task', { state, nodes: [node('current-node', { runId: 'current-result', status: state })] })];
    const rows = executionEntries(runs, [], {}, { rooms: [group], tasks });
    assert.equal(rows.length, 1);
    assertGroup(rows[0], group);
    assert.equal(rows[0]!.status, state);
    assert.equal(executionScope(rows[0]!.status), 'history');
    assert.ok(!rows[0]!.summary.includes(oldError), '终态不能继续显示旧成员错误为当前摘要');
  }
});

test('当前 round 节点失败保留完整错误原文和 L 码，不取更新时间更晚的旧轮错误', () => {
  const group = room('room', { state: 'failed' });
  const error = ' L_CURRENT_401：接口返回原文\n请保留这一行。', oldError = '历史失败 L_OLD_402';
  const currentTask = task('task', { state: 'blocked', round: 2, nodes: [
    node('old-node', { runId: 'old-run', round: 1, status: 'blocked', error: oldError }),
    node('current-node', { runId: 'current-run', round: 2, status: 'blocked', error }),
  ] });
  const runs = [teamRun('old-run', 'task', 'old-node', { status: 'failed', error: oldError, updatedAt: last }),
    teamRun('current-run', 'task', 'current-node', { status: 'failed', error, createdAt: current, updatedAt: current })];
  const rows = executionEntries(runs, [], {}, { rooms: [group], tasks: [currentTask] });
  assert.equal(rows.length, 1);
  assertGroup(rows[0], group);
  assert.equal(executionScope(rows[0]!.status), 'attention');
  assert.ok(rows[0]!.summary.includes(error), '当前错误应逐字保留');
  assert.ok(!rows[0]!.summary.includes(oldError), '历史失败不能替换或污染当前错误');
});

test('当前轮不同节点一失败一完成时，较新的完成节点不得掩盖尚未解决的失败', () => {
  const error = '当前验证失败 L_501：返回字段须原样显示';
  const group = room('room', { state: 'failed' });
  const currentTask = task('task', { state: 'blocked', nodes: [
    node('failed-node', { runId: 'failed-run', status: 'failed', error }),
    node('done-node', { runId: 'done-run', status: 'completed', updatedAt: last }),
  ] });
  const runs = [teamRun('failed-run', 'task', 'failed-node', { status: 'failed', error, createdAt: current, updatedAt: current }),
    teamRun('done-run', 'task', 'done-node', { result: '另一个岗位完成 L_502', createdAt: last, updatedAt: last })];
  const rows = executionEntries(runs, [], {}, { rooms: [group], tasks: [currentTask] });
  assert.equal(rows.length, 1);
  assert.equal(executionScope(rows[0]!.status), 'attention');
  assert.notEqual(rows[0]!.status, 'completed');
  assert.ok(rows[0]!.summary.includes(error));
});

test('未派发且没有 run 的群聊仍有可导航记录，不错误推断已经完成', () => {
  const group = room('queued-room', { title: '待安排的业务需求 L_601', state: 'queued' });
  const pending = task('pending-task', { groupRoomId: group.id, state: 'planning',
    nodes: [node('pending-node', { status: 'pending', runId: undefined, reason: '等待派发 L_602' })] });
  const rows = executionEntries([], [], {}, { rooms: [group], tasks: [pending] });
  assert.equal(rows.length, 1);
  assertGroup(rows[0], group);
  assert.equal(executionScope(rows[0]!.status), 'active');
  assert.equal(rows[0]!.run, undefined, '不能伪造运行');
});

test('自动任务等待用户回复时，即使群摘要仍为 running 也归入需关注', () => {
  const group = room('room', { state: 'running' });
  const waiting = task('task', { state: 'waiting_input', reason: '请确认业务范围 L_INPUT_901',
    nodes: [node('question-node', { runId: 'question-run', status: 'waiting_input', profileId: 'leader', stage: 'plan' })] });
  const saved = teamRun('question-run', 'task', 'question-node', { result: '请确认业务范围 L_INPUT_901',
    createdAt: current, updatedAt: current });
  const rows = executionEntries([saved], [], {}, { rooms: [group], tasks: [waiting] });
  assert.equal(rows.length, 1);
  assertGroup(rows[0], group);
  assert.equal(executionScope(rows[0]!.status), 'attention');
  assert.equal(rows[0]!.statusLabel, '等待回复');
});

test('未知群归属不按相同目标、目录或 taskId 碰巧同名猜测归并', () => {
  const group = room('coincidental', { title: '相同业务标题 L_701', state: 'queued' });
  const runs = [teamRun('unknown-a', 'unmapped-task', 'a', { objective: group.title }),
    teamRun('unknown-b', 'unmapped-task', 'b', { objective: group.title }),
    teamRun('same-id-chat', group.id, 'c', { objective: group.title })];
  const rows = executionEntries(runs, [], {}, { rooms: [group], tasks: [task('unmapped-task', { groupRoomId: undefined })] });
  for (const saved of runs) {
    const row = rows.find(row => row.run?.id === saved.id);
    assert.ok(row, `${saved.id} 不得被猜测为已知群聊成员`);
    assert.equal(row.groupRoomId, undefined);
    assert.equal(row.id, `agent:${saved.conversationId}`);
  }
  assert.equal(rows.filter(row => row.groupRoomId === group.id).length, 1, '未派发群与未知归属运行分别保留');
});

test('普通聊天与自动化仍沿用正式会话聚合，增加群上下文不吞并同目录的普通记录', () => {
  const ordinary = [run('chat-old', { conversationId: 'ordinary', status: 'failed', error: '旧错误 L_801' }),
    run('chat-new', { conversationId: 'ordinary', parentRunId: 'chat-old', sessionId: 'linked-session',
      objective: '普通问题 L_802', result: '普通回复 L_803', createdAt: current, updatedAt: current })];
  const jobs = [job('linked', { threadId: 'linked-session', title: '自动化原始标题 L_804' }), job('unlinked')];
  const titles = { ordinary: '用户命名原文 L_805  保留空格' };
  const baseline = executionEntries(ordinary, jobs, titles);
  assert.deepEqual(executionEntries(ordinary, jobs, titles, { rooms: [], tasks: [] }), baseline);
  const group = room('separate', { title: titles.ordinary, state: 'queued' });
  const context = { rooms: [group], tasks: [] as TeamTask[] };
  const input = { ordinary, jobs, titles, context }, before = structuredClone(input);
  const rows = executionEntries(ordinary, jobs, titles, context);
  assert.deepEqual(rows.filter(row => !row.groupRoomId), baseline);
  assertGroup(rows.find(row => row.groupRoomId === group.id), group);
  assert.deepEqual(input, before);
});
