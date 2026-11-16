/**
 * 设计说明：Agent 业务上下文只关联现有 Jira、本地项目、接口联调和交付记录，不复制原页面状态，也不执行写操作。
 * 交付只按显式任务标识或 CLI Session 关联；工作区仅用于定位项目，不能代表会话归属。
 */
import type { AgentConversation } from './conversation';
import { buildReviewCatalog } from '../api-integration/review-catalog';
import {
  buildAgentBusinessContextCore,
  buildAgentBusinessMentions,
  type AgentBusinessContext,
  type AgentBusinessMention,
  type AgentBusinessMentionType,
  type AgentBusinessSnapshot,
  type AgentInterfaceContext,
} from './agent-business-context-core';

export { buildAgentBusinessMentions };
export type {
  AgentBusinessContext,
  AgentBusinessMention,
  AgentBusinessMentionType,
  AgentBusinessSnapshot,
  AgentInterfaceContext,
};

let reviewIdsByPath: Map<string, string> | undefined;

export function buildAgentBusinessContext(conversation: AgentConversation | undefined, snapshot: AgentBusinessSnapshot): AgentBusinessContext {
  const needsReviewCatalog = !!conversation && !!snapshot.pages?.length && !!snapshot.review;
  if (needsReviewCatalog && !reviewIdsByPath) {
    reviewIdsByPath = new Map(buildReviewCatalog().map(item => [item.path, item.id]));
  }
  return buildAgentBusinessContextCore(conversation, snapshot, reviewIdsByPath);
}
