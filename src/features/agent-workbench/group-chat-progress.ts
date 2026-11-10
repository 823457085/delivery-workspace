import type { AgentRun } from '../../../shared/agent-runtime';
import type { GroupRoom, GroupRound, GroupTurn } from '../../../shared/agent-group-chat';
import type { GroupRoundSummary } from './group-chat-summary';

type TurnState = GroupTurn['status'] | 'saving';
const labels: Record<TurnState, string> = { pending: '待执行', queued: '排队中', running: '正在处理', saving: '正在保存结果',
  completed: '已回复', failed: '执行失败', interrupted: '运行中断', cancelled: '已取消' };
export interface GroupTurnPresentation {
  turn: GroupTurn; run?: AgentRun; step: number; state: TurnState; label: string; reason: string; started: boolean;
  waitingForInput?: boolean;
}
export interface GroupRoundPresentation {
  round: GroupRound; turns: GroupTurnPresentation[]; started: GroupTurnPresentation[]; pending: GroupTurnPresentation[];
  focus?: GroupTurnPresentation; summary: string;
}

/** 追问和重试沿用原轮次，消息末尾仍要能看到当前运行或本次最新回复。 */
export function recentGroupTurns(turns: GroupTurnPresentation[], latestUserAt: string): GroupTurnPresentation[] {
  const active = turns.filter(item => ['queued', 'running', 'saving'].includes(item.state));
  if (active.length) return active;
  const latest = turns.filter(item => item.run && item.run.createdAt >= latestUserAt)
    .sort((a, b) => b.run!.createdAt.localeCompare(a.run!.createdAt))[0];
  return latest ? [latest] : [];
}

export function groupRunAwaitingRestart(run?: AgentRun) {
  return !!(run?.pausedForEdit && run.resumeAfterWorkspaceRestart && run.status === 'cancelled' && !run.error);
}

/** 只整理展示：复用本轮汇总的宿主结论，避免 CLI 已退出掩盖结果接收阻塞；不更改运行和流程状态。 */
export function groupChatPresentation(room: GroupRoom | undefined, runs: AgentRun[], summaries: readonly GroupRoundSummary[] = []) {
  const byId = new Map(runs.map(run => [run.id, run]));
  let blocker: GroupTurnPresentation | undefined;
  const rounds: GroupRoundPresentation[] = (room?.rounds || []).map(round => {
    const summary = summaries.find(summary => summary.round.id === round.id);
    const turns = round.turns.map((turn, index): GroupTurnPresentation => {
      const run = byId.get(turn.runId);
      const awaitingRestart = groupRunAwaitingRestart(run);
      const runtimeState: TurnState = awaitingRestart ? 'queued' : run?.status === 'completed' && run.resultReady === false ? 'saving' : run?.status || turn.status;
      const member = summary?.members.find(member => member.turn.id === turn.id && member.turn.runId === turn.runId);
      const waitingForInput = member?.waitingForInput;
      const resultBlocked = runtimeState === 'completed' && member?.current && member.state === 'failed';
      const state: TurnState = resultBlocked ? 'failed' : runtimeState;
      const paused = room!.paused && round.state !== 'failed' && !['completed', 'cancelled'].includes(round.state);
      let label = labels[state], reason = '';
      if (round.loginHandoff?.answered === false && round.loginHandoff.turnId === turn.id && round.state !== 'cancelled') {
        label = '等待登录'; reason = '等待你在浏览器完成测试环境登录。';
      } else if (awaitingRestart) {
        label = '等待重启后续跑'; reason = '工作台已暂停本轮，重启后将自动续接原运行。';
      } else if (waitingForInput) {
        label = '等待回复';
      } else if (resultBlocked) {
        label = '结果接收受阻'; reason = [...new Set(summary!.blockers.filter(item => item.turn.id === turn.id).map(item => item.text))].join('\n');
      } else if (state === 'pending' && blocker) {
        label = '被阻塞'; reason = `前序成员「${blocker.turn.member.name}」${blocker.label}。${blocker.reason || blocker.run?.error || blocker.turn.error || '请处理该成员的问题后继续。'}`;
      } else if ((state === 'pending' && room!.paused) || (paused && state === 'interrupted')) {
        label = '已暂停'; reason = '群聊已暂停，点击“继续执行”后按原顺序处理。';
      } else if (paused && ['queued', 'running', 'saving'].includes(state)) {
        label = '正在停止'; reason = '已请求暂停，正在等待当前运行停止。';
      } else if (state === 'queued') {
        label = run ? '排队中' : turn.member.capability === 'verify' && room!.workspacePath ? '准备验证副本' : '正在派发';
        reason = run ? '已提交执行器，等待开始。' : turn.member.capability === 'verify' && room!.workspacePath ? '正在准备隔离副本，随后运行验证。' : '正在联系所选执行器。';
      } else if (state === 'pending') reason = '尚未轮到该成员，前面的成员完成后自动执行。';
      const value = { turn, run, step: index + 1, state, label, reason, ...(waitingForInput ? { waitingForInput: true } : {}),
        started: !!run || !['pending', 'cancelled'].includes(state) || turn.attempt > 1 || !!turn.result || !!turn.error || !!turn.fallbacks?.length };
      if (!blocker && !['completed', 'cancelled'].includes(round.state) && (state === 'failed' || ['interrupted', 'cancelled'].includes(state) && !paused)) blocker = value;
      return value;
    });
    const waitingForLogin = round.loginHandoff?.answered === false ? round.loginHandoff : undefined;
    const focus = round.state !== 'cancelled' ? (waitingForLogin ? turns.find(item => item.turn.id === waitingForLogin.turnId) : undefined)
      || turns.find(item => ['queued', 'running', 'saving'].includes(item.state))
      || turns.find(item => item.waitingForInput)
      || turns.find(item => ['failed', 'interrupted', 'cancelled'].includes(item.state)) || turns.find(item => item.state === 'pending') : undefined;
    return { round, turns, started: turns.filter(item => item.started), pending: turns.filter(item => !item.started), focus,
      summary: focus ? `第 ${focus.step}/${turns.length} 步 · ${focus.turn.member.name}${focus.label}` : '' };
  });
  const current = rounds.find(item => item.focus && ['queued', 'running', 'saving'].includes(item.focus.state))
    || rounds.find(item => item.focus && item.round.state !== 'cancelled') || rounds.at(-1);
  const active = current?.focus && ['queued', 'running', 'saving'].includes(current.focus.state) ? current.focus : undefined;
  const awaitingRestart = groupRunAwaitingRestart(active?.run);
  const loginRound = rounds.find(item => item.round.loginHandoff && !item.round.loginHandoff.answered && !['completed', 'cancelled'].includes(item.round.state));
  const status = loginRound ? '等待你登录测试环境' : !current ? '等待消息' : current.round.state === 'completed' && !current.focus ? '本轮完成' : current.round.state === 'cancelled' ? '已取消'
    : active ? active.label === '正在停止' ? '正在停止' : `${active.turn.member.name}${active.label}` : blocker ? '被阻塞' : room?.paused ? '已暂停' : current.round.state === 'failed' ? '被阻塞'
    : current.focus ? `${current.focus.turn.member.name}${current.focus.label}` : '待执行';
  const hint = loginRound ? '登录后，点击“已登录，继续验证”。' : current?.focus?.waitingForInput ? '等待你的回复' : active && awaitingRestart ? active.reason : active && room?.paused ? active.label === '正在停止' ? active.reason : '当前成员仍在执行，后续步骤已暂停，当前运行结束后可继续。'
    : status === '被阻塞' ? `前序成员「${blocker?.turn.member.name || current?.focus?.turn.member.name || '未知'}」执行未完成，请处理具体原因后继续；等待不会自动恢复。`
    : status === '已暂停' || status === '正在停止' ? current?.focus?.reason || '已暂停，点击“继续执行”后按原顺序处理。'
    : '成员按顺序执行，未开始的成员收在后续步骤中。';
  const progressText = current ? `${current.turns.filter(item => item.state === 'completed' && item.label !== '等待登录').length}/${current.turns.length} 位成员已完成 · ${status === '本轮完成' ? '团队本轮已结束，待核验交付结果' : status}` : '';
  return { rounds, active, status, hint, progressText, awaitingRestart, waitingForRun: !!active && !!room?.paused };
}
