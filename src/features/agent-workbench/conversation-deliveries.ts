import type { AgentConversation } from './conversation';

/** 保留会话原轮号和原始运行对象，文件操作始终使用所属轮次的 ID。 */
export function conversationDeliveries(conversation?: AgentConversation) {
  return (conversation?.runs || []).map((run, index) => ({ run, round: index + 1 }))
    .filter(({ run }) => !!run.result.trim() || !run.syncedHistory && !!run.changedFiles?.length)
    .reverse();
}
