import type { AgentRun } from '../../../shared/agent-runtime';
import type { GroupRound } from '../../../shared/agent-group-chat';
import { readAgentDeliveryReport } from '../../../shared/delivery-report';
import { agentReplyText } from './execution-summary';
import type { GroupSummaryMember } from './group-chat-summary';
import type { groupChatMessages } from './group-chat-messages';

/** 普通正文可以直接阅读；完整或未完成的岗位报告仍保留在成员报告路径。 */
function directReply(result: string): string {
  if (!result.trim()) return '';
  const reply = agentReplyText(result);
  if (reply !== result) return reply;
  try { readAgentDeliveryReport(result); return ''; }
  catch {
    return /^ {0,3}(?:`{3,}|~{3,})[\t ]*delivery-report(?:[\t ]|$)/m.test(result) ? '' : result;
  }
}

export function groupRoundReply(round: GroupRound | undefined, runs: readonly AgentRun[]): string {
  if (round?.turns.length !== 1) return '';
  const turn = round.turns[0]!, run = runs.find(run => run.id === turn.runId);
  return directReply(run ? run.result : turn.result);
}

/** 摘要沿用现有岗位字段优先级；调用方仍须保留原始报告和执行记录入口。 */
export function groupMemberReply(member?: GroupSummaryMember): string {
  if (!member) return '';
  return member.summary || directReply(member.run ? member.run.result : member.turn.result);
}

type GroupChatMessage = ReturnType<typeof groupChatMessages>[number];
export interface GroupChatMessageBlock { message: GroupChatMessage; history: GroupChatMessage[] }

/** 连续同岗交接只收起先前反馈；用户输入和其他消息种类始终保留为独立边界。 */
export function groupChatMessageBlocks(messages: readonly GroupChatMessage[]): GroupChatMessageBlock[] {
  const blocks: GroupChatMessageBlock[] = [];
  const handoff = (message: GroupChatMessage) => message.role === 'assistant' && message.kind === 'handoff'
    && !message.hostGenerated && !!message.profileId;
  for (const message of messages) {
    const previous = blocks.at(-1);
    if (previous && handoff(message) && handoff(previous.message)
      && previous.message.task.id === message.task.id && previous.message.profileId === message.profileId) {
      previous.history.push(previous.message); previous.message = message;
    } else blocks.push({ message, history: [] });
  }
  return blocks;
}
