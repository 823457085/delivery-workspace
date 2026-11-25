/**
 * 设计说明：借鉴 GitHub 标杆项目 Linear / OpenCode / Cherry Studio 的会话状态快速过滤胶囊。
 * 在左侧会话栏提供一键筛选「进行中」「有改代码」「异常/待处理」会话，避免在几十条历史对话中人工逐条翻找。
 */
import type { AgentConversation } from './conversation';

export type SessionQuickFilter = 'all' | 'unread' | 'active' | 'changed' | 'attention';

export interface SessionQuickFilterCounts {
  all: number;
  unread: number;
  active: number;
  changed: number;
  attention: number;
}

export function isSessionActive(conversation: AgentConversation): boolean {
  return ['running', 'queued'].includes(conversation.latest.status);
}

export function isSessionChangedFiles(conversation: AgentConversation): boolean {
  return conversation.runs.some(run => run.hasChangedFiles || (run.changedFiles?.length || 0) > 0);
}

export function isSessionAttentionNeeded(conversation: AgentConversation): boolean {
  if (['failed', 'interrupted'].includes(conversation.latest.status)) return true;
  return conversation.runs.some(run => Boolean(run.pausedForEdit));
}

export function matchesSessionQuickFilter(
  conversation: AgentConversation,
  filter: SessionQuickFilter,
  unread = false,
): boolean {
  switch (filter) {
    case 'unread':
      return unread;
    case 'active':
      return isSessionActive(conversation);
    case 'changed':
      return isSessionChangedFiles(conversation);
    case 'attention':
      return isSessionAttentionNeeded(conversation);
    case 'all':
    default:
      return true;
  }
}

export function summarizeSessionQuickFilters(
  conversations: readonly AgentConversation[],
  unreadIds?: ReadonlySet<string>,
): SessionQuickFilterCounts {
  let unread = 0;
  let active = 0;
  let changed = 0;
  let attention = 0;
  for (const conv of conversations) {
    if (unreadIds?.has(conv.id)) unread++;
    if (isSessionActive(conv)) active++;
    if (isSessionChangedFiles(conv)) changed++;
    if (isSessionAttentionNeeded(conv)) attention++;
  }
  return {
    all: conversations.length,
    unread,
    active,
    changed,
    attention,
  };
}
