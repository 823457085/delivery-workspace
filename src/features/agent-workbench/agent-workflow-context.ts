/**
 * 设计说明：工作流与 Agent 会话通过稳定 ID、工作区和分支绑定，不根据标题猜测关系。
 * 同工作区会话只作为并行 Agent 展示；续聊运行仍属于原会话，不冒充独立子 Agent。
 */
import type { RunView, WorkflowRunContext } from '../../../shared/types';
import type { AgentProvider } from '../../../shared/agent-runtime';
import { agentRunContextPath, type AgentConversation } from './conversation';

export interface WorkflowAgentLane {
  id: string;
  title: string;
  role: 'main' | 'parallel';
  provider: AgentProvider;
  branch: string;
  status: string;
}

export function workflowContext(conversation?: AgentConversation): WorkflowRunContext | undefined {
  const provider = (['codex', 'cursor', 'claude', 'kiro', 'antigravity'] as const).find(id => id === conversation?.latest.provider);
  if (!conversation || !provider) return undefined;
  return {
    conversationId: conversation.id,
    agentRunId: conversation.latest.id,
    workspacePath: agentRunContextPath(conversation.latest),
    branch: conversation.latest.baseBranch || conversation.latest.branch,
    provider,
  };
}

export function conversationWorkflowRuns(runs: RunView[], conversationId: string) {
  if (!conversationId) return [];
  return runs.filter((run) => run.context?.conversationId === conversationId);
}

export function workflowAgentLanes(current: AgentConversation | undefined, conversations: AgentConversation[]): WorkflowAgentLane[] {
  if (!current) return [];
  const workspacePath = agentRunContextPath(current.latest);
  const peers = conversations.filter((conversation) => conversation.id !== current.id
    && agentRunContextPath(conversation.latest) === workspacePath
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
