/**
 * 设计说明：借鉴 GitHub 标杆项目 Cherry Studio / LobeChat 的重点消息书签收藏夹：
 * 支持将长对话里的关键命令、SQL、排障结论或核对清单一键加星收藏，
 * 不仅可在当前会话内快速跳回对应轮次，还能在其他会话中直接跨会话复制或引用追问。
 */
import { computed, shallowRef, type ShallowRef } from 'vue';

export interface AgentMessageBookmark {
  id: string;
  conversationId: string;
  conversationTitle: string;
  messageKey: string;
  turnIndex?: number;
  excerpt: string;
  content: string;
  createdAt: string;
}

export interface AgentBookmarkInput {
  conversationId: string;
  conversationTitle?: string;
  messageKey: string;
  turnIndex?: number;
  content: string;
}

export const AGENT_BOOKMARKS_STORAGE_KEY = 'agent-message-bookmarks:v1';
const MAX_AGENT_BOOKMARKS = 100;
const MAX_BOOKMARK_CONTENT_LENGTH = 12_000;

function defaultStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function buildAgentBookmarkId(conversationId: string, messageKey: string): string {
  return `${conversationId.trim()}::${messageKey.trim()}`;
}

export function summarizeBookmarkExcerpt(content: string, maxLength = 88): string {
  const cleaned = content
    .replace(/\r\n/g, '\n')
    .replace(/`{3,}[\w-]*\n?/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '（空内容）';
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}

export function readAgentBookmarks(
  storage: Pick<Storage, 'getItem'> | null = defaultStorage(),
): AgentMessageBookmark[] {
  if (!storage) return [];
  try {
    const raw = JSON.parse(storage.getItem(AGENT_BOOKMARKS_STORAGE_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    const result: AgentMessageBookmark[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const conversationId = typeof item.conversationId === 'string' ? item.conversationId.trim() : '';
      const messageKey = typeof item.messageKey === 'string' ? item.messageKey.trim() : '';
      const content = typeof item.content === 'string' ? item.content.slice(0, MAX_BOOKMARK_CONTENT_LENGTH) : '';
      if (!conversationId || !messageKey || !content.trim()) continue;
      const id = typeof item.id === 'string' && item.id
        ? item.id
        : buildAgentBookmarkId(conversationId, messageKey);
      const conversationTitle = typeof item.conversationTitle === 'string' && item.conversationTitle.trim()
        ? item.conversationTitle.trim().slice(0, 80)
        : '未命名会话';
      const excerpt = typeof item.excerpt === 'string' && item.excerpt.trim()
        ? item.excerpt.trim().slice(0, 120)
        : summarizeBookmarkExcerpt(content);
      const turnIndex = typeof item.turnIndex === 'number' && Number.isFinite(item.turnIndex) && item.turnIndex > 0
        ? Math.floor(item.turnIndex)
        : undefined;
      const createdAt = typeof item.createdAt === 'string' && item.createdAt
        ? item.createdAt
        : new Date(0).toISOString();
      result.push({
        id,
        conversationId,
        conversationTitle,
        messageKey,
        ...(turnIndex ? { turnIndex } : {}),
        excerpt,
        content,
        createdAt,
      });
      if (result.length >= MAX_AGENT_BOOKMARKS) break;
    }
    return result;
  } catch {
    return [];
  }
}

export function writeAgentBookmarks(
  bookmarks: readonly AgentMessageBookmark[],
  storage: Pick<Storage, 'setItem'> | null = defaultStorage(),
) {
  if (!storage) return;
  try {
    storage.setItem(
      AGENT_BOOKMARKS_STORAGE_KEY,
      JSON.stringify(bookmarks.slice(0, MAX_AGENT_BOOKMARKS)),
    );
  } catch {
    /* localStorage 受限时仅保留当前内存态 */
  }
}

export function toggleAgentBookmarkList(
  current: readonly AgentMessageBookmark[],
  input: AgentBookmarkInput,
  nowIso = new Date().toISOString(),
): { next: AgentMessageBookmark[]; added: boolean; id: string } {
  const id = buildAgentBookmarkId(input.conversationId, input.messageKey);
  const exists = current.some(item => item.id === id);
  if (exists) {
    return {
      next: current.filter(item => item.id !== id),
      added: false,
      id,
    };
  }
  const boundedContent = input.content.trim().slice(0, MAX_BOOKMARK_CONTENT_LENGTH);
  const entry: AgentMessageBookmark = {
    id,
    conversationId: input.conversationId.trim(),
    conversationTitle: (input.conversationTitle || '').trim().slice(0, 80) || '未命名会话',
    messageKey: input.messageKey.trim(),
    ...(input.turnIndex && input.turnIndex > 0 ? { turnIndex: Math.floor(input.turnIndex) } : {}),
    excerpt: summarizeBookmarkExcerpt(boundedContent),
    content: boundedContent,
    createdAt: nowIso,
  };
  return {
    next: [entry, ...current].slice(0, MAX_AGENT_BOOKMARKS),
    added: true,
    id,
  };
}

let sharedBrowserBookmarks: ShallowRef<AgentMessageBookmark[]> | undefined;

export function useAgentBookmarks(customStorage?: Storage | null) {
  const storage = customStorage === undefined ? defaultStorage() : customStorage;
  const listRef = customStorage === undefined
    ? (sharedBrowserBookmarks ??= shallowRef<AgentMessageBookmark[]>(readAgentBookmarks(storage)))
    : shallowRef<AgentMessageBookmark[]>(readAgentBookmarks(storage));

  const bookmarkedIds = computed(() => new Set(listRef.value.map(item => item.id)));

  function isBookmarked(conversationId: string, messageKey: string): boolean {
    if (!conversationId || !messageKey) return false;
    return bookmarkedIds.value.has(buildAgentBookmarkId(conversationId, messageKey));
  }

  function toggleBookmark(input: AgentBookmarkInput): boolean {
    if (!input.conversationId.trim() || !input.messageKey.trim() || !input.content.trim()) {
      return false;
    }
    const { next, added } = toggleAgentBookmarkList(listRef.value, input);
    listRef.value = next;
    writeAgentBookmarks(next, storage);
    return added;
  }

  function removeBookmark(id: string) {
    const next = listRef.value.filter(item => item.id !== id);
    listRef.value = next;
    writeAgentBookmarks(next, storage);
  }

  function reloadBookmarks() {
    listRef.value = readAgentBookmarks(storage);
  }

  return {
    bookmarks: listRef,
    isBookmarked,
    toggleBookmark,
    removeBookmark,
    reloadBookmarks,
  };
}
