/** 用户正文只归纳本轮结构化证据；完整命令、路径和日志由技术记录保留，不改写任务或验收状态。 */
import { z } from 'zod';
import type { TeamTask } from '../../../shared/agent-team';
import { evaluateReview, evaluateVerification, readAgentTaskReport } from '../../../shared/agent-task-result';
import { readAgentDeliveryReport } from '../../../shared/delivery-report';

export type GroupDeliveryContext = Pick<TeamTask, 'round' | 'nodes' | 'sourceWorkspacePath'> & {
  workspacePath?: string;
  diagnosis?: Pick<NonNullable<TeamTask['diagnosis']>, 'unverified'> & Partial<Pick<NonNullable<TeamTask['diagnosis']>, 'summary' | 'rootCause'>>;
  technicalDesign?: Pick<NonNullable<TeamTask['technicalDesign']>, 'decisions'>;
  plan?: Pick<NonNullable<TeamTask['plan']>, 'templateId' | 'acceptanceCriteria'>;
};
const buildEvidenceSchema = z.object({ status: z.enum(['pending', 'passed', 'failed', 'not_applicable']),
  evidence: z.string().trim().min(1).max(6000) });
function taskReport(result?: string) {
  try { return result ? readAgentTaskReport(result) : undefined; } catch { return undefined; }
}

function applyCurrentReview(summary: string) {
  // 并列的未测项目保留原状态，仅从列表移除已完成的审查。
  return summary
    .replace(/[、及和与](?:正式)?独立审查(?=(?:仍|尚)?未(?:验证|执行|进行|完成))/g, '')
    .replace(/(?:正式)?独立审查(?:仍|尚)?待(?:宿主)?(?:后续)?(?:派发|执行|进行)(?:，整体交付尚不能据此宣称独立审查完成)?/g, '独立审查已通过');
}

export function groupDeliveryPresentation(task?: GroupDeliveryContext) {
  const current = task?.nodes.filter(node => node.round === task.round && node.status !== 'skipped') || [];
  const verification = current.filter(node => node.stage === 'verify').at(-1);
  const verified = verification?.status === 'completed' ? taskReport(verification.result) : undefined;
  let build: z.infer<typeof buildEvidenceSchema> | undefined;
  if (verified?.taskResult.role === 'verifier') {
    try {
      const raw = readAgentDeliveryReport(verification!.result!) as { validationEvidence?: { build?: unknown } };
      const parsedBuild = buildEvidenceSchema.safeParse(raw.validationEvidence?.build);
      if (parsedBuild.success) build = parsedBuild.data;
    } catch { /* 无效报告保持未确认。 */ }
  }
  const verificationPassed = !!verification?.result && verification.status === 'completed'
    && evaluateVerification(verification.result, task?.plan?.acceptanceCriteria || []).outcome === 'passed';
  const reviews = current.filter(node => node.stage === 'review');
  const reviewReports = reviews.flatMap(node => {
    const report = node.status === 'completed' ? taskReport(node.result)?.taskResult : undefined;
    return report?.role === 'reviewer' ? [report] : [];
  });
  const reviewPassed = reviews.length > 0 && reviews.every(node => node.status === 'completed' && !!node.result
    && evaluateReview(node.result, task?.plan?.acceptanceCriteria || []).outcome === 'passed');
  const findings = [...new Set(reviewReports.flatMap(report => report.findings.map(finding => finding.problem)).filter(Boolean))];
  const noFindings = reviewPassed && reviewReports.every(report => report.findings.length === 0);
  const reviewFailed = reviews.some(node => ['failed', 'blocked', 'needs_reconciliation'].includes(node.status)
    || node.status === 'completed' && !!node.result && evaluateReview(node.result, task?.plan?.acceptanceCriteria || []).outcome !== 'passed');
  const diagnosisNode = current.find(node => node.stage === 'diagnose');
  const diagnosisOnly = task?.plan?.templateId === 'diagnosis' || !verification && !reviews.length && !!diagnosisNode;
  const diagnosis = diagnosisNode?.status === 'completed' ? task?.diagnosis : undefined;
  const buildPassed = !diagnosisOnly && verificationPassed && build?.status === 'passed';
  const workspaceCopy = !!task?.workspacePath && task.workspacePath !== task.sourceWorkspacePath;
  const buildText = buildPassed ? workspaceCopy ? '工作副本的构建已通过。' : '本地构建已经通过。'
    : build?.status === 'failed' ? `${workspaceCopy ? '工作副本的' : '本地'}构建还没有通过。` : '';
  const reviewSubject = !buildPassed && task?.plan?.templateId === 'research_design' ? '方案' : '代码';
  const reviewText = reviewFailed ? `${reviewSubject}复查尚未通过。`
    : reviewPassed ? `${reviewSubject}复查已通过。` : '';
  const implementation = new Map<TeamTask['nodes'][number]['profileId'], string>();
  for (const node of current) {
    if (node.stage !== 'implement' || node.status !== 'completed') continue;
    const report = taskReport(node.result)?.taskResult;
    if (report?.role === 'implementer' && report.status === 'succeeded') implementation.set(node.profileId, report.summary);
  }
  const implementationSummary = [...new Set(implementation.values())].filter(Boolean).join('\n\n');
  const designSummary = task?.plan?.templateId === 'research_design' && current.some(node => node.stage === 'architect' && node.status === 'completed')
    ? task.technicalDesign?.decisions.map(item => item.decision).join('\n\n') : '';
  const verificationSummary = verificationPassed ? verified?.taskResult.summary : '';
  const verificationGap = verification?.status === 'completed' && !verificationPassed && build?.status !== 'failed' ? '本轮验证尚未通过。' : '';
  // 正文直接使用本轮岗位说明；流程状态、验收证据和报告原文仍各自独立。
  const reported = diagnosisOnly ? diagnosis?.summary || diagnosis?.rootCause
    : designSummary || verificationSummary || implementationSummary;
  const result = reported && reviewPassed && !diagnosisOnly ? applyCurrentReview(reported) : reported;
  const boundary = diagnosisOnly ? '本轮只做了问题分析。' : [
    verificationGap,
    build?.status === 'failed' ? buildText : '', reviewFailed ? reviewText : '',
  ].filter(Boolean).join('');
  const conclusion = result ? [result, boundary].filter(Boolean).join('\n\n')
    : diagnosisOnly ? '本轮没有可确认的问题分析结论。'
    : buildText + verificationGap + reviewText || '本轮没有记录具体结果。';
  return { conclusion, buildStatus: build?.status, buildPassed, reviewPassed, noFindings, diagnosisOnly,
    workspaceNotice: workspaceCopy ? '结果保存在工作副本中，原项目尚未确认。' : '', unverified: [...(diagnosis?.unverified || [])], findings };
}

export function groupDeliveryOverview(task?: GroupDeliveryContext): string {
  const view = groupDeliveryPresentation(task);
  return [view.conclusion, view.workspaceNotice,
    view.findings.length ? `审查意见\n\n${view.findings.map(text => `- ${text}`).join('\n')}` : '',
    view.unverified.length ? `尚未确认：\n${view.unverified.map(text => `- ${text}`).join('\n')}` : ''].filter(Boolean).join('\n\n');
}
