import type { AgentRun } from '../../../shared/agent-runtime';
import type { GroupRoom } from '../../../shared/agent-group-chat';
import type { AgentConversation } from './conversation';

/** 房间只投影其明确引用的真实运行；目录和原生 CLI 会话不能证明群聊归属。 */
export function buildGroupChatConversation(room: GroupRoom | undefined, runs: AgentRun[]): AgentConversation | undefined {
  if (!room) return undefined;
  const taskIds = new Set([room.id, ...room.rounds.flatMap(round => round.automatic?.taskId ? [round.automatic.taskId] : [])]);
  const referencedIds = new Set(room.rounds.flatMap(round => round.turns.flatMap(turn =>
    [turn.runId, ...(turn.fallbacks || []).map(fallback => fallback.runId)])).filter(Boolean));
  const time = (value: string) => Date.parse(value) || 0;
  const ordered = [...new Map(runs.filter(run => referencedIds.has(run.id) || run.team && taskIds.has(run.team.taskId))
    .map(run => [run.id, run])).values()].sort((left, right) => time(left.createdAt) - time(right.createdAt));
  if (!ordered.length) return undefined;
  const priority = (run: AgentRun) => run.status === 'running' ? 2 : run.status === 'queued' ? 1 : 0;
  const latest = ordered.reduce((current, candidate) => priority(candidate) !== priority(current)
    ? priority(candidate) > priority(current) ? candidate : current
    : time(candidate.updatedAt) >= time(current.updatedAt) ? candidate : current);
  const updatedAt = ordered.reduce((value, run) => time(run.updatedAt) > time(value) ? run.updatedAt : value, room.updatedAt);
  const runRounds: NonNullable<AgentConversation['runRounds']> = {};
  let number = 0;
  for (const round of room.rounds) {
    for (const turn of round.turns) {
      number++;
      for (const run of ordered) {
        if (turn.runId === run.id || turn.fallbacks?.some(fallback => fallback.runId === run.id)
          || run.team?.taskId === (round.automatic?.taskId || room.id) && run.team.nodeId === turn.id) {
          runRounds[run.id] = { round: number, current: run.id === turn.runId };
        }
      }
    }
  }
  return { id: `group:${room.id}`, title: room.title, runs: ordered, latest, updatedAt, source: 'workspace', loaded: true, runRounds };
}
