/** 只读汇总现有业务状态；读取失败保留覆盖缺口，不以空数组冒充完整任务。 */
import type { AutomationData, CatchupData, IssueResponse, MergeData } from '../shared/hub.js';
import type { ExecutionDashboard } from '../shared/design-execution.js';
import type { AgentRuntimeDashboard } from '../shared/agent-runtime.js';
import { requirementStageLabels, type RequirementDevelopmentRecord } from '../shared/requirement-development.js';
import type { JiraFixRecord } from '../shared/jira-fix.js';
import type { TeamTask } from '../shared/agent-team.js';
import type { GroupRoomSummary } from '../shared/agent-group-chat.js';
import type { TodoItem } from '../shared/workspace-todos.js';
import type { ReportCategory, ReportCoverage, ReportSnapshot, ReportSource, ReportTask } from '../shared/workspace-reports.js';
import { workspaceTeamTodos, workspaceCurrentTeams } from '../shared/workspace-team-todos.js';
import { deliveryRecords, launchDeliveryRecords, reconcileDeliveryRecords } from '../src/features/workbench/domain.js';
import { buildAgentConversations } from '../src/features/agent-workbench/conversation.js';

export interface WorkspaceReportReaders {
  jira(): Promise<IssueResponse>; automation(): Promise<AutomationData>; runtime(): Promise<AgentRuntimeDashboard>;
  design(): Promise<ExecutionDashboard>; requirements(): RequirementDevelopmentRecord[]; fixes(): JiraFixRecord[];
  catchup(): Promise<CatchupData>; merge(): Promise<MergeData>; teams(): TeamTask[]; groups?(): GroupRoomSummary[]; todos(): TodoItem[];
}
const done = (value: string) => /^(done|完成|已完成|关闭|已关闭|resolved|closed)$/i.test(value);
const active = (value = '') => ['running', 'queued', 'planning', 'dispatching', 'dispatched', 'starting', 'preparing'].includes(value);
function category(status: string): ReportCategory {
  return active(status) ? 'doing' : ['failed', 'interrupted', 'blocked', 'needs_reconciliation', 'uncertain'].includes(status) ? 'blocked'
    : ['review', 'awaiting_acceptance', 'ended', 'completed'].includes(status) ? 'review' : 'todo';
}
export async function readWorkspaceReportSnapshot(readers: WorkspaceReportReaders, now = new Date()): Promise<ReportSnapshot> {
  const coverage: ReportCoverage[] = [];
  async function read<T>(source: ReportSource, label: string, fn: () => T | Promise<T>): Promise<T | undefined> {
    try { const value = await fn(); coverage.push({ source, label, available: true }); return value; }
    catch { coverage.push({ source, label, available: false, detail: '当前来源读取失败，请在工作台核对连接与状态；未计为零任务' }); return undefined; }
  }
  const [jira, automation, runtime, design, requirements, fixes, catchup, merge, teams, todos, groups] = await Promise.all([
    read('jira', '当前用户 Jira 任务', readers.jira), read('delivery', '自动交付队列', readers.automation),
    read('agent', '本机 Agent 运行快照', readers.runtime), read('delivery', '技术方案', readers.design),
    read('delivery', '需求开发', readers.requirements), read('delivery', 'Jira 修复', readers.fixes),
    read('delivery', '重构追平', readers.catchup), read('delivery', '合入审核', readers.merge),
    read('team', '团队协作待办', readers.teams), read('manual', '个人待办', readers.todos),
    read('team', '团队群聊', () => readers.groups?.() || []),
  ]);
  const jiraCoverage = coverage.find(item => item.source === 'jira')!;
  if (jira && jira.source !== 'jira') { jiraCoverage.available = false; jiraCoverage.detail = '当前 Jira 来源不是实时任务，未将模拟任务计入汇报'; }
  else if (jira) jiraCoverage.detail = `已读取 ${jira.issues.length}/${jira.total} 条 Jira 记录；包含主任务与分配给当前用户的子任务`;
  if (jira && jira.source === 'jira' && jira.total > jira.issues.length) { jiraCoverage.available = false; jiraCoverage.detail += '；达到查询上限，覆盖不完整'; }
  const runtimeCoverage = coverage.find(item => item.source === 'agent')!;
  if (runtime) runtimeCoverage.detail = `当前运行与会话最新状态快照（${runtime.runs.length} 条），仅展示近期48小时结束的独立会话及所有活动会话；不代表全天电脑活动日志`;
  const issues = jira?.source === 'jira' ? jira.issues : [];
  const tasks = new Map<string, ReportTask>();
  const jiraTasks = new Map<string, ReportTask>();
  for (const issue of issues) {
    const completed = done(issue.statusCategory) || done(issue.status);
    tasks.set(`jira:${issue.key}`, { id: `jira:${issue.key}`, title: `${issue.key} ${issue.summary}`, source: 'jira',
      category: completed ? 'completed' : /progress|indeterminate|处理中|进行中|正在进行/i.test(`${issue.statusCategory} ${issue.status}`) ? 'doing' : 'todo',
      status: issue.status, detail: [issue.parent ? `父任务：${issue.parent.key}` : '', issue.startDate || issue.endDate ? `计划时间：${issue.startDate || '未定'} 至 ${issue.endDate || issue.dueDate || '未定'}` : ''].filter(Boolean).join('；'),
      nextAction: !completed && /待办|待开始|to do|open/i.test(`${issue.statusCategory} ${issue.status}`) ? issue.startDate ? `计划 ${issue.startDate} 开始` : '请在 Jira 确认开始时间' : undefined,
      updatedAt: completed ? issue.resolutionDate || issue.updated : issue.updated, dueDate: issue.endDate || issue.dueDate || '', url: issue.url, project: issue.project });
  }
  for (const [id, task] of tasks) jiraTasks.set(id, task);
  const runs = runtime?.runs || [];
  const records = reconcileDeliveryRecords([
    ...deliveryRecords(automation, design, catchup, merge), ...launchDeliveryRecords(requirements, fixes),
  ], issues, runs, { includeStandalone: false, runtimeKnown: !!runtime, workflows: runtime?.workflows });
  const claimedRuns = new Set<string>();
  for (const record of records) {
    for (const run of record.agentRuns || []) claimedRuns.add(run.id);
    if (record.runId) claimedRuns.add(record.runId);
    const primaryKey = record.issueKeys[0], jiraTask = primaryKey ? jiraTasks.get(`jira:${primaryKey}`) : undefined;
    const state = record.currentStatus || record.status;
    const isActive = active(record.agentStatus) || active(state);
    if (!isActive && ['skipped', 'cancelled'].includes(record.status)) continue;
    if (!isActive && jiraTask?.category === 'completed') continue;
    if (!isActive && !jiraTask && ['completed', 'ended', 'blocked', 'failed', 'interrupted'].includes(record.status) && now.getTime() - Date.parse(record.updatedAt) > 48 * 60 * 60 * 1000) continue;
    if (!isActive && !jiraTask && state === 'unknown' && (now.getTime() - Date.parse(record.updatedAt) > 48 * 60 * 60 * 1000 || !['completed', 'ended', 'blocked', 'failed', 'review'].includes(record.status))) continue;
    const raw = record.agentStatus || record.status;
    const taskCategory = isActive ? 'doing' : jiraTask?.category === 'completed' ? 'completed' : jiraTask?.category === 'doing' && ['pending', 'unknown'].includes(state) ? 'doing' : category(state === 'unknown' ? record.status : state);
    const item: ReportTask = { id: jiraTask?.id || `delivery:${record.id}`, title: jiraTask?.title || record.title,
      source: 'delivery', relatedSources: ['delivery', ...(jiraTask ? ['jira' as const] : []), ...(record.agentRuns?.length ? ['agent' as const] : [])], category: taskCategory, status: !isActive && taskCategory === jiraTask?.category ? jiraTask.status : raw,
      detail: [jiraTask ? `Jira 当前状态：${jiraTask.status}` : '', jiraTask?.detail, `来源：${record.source}`, record.requirementProgress ? `进展记录：${Object.entries(record.requirementProgress.stages).filter(([, stage]) => ['in_progress', 'blocked'].includes(stage.status)).map(([name, stage]) => `${requirementStageLabels[name as keyof typeof requirementStageLabels] || name}（${stage.status}）`).join('、') || '未提供进行中阶段'}` : '',
        record.groupProgress?.error ? '本轮存在未处理执行错误，请查看工作台记录' : '', !isActive && ['completed', 'ended'].includes(state) ? '执行记录已返回，交付与验收结果请在工作台核验' : ''].filter(Boolean).join('；'),
      updatedAt: jiraTask?.category === 'completed' ? jiraTask.updatedAt : record.updatedAt,
      dueDate: jiraTask?.dueDate, nextAction: jiraTask?.nextAction, url: record.detailPath.startsWith('/catchup/') ? '/agent?view=integration-execution' : record.detailPath, jiraUrl: jiraTask?.url, project: record.project || jiraTask?.project };
    // 同一主任务的多条交付记录仅保留活动或最近记录。
    const existing = tasks.get(item.id);
    if (!existing || existing.source === 'jira' || (isActive && existing.category !== 'doing') || (existing.category !== 'doing' && item.updatedAt > existing.updatedAt)) tasks.set(item.id, item);
  }
  const currentTeams = workspaceCurrentTeams(teams || [], runtime?.runs);
  const teamTasks = workspaceTeamTodos(currentTeams);
  const teamIds = new Set((teams || []).map(task => task.id));
  for (const task of teamTasks) tasks.set(task.id, task);
  for (const task of teams || []) {
    if (!['accepted', 'completed'].includes(task.state)) continue;
    if (task.state === 'completed' && task.chat && !task.plan && task.nodes.every(node => node.stage === 'plan')) continue;
    const runId = task.parentConversationId || [...task.nodes].reverse().find(node => node.runId)?.runId;
    tasks.set(`team:${task.id}`, { id: `team:${task.id}`, title: task.objective.split(/\r?\n/)[0].slice(0, 200), source: 'team',
      category: task.state === 'accepted' ? 'completed' : 'review', status: task.state,
      detail: task.state === 'accepted' ? '团队任务已记录人工验收通过' : '团队本轮执行已结束，交付和验收证据仍需核对',
      updatedAt: task.updatedAt, url: task.groupRoomId ? `/agent?group=1&room=${encodeURIComponent(task.groupRoomId)}` : runId ? `/agent?run=${encodeURIComponent(runId)}` : '/agent', project: task.sourceWorkspacePath });
  }
  const representedRooms = new Set([...(teams || []).map(task => task.groupRoomId), ...records.map(record => record.groupRoomId)].filter(Boolean));
  for (const room of groups || []) {
    if (representedRooms.has(room.id) || ['cancelled', 'idle'].includes(room.state)) continue;
    if (room.state === 'completed' && now.getTime() - Date.parse(room.updatedAt) > 48 * 60 * 60 * 1000) continue;
    tasks.set(`group:${room.id}`, { id: `group:${room.id}`, title: room.title, source: 'team',
      category: room.state === 'failed' || room.paused ? 'blocked' : room.state === 'completed' ? 'review' : 'doing', status: room.paused ? 'paused' : room.state,
      detail: room.activeMember ? `当前成员：${room.activeMember}` : room.state === 'completed' ? '成员本轮已结束，交付与验收结果待核对' : '查看团队会话核对当前进展',
      updatedAt: room.updatedAt, url: `/agent?group=1&room=${encodeURIComponent(room.id)}`, project: room.workspacePath });
  }
  const teamParents = new Set(currentTeams.filter(task => !['completed', 'accepted', 'cancelled', 'rejected', 'taken_over'].includes(task.state)).map(task => task.parentConversationId));
  for (const conversation of buildAgentConversations(runs)) {
    const run = conversation.latest;
    if (teamParents.has(conversation.id) || teamParents.has(run.conversationId || '')) continue;
    if (conversation.runs.some(item => claimedRuns.has(item.id)) || run.team?.taskId && teamIds.has(run.team.taskId)) continue;
    if (run.team?.interactionMode === 'group') continue;
    if (!active(run.status) && (now.getTime() - Date.parse(run.updatedAt) > 48 * 60 * 60 * 1000 || run.status === 'cancelled')) continue;
    tasks.set(`agent:${conversation.id}`, { id: `agent:${conversation.id}`, title: (run.task?.title || conversation.title || run.objective).split(/\r?\n/)[0].slice(0, 200), source: 'agent',
      category: category(run.status), status: run.status,
      detail: `执行工具：${run.provider}${run.status === 'completed' ? '；本轮已有结果，请打开会话检查；待核验结果后再确认完成' : ''}`,
      updatedAt: run.updatedAt, url: `/agent?run=${encodeURIComponent(run.id)}`, project: run.workspacePath });
  }
  for (const todo of todos || []) tasks.set(`manual:${todo.id}`, { id: `manual:${todo.id}`, title: todo.title, source: 'manual',
    category: todo.status === 'done' ? 'completed' : todo.status === 'doing' ? 'doing' : 'todo', status: todo.status,
    detail: todo.details, nextAction: todo.status === 'done' ? undefined : todo.title, dueDate: todo.dueDate, updatedAt: todo.updatedAt,
    url: '/agent?view=today' });
  return { generatedAt: now.toISOString(), tasks: [...tasks.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    jiraTasks: [...jiraTasks.values()], coverage };
}
