import type { AgentRun } from '../../../shared/agent-runtime';
import type { GroupRound } from '../../../shared/agent-group-chat';
import type { TeamNode, TeamTask } from '../../../shared/agent-team';

export interface GroupElapsedTiming { startedAt: number; endedAt?: number; running: boolean }
type TimingTask = Pick<TeamTask, 'id' | 'state' | 'nodes'> & { round?: number; chat?: { paused?: boolean } };
const timestamp = (value?: string) => value ? Date.parse(value) : Number.NaN;
const executing = (run: AgentRun) => ['queued', 'running'].includes(run.status)
  || run.status === 'completed' && run.resultReady === false;
const purpose = (node: TeamNode) => (node as TeamNode & { purpose?: string }).purpose;

/** 本轮总经过时间：重试保留起点，并行成员不累加；暂停后的继续包含轮内等待。 */
export function groupRoundTiming(round: GroupRound, runs: AgentRun[], task?: TimingTask, paused = false): GroupElapsedTiming | undefined {
  const startedAt = timestamp(round.createdAt);
  if (!Number.isFinite(startedAt)) return undefined;
  const associatedTask = task?.id === round.automatic?.taskId ? task : undefined;
  const turnsById = new Map(round.turns.map(turn => [turn.id, turn]));
  const nodes = associatedTask?.nodes.filter(node => turnsById.has(node.id)) || [];
  const latestRound = associatedTask?.round ?? Math.max(-1, ...nodes.map(node => node.round));
  const currentNodes = nodes.filter((node, index) => node.round === latestRound && node.status !== 'skipped'
    && !(['coordinate', 'answer'].includes(purpose(node) || '') && nodes.some((next, nextIndex) => nextIndex > index
      && next.round === node.round && next.profileId === node.profileId && purpose(next) === purpose(node) && next.status !== 'skipped')));
  const currentTurns = associatedTask && nodes.length
    ? round.turns.filter(turn => currentNodes.some(node => node.id === turn.id && (!node.runId || node.runId === turn.runId)))
    : round.turns;
  const runIds = new Set(round.turns.map(turn => turn.runId));
  const previousRunIds = new Set(round.turns.flatMap(turn => (turn.fallbacks || []).map(fallback => fallback.runId)));
  const relatedRuns = runs.filter(run => runIds.has(run.id) || previousRunIds.has(run.id) || !!run.team && turnsById.has(run.team.nodeId)
    && (round.automatic?.taskId ? run.team.taskId === round.automatic.taskId : run.team.stageKey.split(':')[0] === 'group' && run.team.stageKey.split(':')[2] === round.id));
  const runsById = new Map(relatedRuns.map(run => [run.id, run]));
  const hasActiveRun = currentTurns.some(turn => {
    const run = runsById.get(turn.runId);
    return !!run && executing(run);
  });
  const taskCanProgress = !associatedTask || ['planning', 'running'].includes(associatedTask.state);
  const waiting = paused || associatedTask?.chat?.paused || round.loginHandoff?.answered === false || !taskCanProgress;
  const missingRun = !relatedRuns.length || currentTurns.some(turn => !runsById.has(turn.runId) && ['pending', 'queued', 'running'].includes(turn.status));
  const running = hasActiveRun || !waiting && ['queued', 'running'].includes(round.state) && (!!associatedTask || missingRun);
  if (running) return { startedAt, running: true };

  // 自动任务 updatedAt 也会被人工验收和后续聊天更新，不能作为执行结束时间。
  const ends = [startedAt, ...nodes.map(node => timestamp(node.finishedAt)),
    ...relatedRuns.filter(run => !executing(run)).map(run => {
      const node = nodes.find(node => node.runId === run.id || !node.runId && turnsById.get(node.id)?.runId === run.id);
      const finishedAt = timestamp(node?.finishedAt);
      return Number.isFinite(finishedAt) ? finishedAt : timestamp(run.updatedAt);
    }),
    ...round.turns.filter(turn => !Number.isFinite(timestamp(runsById.get(turn.runId)?.updatedAt))
      && !nodes.some(node => node.id === turn.id && Number.isFinite(timestamp(node.finishedAt)))).map(turn => timestamp(turn.updatedAt)),
    ...(!round.automatic ? [timestamp(round.updatedAt)] : [])].filter(Number.isFinite);
  return { startedAt, endedAt: Math.max(...ends), running: false };
}

export function formatElapsedTime(milliseconds: number): string {
  const seconds = Number.isFinite(milliseconds) ? Math.max(0, Math.floor(milliseconds / 1000)) : 0;
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), remainder = seconds % 60;
  return hours ? `${hours}小时 ${minutes}分钟 ${remainder}秒` : minutes ? `${minutes}分钟 ${remainder}秒` : `${remainder}秒`;
}
