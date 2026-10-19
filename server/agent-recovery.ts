import type { AgentRun } from '../shared/agent-runtime.js';
import type { CodexSessionSource } from './codex-session-source.js';

export function processIsAlive(pid: number | null) {
  if (!pid || !Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Only a fresh, exact native turn can repair completion; text similarity and cached replies are not evidence. */
export async function checkAgentRecovery(run: AgentRun, source: CodexSessionSource,
  alive = processIsAlive): Promise<Pick<AgentRun, 'status' | 'result' | 'error' | 'recovery'>> {
  const recovery = { ...run.recovery!, checkedAt: new Date().toISOString() };
  let detail = '';
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
  const message = active ? '原执行进程仍存在，禁止重复派发；请等待后重新核对。'
    : recovery.previousStatus === 'queued' ? '该消息重启前尚在排队，未自动派发；确认前序任务后可继续。'
      : `${detail || '缺少可验证的原生结束记录。'}请核对已有结果与外部操作后再继续，避免重复执行。`;
  return { status: 'interrupted', result: run.result, error: message,
    recovery: { ...recovery, state: active ? 'active' : 'needs-review', message } };
}
