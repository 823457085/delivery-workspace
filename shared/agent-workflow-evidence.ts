/** 团队验收只预填当前候选版本的独立验证证据；流程推进后，旧验收来源随之失效。 */
import type { AgentRun, AgentWorkflowSummary } from './agent-runtime.js';
import { readDeliveryEvidenceReport, type DeliveryEvidence } from './delivery-acceptance.js';
import { evaluateReview, evaluateVerification } from './agent-task-result.js';
import { sameWorkspaceVersion } from './agent-workflow.js';

export function teamDeliveryEvidence(run: AgentRun | undefined, runs: AgentRun[], workflows?: AgentWorkflowSummary[]):
  { checks?: DeliveryEvidence; updatedAt: string; active: boolean } | undefined {
  const link = run?.task?.workflow;
  if (!run || link?.stage !== 'implement') return undefined;
  const workflow = workflows?.find(item => item.id === link.id);
  const related = runs.filter(item => item.task?.workflow?.id === link.id);
  const updatedAt = [run.updatedAt, workflow?.updatedAt || '', ...related.map(item => item.updatedAt)]
    .filter(Boolean).sort((left, right) => Date.parse(right) - Date.parse(left))[0]!;
  const state = { updatedAt, active: !workflow || !['awaiting_acceptance', 'taken_over', 'cancelled'].includes(workflow.state) };
  if (!workflow || workflow.state !== 'awaiting_acceptance' || !workflow.snapshot) return state;
  const implementation = workflow.steps.filter(item => item.stage === 'implement').at(-1);
  const review = workflow.steps.at(-1);
  const verification = workflow.steps.filter(item => item.stage === 'verify' && item.step < (review?.step || 0)).at(-1);
  if (implementation?.runId !== run.id || review?.stage !== 'review' || !verification) return state;
  const verifiedRun = related.find(item => item.id === verification.runId);
  const reviewedRun = related.find(item => item.id === review.runId);
  if ((verifiedRun && Date.parse(verifiedRun.createdAt) < Date.parse(run.createdAt))
    || (verifiedRun && reviewedRun && Date.parse(reviewedRun.createdAt) < Date.parse(verifiedRun.createdAt))) {
    return { updatedAt, active: true };
  }
  if (!verifiedRun || !reviewedRun || [verifiedRun, reviewedRun].some(item => item.status !== 'completed' || !item.resultReady || item.pausedForEdit)
    || !sameWorkspaceVersion(workflow.snapshot, verifiedRun.workflowSnapshot)
    || !sameWorkspaceVersion(workflow.snapshot, reviewedRun.workflowSnapshot)
    || evaluateVerification(verifiedRun.result, workflow.acceptanceCriteria).outcome !== 'passed'
    || evaluateReview(reviewedRun.result).outcome !== 'passed') return state;
  return { ...state, checks: readDeliveryEvidenceReport(verifiedRun.result) };
}
