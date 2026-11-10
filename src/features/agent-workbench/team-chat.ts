import { isCurrentTeamChatTask } from '../../../shared/workspace-team-todos';
/** 主聊天只展示真实用户输入、问题和结果；岗位交接与内部运行指令留在执行记录。 */
import type { AgentRun } from '../../../shared/agent-runtime';
import type { TeamChatMessage, TeamProfileId } from '../../../shared/agent-team';
import { teamChatMessageIdentity } from '../../../shared/agent-team';
import type { AdvancedTeamTask, TeamChatRequest, TeamRoom } from './team-api';
import type { AgentConversation } from './conversation';
import { jiraTaskPromptTitle } from './message-text';
import { agentResultSummary, previewRunExecution } from './execution-summary';
import { readableTeamReason, teamNodeCheckStatus, teamRoundFeedback } from './team-result-status';

/** 界面角色名称；不改已保存的模型指令、接口文案或历史消息。 */
export const teamRoleLabels: Record<TeamProfileId, string> = {
  leader: '任务助手', analyst: '需求分析师', architect: '架构师', engineer: '开发工程师', frontend: '前端工程师',
  verifier: '测试工程师', reviewer: '代码评审', batch: '批量开发', reporter: '交付助手', second_opinion: '独立顾问',
};

export const teamChatActiveStates = new Set(['planning', 'running', 'waiting_input', 'awaiting_plan', 'blocked', 'needs_decision', 'needs_reconciliation']);
/** 重试未知回执时即使查询已恢复taskId，也复用同一会话中该次内容的去重键。 */
export function teamChatRequestKey(input: Omit<TeamChatRequest, 'requestId'>, conversationId: string) {
  return JSON.stringify([conversationId, input.objective, input.attachmentIds, input.workspacePath || '', input.accessMode || 'full']);
}
export function isChatTask(task: AdvancedTeamTask) { return task.interactionMode === 'chat' && !!task.chat; }
/** 新的单 Agent 消息接续会话后，静止的旧协作不能覆盖当前轮；仍有执行节点时继续呈现真实协作状态。 */
export { isCurrentTeamChatTask };

export function teamChatConversation(task: AdvancedTeamTask): AgentConversation {
  const pending = teamChatActiveStates.has(task.state);
  const failed = ['blocked', 'needs_decision', 'needs_reconciliation'].includes(task.state);
  const latest: AgentRun = {
    id: `team-chat:${task.parentConversationId}`, conversationId: task.parentConversationId, provider: 'codex', mode: 'agent', accessMode: task.accessMode || 'full',
    model: '', reasoningEffort: '', objective: task.chat?.messages.find(message => message.role === 'user')?.text || task.objective,
    workspacePath: task.workspacePath || task.sourceWorkspacePath || '', branch: '', headSha: '', status: failed ? 'failed' : pending ? 'running' : 'completed',
    pid: null, sessionId: '', result: '', error: '', events: [], createdAt: task.createdAt, updatedAt: task.updatedAt,
  };
  return { id: task.parentConversationId, title: jiraTaskPromptTitle(latest.objective) || latest.objective, latest, runs: [], updatedAt: task.updatedAt, source: 'workspace', loaded: true,
    teamChat: { state: task.state, lastUserAt: task.chat?.messages.filter(message => message.role === 'user').at(-1)?.createdAt || task.createdAt,
      workspaceBound: !!task.chat?.workspaceBound, workspacePath: task.chat?.projectWorkspacePath || task.sourceWorkspacePath } };
}
export function withTeamChatConversations(conversations: AgentConversation[], tasks: AdvancedTeamTask[], titles: Record<string, string> = {}) {
  const chatTasks = tasks.filter(isChatTask), byTask = new Map(chatTasks.map(task => [task.id, task]));
  const chatTitle = (id: string) => {
    const text = chatTasks.filter(task => task.parentConversationId === id)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]?.chat?.messages.find(message => message.role === 'user')?.text || '';
    return titles[id] || jiraTaskPromptTitle(text) || text || '团队聊天';
  };
  const result = conversations.filter(conversation => !conversation.runs.some(run => run.team && (byTask.has(run.team.taskId)
    ? byTask.get(run.team.taskId)!.parentConversationId !== conversation.id
    : run.team.interactionMode === 'chat' && run.task?.parentConversationId && run.task.parentConversationId !== conversation.id)))
    .map(conversation => conversation.runs.some(run => run.team?.interactionMode === 'chat')
      ? { ...conversation, title: chatTitle(conversation.id) } : conversation);
  const known = new Map(result.map((item, index) => [item.id, index]));
  for (const task of [...chatTasks].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))) {
    const index = known.get(task.parentConversationId);
    if (index === undefined) { known.set(task.parentConversationId, result.length); const value = teamChatConversation(task); value.title = titles[value.id] || value.title; result.push(value); continue; }
    const current = result[index];
    if (current.teamChat || current.runs.some(run => ['running', 'queued'].includes(run.status) && !run.team)
      || !isCurrentTeamChatTask(task, current)) continue;
    const lastUserAt = task.chat?.messages.filter(message => message.role === 'user').at(-1)?.createdAt || task.createdAt;
    if (Date.parse(current.latest.createdAt) > Date.parse(task.updatedAt) && !teamChatActiveStates.has(task.state)) continue;
    const text = task.chat?.messages.find(message => message.role === 'user')?.text || '';
    result[index] = { ...current, title: titles[current.id] || jiraTaskPromptTitle(text) || text || current.title,
      updatedAt: Date.parse(task.updatedAt) > Date.parse(current.updatedAt) ? task.updatedAt : current.updatedAt,
      teamChat: { state: task.state, lastUserAt, workspaceBound: !!task.chat?.workspaceBound, workspacePath: task.chat?.projectWorkspacePath || task.sourceWorkspacePath } };
  }
  return result;
}
export function teamChatParticipant(message: TeamChatMessage) {
  return message.role === 'user' ? '你' : message.kind === 'delivery' ? '团队交付' : teamRoleLabels[message.profileId as TeamProfileId] || '任务助手';
}
export interface TeamQuestionTarget { taskId: string; questionId: string }
/** 回复始终绑定用户选中的问题；过期或已答的问题不能退化成新的任务指令。 */
export function teamQuestionReply(tasks: AdvancedTeamTask[], target: TeamQuestionTarget, room?: TeamRoom) {
  const task = room?.task.id === target.taskId ? room.task : tasks.find(item => item.id === target.taskId);
  const message = task?.chat?.messages.find(item => item.id === target.questionId);
  return task && message ? { ...target, text: message.text, state: teamQuestionState(task, message, room) || 'expired' as const } : undefined;
}
export type TeamChatEntry = { id: string; createdAt: string; kind: 'run'; run: AgentRun }
  | { id: string; createdAt: string; kind: 'team'; message: TeamChatMessage; taskId: string; questionState?: 'pending' | 'answered' | 'expired'; pendingInput?: boolean; identity?: { provider: AgentRun['provider']; model: string } };
export function teamQuestionState(task: AdvancedTeamTask, message: TeamChatMessage, room?: TeamRoom): 'pending' | 'answered' | 'expired' | undefined {
  if (message.kind !== 'question') return undefined;
  const ask = room?.task.id === task.id ? room.messages.find(item => item.id === message.id && item.type === 'ask' && item.to.kind === 'user') : undefined;
  if (task.chat?.messages.some(item => item.replyTo === message.id) || ask?.processing === 'answered') return 'answered';
  if (!teamChatActiveStates.has(task.state)) return 'expired';
  if (message.id.startsWith('plan-question:')) {
    const planNode = task.nodes.filter(node => node.stage === 'plan' && !('purpose' in node && ['answer', 'coordinate'].includes(String(node.purpose)))).at(-1);
    return task.state === 'awaiting_plan' && planNode?.id === message.nodeId ? 'pending' : 'expired';
  }
  if (ask) return ask.processing !== 'expired' && task.nodes.some(node => node.status === 'waiting_input' && `${node.id}:${node.attempt}` === ask.nodeId) ? 'pending' : 'expired';
  return undefined;
}
export function teamChatEntries(runs: AgentRun[], tasks: AdvancedTeamTask[], search = '', teamRuns: AgentRun[] = [], room?: TeamRoom): TeamChatEntry[] {
  const chatTasks = tasks.filter(isChatTask), ids = new Set(chatTasks.map(task => task.id));
  const entries: TeamChatEntry[] = runs.filter(run => !run.id.startsWith('team-chat:') && !(run.team && (run.team.interactionMode === 'chat' || ids.has(run.team.taskId))))
    .map(run => ({ id: run.id, kind: 'run', run, createdAt: run.createdAt }));
  const seen = new Set<string>();
  for (const task of chatTasks) for (const message of task.chat?.messages || []) {
    if (message.kind === 'progress' || message.kind === 'handoff') continue;
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    entries.push({ id: message.id, kind: 'team', message, taskId: task.id, createdAt: message.createdAt,
      questionState: teamQuestionState(task, message, room), pendingInput: task.chat?.pendingInputs.some(input => input.id === message.id),
      identity: teamChatMessageIdentity(message, task, [...runs, ...teamRuns]) });
  }
  const term = search.trim().toLowerCase();
  return entries.filter(entry => !term || (entry.kind === 'team' ? entry.message.text
    : [entry.run.objective, entry.run.result, entry.run.error, ...entry.run.events.map(event => event.message)].join('\n')).toLowerCase().includes(term))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}
export function teamChatActivity(task?: AdvancedTeamTask) {
  if (!task) return '';
  if (task.chat?.coordination?.text && !['completed', 'accepted', 'rejected', 'cancelled', 'taken_over'].includes(task.state)) return task.chat.coordination.text;
  const running = task.nodes.find(node => node.status === 'running') || task.nodes.find(node => node.status === 'queued');
  if (running) return `${teamRoleLabels[running.profileId] || '团队'}${running.status === 'queued' ? '等待执行' : '正在处理'}`;
  return ({ planning: '正在制定计划', awaiting_plan: '等待你补充信息', waiting_input: '等待你的回复', running: '正在分配任务',
    blocked: '团队需要处理阻塞', needs_decision: '需要你决定下一步', needs_reconciliation: '需要核对执行状态',
    awaiting_acceptance: '结果已生成', accepted: '已验收', rejected: '已退回', cancelled: '已取消', taken_over: '已由你接手', completed: '本轮已完成' } as Record<string, string>)[task.state] || '';
}

export function teamChatNodeProgress(task: AdvancedTeamTask, runs: AgentRun[]) {
  const byId = new Map(runs.map(run => [run.id, run]));
  return [...new Set(task.nodes.map(node => node.round))].sort((a, b) => b - a).map(round => ({ round, current: round === task.round,
    feedback: teamRoundFeedback(task, round, runs),
    nodes: task.nodes.filter(node => node.round === round).map(node => {
      const run = node.runId ? byId.get(node.runId) : undefined;
      const preview = run ? previewRunExecution(run) : undefined;
      const message = task.chat?.messages.filter(message => message.nodeId === node.id && message.role === 'assistant'
        && message.profileId === node.profileId && message.kind !== 'progress').at(-1);
      const identity = run ? { provider: run.provider, model: run.model } : teamChatMessageIdentity({ id: node.id, role: 'assistant',
        profileId: node.profileId, nodeId: node.id, text: '', createdAt: node.finishedAt || node.updatedAt }, task, runs);
      const active = ['running', 'queued', 'waiting_input'].includes(node.status);
      const summary = agentResultSummary(run ? run.result : node.result || '') || preview?.summary || (!run && !active ? message?.text : '') || '';
      const error = active && run ? run.error : node.error || run?.error || (['blocked', 'needs_reconciliation'].includes(node.status) ? readableTeamReason(node.reason) : '') || '';
      const activity = active ? preview?.progress || (!run ? readableTeamReason(node.reason) : '') || '' : '';
      return { node, run, identity, summary, error, activity, check: teamNodeCheckStatus(node, run, task), tool: preview?.tools.at(-1) };
    }),
  }));
}
