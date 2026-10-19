/**
 * 设计说明：执行器事件是诊断证据，不适合直接作为用户进度。
 * 这里只做无状态的展示归纳：关键过程保留进度说明、状态和异常，工具流水留在完整信息中。
 * 事件可能只保留最近一段，因此只统计已保存的记录，不推断整轮调用次数或工具执行成功。
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

function isRoutineCommandEvent(event: AgentRun['events'][number]) {
  if (event.type === 'tool') return true;
  return event.type === 'lifecycle' && (
    /^(?:Codex|Cursor) 正在(?:执行工作区命令|执行只读检查|调用工作区工具)$/.test(event.message)
    || /^(?:工作区命令|只读检查)(?:已完成|未通过)$/.test(event.message));
}

export function groupRunExecutionEvents(events: AgentRun['events']): AgentExecutionEvents {
  const routine = events.filter(isRoutineCommandEvent);
  const visible = events.filter((event) => !isRoutineCommandEvent(event));
  return { visible, routine, routineSummary: `已保存 ${routine.length} 条工具记录` };
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
  const { routine } = groupRunExecutionEvents(run.events);
  if (!routine.length) return undefined;
  const failed = routine.filter((event) => /^(?:工作区命令|只读检查)未通过$|^执行(?:失败|未通过)[:：]/.test(event.message)).length;
  const detail = `${routine.length} 条记录已收起${failed ? `，${failed} 条提示未通过` : '，可在完整信息中查看'}`;
  return { key: 'commands', title: '工具调用', detail, tone: failed ? 'warning' : 'muted' };
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
