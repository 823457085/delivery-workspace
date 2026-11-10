/** V1 历史只读投影：不改原记录，不创建第二套派发或验收决定。 */
import { createHash } from 'node:crypto';
import type { AdvancedTeamTask } from './agent-team-service.js';
import type { AgentRun, AgentWorkflowState, AgentWorkflowSummary } from '../shared/agent-runtime.js';
import { sameDeliverySource, type DeliveryAcceptanceRecord } from '../shared/delivery-acceptance.js';
import type { TeamModelChoice, TeamProfileConfig, TeamTaskState } from '../shared/agent-team.js';

export interface LegacyTeamRuntime {
  workflows(): AgentWorkflowSummary[];
  getRun(id: string): AgentRun | undefined;
}
const states: Record<AgentWorkflowState, TeamTaskState> = {
  implementing: 'running', verifying: 'running', reviewing: 'running', reworking: 'running',
  awaiting_acceptance: 'awaiting_acceptance', needs_decision: 'needs_decision', blocked: 'blocked', cancelled: 'cancelled', taken_over: 'taken_over',
};
export type LegacyAdvancedTeamTask = AdvancedTeamTask & { legacy: true; legacyAcceptanceRecordId: string };

export function legacyTeamTask(runtime: LegacyTeamRuntime, id: string, config: TeamProfileConfig,
  readAcceptance?: (recordId: string) => DeliveryAcceptanceRecord | undefined): AdvancedTeamTask | undefined {
  const summary = runtime.workflows().find(item => item.id === id);
  if (!summary) return undefined;
  const steps = [...summary.steps].sort((a, b) => a.step - b.step);
  const runs = new Map(steps.map(step => [step.runId, runtime.getRun(step.runId)]));
  const implementations = steps.filter(step => step.stage === 'implement');
  const first = implementations.map(step => runs.get(step.runId)).find((run): run is AgentRun => !!run);
  const lastStep = implementations.at(-1), implementation = lastStep ? runs.get(lastStep.runId) : undefined;
  const latestRun = implementation || first;
  const evidenceAt = [summary.updatedAt, ...[...runs.values()].flatMap(run => run ? [run.updatedAt] : [])]
    .filter(value => Number.isFinite(Date.parse(value))).sort((a, b) => Date.parse(b) - Date.parse(a))[0] || summary.updatedAt;
  const legacyAcceptanceRecordId = `agent:${summary.implementationConversationId}`;
  const source = { runId: lastStep?.runId || '', updatedAt: evidenceAt };
  const saved = readAcceptance?.(legacyAcceptanceRecordId);
  const acceptance = summary.state === 'awaiting_acceptance' && saved?.recordId === legacyAcceptanceRecordId && sameDeliverySource(saved.source, source) ? saved : undefined;
  const nodes: AdvancedTeamTask['nodes'] = steps.map((step, index) => {
    const run = runs.get(step.runId), digest = run ? createHash('sha256').update(run.result).digest('hex') : undefined;
    return { id: step.runId, stage: step.stage === 'implement' ? 'implement' : step.stage, profileId: step.profileId,
      status: run?.status || step.status, dependencies: index ? [steps[index - 1].runId] : [], attempt: 1, round: step.round, runId: step.runId,
      createdAt: run?.createdAt || summary.createdAt, updatedAt: run?.updatedAt || summary.updatedAt,
      ...(run ? { workspacePath: run.workspacePath, snapshot: run.workflowSnapshot ? structuredClone(run.workflowSnapshot) : undefined,
        result: run.result, changedFiles: structuredClone(run.changedFiles || []), ...(run.error ? { error: run.error } : {}) } : {}),
      // 历史强度可能包含 max/ultra；仅保留真实只读元数据，不经过新配置或派发入口。
      effectiveChoice: { provider: run?.provider || step.provider, model: run?.model || step.model,
        reasoningEffort: run?.reasoningEffort ?? step.reasoningEffort } as TeamModelChoice,
      reason: step.reason, ...(digest ? { artifactHash: digest, artifactIds: [step.runId] } : {}),
    };
  });
  const artifacts = nodes.flatMap(node => node.artifactHash ? [{ id: node.runId!, kind: node.stage,
    path: `/agent?run=${encodeURIComponent(node.runId!)}`, hash: node.artifactHash, createdAt: node.updatedAt, nodeId: node.id }] : []);
  const snapshot = summary.snapshot || [...nodes].reverse().find(node => node.snapshot)?.snapshot;
  const projected: LegacyAdvancedTeamTask = {
    id: summary.id, legacy: true, legacyAcceptanceRecordId, parentConversationId: summary.parentConversationId,
    sourceWorkspacePath: latestRun?.sourceWorkspacePath || latestRun?.workspacePath || '',
    ...(latestRun ? { workspacePath: latestRun.workspacePath } : {}), objective: summary.objective,
    attachmentIds: (first?.attachments || latestRun?.attachments || []).map(item => item.id), profileConfig: structuredClone(config),
    requestedTemplateId: summary.templateId, planRevision: 0,
    plan: { templateId: summary.templateId, reason: 'V1 固定流程历史输入，只读展示', risk: 'medium',
      acceptanceCriteria: summary.acceptanceCriteria.map(item => ({ ...item, source: 'V1输入' })), allowedPaths: [...summary.allowedPaths],
      needsAnalyst: false, needsArchitect: false, questions: [], risks: [], ownership: [], shared: [] },
    nodes, state: acceptance?.decision === 'accepted' ? 'accepted' : acceptance?.decision === 'rejected' ? 'rejected' : states[summary.state],
    round: summary.round, maxRounds: null, createdAt: summary.createdAt, updatedAt: evidenceAt,
    candidateEvidenceAt: evidenceAt, artifacts, reason: summary.reason,
    ...(first?.headSha ? { baseHead: first.headSha } : {}),
    ...(summary.providerFallback ? { providerFallback: structuredClone(summary.providerFallback) } : {}),
    ...(acceptance && acceptance.decision !== 'pending' && snapshot ? { acceptance: { revision: acceptance.revision,
      snapshot: structuredClone(snapshot), decision: acceptance.decision, summary: acceptance.summary, at: acceptance.updatedAt, confirmedBy: 'user' as const } } : {}),
    budgetLimit: null,
    reverifyCount: steps.filter(step => step.stage === 'verify').length - new Set(steps.filter(step => step.stage === 'verify').map(step => step.round)).size,
    requestIds: {}, upgradedProfiles: [], escalations: summary.escalated ? 1 : 0,
  };
  return projected;
}
export function legacyTeamTasks(runtime: LegacyTeamRuntime, config: TeamProfileConfig,
  readAcceptance?: (recordId: string) => DeliveryAcceptanceRecord | undefined): AdvancedTeamTask[] {
  return runtime.workflows().map(summary => legacyTeamTask(runtime, summary.id, config, readAcceptance)).filter((item): item is AdvancedTeamTask => !!item);
}
