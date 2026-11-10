import type { AgentRun } from '../shared/agent-runtime.js';
import type { CodexSessionSource } from './codex-session-source.js';
import { desktopTurnFromSnapshot, readCodexDesktopSnapshot } from './codex-desktop-turn.js';
import { desktopObject as object } from './codex-desktop-ipc.js';

export function processIsAlive(pid: number | null) {
  if (!pid || !Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Only a fresh, exact native turn can repair completion; text similarity and cached replies are not evidence. */
export async function checkAgentRecovery(run: AgentRun, source: CodexSessionSource,
  alive = processIsAlive, readDesktop = readCodexDesktopSnapshot): Promise<Pick<AgentRun, 'status' | 'result' | 'error' | 'recovery'>> {
  const recovery = { ...run.recovery!, checkedAt: new Date().toISOString() };
  let detail = '';
  if (recovery.nativeObservation === 'codex-desktop' && run.sessionId && run.codexTurnId) {
    try {
      const state = await readDesktop(run.sessionId);
      const turn = desktopTurnFromSnapshot(state, run.sessionId, run.codexTurnId);
      const latestMessage = (Array.isArray(turn?.items) ? turn.items.map(object) : [])
        .filter(item => item.type === 'agentMessage' && typeof item.text === 'string').at(-1)?.text;
      if (turn?.status === 'inProgress') {
        const message = 'Codex 原轮次仍在执行，正在恢复结果同步；未重复派发。';
        return { status: 'interrupted', result: latestMessage ? String(latestMessage) : run.result, error: '', recovery: { ...recovery, state: 'active', message } };
      }
      if (turn?.status === 'completed') {
        if (latestMessage) return { status: 'completed', result: String(latestMessage), error: '',
          recovery: { ...recovery, state: 'completed', message: '已核对桌面原轮次结束并同步最终结果；未重复执行。' } };
      }
      if (turn && ['failed', 'interrupted'].includes(String(turn.status))) {
        const message = String(object(turn.error).message || `Codex 原轮次${turn.status}`);
        if (recovery.stopRequested) return { status: turn.status === 'interrupted' ? 'cancelled' : 'failed', result: run.result,
          error: turn.status === 'interrupted' ? '' : message,
          recovery: { ...recovery, state: 'completed', message: turn.status === 'interrupted' ? '已核对桌面原轮次停止；已有改动保留，未重复执行。' : message } };
        return { status: 'failed', result: run.result, error: message, recovery: { ...recovery, state: 'needs-review', message } };
      }
    } catch { /* 桌面暂不可读时仍可使用确切轮次的持久化结束证据。 */ }
  }
  if (run.provider === 'codex' && run.sessionId && run.codexTurnId) {
    try {
      const session = await source.session(run.sessionId);
      const turn = session.id === run.sessionId ? session.turns.find(item => item.id === run.codexTurnId) : undefined;
      if (turn?.completedAt && turn.agentMessage) {
        return { status: 'completed', result: turn.agentMessage, error: '',
          recovery: { ...recovery, state: 'completed', message: '已核对原生轮次结束并同步最终回复；业务验收需另行确认。' } };
      }
      detail = turn ? '原生轮次尚无完整结束记录。' : '未找到对应原生轮次。';
    } catch { detail = '原生轮次暂时无法读取。'; }
  }
  const active = alive(recovery.previousPid);
  const message = recovery.nativeObservation === 'codex-desktop' ? '暂未确认 Codex 原轮次结束，正在自动核对；未重复派发。'
    : active ? '原执行进程仍存在，禁止重复派发；请等待后重新核对。'
    : recovery.previousStatus === 'queued' ? '该消息重启前尚在排队，未自动派发；确认前序任务后可继续。'
      : `${detail || '缺少可验证的原生结束记录。'}请核对已有结果与外部操作后再继续，避免重复执行。`;
  return { status: 'interrupted', result: run.result, error: message,
    recovery: { ...recovery, state: active ? 'active' : 'needs-review', message } };
}
