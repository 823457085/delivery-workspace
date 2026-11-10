/**
 * 设计说明：CLI 运行记录以轮次保存，但协作视图需要以会话为节点展示真实父子关系和前置依赖。
 * 本模块只投影服务端已经持久化的 task 元数据，不按工作区或标题猜测 Agent 关系。
 */
import type { AgentRunStatus, AgentTaskRole, AgentRun, AgentWorkflowSummary } from '../../../shared/agent-runtime';
import { teamDeliveryEvidence } from '../../../shared/agent-workflow-evidence';
import { deliveryAcceptanceStatus, type DeliveryAcceptanceRecord, type DeliveryAcceptanceStatus } from '../../../shared/delivery-acceptance';
import type { AgentConversation } from './conversation';

export interface AgentTaskNode {
  id: string;
  runId: string;
  title: string;
  role: AgentTaskRole;
  status: AgentRunStatus;
  branch: string;
  model: string;
  pid: number | null;
  changedFiles: number;
  events: number;
  resultReady: boolean;
  hasResult: boolean;
  hasError: boolean;
  workspacePath: string;
  updatedAt: string;
  parentRunId: string;
  recoveryOfRunId: string;
  recoveryState: NonNullable<AgentRun['recovery']>['state'] | '';
  recoveryMessage: string;
  acceptanceStatus?: DeliveryAcceptanceStatus;
  parentConversationId: string;
  dependsOnConversationIds: string[];
}

export type AgentTaskBoardColumn = 'queued' | 'running' | 'review' | 'completed' | 'blocked';

export function agentTaskBoardColumn(status: AgentRunStatus, role: AgentTaskRole): AgentTaskBoardColumn {
  if (['failed', 'interrupted', 'cancelled'].includes(status)) return 'blocked';
  if (status === 'completed') return 'completed';
  if (role === 'reviewer') return 'review';
  if (status === 'running') return 'running';
  return 'queued';
}

function parentId(conversation: AgentConversation) {
  return conversation.latest.task?.parentConversationId || '';
}

export function agentTaskRootId(current: AgentConversation) {
  return parentId(current) || current.id;
}

export function buildAgentTaskGraph(current: AgentConversation | undefined, conversations: AgentConversation[],
  acceptances?: Map<string, DeliveryAcceptanceRecord>, acceptanceKnown = true, workflows?: AgentWorkflowSummary[]): AgentTaskNode[] {
  if (!current) return [];
  const rootId = agentTaskRootId(current);
  const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  const root = byId.get(rootId) || current;
  const included = new Set([root.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const conversation of conversations) {
      const parentConversationId = parentId(conversation);
      if (!parentConversationId || !included.has(parentConversationId) || included.has(conversation.id)) continue;
      included.add(conversation.id);
      changed = true;
    }
  }
  const family = [root, ...conversations.filter((conversation) => conversation.id !== root.id && included.has(conversation.id))];
  const runs = conversations.flatMap(conversation => conversation.runs);
  return family.map((conversation, index) => ({
    runId: conversation.latest.id,
    id: conversation.id,
    title: conversation.latest.task?.title || conversation.title,
    role: index === 0 ? 'main' : conversation.latest.task?.role || 'worker',
    status: conversation.latest.status,
    branch: conversation.latest.baseBranch || conversation.latest.branch,
    model: conversation.latest.model,
    pid: conversation.latest.pid,
    changedFiles: conversation.runs.reduce((total, run) => total + (run.changedFiles?.length || 0), 0),
    events: conversation.latest.events.length,
    resultReady: conversation.latest.resultReady === true,
    hasResult: !!conversation.latest.result.trim(),
    hasError: !!conversation.latest.error.trim(),
    workspacePath: conversation.latest.workspacePath,
    updatedAt: conversation.latest.updatedAt,
    parentRunId: conversation.latest.parentRunId || '',
    recoveryOfRunId: conversation.latest.recoveryOfRunId || '',
    recoveryState: conversation.latest.recovery?.state || '',
    recoveryMessage: conversation.latest.recovery?.message || '',
    acceptanceStatus: acceptances && acceptanceKnown
      ? deliveryAcceptanceStatus(acceptances.get(conversation.id), { runId: conversation.latest.id,
        updatedAt: teamDeliveryEvidence(conversation.latest, runs, workflows)?.updatedAt || conversation.latest.updatedAt })
      : undefined,
    parentConversationId: index === 0 ? '' : parentId(conversation),
    dependsOnConversationIds: (conversation.latest.task?.dependsOnConversationIds || []).filter((id) => included.has(id)),
  }));
}
