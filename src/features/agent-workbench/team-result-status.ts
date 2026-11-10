/** 运行结束只说明执行器退出；测试与审查结论由本次已保存的结构化报告判定。 */
import type { AgentRun } from '../../../shared/agent-runtime';
import type { TeamNode, TeamTask } from '../../../shared/agent-team';
import { evaluateReview, evaluateVerification, readAgentTaskReport } from '../../../shared/agent-task-result';

export type TeamResultContext = Pick<TeamTask, 'id' | 'nodes' | 'plan'> & Partial<Pick<TeamTask, 'round' | 'planHistory'>>;
type Criteria = NonNullable<TeamTask['plan']>['acceptanceCriteria'];
export interface TeamCheckStatus {
  value: 'passed' | 'failed' | 'blocked' | 'unknown';
  label: string; detail: string; tone: 'success' | 'danger' | 'warning' | 'muted';
}

function checkRole(profileId?: string, stage?: string) {
  if (profileId === 'verifier' && (!stage || stage === 'verify')) return 'verifier';
  if (profileId === 'reviewer' && (!stage || stage === 'review')) return 'reviewer';
  return undefined;
}

export function teamCheckStatus(profileId: string, source: string, criteria?: Criteria, stage?: string): TeamCheckStatus | undefined {
  const role = checkRole(profileId, stage);
  if (!role) return undefined;
  const title = role === 'verifier' ? '验证' : '审查';
  let report: ReturnType<typeof readAgentTaskReport>;
  try { report = readAgentTaskReport(source); }
  catch { return { value: 'unknown', label: `${title}结果待核对`, detail: `运行已结束，尚无有效${title}报告。`, tone: 'muted' }; }
  const result = report.taskResult;
  const outcome = role === 'verifier' ? evaluateVerification(source, criteria || []) : evaluateReview(source, criteria || []);
  const failedTests = result.selfTests.filter(item => item.exitCode !== null && item.exitCode !== 0);
  const failedEvidence = Object.values(report.validationEvidence || {}).filter(item => item.status === 'failed');
  // 同一报告明确记录的失败必须保留，不能因进程正常退出或宽泛 summary 而抹去。
  const explicitFailure = result.status === 'failed' || result.acceptance.some(item => item.status === 'failed')
    || role === 'reviewer' && result.verdict === 'changes_requested';
  const value = result.role === role && (explicitFailure || failedTests.length || failedEvidence.length) ? 'failed' : outcome.outcome;
  const reason = value === 'failed' && outcome.outcome === 'passed' ? '测试 / 检查未通过' : outcome.reason;
  const missingEvidence = role === 'verifier' && value === 'passed' && (report.validationEvidence?.tests.status === 'pending'
    || result.acceptance.some(item => item.status === 'passed' && !item.evidence));
  const facts = [result.summary, ...result.blockers,
    ...outcome.failedCriteria.map(item => item.evidence), ...outcome.findings.map(item => item.problem),
    ...failedEvidence.map(item => item.evidence), ...failedTests.map(item => `${item.command}（退出码 ${item.exitCode}）`),
    ...(value !== 'passed' ? [reason] : [])].filter(Boolean);
  if (missingEvidence) return { value: 'unknown', label: '验证结果待核对',
    detail: [result.summary, '验证报告中仍有检查未执行或验收证据缺失。'].filter(Boolean).join('\n'), tone: 'muted' };
  if (criteria === undefined && !explicitFailure && !failedTests.length && !failedEvidence.length
    && result.status !== 'blocked' && result.verdict !== 'blocked' && !result.blockers.length
    && !result.acceptance.some(item => item.status === 'blocked') && !result.findings.some(item => item.severity === 'blocker')) {
    return { value: 'unknown', label: `${title}结果待核对`,
      detail: [result.summary, '报告已返回，尚未取得本轮验收标准。'].filter(Boolean).join('\n'), tone: 'muted' };
  }
  return { value, label: `${title}${value === 'passed' ? '通过' : value === 'failed' ? '未通过' : '受阻'}`,
    detail: [...new Set(facts)].join('\n') || outcome.reason,
    tone: value === 'passed' ? 'success' : value === 'failed' ? 'danger' : 'warning' };
}

function criteriaForNode(task: TeamResultContext | undefined, node: TeamNode | undefined): Criteria | undefined {
  if (!task || !node) return undefined;
  if (task.round === undefined || node.round === task.round) return task.plan?.acceptanceCriteria;
  const createdAt = Date.parse(node.startedAt || node.createdAt);
  return task.planHistory?.filter(item => Date.parse(item.createdAt) <= createdAt)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0]?.plan.acceptanceCriteria;
}

export function teamRunCheckStatus(run: AgentRun, task?: TeamResultContext): TeamCheckStatus | undefined {
  if (run.status !== 'completed' || run.resultReady === false || run.pausedForEdit || run.resumeAfterWorkspaceRestart) return undefined;
  const matchedTask = task?.id === run.team?.taskId ? task : undefined;
  const node = matchedTask?.nodes.find(item => item.id === run.team?.nodeId && item.runId === run.id);
  const role = node?.profileId || run.team?.profileId;
  return role ? teamCheckStatus(role, run.result, criteriaForNode(matchedTask, node), node?.stage) : undefined;
}

export function teamNodeCheckStatus(node: TeamNode, run: AgentRun | undefined, task: TeamResultContext): TeamCheckStatus | undefined {
  if (['pending', 'queued', 'running', 'waiting_input', 'cancelled', 'skipped'].includes(node.status)) return undefined;
  if (run) {
    if (run.id !== node.runId || run.status !== 'completed' || run.resultReady === false || run.pausedForEdit || run.resumeAfterWorkspaceRestart) return undefined;
    return teamCheckStatus(node.profileId, run.result, criteriaForNode(task, node), node.stage);
  }
  // 没有当前运行快照时，节点自身的已保存报告是唯一可用来源。
  return teamCheckStatus(node.profileId, node.result || '', criteriaForNode(task, node), node.stage);
}

/** 服务端历史返工原因包含 JSON 包装；只取展示字段原文，绝不将原始 JSON 铺到进度区。 */
export function readableTeamReason(source?: string): string {
  if (!source?.trim()) return '';
  const value = source.trim();
  if (!value.startsWith('{') && !value.startsWith('[')) return source;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
    const rows: string[] = typeof parsed.reason === 'string' ? [parsed.reason] : [];
    for (const finding of Array.isArray(parsed.findings) ? parsed.findings : []) {
      if (!finding || typeof finding !== 'object') continue;
      const parts = [finding.file, finding.problem, finding.expectation].filter((item): item is string => typeof item === 'string' && !!item.trim());
      if (parts.length) rows.push(parts.join('；'));
    }
    return [...new Set(rows.filter(Boolean))].join('\n');
  } catch { return ''; }
}

export function teamRoundFeedback(task: TeamResultContext & Pick<TeamTask, 'round'>, round = task.round, runs: AgentRun[] = []) {
  if (round < 1) return undefined;
  const reasons = task.nodes.filter(node => node.round === round && ['implement', 'architect', 'analyst'].includes(node.stage))
    .map(node => {
      const persisted = (node as TeamNode & { reworkReason?: string }).reworkReason;
      return persisted ? readableTeamReason(persisted) : node.reason?.trim().startsWith('{') ? readableTeamReason(node.reason) : '';
    }).filter(Boolean);
  if (reasons.length) return { label: '返工原因', text: [...new Set(reasons)].join('\n') };
  const previous = task.nodes.filter(node => node.round === round - 1 && ['verify', 'review'].includes(node.stage))
    .flatMap(node => {
      const run = runs.find(run => run.id === node.runId);
      try {
        const report = readAgentTaskReport(run ? run.result : node.result || ''), result = report.taskResult;
        const explicitProblem = result.status === 'failed' || result.status === 'blocked' || result.blockers.length
          || ['changes_requested', 'blocked'].includes(result.verdict || '')
          || result.acceptance.some(item => ['failed', 'blocked'].includes(item.status))
          || result.selfTests.some(item => item.exitCode !== null && item.exitCode !== 0)
          || result.findings.some(item => item.severity === 'blocker')
          || Object.values(report.validationEvidence || {}).some(item => item.status === 'failed');
        if (!explicitProblem) return [];
      } catch { return []; }
      const status = teamNodeCheckStatus(node, run, task);
      return status && ['failed', 'blocked'].includes(status.value) ? [`${status.label}\n${status.detail}`] : [];
    });
  return previous.length ? { label: '上一轮未通过结论', text: [...new Set(previous)].join('\n') } : undefined;
}
