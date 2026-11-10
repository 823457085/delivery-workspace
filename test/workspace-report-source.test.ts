import test from 'node:test';
import assert from 'node:assert/strict';
import { readWorkspaceReportSnapshot, type WorkspaceReportReaders } from '../server/workspace-report-source.js';
import { renderWorkspaceReport } from '../server/workspace-reports.js';
import { defaultReportPolicy } from '../shared/workspace-reports.js';
import { workspaceTeamTodos } from '../shared/workspace-team-todos.js';
import type { JiraIssue, Job, AutomationData, CatchupData, MergeData } from '../shared/hub.js';
import type { AgentRun, AgentRuntimeDashboard } from '../shared/agent-runtime.js';
import type { ExecutionDashboard } from '../shared/design-execution.js';
import type { TeamTask } from '../shared/agent-team.js';
import { defaultTeamProfileConfig } from '../shared/agent-team.js';
import type { TodoItem } from '../shared/workspace-todos.js';

const now = new Date('2026-11-04T10:00:00.000Z'), at = '2026-11-04T09:00:00.000Z';
function readers(override: Partial<WorkspaceReportReaders> = {}): WorkspaceReportReaders {
  return { jira: async () => ({ source: 'jira', total: 0, issues: [], baseUrl: 'https://jira.example', jql: 'assignee = currentUser()' }),
    automation: async () => ({ jobs: [] } as unknown as AutomationData), runtime: async () => ({ runs: [], workflows: [] } as unknown as AgentRuntimeDashboard),
    design: async () => ({ runs: [] } as unknown as ExecutionDashboard), requirements: () => [], fixes: () => [],
    catchup: async () => ({ requirements: [] } as unknown as CatchupData), merge: async () => ({ items: [] } as unknown as MergeData),
    teams: () => [], todos: () => [], ...override };
}
function issue(key: string, extra: Partial<JiraIssue> = {}): JiraIssue {
  return { key, url: `https://jira.example/browse/${key}`, summary: '原始需求 L100', status: '待开始', statusCategory: '待办',
    issueType: '任务', priority: '普通', project: 'APEX', projectName: '项目', assignee: 'me', fixVersions: [], created: at, updated: at,
    dueDate: '2026-11-05', startDate: '2026-11-04', endDate: null, resolutionDate: null, parent: null, subtasks: [], ...extra };
}
function run(id: string, extra: Partial<AgentRun> = {}): AgentRun {
  return { id, conversationId: `conversation-${id}`, provider: 'codex', mode: 'agent', accessMode: 'workspace', model: 'fixture', reasoningEffort: '',
    objective: `执行${id}`, workspacePath: '/fixture/project', branch: 'feature/fixture', headSha: 'fixture', status: 'completed',
    sessionId: `session-${id}`, pid: null, result: '本轮返回', error: '', events: [], createdAt: at, updatedAt: at, ...extra };
}
function job(id: string, threadId: string, extra: Partial<Job> = {}): Job {
  return { id, issueKey: 'APEX-1', issueUrl: 'https://jira.example/browse/APEX-1', title: '任务原文', category: 'implementation', categoryLabel: '开发',
    model: 'fixture', status: 'completed', createdAt: at, updatedAt: at, attempts: 1, workspacePath: '/fixture/project', branch: 'feature/fixture', threadId, ...extra };
}
function team(id: string, extra: Partial<TeamTask> = {}): TeamTask {
  return { id, parentConversationId: `parent-${id}`, sourceWorkspacePath: '/fixture/project', objective: `团队目标${id}`, attachmentIds: [],
    profileConfig: defaultTeamProfileConfig(), planRevision: 1, nodes: [], state: 'waiting_input', round: 1, maxRounds: null,
    createdAt: at, updatedAt: at, ...extra };
}

test('来源失效和模拟 Jira 保留覆盖缺口，个人待办仍能独立汇总', async () => {
  const todo: TodoItem = { id: 'manual', title: '核对输入', details: '已有明确事项', dueDate: '2026-11-04', priority: 'high', status: 'todo', createdAt: at, updatedAt: at };
  const value = await readWorkspaceReportSnapshot(readers({ jira: async () => { throw new Error('offline'); },
    runtime: async () => { throw new Error('offline'); }, todos: () => [todo] }), now);
  assert.equal(value.tasks.length, 1); assert.equal(value.tasks[0].source, 'manual');
  assert.equal(value.coverage.find(item => item.source === 'jira')!.available, false);
  assert.equal(value.coverage.find(item => item.source === 'agent')!.available, false);
  const mock = await readWorkspaceReportSnapshot(readers({ jira: async () => ({ source: 'mock', total: 1, issues: [issue('APEX-1')], baseUrl: '', jql: '' }) }), now);
  assert.equal(mock.tasks.length, 0); assert.equal(mock.coverage.find(item => item.source === 'jira')!.available, false);
  const partial = await readWorkspaceReportSnapshot(readers({ jira: async () => ({ source: 'jira', total: 10, issues: [issue('APEX-1')], baseUrl: '', jql: '' }) }), now);
  assert.equal(partial.tasks.length, 1); assert.equal(partial.coverage.find(item => item.source === 'jira')!.available, false);
});

test('真实 Jira 中文进行中状态归正在做，原始状态保留，分配的子任务与父任务身份分开保留', async () => {
  const issues = [issue('APEX-1', { status: '开发中', statusCategory: '处理中' }), issue('APEX-2', { status: '测试中', statusCategory: '处理中' }),
    issue('APEX-3', { status: '未完成', statusCategory: '待办' }), issue('APEX-4', { status: '已完成', statusCategory: '完成', resolutionDate: at }),
    issue('APEX-5', { parent: { key: 'APEX-1' }, issueType: '子任务' })];
  const value = await readWorkspaceReportSnapshot(readers({ jira: async () => ({ source: 'jira', total: issues.length, issues, baseUrl: '', jql: '' }) }), now);
  const byId = new Map(value.tasks.map(item => [item.id, item]));
  assert.equal(value.tasks.length, 5); assert.match(byId.get('jira:APEX-5')!.detail, /父任务：APEX-1/); assert.equal(byId.get('jira:APEX-5')!.category, 'todo'); assert.ok(byId.get('jira:APEX-5')!.nextAction); assert.equal(byId.get('jira:APEX-1')!.category, 'doing');
  assert.equal(byId.get('jira:APEX-2')!.category, 'doing'); assert.equal(byId.get('jira:APEX-2')!.status, '测试中');
  assert.equal(byId.get('jira:APEX-3')!.category, 'todo'); assert.equal(byId.get('jira:APEX-4')!.category, 'completed');
  assert.match(byId.get('jira:APEX-1')!.title, /原始需求 L100/);
});

test('同主 Jira 多条交付只保留当前活动记录，旧失败不覆盖活动且不会重复加入独立会话', async () => {
  for (const activeNewer of [true, false]) {
    const running = run('active', { status: 'running', updatedAt: activeNewer ? at : '2026-11-03T09:00:00.000Z' });
    const failed = run('old-failure', { status: 'failed', updatedAt: activeNewer ? '2026-11-03T09:00:00.000Z' : at });
    const value = await readWorkspaceReportSnapshot(readers({
      jira: async () => ({ source: 'jira', total: 1, issues: [issue('APEX-1')], baseUrl: '', jql: '' }),
      runtime: async () => ({ runs: [running, failed], workflows: [] } as unknown as AgentRuntimeDashboard),
      automation: async () => ({ jobs: [job('active', running.sessionId, { updatedAt: running.updatedAt }), job('failed', failed.sessionId, { updatedAt: failed.updatedAt, status: 'blocked' })] } as unknown as AutomationData),
    }), now);
    assert.equal(value.tasks.length, 1); assert.equal(value.tasks[0].id, 'jira:APEX-1');
    assert.equal(value.tasks[0].category, 'doing'); assert.equal(value.tasks[0].status, 'running');
  }
});

test('历史已结束的交付不把 Jira 当前开发中降为待办', async () => {
  const value = await readWorkspaceReportSnapshot(readers({
    jira: async () => ({ source: 'jira', total: 1, issues: [issue('APEX-1', { status: '开发中', statusCategory: '处理中' })], baseUrl: '', jql: '' }),
    automation: async () => ({ jobs: [job('old-returned', 'old-native', { updatedAt: '2026-10-28T01:00:00.000Z' })] } as unknown as AutomationData),
  }), now);
  assert.equal(value.tasks.length, 1); assert.equal(value.tasks[0].category, 'doing');
  assert.equal(value.tasks[0].status, '开发中');
  assert.match(renderWorkspaceReport(value, defaultReportPolicy()).content, /当前状态：开发中/);
});

test('未关联当前运行的跳过、取消和结束队列记录不会伪造成新待办', async () => {
  const value = await readWorkspaceReportSnapshot(readers({ automation: async () => ({ jobs: [
    job('skipped', '', { status: 'skipped' }), job('cancelled', '', { status: 'cancelled' }),
    job('returned', '', { status: 'completed', result: '最近已有返回' }),
  ] } as unknown as AutomationData) }), now);
  assert.equal(value.tasks.length, 1); assert.equal(value.tasks[0].category, 'review');
  assert.equal(value.tasks[0].status, 'completed');
});

test('跳过的旧队列不覆盖未完成 Jira 自身的真实状态', async () => {
  const value = await readWorkspaceReportSnapshot(readers({
    jira: async () => ({ source: 'jira', total: 1, issues: [issue('APEX-1')], baseUrl: '', jql: '' }),
    automation: async () => ({ jobs: [job('skipped', '', { status: 'skipped' })] } as unknown as AutomationData),
  }), now);
  assert.equal(value.tasks.length, 1); assert.equal(value.tasks[0].source, 'jira'); assert.equal(value.tasks[0].status, '待开始');
});

test('关联 Jira 与交付归并后仍能被任一已选来源找到，全部来源只计一次', async () => {
  const value = await readWorkspaceReportSnapshot(readers({
    jira: async () => ({ source: 'jira', total: 1, issues: [issue('APEX-1', { status: '开发中', statusCategory: '处理中' })], baseUrl: '', jql: '' }),
    automation: async () => ({ jobs: [job('linked', '', { status: 'completed' })] } as unknown as AutomationData),
  }), now);
  assert.equal(value.tasks.length, 1);
  assert.equal(value.tasks[0].jiraUrl, 'https://jira.example/browse/APEX-1');
  const policy = defaultReportPolicy();
  for (const sources of [['jira'], ['delivery'], ['jira', 'delivery']] as const) {
    const rendered = renderWorkspaceReport(value, { ...policy, sources: [...sources] });
    assert.equal(rendered.counts.doing, 1, `来源${sources.join(',')}应保留关联的唯一任务`);
    assert.match(rendered.fullContent, /\[APEX-1\]\(https:\/\/jira.example\/browse\/APEX-1\) 原始需求 L100/);
  }
});

test('只汇总近期结束的独立会话，老失败不当当前待办，中断归阻塞，返回不等于验收', async () => {
  const runs = [run('old-failed', { status: 'failed', updatedAt: '2026-10-28T00:00:00.000Z' }),
    run('old-running', { status: 'running', updatedAt: '2026-10-28T00:00:00.000Z' }),
    run('returned'), run('interrupted', { status: 'interrupted' }), run('cancelled', { status: 'cancelled' })];
  const value = await readWorkspaceReportSnapshot(readers({ runtime: async () => ({ runs, workflows: [] } as unknown as AgentRuntimeDashboard) }), now);
  assert.equal(value.tasks.length, 3);
  assert.equal(value.tasks.find(item => item.id.endsWith('old-running'))!.category, 'doing');
  assert.equal(value.tasks.find(item => item.id.endsWith('interrupted'))!.category, 'blocked');
  const returned = value.tasks.find(item => item.id.endsWith('returned'))!;
  assert.equal(returned.category, 'review'); assert.match(returned.detail, /待核验/);
  assert.match(value.coverage.find(item => item.source === 'agent')!.detail!, /不代表全天/);
});

test('团队待确认问题排除已回答项，群聊和普通团队链接使用现有可打开入口', () => {
  const pending = team('pending', { state: 'awaiting_plan', plan: { questions: [
    { id: 'Q1', text: '未回答问题', blocking: true }, { id: 'Q2', text: '已回答问题', blocking: true }, { id: 'Q3', text: '非阻断建议', blocking: false },
  ] } as TeamTask['plan'], planAnswers: [{ questionId: 'Q2', text: '已有回答', at }],
    nodes: [{ id: 'leader-node', stage: 'plan', profileId: 'leader', status: 'completed', dependencies: [], attempt: 1, round: 1,
      runId: 'leader-run', createdAt: at, updatedAt: at }] });
  const group = team('group', { state: 'waiting_input', groupRoomId: 'room' });
  const values = workspaceTeamTodos([pending, group]);
  const first = values.find(item => item.id === 'team:pending')!;
  assert.equal(first.category, 'todo'); assert.equal(first.nextAction, '未回答问题'); assert.doesNotMatch(first.detail, /已回答问题/);
  assert.match(first.url!, /[?&]run=parent-pending/); assert.doesNotMatch(first.url!, /[?&]team=/);
  assert.equal(values.find(item => item.id === 'team:group')!.url, '/agent?group=1&room=room');
});

test('团队待输入不被最后一条完成的成员运行掩盖，已验收和仅结束的团队分别进入汇报', async () => {
  const waiting = team('waiting');
  const accepted = team('accepted', { state: 'accepted', acceptance: { revision: 1, decision: 'accepted', summary: '人工核对通过', at,
    confirmedBy: 'user', snapshot: {} as NonNullable<TeamTask['acceptance']>['snapshot'] } });
  const completed = team('completed', { state: 'completed' });
  const child = run('member', { team: { taskId: waiting.id, nodeId: 'n', stageKey: 's', profileId: 'leader', profileRevision: 1 } });
  const value = await readWorkspaceReportSnapshot(readers({ teams: () => [waiting, accepted, completed],
    runtime: async () => ({ runs: [child], workflows: [] } as unknown as AgentRuntimeDashboard) }), now);
  const values = new Map(value.tasks.map(item => [item.id, item]));
  assert.equal(value.tasks.length, 3); assert.equal(values.get('team:waiting')!.category, 'todo');
  assert.equal(values.get('team:accepted')!.category, 'completed'); assert.equal(values.get('team:completed')!.category, 'review');
});

test('历史追平和合入记录的入口指向当前重构管理视图', async () => {
  const value = await readWorkspaceReportSnapshot(readers({ catchup: async () => ({ requirements: [{ id: 'catchup', title: '追平任务',
    session: { status: 'completed', threadId: 'native', jiraKey: '', workspacePath: '/fixture', branch: 'feature/fixture', result: '已返回', error: '', updatedAt: at } }] } as unknown as CatchupData),
    merge: async () => ({ items: [{ requirementId: 'merge', title: '合入任务', jiraKey: '', status: 'review', pipeline: { threadId: '', result: '', error: '', updatedAt: at } }] } as unknown as MergeData) }), now);
  assert.equal(value.tasks.length, 2); assert.ok(value.tasks.every(item => item.url?.startsWith('/agent?view=integration-execution')));
});

test('独立群聊保留当前活动，已结束仅近期待核验，有团队任务的房间不重复计数', async () => {
  const group = (id: string, state: 'running' | 'completed', updatedAt = at) => ({ id, state, title: `群聊${id}`, paused: false,
    workspacePath: '/fixture', createdAt: at, updatedAt });
  const value = await readWorkspaceReportSnapshot(readers({ teams: () => [team('team', { groupRoomId: 'covered' })],
    groups: () => [group('covered', 'running'), group('running', 'running'), group('recent', 'completed'), group('old', 'completed', '2026-10-28T00:00:00.000Z')] }), now);
  assert.equal(value.tasks.length, 3);
  assert.equal(value.tasks.find(item => item.id === 'team:team')!.category, 'todo');
  assert.equal(value.tasks.find(item => item.id === 'group:running')!.category, 'doing');
  assert.equal(value.tasks.find(item => item.id === 'group:recent')!.category, 'review');
});


test('已关闭Jira的旧交付与关联群聊不制造当期待核验事项', async () => {
  const closed = issue('APEX-1', { status: '已完成', statusCategory: '完成', updated: '2026-09-01T00:00:00Z', resolutionDate: '2026-09-01T00:00:00Z' });
  const value = await readWorkspaceReportSnapshot(readers({ jira: async () => ({ source: 'jira', total: 1, issues: [closed], baseUrl: '', jql: '' }),
    automation: async () => ({ jobs: [job('old', '', { updatedAt: '2026-09-01T00:00:00Z' })] } as unknown as AutomationData) }), now);
  const rendered = renderWorkspaceReport(value, defaultReportPolicy());
  assert.equal(rendered.counts.review, 0); assert.equal(rendered.counts.todo, 0); assert.equal(rendered.counts.completed, 0);
});


test('后续普通会话已接续的静止旧协作不复活为今日待办，活动协作仍保留', async () => {
  const oldAt = '2026-11-03T01:00:00Z';
  const waiting = team('old-wait', { parentConversationId: 'chat-1', createdAt: oldAt, updatedAt: at,
    chat: { messages: [{ id: 'user-old', role: 'user', text: '原任务', createdAt: oldAt }], workspaceBound: true, pendingInputs: [] } });
  const manual = run('later-manual', { conversationId: 'chat-1', createdAt: '2026-11-03T02:00:00Z', updatedAt: at, status: 'completed' });
  assert.equal(workspaceTeamTodos([waiting], [manual]).length, 0);
  const snapshot = await readWorkspaceReportSnapshot(readers({ teams: () => [waiting], runtime: async () => ({ runs: [manual], workflows: [] } as unknown as AgentRuntimeDashboard) }), now);
  assert.equal(snapshot.tasks.some(task => task.id === 'team:old-wait'), false);
  assert.equal(snapshot.tasks.some(task => task.id.startsWith('agent:')), true, '后续普通会话仍保留真实结果');
  const activeNode = { id: 'active-node', stage: 'plan', profileId: 'leader', status: 'running', dependencies: [], attempt: 1, round: 1, createdAt: at, updatedAt: at } as TeamTask['nodes'][number];
  assert.equal(workspaceTeamTodos([{ ...waiting, nodes: [activeNode] }], [manual]).length, 1, '仍有实际运行节点时不丢当前协作');
});


test('仅直接回答的已结束团队讨论不制造交付待核验任务', async () => {
  const greeting = team('greeting', { state: 'completed', chat: { messages: [{ id: 'hello', role: 'user', text: '你好', createdAt: at }], workspaceBound: false, pendingInputs: [] }, nodes: [] });
  const snapshot = await readWorkspaceReportSnapshot(readers({ teams: () => [greeting] }), now);
  assert.equal(snapshot.tasks.length, 0);
});
