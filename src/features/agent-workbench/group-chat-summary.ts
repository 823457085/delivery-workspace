/** 历史群聊只按已保存的本轮成员记录整理，不重跑任务，也不把运行结束当作开发验收。 */
import type { AgentRun } from '../../../shared/agent-runtime';
import { groupTeamMembers, type GroupJiraSource, type GroupMember, type GroupRoom, type GroupRound, type GroupTurn } from '../../../shared/agent-group-chat';
import type { TeamTask } from '../../../shared/agent-team';
import { readAgentDeliveryReport } from '../../../shared/delivery-report';
import { agentTaskResultSchema } from '../../../shared/agent-task-result';
import { deliveryEvidenceSchema, deliveryEvidenceKinds, deliveryEvidenceLabels } from '../../../shared/delivery-acceptance';
import { requirementProgressDataSchema } from '../../../shared/requirement-development';
import { agentResultSummary, readableDeliveryReport } from './execution-summary';
import { groupRunAwaitingRestart } from './group-chat-progress';

type SavedReport = {
  version?: unknown;
  taskResult?: { summary?: unknown };
  diagnosis?: { summary?: unknown };
  jiraHandoff?: { cause?: unknown; impact?: unknown; suggestion?: unknown; conclusion?: unknown };
  conversationReply?: { text?: unknown };
  taskPlan?: { reason?: unknown };
  requirementProgress?: unknown;
  validationEvidence?: unknown;
};
type TaskContext = Pick<TeamTask, 'id' | 'round' | 'nodes'> & Partial<Pick<TeamTask, 'state'>>;
export interface GroupSummaryMember {
  turn: GroupTurn; run?: AgentRun; state: GroupTurn['status'] | 'saving'; current: boolean;
  waitingForInput?: boolean;
  summary: string; hasLocalSummary: boolean;
  outcome?: { label: string; state: 'failed' | 'blocked' | 'returned' };
}
export interface GroupSummaryBlocker { member: GroupMember; turn: GroupTurn; run?: AgentRun; text: string }
export interface GroupRoundSummary {
  source?: GroupJiraSource;
  round: GroupRound; members: GroupSummaryMember[]; coordinator?: GroupSummaryMember;
  report?: { source: string; turn: GroupTurn; run?: AgentRun };
  status: 'running' | 'blocked' | 'returned' | 'cancelled'; headline: string; ready: boolean;
  blockers: GroupSummaryBlocker[]; completed: number; total: number; updatedAt: string;
}
function savedReport(result: string): SavedReport | undefined {
  try {
    const value = readAgentDeliveryReport(result) as SavedReport | null;
    return value?.version === 1 ? value : undefined;
  } catch { return undefined; }
}
const originalText = (value: unknown) => typeof value === 'string' && value.trim() ? value : '';

/** 有报告时仅取本岗明确字段；不把每个人复制的全局阶段表当成本岗成果。 */
export function groupMemberSummary(result: string, capability?: GroupMember['capability']): string {
  const report = savedReport(result);
  if (!report) return agentResultSummary(result);
  const summary = [report.taskResult?.summary, report.diagnosis?.summary, report.jiraHandoff?.conclusion,
    report.conversationReply?.text, report.taskPlan?.reason].map(originalText).find(Boolean);
  if (summary) return summary;
  if (capability === 'write') {
    const progress = requirementProgressDataSchema.safeParse(report.requirementProgress);
    if (progress.success) return [...new Set([progress.data.stages.design.evidence, progress.data.stages.development.evidence].filter(Boolean))].join('\n');
  }
  if (capability === 'verify') {
    const evidence = deliveryEvidenceSchema.safeParse(report.validationEvidence);
    if (evidence.success) return [evidence.data.tests.evidence, evidence.data.browser.evidence].filter(Boolean).join('\n');
  }
  return '';
}

export function groupChatSummaries(room: GroupRoom | undefined, runs: AgentRun[], tasks: TaskContext[] = []): GroupRoundSummary[] {
  const byId = new Map(runs.map(run => [run.id, run]));
  return (room?.rounds || []).map(round => {
    const task = tasks.find(task => task.id === round.automatic?.taskId);
    const blockers: GroupSummaryBlocker[] = [];
    const members: GroupSummaryMember[] = round.turns.map(turn => {
      // 当前发言的 runId 是重试身份；不能拿旧备用尝试或旧 turn.result 填补新运行的空结果。
      const run = byId.get(turn.runId), node = task?.nodes.find(node => node.id === turn.id && (!node.runId || node.runId === turn.runId));
      const purpose = (node as { purpose?: string } | undefined)?.purpose;
      const superseded = node && ['coordinate', 'answer'].includes(purpose || '') && task?.nodes.some((next, index) =>
        index > task.nodes.indexOf(node) && next.round === node.round && next.profileId === node.profileId
        && (next as { purpose?: string }).purpose === purpose && next.status !== 'skipped');
      const current = !task || !!node && node.round === task.round && node.status !== 'skipped' && !superseded;
      const waitingForInput = current && node?.status === 'waiting_input' && !node.error && !run?.error
        && run?.status === 'completed' && run.resultReady !== false;
      const result = run ? run.result : turn.result;
      const report = savedReport(result), parsed = agentTaskResultSchema.safeParse(report?.taskResult);
      const state: GroupSummaryMember['state'] = node && !waitingForInput && ['blocked', 'waiting_input', 'needs_reconciliation'].includes(node.status) ? 'failed'
        : node?.status === 'skipped' ? 'cancelled' : groupRunAwaitingRestart(run) ? 'queued'
          : run?.status === 'completed' && run.resultReady === false ? 'saving' : run?.status || turn.status;
      const summary = groupMemberSummary(result, turn.member.capability);
      let outcome: GroupSummaryMember['outcome'];
      const reasons: string[] = [];
      const error = run ? run.error : turn.error;
      if (state === 'completed' && !result.trim()) {
        reasons.push('该岗位尚未保存结果');
        outcome = { label: '缺少汇报结果', state: 'blocked' };
      }
      if (['failed', 'interrupted'].includes(state) && node?.status !== 'skipped') {
        reasons.push(error || node?.error || node?.reason || (state === 'failed' ? '本岗位执行未完成' : '本岗位运行已中断'));
        outcome = { label: '执行未完成', state: 'blocked' };
      }
      if (parsed.success) {
        const result = parsed.data;
        const failedAcceptance = result.acceptance.filter(item => ['failed', 'blocked'].includes(item.status));
        const findings = result.role === 'reviewer' ? result.findings.filter(finding => finding.severity !== 'minor') : [];
        const failedTests = result.selfTests.filter(item => typeof item.exitCode === 'number' && Number.isFinite(item.exitCode) && item.exitCode !== 0);
        const failed = result.status === 'failed' || result.verdict === 'changes_requested' || findings.length > 0
          || failedAcceptance.some(item => item.status === 'failed') || failedTests.length > 0;
        if (result.status !== 'succeeded' || ['changes_requested', 'blocked'].includes(result.verdict || '') || result.blockers.length || failedAcceptance.length || findings.length || failedTests.length) {
          outcome = { label: failed ? '有未通过项' : '有阻塞项', state: failed ? 'failed' : 'blocked' };
          reasons.push(...result.blockers);
          if (result.summary) reasons.push(result.summary);
          reasons.push(...findings.map(finding => finding.problem).filter(Boolean));
          reasons.push(...failedAcceptance.map(item => `${item.id}：${item.status}${item.evidence ? `。${item.evidence}` : ''}`));
          reasons.push(...failedTests.map(item => `${item.command || '本岗位检查'}：退出码 ${item.exitCode}`));
          if (!reasons.length) reasons.push(result.verdict === 'changes_requested' ? '审查要求修改后复核' : '本岗位报告尚未通过');
        } else if (!outcome) outcome = { label: '本岗位已汇报', state: 'returned' };
      }
      if (['verify', 'review'].includes(turn.member.capability)) {
        const evidence = deliveryEvidenceSchema.safeParse(report?.validationEvidence);
        const copiedVerification = room?.source?.workflow === 'requirement' && turn.member.capability === 'review'
          && round.turns.some(previous => previous.member.capability === 'verify');
        if (evidence.success && !copiedVerification) for (const kind of deliveryEvidenceKinds) if (evidence.data[kind].status === 'failed') {
          reasons.push(`${deliveryEvidenceLabels[kind]}：${evidence.data[kind].evidence}`);
          outcome = { label: '有未通过项', state: 'failed' };
        }
      }
      if (current) for (const text of new Set(reasons)) blockers.push({ member: turn.member, turn, run, text });
      return { turn, run, state, current, summary, hasLocalSummary: !!summary,
        ...(waitingForInput ? { waitingForInput: true } : {}), ...(outcome ? { outcome } : {}) };
    });
    const activeMembers = members.filter(member => member.current);
    const last = members.at(-1);
    const reportValue = last && savedReport(last.run ? last.run.result : last.turn.result);
    const source = reportValue ? JSON.stringify(reportValue) : '';
    const readable = source ? readableDeliveryReport(source) : undefined;
    // 只有末位真实汇总记录可代表本轮全局报告，前序实现/验证成员的全局表不能顶替它。
    const globalReport = reportValue && (requirementProgressDataSchema.safeParse(reportValue.requirementProgress).success
      || readable?.sections.some(section => section.title === '交接说明'));
    const report = last?.current && globalReport && readable ? { source, turn: last.turn, run: last.run } : undefined;
    const reportProblems = report && readable?.sections.flatMap(section => section.rows.filter(row => ['failed', 'blocked'].includes(row.state))) || [];
    if (report && last) for (const row of reportProblems) {
      const text = `${row.title}：${row.status}${row.evidence ? `。${row.evidence}` : ''}`;
      if (!blockers.some(item => item.turn.id === last.turn.id && item.text === text)) blockers.push({ member: last.turn.member, turn: last.turn, run: last.run, text });
    }
    const unfinished = !activeMembers.length || activeMembers.some(member => ['pending', 'queued', 'running', 'saving'].includes(member.state));
    const executing = activeMembers.some(member => ['queued', 'running', 'saving'].includes(member.state));
    const waitingForLogin = !!round.loginHandoff && !round.loginHandoff.answered && !['completed', 'cancelled'].includes(round.state);
    const status: GroupRoundSummary['status'] = round.state === 'cancelled' ? 'cancelled'
      : waitingForLogin ? 'running'
      : executing && task?.state === 'running' && round.state === 'running' ? 'running'
      : blockers.length || task && ['blocked', 'needs_decision', 'needs_reconciliation'].includes(task.state || '') ? 'blocked'
      : unfinished || task && ['planning', 'awaiting_plan', 'running', 'waiting_input'].includes(task.state || '') ? 'running' : 'returned';
    const partialRequirement = room?.source?.workflow === 'requirement' && round.state === 'failed';
    const ready = (!unfinished || partialRequirement) && ['completed', 'failed', 'cancelled'].includes(round.state)
      && !(task && ['planning', 'awaiting_plan', 'running', 'waiting_input'].includes(task.state || ''))
      && activeMembers.every(member => member.run?.resultReady !== false && !['queued', 'running'].includes(member.run?.status || '')
        && (member.state !== 'completed' || !!(member.run ? member.run.result : member.turn.result).trim()))
      && activeMembers.some(member => !!(member.run ? member.run.result : member.turn.result).trim());
    const headline = waitingForLogin ? '等待你登录测试环境' : status === 'cancelled' ? '本轮已取消' : status === 'blocked' ? '本轮仍有待处理项'
      : !activeMembers.length ? '尚无本轮成员执行记录' : status === 'running' ? '团队正在处理，尚未形成最终汇总'
      : report && readable ? readable.headline : '成员汇报已返回，交付结果待核对';
    const leaderId = round.automatic ? groupTeamMembers(round.automatic.config).leader?.id : undefined;
    const coordinator = round.automatic
      ? members.find(member => member.run?.team?.profileId === 'leader') || members.find(member => member.turn.member.id === leaderId)
      : members.find(member => member.turn.member.id === 'leader');
    const updatedAt = members.reduce((value, member) => (member.run?.updatedAt || member.turn.updatedAt) > value ? member.run?.updatedAt || member.turn.updatedAt : value, round.updatedAt);
    return { source: room?.source, round, members, coordinator, report, status, headline, ready, blockers,
      completed: activeMembers.filter(member => member.state === 'completed').length, total: activeMembers.length, updatedAt };
  });
}
