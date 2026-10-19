import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRun } from '../shared/agent-runtime';
import type { JiraIssue } from '../shared/hub';
import type { JiraFixRecord } from '../shared/jira-fix';
import type { RequirementDevelopmentRecord } from '../shared/requirement-development';
import { agentStatusLabel, deliveryRecordCount, forIssue, hasDeliveryResult, launchDeliveryRecords, reconcileDeliveryRecords, recordMatchesFilter, type DeliveryRecord } from '../src/features/workbench/domain';
import { readLaunchRecords } from '../src/features/workbench/launch-records';

function run(id: string, values: Partial<AgentRun> = {}): AgentRun {
  return { id, provider: 'codex', mode: 'ask', accessMode: 'workspace', model: '', reasoningEffort: '', objective: '相同标题',
    workspacePath: '/worktree', sourceWorkspacePath: '/project', branch: 'feature/test', headSha: '', status: 'running',
    sessionId: `session-${id}`, pid: null, result: '', error: '', events: [], createdAt: '2026-10-15T01:00:00Z', updatedAt: '2026-10-15T01:00:00Z', ...values };
}
const requirement = { id: 'requirement-1', input: { title: '需求标题', issueKey: 'https://jira.example/browse/APEX-12', project: 'APEX', branch: 'feature/APEX-12' },
  status: 'started', workspacePath: '/requirement-worktree', runId: 'first', error: '', createdAt: '2026-10-14T01:00:00Z' } as RequirementDevelopmentRecord;
const sourceTask = { source: 'workflow', role: 'main', sourceId: 'requirement:requirement-1', title: '需求任务', parentConversationId: '', dependsOnConversationIds: [] } as const;
const legacy: DeliveryRecord = { id: 'job:legacy', source: '自动交付', issueKeys: ['APEX-12'], title: '旧交付', status: 'completed',
  threadId: 'session-first', workspacePath: '/legacy', branch: 'feature/legacy', updatedAt: '2026-10-13T01:00:00Z', result: '原历史结果', error: '', detailPath: '/delivery/queue', links: [] };

test('需求启动、原运行和续聊只显示一条交付记录，保留每轮结果与项目/Jira/原会话', () => {
  const first = run('first', { conversationId: 'conversation', status: 'failed', result: '首轮结果', error: '首轮错误', task: { ...sourceTask, dependsOnConversationIds: [] } });
  const resumed = run('resumed', { conversationId: 'conversation', parentRunId: 'first', updatedAt: '2026-10-15T03:00:00Z', task: { ...sourceTask, dependsOnConversationIds: [] } });
  const rows = reconcileDeliveryRecords(launchDeliveryRecords([requirement]), [], [first, resumed], { includeStandalone: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'requirement:requirement-1');
  assert.equal(rows[0].runId, 'resumed');
  assert.equal(rows[0].threadId, 'session-resumed');
  assert.equal(rows[0].workspacePath, '/requirement-worktree');
  assert.equal(rows[0].project, 'APEX');
  assert.equal(rows[0].branch, 'feature/APEX-12');
  assert.deepEqual(rows[0].agentRuns?.map(item => item.id), ['resumed', 'first']);
  assert.equal(rows[0].agentRuns?.[1].result, '首轮结果');
  assert.equal(rows[0].agentRuns?.[1].error, '首轮错误');
  assert.equal(forIssue(rows, 'APEX-12').length, 1);
  assert.equal(recordMatchesFilter(rows[0], 'running'), true);
  assert.equal(hasDeliveryResult(rows[0]), true);
});

test('没有业务启动记录的独立运行进入执行中，同名同目录不合并，Cursor 不伪造 Codex 链接', () => {
  const rows = reconcileDeliveryRecords([], [], [run('one'), run('two', { provider: 'cursor' })], { includeStandalone: true });
  assert.equal(rows.length, 2);
  assert.equal(rows.filter(row => recordMatchesFilter(row, 'running')).length, 2);
  assert.equal(rows.find(row => row.runId === 'two')?.threadId, '');
  assert.equal(rows[0].project, '/project');
});

test('Jira 等来源失败时执行中计数仍使用已知 runtime，未知运行不能显示零', () => {
  const rows = reconcileDeliveryRecords([], [], [run('one')], { includeStandalone: true });
  const knownRuntime = { incomplete: true, runtimeKnown: true };
  assert.equal(deliveryRecordCount(rows, 'running', knownRuntime), 1);
  for (const filter of ['actionable', 'review', 'blocked', 'results', 'all'] as const) {
    assert.equal(deliveryRecordCount(rows, filter, knownRuntime), undefined);
  }
  assert.equal(deliveryRecordCount(rows, 'running', { incomplete: true, runtimeKnown: false }), undefined);
  assert.equal(deliveryRecordCount([], 'running', knownRuntime), 0);
  assert.equal(deliveryRecordCount(rows, 'all', { incomplete: false, runtimeKnown: true }), 1);
});

test('明确 sourceId 优先于旧 runId，并保留独立来源历史，避免按复用物理会话误连', () => {
  const exact = run('exact', { task: { ...sourceTask, dependsOnConversationIds: [] }, sessionId: 'session-first' });
  const wrong = run('first', { sessionId: 'session-first', conversationId: 'independent' });
  const rows = reconcileDeliveryRecords([legacy, ...launchDeliveryRecords([requirement])], [], [exact, wrong], { includeStandalone: true });
  assert.equal(rows.length, 3);
  assert.equal(rows.find(row => row.sourceId === sourceTask.sourceId)?.runId, 'exact');
  assert.equal(rows.find(row => row.id === legacy.id)?.agentStatus, undefined);
  assert.equal(rows.find(row => row.id === legacy.id)?.result, '原历史结果');
  assert.ok(rows.some(row => row.id === 'agent:independent'));
});

test('唯一 session 可关联旧记录，多个会话复用同一 session 时保持独立且不猜关联', () => {
  const one = run('one', { sessionId: 'session-first' });
  const rows = reconcileDeliveryRecords([legacy], [], [one], { includeStandalone: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].runId, 'one');
  const ambiguous = reconcileDeliveryRecords([legacy], [], [one, run('two', { sessionId: 'session-first' })], { includeStandalone: true });
  assert.equal(ambiguous.length, 3);
  assert.equal(ambiguous.find(row => row.id === legacy.id)?.agentStatus, undefined);
});

test('运行结束仅表示本轮结束，真实 Jira 完成才移出 Jira 待处理，接口展示状态原样保留', () => {
  const finished = run('first', { status: 'completed', result: '待验收' });
  const [row] = reconcileDeliveryRecords(launchDeliveryRecords([requirement]), [], [finished], { includeStandalone: true });
  assert.equal(row.currentStatus, 'ended');
  assert.equal(agentStatusLabel(row.agentStatus), '本轮已结束');
  assert.equal(recordMatchesFilter(row, 'results'), true);
  const issue = { key: 'APEX-12', status: ' L-STATUS-12 ', statusCategory: 'indeterminate' } as JiraIssue;
  const [pending] = reconcileDeliveryRecords(launchDeliveryRecords([requirement]), [issue], [finished]);
  assert.equal(pending.currentStatus, 'pending');
  assert.equal(pending.jiraStatuses?.[0].status, ' L-STATUS-12 ');
  const [done] = reconcileDeliveryRecords(launchDeliveryRecords([requirement]), [{ ...issue, statusCategory: 'Done' }], [finished]);
  assert.equal(done.currentStatus, 'completed');
});

test('快照读取失败保留已知历史，不把缓存运行当作当前执行中，也不丢失原结果', () => {
  const cached = run('first', { result: '已记录结果' });
  const [row] = reconcileDeliveryRecords(launchDeliveryRecords([requirement]), [], [cached], { includeStandalone: true, runtimeKnown: false });
  assert.equal(row.agentStateKnown, false);
  assert.equal(row.agentStatus, undefined);
  assert.equal(row.currentStatus, 'unknown');
  assert.equal(row.agentRuns?.[0].result, '已记录结果');
  assert.equal(recordMatchesFilter(row, 'running'), false);
  assert.equal(recordMatchesFilter(row, 'results'), true);
});

test('未创建运行的准备/失败/不确定记录可处理，失效来源不作为当前待办', () => {
  for (const status of ['preparing', 'starting', 'failed', 'uncertain'] as const) {
    const records = launchDeliveryRecords([{ ...requirement, runId: '', status }]);
    assert.equal(recordMatchesFilter(reconcileDeliveryRecords(records, [], [])[0], 'actionable'), true);
    const unavailable = launchDeliveryRecords([{ ...requirement, runId: '', status }], [], { requirements: false });
    assert.equal(reconcileDeliveryRecords(unavailable, [], [])[0].currentStatus, 'unknown');
  }
});

test('Jira 修复按输入链接关联，runId 缺失时仍可按 sourceId 去重，同一来源 ID 不重复', () => {
  const fix = { id: 'fix-1', input: { issueKey: 'https://jira.example/browse/TEST-4008', branch: 'feature/TEST-4008' },
    status: 'started', workspacePath: '/fix', runId: '', error: '', createdAt: '2026-10-15T01:00:00Z' } as JiraFixRecord;
  const records = launchDeliveryRecords([], [fix, fix]);
  const rows = reconcileDeliveryRecords(records, [], [run('fix-run', { task: { ...sourceTask, sourceId: 'jira-fix:fix-1', dependsOnConversationIds: [] } })], { includeStandalone: true });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].issueKeys, ['TEST-4008']);
  assert.equal(rows[0].runId, 'fix-run');
  assert.equal(rows[0].detailPath, '/agent?view=jira-fix');
});

test('启动记录 GET 拒绝断线/错误/缺字段，读取和刷新不发送写操作', async () => {
  const original = globalThis.fetch;
  const requests: RequestInit[] = [];
  let response = new Response(JSON.stringify({ records: [] }));
  globalThis.fetch = async (_input, init) => { requests.push(init || {}); return response; };
  try {
    assert.deepEqual(await readLaunchRecords('requirement-development'), []);
    response = new Response(JSON.stringify({ records: [] }), { headers: { 'X-Delivery-Source': 'Delivery-Offline' } });
    await assert.rejects(readLaunchRecords('jira-fix'), /交付后端不可用/);
    response = new Response(JSON.stringify({}));
    await assert.rejects(readLaunchRecords('jira-fix'), /缺少 records/);
    response = new Response(JSON.stringify({ message: 'not ready' }), { status: 503 });
    await assert.rejects(readLaunchRecords('requirement-development'), /not ready/);
    assert.ok(requests.every(request => !request.body && !request.method));
  } finally { globalThis.fetch = original; }
});
