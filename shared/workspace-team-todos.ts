/** 团队等待用户输入和计划确认有独立状态，不能仅从成员的最后一次运行推断待办。 */
import type { TeamTask } from './agent-team.js';
import type { AgentRun } from './agent-runtime.js';
import type { ReportTask } from './workspace-reports.js';

const states: Partial<Record<TeamTask['state'], { category: ReportTask['category']; label: string; next: string }>> = {
  planning: { category: 'doing', label: '正在规划', next: '等待当前规划返回' },
  running: { category: 'doing', label: '团队执行中', next: '查看当前节点与执行记录' },
  awaiting_plan: { category: 'todo', label: '等待计划确认或补充信息', next: '打开团队会话，核对计划与待确认问题' },
  waiting_input: { category: 'todo', label: '等待你的回复', next: '打开团队会话，回答当前待确认问题' },
  needs_decision: { category: 'review', label: '需要你作出决定', next: '打开团队会话，核对待决事项' },
  needs_reconciliation: { category: 'blocked', label: '需要核对执行状态', next: '核对执行记录与实际工作区后继续' },
  blocked: { category: 'blocked', label: '团队阻塞', next: '查看当前阻塞原因与需要补充的条件' },
  awaiting_acceptance: { category: 'review', label: '等待验收', next: '核对最终改动、验证证据与交接结果' },
};
export function isCurrentTeamChatTask(task: TeamTask, conversation: { id: string; runs: (AgentRun & { syncedHistory?: true })[] }) {
  if (task.parentConversationId !== conversation.id) return false;
  const manual = conversation.runs.filter(run => !run.team && !run.syncedHistory)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  if (!manual) return true;
  const lastInputAt = Math.max(Date.parse(task.createdAt), ...(task.chat?.messages.filter(message => message.role === 'user')
    .map(message => Date.parse(message.createdAt)) || []));
  if (!(Date.parse(manual.createdAt) > lastInputAt)) return true;
  if (['running', 'queued'].includes(manual.status)) return false;
  const runnablePending = ['planning', 'running'].includes(task.state) && !task.chat?.paused
    && task.nodes.some(node => node.status === 'pending' && node.dependencies.every(id => task.nodes.find(item => item.id === id)?.status === 'completed'));
  return task.nodes.some(node => ['running', 'queued'].includes(node.status)) || runnablePending || !!task.chat?.pendingInputs.length;
}
export function workspaceCurrentTeams(tasks: TeamTask[], runs?: AgentRun[]): TeamTask[] {
  if (!runs) return tasks;
  return tasks.filter(task => !states[task.state] || isCurrentTeamChatTask(task, { id: task.parentConversationId,
    runs: runs.filter(run => (run.conversationId || run.id) === task.parentConversationId) }));
}
export function workspaceTeamTodos(tasks: TeamTask[], runs?: AgentRun[]): ReportTask[] {
  tasks = workspaceCurrentTeams(tasks, runs);
  return tasks.flatMap(task => {
    const state = states[task.state];
    if (!state) return [];
    const answers = new Set(task.planAnswers?.map(answer => answer.questionId));
    const questions = task.plan?.questions.filter(question => question.blocking && !answers.has(question.id)).map(question => question.text) || [];
    const runId = task.parentConversationId || [...task.nodes].reverse().find(item => item.runId)?.runId;
    const node = task.nodes.find(item => ['running', 'queued', 'waiting_input', 'blocked', 'needs_reconciliation'].includes(item.status));
    return [{ id: `team:${task.id}`, title: task.objective.split(/\r?\n/).find(line => line.trim())?.slice(0, 200) || '团队任务',
      source: 'team' as const, category: state.category, status: state.label,
      detail: [task.reason, questions.join('；'), node?.reason || node?.error].filter(Boolean).join('；'),
      nextAction: questions.length ? questions.join('；') : state.next,
      updatedAt: task.updatedAt, project: task.sourceWorkspacePath,
      url: task.groupRoomId ? `/agent?group=1&room=${encodeURIComponent(task.groupRoomId)}` : runId ? `/agent?run=${encodeURIComponent(runId)}` : '/agent' }];
  }).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}
