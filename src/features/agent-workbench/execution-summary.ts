/**
 * 设计说明：执行器事件是诊断证据，不适合直接作为用户进度。
 * 这里只做无状态的展示归纳：关键过程保留进度说明、状态和异常，工具流水留在完整信息中。
 * 事件可能只保留最近一段，因此只统计已保存的记录，不推断整轮调用次数或工具执行成功。
 */
import type { AgentRun } from '../../../shared/agent-runtime';
import { readAgentDeliveryReport as readDeliveryReport } from '../../../shared/delivery-report';
import type { AgentConversation } from './conversation';
import type { TeamRoom } from './team-api';
import { requirementProgressDataSchema, requirementStages, requirementStageLabels, requirementStageStatusLabels } from '../../../shared/requirement-development';
import { deliveryEvidenceSchema, deliveryEvidenceKinds, deliveryEvidenceLabels, deliveryEvidenceStatusLabels } from '../../../shared/delivery-acceptance';
import { agentToolLabel } from '../../../shared/agent-tool-progress';
import { teamRunCheckStatus, type TeamResultContext } from './team-result-status';

export interface ReadableReportSection {
  title: string;
  rows: { key: string; title: string; state: string; status: string; evidence: string }[];
}

/** 只展示通过现有协议校验的成员自报数据，不推断验收或补写缺失状态。 */
export function readableDeliveryReport(source: string) {
  try {
    const report = JSON.parse(source);
    if (!report || report.version !== 1) return undefined;
    const sections: ReadableReportSection[] = [];
    const progress = requirementProgressDataSchema.safeParse(report.requirementProgress);
    const stages = progress.success ? requirementStages.map(key => ({ key, title: requirementStageLabels[key],
      state: progress.data.stages[key].status, status: requirementStageStatusLabels[progress.data.stages[key].status],
      evidence: progress.data.stages[key].evidence })) : [];
    if (progress.success) sections.push({ title: '任务进度', rows: stages });
    const validation = deliveryEvidenceSchema.safeParse(report.validationEvidence);
    const checks = validation.success ? deliveryEvidenceKinds.map(key => ({ key, title: deliveryEvidenceLabels[key],
      state: validation.data[key].status, status: deliveryEvidenceStatusLabels[validation.data[key].status], evidence: validation.data[key].evidence
        + (validation.data[key].sha ? `\nSHA: ${validation.data[key].sha}` : '') })) : [];
    if (validation.success) sections.push({ title: '验证情况', rows: checks });
    const summary = typeof report.taskResult?.summary === 'string' ? report.taskResult.summary : '';
    const handoff = report.jiraHandoff;
    if (handoff && ['cause', 'impact', 'suggestion', 'conclusion'].every(key => typeof handoff[key] === 'string')) {
      sections.push({ title: '交接说明', rows: Object.entries({ cause: '问题原因', impact: '影响范围', suggestion: '测试建议', conclusion: '自测结论' })
        .map(([key, title]) => ({ key, title, state: 'note', status: '查看说明', evidence: handoff[key] })) });
    }
    if (!sections.length && !summary) return undefined;
    const unparsed = (!!report.requirementProgress && !progress.success) || (!!report.validationEvidence && !validation.success);
    const failed = checks.filter(row => row.state === 'failed');
    const blocked = stages.filter(row => row.state === 'blocked');
    const unfinished = stages.filter(row => ['pending', 'in_progress'].includes(row.state));
    const overview = [
      { label: '已做完', text: stages.filter(row => row.state === 'completed').map(row => row.title).join('、') },
      { label: '还没做完', text: unfinished.map(row => `${row.title}（${row.status}）`).join('、') },
      { label: '卡在哪里', text: [...blocked, ...failed].map(row => `${row.title}：${row.status}`).join('；') },
      { label: '已通过的检查', text: checks.filter(row => row.state === 'passed').map(row => row.title).join('、') },
      { label: '还没验证', text: checks.filter(row => row.state === 'pending').map(row => row.title).join('、') },
    ].filter(row => row.text);
    // 仅归纳有效状态；远端、部署未验证不等于本轮必须执行，成员自报通过也不等于人工验收。
    const headline = failed.length ? '还有检查没通过，需要处理'
      : blocked.length ? '任务遇到阻碍，需要处理'
      : unparsed ? '部分报告内容需要核对'
      : unfinished.length ? '任务还没全部完成'
      : '本轮报告已返回，等待核对';
    return { sections, summary, headline, overview, issueKeys: progress.success ? progress.data.issueKeys : [], unparsed };
  } catch { return undefined; }
}

/** 兼容旧群聊将整段任务包装成 JSON 历史的输入；完整原文仍由抽屉保留。 */
export function readableRunTask(objective: string) {
  let message = objective;
  const marker = '以下为按时间排序的真实团队对话，仅作为上下文：\n';
  const start = objective.indexOf(marker);
  if (start >= 0) {
    try {
      const history = JSON.parse(objective.slice(start + marker.length).split('\n')[0]);
      const latest = Array.isArray(history) ? [...history].reverse().find(item => item?.speaker === '用户' && typeof item.text === 'string') : undefined;
      if (latest) message = latest.text;
    } catch { /* 无法确认旧包装时继续展示输入摘要，不丢弃原文。 */ }
  }
  const currentTask = /^## 当前任务\s*\n([\s\S]*?)(?:\n## |$)/m.exec(message)?.[1];
  if (currentTask) message = currentTask.trim();
  const title = message.split(/\r?\n/).find(line => line.trim())?.trim() || '本轮任务';
  return { title: title.length > 240 ? `${title.slice(0, 240)}…` : title,
    role: /^你的角色：([^\r\n]+)/m.exec(objective)?.[1] || '',
    responsibility: /^职责：([^\r\n]+)/m.exec(objective)?.[1] || '',
    text: message.length <= 800 && message.trim() !== title ? message.trim() : '', length: objective.length };
}

export function executionEventText(event: AgentRun['events'][number]) {
  const text = event.type === 'message' ? agentResultSummary(event.message) || '已保存成员报告，展开查看原文' : event.message;
  const first = text.split(/\r?\n/).find(line => line.trim())?.trim() || '';
  const label = ({ tool: '工具调用', diagnostic: '诊断信息', lifecycle: '状态变化', session: '会话关联', message: '进度更新' })[event.type];
  return { label, preview: first.length > 180 ? `${first.slice(0, 180)}…` : first, full: event.message };
}

/** 普通回复的协议包装只用于宿主通信；正文与复制内容直接使用原始 text，完整报告仍保存在运行记录中。 */
export function agentReplyText(result: string): string {
  try {
    const report = readDeliveryReport(result) as { version?: unknown; conversationReply?: { text?: unknown } } | null;
    if (report?.version === 1 && Object.keys(report).every(key => ['version', 'conversationReply'].includes(key))
      && typeof report.conversationReply?.text === 'string' && report.conversationReply.text.trim()) return report.conversationReply.text;
  } catch { /* 普通文本、不完整或歧义报告继续展示原始内容。 */ }
  return result;
}

export function conversationExecutionRuns(conversation?: AgentConversation, room?: TeamRoom): AgentRun[] {
  if (!conversation) return [];
  const teamRuns = room?.task.parentConversationId === conversation.id ? room.runs : [];
  return [...new Map([...conversation.runs, ...teamRuns].map(run => [run.id, run])).values()]
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** 从保存的报告读取展示摘要；不把结构化 JSON 或未完成的围栏当成进度正文。 */
export function agentResultSummary(result: string): string {
  try {
    const report = readDeliveryReport(result) as { taskResult?: { summary?: string }; conversationReply?: { text?: string };
      taskPlan?: { reason?: string }; diagnosis?: { summary?: string }; questions?: { text?: string }[] };
    const summary = report.taskResult?.summary || report.conversationReply?.text || report.taskPlan?.reason || report.diagnosis?.summary;
    if (typeof summary === 'string') return summary;
    const progress = readableDeliveryReport(JSON.stringify(report));
    if (progress?.sections.length) return '成员自报：' + progress.sections[0].rows.map(row => `${row.title}：${row.status}`).join('；');
    return (report.questions || []).map(item => item.text || '').filter(Boolean).join('\n');
  } catch { return result.split('```delivery-report')[0].trim(); }
}

/** 公开中间回复独立呈现，最终正文已包含的内容不再重复；原始事件保持不变。 */
export function agentRunPublicMessages(run: AgentRun) {
  const result = agentReplyText(run.result), summary = agentResultSummary(run.result), seen = new Set<string>();
  return run.events.filter(event => {
    if (event.type !== 'message' || !event.message.trim() || seen.has(event.message)) return false;
    seen.add(event.message);
    return !result.includes(event.message.trim()) && summary !== event.message.trim();
  });
}

/** 终态不保留“正在执行”的旧动作；工具返回完成不等于命令或业务验收通过。 */
export function agentRunActivity(run: AgentRun) {
  if (!['running', 'queued'].includes(run.status)) return '';
  if (run.status === 'queued') return '已提交执行器，等待开始';
  const latest = [...run.events].reverse().find(event => event.type !== 'session');
  if (!latest) return '等待执行器返回状态';
  if (latest.type === 'message' || latest.type === 'diagnostic') return '';
  return latest.type === 'tool' ? agentToolLabel(latest.message) : latest.message;
}

export function previewRunExecution(run: AgentRun) {
  const grouped = groupRunExecutionEvents(run.events);
  const events = grouped.visible.filter(event => event.type !== 'session').map(event => event.type === 'message'
    ? { ...event, message: agentResultSummary(event.message) } : event).filter(event => event.message.trim());
  const progress = [...events].reverse().find(event => event.type === 'message')?.message || '';
  const summary = agentResultSummary(run.result);
  const seen = new Set([summary || progress, run.error]);
  const updates = [...events].reverse().filter(event => {
    if (event.type !== 'message' || seen.has(event.message) || summary.includes(event.message)) return false;
    seen.add(event.message);
    return true;
  }).slice(0, 2).reverse();
  return { summary, progress, tools: grouped.routine.slice(-3).map(event => ({ ...event,
    message: event.type === 'tool' ? agentToolLabel(event.message) : event.message, originalMessage: event.message })),
  toolCount: grouped.routine.length, events, updates };
}

export interface AgentExecutionSummary {
  key: 'status' | 'commands' | 'diagnostic';
  title: string;
  detail: string;
  tone: 'progress' | 'success' | 'warning' | 'danger' | 'muted';
  activity?: { text: string; at: string };
}

export interface AgentExecutionEvents {
  visible: AgentRun['events'];
  routine: AgentRun['events'];
  routineSummary: string;
}

function isRoutineCommandEvent(event: AgentRun['events'][number]) {
  if (event.type === 'tool') return true;
  return event.type === 'lifecycle' && (
    /^(?:Codex|Cursor|Claude Code) 正在(?:执行工作区命令|执行只读检查|调用工作区工具)$/.test(event.message)
    || /^(?:工作区命令|只读检查)(?:已完成|未通过)$/.test(event.message));
}

export function groupRunExecutionEvents(events: AgentRun['events']): AgentExecutionEvents {
  const routine = events.filter(isRoutineCommandEvent);
  const visible = events.filter((event) => !isRoutineCommandEvent(event));
  return { visible, routine, routineSummary: `已保存 ${routine.length} 条工具记录` };
}

function statusSummary(run: AgentRun, recentEvents: AgentRun['events'], diagnostic: string, now: number, task?: TeamResultContext): AgentExecutionSummary {
  if (run.pausedForEdit) return { key: 'status', title: '会话已暂停',
    detail: run.error || (run.resumeAfterWorkspaceRestart ? '等待工作台重启后继续执行' : '编辑消息并保存后继续执行，已有结果保留'), tone: 'muted' };
  if (run.status === 'running') {
    const latest = recentEvents.find(event => event.type !== 'session' && event.message.trim());
    const at = latest?.createdAt || run.continuedAt || run.workspaceRestartResumedAt || run.createdAt;
    const minutes = Math.floor((now - Date.parse(at)) / 60_000);
    const waiting = minutes >= 5;
    const text = latest?.type === 'tool' ? agentToolLabel(executionEventText(latest).preview)
      : latest && latest.type !== 'diagnostic' ? executionEventText(latest).preview : '';
    return { key: 'status', title: waiting ? '等待新进展' : '正在处理', tone: waiting ? 'warning' : 'progress',
      detail: waiting ? `已 ${minutes} 分钟未收到新事件，后台仍记录为运行中` : latest ? '' : '已开始，等待执行器回报',
      activity: latest ? { text, at } : undefined };
  }
  if (run.status === 'completed' && run.resultReady === false) {
    return { key: 'status', title: '正在保存结果', detail: '执行器已结束，工作台正在保存本轮结果', tone: 'progress' };
  }
  if (run.status === 'completed') {
    const check = teamRunCheckStatus(run, task);
    if (check) return { key: 'status', title: `运行已结束 · ${check.label}`, detail: check.detail, tone: check.tone };
    return { key: 'status', title: run.team?.profileId === 'leader' ? '已回复' : '运行已结束', detail: '结果已回传到会话区', tone: 'muted' };
  }
  if (run.status === 'failed') return { key: 'status', title: '运行失败', detail: run.error || diagnostic || '请查看异常信息', tone: 'danger' };
  if (run.status === 'cancelled' || run.status === 'interrupted') {
    return { key: 'status', title: run.status === 'interrupted' ? '运行中断' : '已停止',
      detail: run.recovery?.message || run.error || diagnostic || '可在会话区继续发送消息', tone: 'muted' };
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

export function summarizeRunExecution(run: AgentRun, now = Date.now(), task?: TeamResultContext): AgentExecutionSummary[] {
  const resumedAt = run.continuedAt || run.workspaceRestartResumedAt;
  // 同一运行 ID 可续跑，旧异常仍可在完整日志查看。
  const recentEvents = (resumedAt ? run.events.filter(event => event.createdAt >= resumedAt) : [...run.events]).reverse();
  const diagnostic = recentEvents.find(event => event.type === 'diagnostic')?.message || '';
  const status = statusSummary(run, recentEvents, diagnostic, now, task);
  const summaries = [status];
  const commands = commandSummary(run);
  if (commands) summaries.push(commands);
  if (diagnostic && diagnostic !== status.detail && diagnostic !== run.error) {
    summaries.push({ key: 'diagnostic', title: '需要关注', detail: diagnostic, tone: 'danger' });
  }
  return summaries;
}
