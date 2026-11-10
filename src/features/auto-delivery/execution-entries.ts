/** 和会话列表共用运行聚合及公开摘要；自动化只按正式会话 ID 关联。 */
import { agentProviderLabels, type AgentRun } from '../../../shared/agent-runtime';
import type { GroupRoomSummary } from '../../../shared/agent-group-chat';
import type { TeamTask } from '../../../shared/agent-team';
import type { Job } from '../../../shared/hub';
import { buildAgentConversations } from '../agent-workbench/conversation';
import { agentResultSummary, agentRunActivity, readableRunTask } from '../agent-workbench/execution-summary';

export type ExecutionScope = 'active' | 'attention' | 'history' | 'all';
export interface ExecutionEntry {
  id: string; title: string; status: string; workspacePath: string; branch: string; updatedAt: string;
  source: string; summary: string; run?: AgentRun; job?: Job; groupRoomId?: string; statusLabel?: string;
}
export interface ExecutionGroupContext { rooms: GroupRoomSummary[]; tasks: TeamTask[] }
export function executionScope(status: string): Exclude<ExecutionScope, 'all'> {
  if (['queued', 'pending', 'waiting', 'dispatching', 'dispatched', 'running'].includes(status)) return 'active';
  if (['completed', 'cancelled', 'interrupted', 'done', 'skipped'].includes(status)) return 'history';
  return 'attention';
}
export function executionEntries(runs: AgentRun[], jobs: Job[], titles: Record<string, string> = {}, groups?: ExecutionGroupContext): ExecutionEntry[] {
  const linkedJobs = new Set<string>();
  const entries: ExecutionEntry[] = [];
  const rooms = new Map(groups?.rooms.map(room => [room.id, room]));
  const taskRooms = new Map(groups?.tasks.filter(task => task.groupRoomId && rooms.has(task.groupRoomId)).map(task => [task.id, task.groupRoomId!]));
  const referencedRooms = new Map(groups?.tasks.flatMap(task => taskRooms.has(task.id)
    ? task.nodes.flatMap(node => node.runId ? [[node.runId, taskRooms.get(task.id)!] as const] : []) : []));
  const groupRuns = new Map<string, AgentRun[]>();
  const ordinaryRuns = runs.filter(run => {
    const roomId = run.team?.interactionMode === 'group' && rooms.has(run.team.taskId) ? run.team.taskId
      : run.team && taskRooms.get(run.team.taskId) || referencedRooms.get(run.id)
        || run.task && rooms.has(run.task.parentConversationId) && run.task.parentConversationId;
    if (!roomId) return true;
    groupRuns.set(roomId, [...groupRuns.get(roomId) || [], run]);
    return false;
  });
  const time = (value: string) => Date.parse(value) || 0;
  const newest = (values: AgentRun[]) => [...values].sort((a, b) => time(b.updatedAt) - time(a.updatedAt))[0];
  for (const room of rooms.values()) {
    const chain = groupRuns.get(room.id) || [];
    const tasks = (groups?.tasks.filter(task => task.groupRoomId === room.id) || []).sort((a, b) => time(a.createdAt) - time(b.createdAt));
    const terminal = ['completed', 'cancelled'].includes(room.state);
    const task = (!terminal && tasks.find(task => !['completed', 'accepted', 'awaiting_acceptance', 'cancelled', 'taken_over', 'rejected'].includes(task.state))) || tasks.at(-1);
    const nodes = task?.nodes.filter((node, index) => {
      if (node.round !== task.round || node.status === 'skipped') return false;
      const purpose = (node as { purpose?: string }).purpose;
      return !(['coordinate', 'answer'].includes(purpose || '') && task.nodes.some((next, nextIndex) => nextIndex > index
        && next.round === node.round && next.profileId === node.profileId && (next as { purpose?: string }).purpose === purpose && next.status !== 'skipped'));
    }) || [];
    const currentIds = new Set(nodes.flatMap(node => node.runId ? [node.runId] : []));
    const currentRuns = task ? chain.filter(run => currentIds.has(run.id)) : chain;
    const failedNode = nodes.find(node => ['failed', 'interrupted', 'blocked', 'needs_reconciliation'].includes(node.status));
    const failedRun = (failedNode && currentRuns.find(run => run.id === failedNode.runId))
      || newest(currentRuns.filter(run => ['failed', 'interrupted'].includes(run.status)));
    const activeRun = newest(currentRuns.filter(run => ['running', 'queued'].includes(run.status)
      || run.status === 'completed' && run.resultReady === false));
    const paused = !terminal && (room.waitingForLogin || room.paused && room.state !== 'failed');
    // 固定群的当前轮次由服务端给出，整条历史中的失败不能覆盖新轮状态。
    const waiting = task && ['waiting_input', 'awaiting_plan', 'needs_decision'].includes(task.state) ? task.state : undefined;
    const state = terminal ? room.state : paused ? 'paused' : waiting || (room.state === 'failed' || task && (failedNode || failedRun) ? 'failed'
      : activeRun ? activeRun.status === 'queued' ? 'queued' : 'running' : room.state);
    const run = state === 'failed' ? failedRun || newest(currentRuns) : terminal ? newest(currentRuns) : activeRun || (task ? newest(currentRuns) : undefined);
    const statusLabel = room.waitingForLogin && !terminal ? '等待登录' : ({ cancelled: '已取消', completed: '本轮完成', paused: '已暂停', failed: '被阻塞',
      queued: '排队中', running: '执行中', idle: '等待消息', waiting_input: '等待回复', awaiting_plan: '等待补充', needs_decision: '等待决定' } as Record<string, string>)[state];
    const summary = state === 'cancelled' || state === 'idle' ? '' : room.waitingForLogin && !terminal ? '等待你登录测试环境'
      : state === 'failed' ? failedRun?.error || failedNode?.error || failedNode?.reason || task?.reason || ''
      : state === 'paused' ? '' : waiting && task?.reason ? task.reason
      : run ? (terminal ? agentResultSummary(run.result) : run.error || agentRunActivity(run) || agentResultSummary(run.result)) : '';
    const job = jobs.find(item => !linkedJobs.has(item.id) && !!item.threadId
      && !(executionScope(item.status) === 'active' && executionScope(state) !== 'active' && time(item.updatedAt) > time(room.updatedAt))
      && chain.some(run => run.sessionId === item.threadId || run.originSessionId === item.threadId));
    if (job) linkedJobs.add(job.id);
    entries.push({ id: `group:${room.id}`, groupRoomId: room.id, title: room.title, status: state, statusLabel,
      workspacePath: room.workspacePath, branch: run?.branch || '', updatedAt: room.updatedAt, source: '团队群聊', summary, run, job });
  }
  for (const conversation of buildAgentConversations(ordinaryRuns)) {
    const { id, runs: chain, latest: run } = conversation;
    const job = jobs.find(item => !linkedJobs.has(item.id) && !!item.threadId
      && !(executionScope(item.status) === 'active' && executionScope(run.status) !== 'active' && Date.parse(item.updatedAt) > Date.parse(run.updatedAt))
      && chain.some(run => run.sessionId === item.threadId || run.originSessionId === item.threadId));
    if (job) linkedJobs.add(job.id);
    entries.push({ id: `agent:${id}`, title: titles[id] || job?.title || readableRunTask(run.objective).title,
      status: run.status, workspacePath: run.workspacePath, branch: run.branch, updatedAt: run.updatedAt,
      source: agentProviderLabels[run.provider],
      summary: run.error || agentRunActivity(run) || agentResultSummary(run.result), run, job });
  }
  for (const job of jobs) {
    if (linkedJobs.has(job.id)) continue;
    entries.push({ id: `job:${job.id}`, title: job.title, status: job.status, workspacePath: job.workspacePath,
      branch: job.branch, updatedAt: job.updatedAt, source: '自动化任务', summary: job.error || job.result || '', job });
  }
  return entries.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}
