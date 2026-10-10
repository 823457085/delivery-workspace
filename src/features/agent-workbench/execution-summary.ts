/**
 * 设计说明：执行器事件是诊断证据，不适合直接作为用户进度。
 * 这里只做无状态的展示归纳：保留本轮结果、命令数量和最后一条异常，不改写原始事件。
 */
import type { AgentRun } from '../../../shared/agent-runtime';

export interface AgentExecutionSummary {
  key: 'status' | 'commands' | 'diagnostic';
  title: string;
  detail: string;
  tone: 'progress' | 'success' | 'warning' | 'danger' | 'muted';
}

export interface AgentExecutionEvents {
  visible: AgentRun['events'];
  routine: AgentRun['events'];
  routineSummary: string;
}

function isRoutineCommandEvent(message: string) {
  return /^(?:Codex|Cursor) 正在(?:执行工作区命令|执行只读检查|调用工作区工具)$/.test(message)
    || /^(?:工作区命令|只读检查)(?:已完成|未通过)$/.test(message);
}

export function groupRunExecutionEvents(events: AgentRun['events']): AgentExecutionEvents {
  const routine = events.filter((event) => isRoutineCommandEvent(event.message));
  const visible = events.filter((event) => !isRoutineCommandEvent(event.message));
  const started = routine.filter((event) => /正在/.test(event.message)).length;
  const succeeded = routine.filter((event) => /已完成$/.test(event.message)).length;
  const failed = routine.filter((event) => /未通过$/.test(event.message)).length;
  const total = Math.max(started, succeeded + failed);
  const parts = [`${total} 次执行`];
  if (succeeded) parts.push(`${succeeded} 次完成`);
  if (failed) parts.push(`${failed} 次未通过`);
  if (started > succeeded + failed) parts.push(`${started - succeeded - failed} 次执行中`);
  return { visible, routine, routineSummary: parts.join(' · ') };
}

function statusSummary(run: AgentRun): AgentExecutionSummary {
  if (run.pausedForEdit) return { key: 'status', title: '会话已暂停', detail: '编辑消息并保存后继续执行，已有结果保留', tone: 'muted' };
  if (run.status === 'running') return { key: 'status', title: '正在处理', detail: 'Agent 仍在执行本轮任务', tone: 'progress' };
  if (run.status === 'completed') return { key: 'status', title: '本轮已完成', detail: '结果已回传到会话区', tone: 'success' };
  if (run.status === 'failed') return { key: 'status', title: '本轮执行失败', detail: run.error || '请查看异常信息', tone: 'danger' };
  if (run.status === 'cancelled' || run.status === 'interrupted') {
    return { key: 'status', title: '本轮已停止', detail: '可在会话区继续发送消息', tone: 'muted' };
  }
  return { key: 'status', title: '等待开始', detail: '已进入本机执行队列', tone: 'muted' };
}

function commandSummary(run: AgentRun): AgentExecutionSummary | undefined {
  const messages = run.events.map((event) => event.message);
  const started = messages.filter((message) => /正在(?:执行工作区命令|执行只读检查|调用工作区工具)/.test(message)).length;
  const succeeded = messages.filter((message) => /(?:工作区命令|只读检查)已完成/.test(message)).length;
  const failed = messages.filter((message) => /(?:工作区命令|只读检查)未通过/.test(message)).length;
  const finished = succeeded + failed;
  const total = Math.max(started, finished);
  if (!total) return undefined;
  const active = run.status === 'running' ? Math.max(0, started - finished) : 0;
  let detail = `已执行 ${total} 个操作`;
  if (active) detail += `，${active} 个执行中`;
  if (failed) detail += run.status === 'running' ? `，${failed} 个需要调整` : `，${failed} 个曾未通过`;
  return { key: 'commands', title: '工作区操作', detail, tone: failed ? 'warning' : active ? 'progress' : 'success' };
}

export function summarizeRunExecution(run: AgentRun): AgentExecutionSummary[] {
  const summaries = [statusSummary(run)];
  const commands = commandSummary(run);
  if (commands) summaries.push(commands);
  const diagnostic = [...run.events].reverse().find((event) => event.type === 'diagnostic');
  if (diagnostic && diagnostic.message !== run.error) {
    summaries.push({ key: 'diagnostic', title: '需要关注', detail: diagnostic.message, tone: 'danger' });
  }
  return summaries;
}
