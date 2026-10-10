/**
 * 设计说明：CLI 运行记录以轮次保存，但协作视图需要以会话为节点展示真实父子关系和前置依赖。
 * 本模块只投影服务端已经持久化的 task 元数据，不按工作区或标题猜测 Agent 关系。
 */
import type { AgentRunStatus, AgentTaskRole } from '../../../shared/agent-runtime';
import type { AgentConversation } from './conversation';

export interface AgentTaskNode {
  id: string;
  title: string;
  role: AgentTaskRole;
  status: AgentRunStatus;
  branch: string;
  model: string;
  pid: number | null;
  changedFiles: number;
  parentConversationId: string;
  dependsOnConversationIds: string[];
}

function parentId(conversation: AgentConversation) {
  return conversation.latest.task?.parentConversationId || '';
}

export function agentTaskRootId(current: AgentConversation) {
  return parentId(current) || current.id;
}

export function buildAgentTaskGraph(current: AgentConversation | undefined, conversations: AgentConversation[]): AgentTaskNode[] {
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
  return family.map((conversation, index) => ({
    id: conversation.id,
    title: conversation.latest.task?.title || conversation.title,
    role: index === 0 ? 'main' : conversation.latest.task?.role || 'worker',
    status: conversation.latest.status,
    branch: conversation.latest.baseBranch || conversation.latest.branch,
    model: conversation.latest.model,
    pid: conversation.latest.pid,
    changedFiles: conversation.runs.reduce((total, run) => total + (run.changedFiles?.length || 0), 0),
    parentConversationId: index === 0 ? '' : parentId(conversation),
    dependsOnConversationIds: (conversation.latest.task?.dependsOnConversationIds || []).filter((id) => included.has(id)),
  }));
}
