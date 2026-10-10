/**
 * 设计说明：工作流与 Agent 会话通过稳定 ID、工作区和分支绑定，不根据标题猜测关系。
 * 同工作区会话只作为并行 Agent 展示；续聊运行仍属于原会话，不冒充独立子 Agent。
 */
import type { RunView, WorkflowRunContext } from '../../../shared/types';
import { agentRunProjectPath, type AgentConversation } from './conversation';

export interface WorkflowAgentLane {
  id: string;
  title: string;
  role: 'main' | 'parallel';
  provider: 'codex' | 'cursor';
  branch: string;
  status: string;
}

export function workflowContext(conversation?: AgentConversation): WorkflowRunContext | undefined {
  if (!conversation) return undefined;
  return {
    conversationId: conversation.id,
    agentRunId: conversation.latest.id,
    workspacePath: agentRunProjectPath(conversation.latest),
    branch: conversation.latest.baseBranch || conversation.latest.branch,
    provider: conversation.latest.provider,
  };
}

export function conversationWorkflowRuns(runs: RunView[], conversationId: string) {
  if (!conversationId) return [];
  return runs.filter((run) => run.context?.conversationId === conversationId);
}

export function workflowAgentLanes(current: AgentConversation | undefined, conversations: AgentConversation[]): WorkflowAgentLane[] {
  if (!current) return [];
  const workspacePath = agentRunProjectPath(current.latest);
  const peers = conversations.filter((conversation) => conversation.id !== current.id
    && agentRunProjectPath(conversation.latest) === workspacePath
    && ['queued', 'running'].includes(conversation.latest.status));
  return [current, ...peers].slice(0, 6).map((conversation, index) => ({
    id: conversation.id,
    title: conversation.title,
    role: index === 0 ? 'main' : 'parallel',
    provider: conversation.latest.provider,
    branch: conversation.latest.baseBranch || conversation.latest.branch,
    status: conversation.latest.status,
  }));
}
