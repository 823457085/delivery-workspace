/** 验收与工作台使用同一个纯读模型，避免后端按标题、目录或输入 runId 猜测记录归属。 */
import { deliveryRecords, launchDeliveryRecords, reconcileDeliveryRecords } from '../src/features/workbench/domain.js';
import type { AutomationData, CatchupData, MergeData } from '../shared/hub.js';
import type { ExecutionDashboard } from '../shared/design-execution.js';
import type { AgentRun, AgentWorkflowSummary } from '../shared/agent-runtime.js';
import type { RequirementDevelopmentRecord } from '../shared/requirement-development.js';
import type { JiraFixRecord } from '../shared/jira-fix.js';
import type { DeliveryAcceptanceSourceResolver } from './delivery-acceptance.js';

export interface DeliveryAcceptanceSnapshot {
  automation?: AutomationData; design?: ExecutionDashboard; catchup?: CatchupData; merge?: MergeData;
  requirements: RequirementDevelopmentRecord[]; fixes: JiraFixRecord[]; runs: AgentRun[]; workflows?: AgentWorkflowSummary[];
}
export function createDeliveryAcceptanceSourceResolver(readSnapshot: () => DeliveryAcceptanceSnapshot | Promise<DeliveryAcceptanceSnapshot>): DeliveryAcceptanceSourceResolver {
  return async id => {
    const snapshot = await readSnapshot();
    const records = reconcileDeliveryRecords([
      ...deliveryRecords(snapshot.automation, snapshot.design, snapshot.catchup, snapshot.merge),
      ...launchDeliveryRecords(snapshot.requirements, snapshot.fixes),
    ], [], snapshot.runs, { includeStandalone: true, runtimeKnown: true, workflows: snapshot.workflows });
    const record = records.find(item => item.id === id);
    if (!record || (record.runId && !snapshot.runs.some(run => run.id === record.runId))) return undefined;
    return { runId: record.runId || '', updatedAt: record.updatedAt,
      active: !!record.workflowActive || [record.agentStatus, record.status].some(status => ['running', 'queued', 'preparing', 'starting', 'dispatching', 'dispatched', 'in_progress', 'active'].includes((status || '').toLowerCase()))
        || !!record.agentRuns?.some(run => run.pausedForEdit || (run.status === 'interrupted' && run.recovery?.state === 'active')) };
  };
}
