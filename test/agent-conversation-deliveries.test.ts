import test from 'node:test';
import assert from 'node:assert/strict';
import { agentRunStatus, type AgentConversation, type AgentConversationRun } from '../src/features/agent-workbench/conversation.js';
import { conversationDeliveries, conversationFileDeliveries, conversationResultDownloads } from '../src/features/agent-workbench/conversation-deliveries.js';
import type { AdvancedTeamTask } from '../src/features/agent-workbench/team-api.js';

function run(id: string, input: Partial<AgentConversationRun> = {}): AgentConversationRun {
  return { id, provider: 'codex', mode: 'ask', accessMode: 'workspace', model: '', reasoningEffort: '',
    objective: id, workspacePath: `/workspaces/${id}`, branch: '', headSha: '', status: 'completed',
    sessionId: '', pid: null, result: '', error: '', events: [],
    createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z', ...input };
}

function conversation(runs: AgentConversationRun[], id = 'conversation'): AgentConversation {
  return { id, title: id, runs, latest: runs.at(-1)!, updatedAt: '2026-10-16T00:00:00.000Z',
    source: 'workspace', loaded: true };
}

test('会话成果跳过空轮但保留原轮号，最新有内容轮次排在首位', () => {
  const runs = [run('first', { result: '首轮回复' }), run('empty'), run('files', {
    changedFiles: [{ path: 'report.html', status: 'generated' }],
  }), run('whitespace', { result: ' \n\t ' }), run('active', { status: 'running' })];
  const selected = conversation(runs);
  assert.equal(selected.latest.id, 'active');
  assert.deepEqual(conversationDeliveries(selected).map(item => [item.round, item.run.id]), [[3, 'files'], [1, 'first']]);
  assert.deepEqual(runs.map(item => item.id), ['first', 'empty', 'files', 'whitespace', 'active']);
});

test('同名文件保留各自运行与工作区身份，绝对路径和原始回复不改写', () => {
  const first = run('first', { result: '  L123\n[文件](src/page.vue)  ',
    changedFiles: [{ path: 'src/page.vue', status: 'modified' }] });
  const second = run('second', { changedFiles: [{ path: 'src/page.vue', status: 'deleted' },
    { path: '/Users/example/成果/report.html', status: 'generated' }] });
  const items = conversationDeliveries(conversation([first, second]));
  assert.strictEqual(items[0].run, second);
  assert.strictEqual(items[0].run.changedFiles, second.changedFiles);
  assert.strictEqual(items[1].run, first);
  assert.equal(items[1].run.result, '  L123\n[文件](src/page.vue)  ');
  assert.deepEqual(items.map(item => [item.run.id, item.run.workspacePath, item.run.changedFiles?.map(file => file.path)]), [
    ['second', '/workspaces/second', ['src/page.vue', '/Users/example/成果/report.html']],
    ['first', '/workspaces/first', ['src/page.vue']],
  ]);
});

test('有部分回复的执行中、失败、停止轮次仍可查看且保留真实状态', () => {
  const runs = (['running', 'failed', 'cancelled', 'interrupted'] as const).map(status => run(status, { status, result: `partial-${status}` }));
  const items = conversationDeliveries(conversation(runs));
  assert.deepEqual(items.map(item => agentRunStatus(item.run).value), ['interrupted', 'cancelled', 'failed', 'running']);
  assert.deepEqual(items.map(item => item.run.result), ['partial-interrupted', 'partial-cancelled', 'partial-failed', 'partial-running']);
});

test('同步历史回复保留历史标记，不把无回复的同步文件当作本机成果', () => {
  const history = run('history', { syncedHistory: true, result: '历史回复' });
  const noReply = run('no-reply', { syncedHistory: true, changedFiles: [{ path: 'unknown.txt', status: 'modified' }] });
  const local = run('local', { result: '本机回复' });
  const items = conversationDeliveries(conversation([history, noReply, local]));
  assert.deepEqual(items.map(item => [item.round, item.run.id]), [[3, 'local'], [1, 'history']]);
  assert.equal(agentRunStatus(items[1].run).value, 'history');
  assert.equal(agentRunStatus(items[1].run).label, '历史记录');
});

test('未选会话、空会话与切换会话不会沿用上一会话的成果或文件', () => {
  const first = conversation([run('first', { changedFiles: [{ path: 'first.html', status: 'generated' }] })], 'first');
  const second = conversation([run('second', { result: '第二个会话' })], 'second');
  assert.equal(conversationDeliveries(first)[0].run.id, 'first');
  assert.deepEqual(conversationDeliveries(), []);
  assert.deepEqual(conversationDeliveries(conversation([])), []);
  assert.deepEqual(conversationDeliveries(second).map(item => [item.run.id, item.run.changedFiles]), [['second', undefined]]);
});

test('团队交付取产出岗位的当前运行，保留历史文件身份，不混入验证副本或旧重试', () => {
  const file = { path: 'outputs/复测.xlsx', status: 'generated' as const };
  const member = (id: string, nodeId: string) => run(id, { changedFiles: [file], team: {
    taskId: 'team', nodeId, stageKey: id, profileId: 'engineer', profileRevision: 1,
  } });
  const history = member('old', 'node-old'), current = member('new', 'node-new');
  const verifier = member('copy', 'node-copy'), priorAttempt = member('retry-old', 'node-new');
  const task = { id: 'team', parentConversationId: 'conversation', round: 3, nodes: [
    { id: 'node-old', stage: 'implement', round: 2, runId: history.id },
    { id: 'node-new', stage: 'implement', round: 3, runId: current.id },
    { id: 'node-copy', stage: 'verify', round: 3, runId: verifier.id },
  ] } as AdvancedTeamTask;
  const selected = conversation([run('leader')]);
  const items = conversationFileDeliveries(selected, task, [history, current, verifier, priorAttempt]);
  assert.deepEqual(items.map(item => [item.run.id, item.round, item.current]), [['new', 3, true], ['old', 2, false]]);
  assert.strictEqual(items[0].run, current);
  assert.strictEqual(items[0].run.changedFiles, current.changedFiles);
  current.result = '```delivery-report\n' + JSON.stringify({ taskResult: { output: { path: '/workspaces/new/outputs/复测.xlsx' } } }) + '\n```';
  current.changedFiles = [file, { path: 'internal.log', status: 'generated' }, { path: 'src/code.ts', status: 'modified' }];
  assert.deepEqual(conversationResultDownloads(selected, task, [history, current, verifier, priorAttempt]), [{
    key: '/workspaces/new/outputs/复测.xlsx', name: '复测.xlsx',
    url: '/api/agent-runtimes/runs/new/download-file?path=outputs%2F%E5%A4%8D%E6%B5%8B.xlsx',
  }]);
  current.changedFiles = [];
  assert.deepEqual(conversationResultDownloads(selected, task, [history, current, verifier]), [], '未登记的文件不能伪造下载入口或借用历史轮次');
  assert.deepEqual(conversationFileDeliveries(conversation([run('another')], 'another'), task, [current]), []);
});

test('普通会话本轮和历史文件分开，空轮不冒充有交付，切换会话不带入旧团队', () => {
  const first = run('first', { changedFiles: [{ path: 'first.xlsx', status: 'added' }] });
  const last = run('last', { changedFiles: [{ path: 'last.xlsx', status: 'modified' }] });
  assert.deepEqual(conversationFileDeliveries(conversation([first, last])).map(item => [item.run.id, item.current]), [['last', true], ['first', false]]);
  assert.deepEqual(conversationFileDeliveries(conversation([first, run('empty')])).map(item => [item.run.id, item.current]), [['first', false]]);
  const staleTask = { parentConversationId: 'previous' } as AdvancedTeamTask;
  assert.equal(conversationFileDeliveries(conversation([last]), staleTask)[0].current, true);
  assert.deepEqual(conversationFileDeliveries(), []);
});
