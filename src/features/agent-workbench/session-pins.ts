/** 置顶以侧栏会话 ID 为准；旧 CLI session ID 只用于一次性迁移，避免共享原会话的两行继续联动。 */
import type { AgentConversation } from './conversation';

export const PINNED_AGENT_SESSIONS_STORAGE_KEY = 'delivery-workspace.agent-pins.v1';

export function pinnedAgentSessionId(conversation: AgentConversation): string {
  return conversation.id;
}

function pinnedAgentSessionAliases(conversation: AgentConversation): Set<string> {
  const aliases = new Set<string>([pinnedAgentSessionId(conversation), conversation.id]);
  conversation.runs.forEach((run) => {
    [run.id, run.parentRunId, run.originSessionId, run.sessionId].forEach((id) => { if (id) aliases.add(id); });
  });
  return aliases;
}

export function isPinnedAgentSession(ids: ReadonlySet<string>, conversation: AgentConversation): boolean {
  return ids.has(conversation.id);
}

export function togglePinnedAgentSession(ids: ReadonlySet<string>, conversation: AgentConversation): Set<string> {
  const next = new Set(ids);
  const stableId = pinnedAgentSessionId(conversation);
  if (isPinnedAgentSession(ids, conversation)) next.delete(stableId);
  else next.add(stableId);
  return next;
}

export function migratePinnedAgentSessionIds(ids: ReadonlySet<string>, conversations: AgentConversation[]): Set<string> {
  const next = new Set(ids);
  const stableIds = new Set(conversations.map((conversation) => conversation.id));
  conversations.forEach((conversation) => {
    const aliases = pinnedAgentSessionAliases(conversation);
    if (![...aliases].some((id) => ids.has(id))) return;
    next.add(conversation.id);
  });
  for (const id of ids) {
    if (!stableIds.has(id) && conversations.some((conversation) => pinnedAgentSessionAliases(conversation).has(id))) next.delete(id);
  }
  return next;
}

export function parsePinnedAgentSessionIds(value: string | null): Set<string> {
  if (!value) return new Set();
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === 'string' && !!id.trim()));
  } catch {
    return new Set();
  }
}

export function readPinnedAgentSessionIds(storage: Pick<Storage, 'getItem'>): Set<string> {
  try { return parsePinnedAgentSessionIds(storage.getItem(PINNED_AGENT_SESSIONS_STORAGE_KEY)); }
  catch { return new Set(); }
}

export function savePinnedAgentSessionIds(storage: Pick<Storage, 'setItem'>, ids: ReadonlySet<string>): boolean {
  try {
    storage.setItem(PINNED_AGENT_SESSIONS_STORAGE_KEY, JSON.stringify([...ids]));
    return true;
  } catch {
    return false;
  }
}
