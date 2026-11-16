/**
 * 设计说明：会话输入草稿必须以会话 ID 隔离，切换会话只切换当前引用，不销毁未发送内容。
 * 纯文本草稿节流同步到浏览器 localStorage 防止误刷新丢失；临时附件仍仅保留在内存生命周期内，避免刷新后恢复失效附件。
 */
import { computed, shallowRef, type Ref } from 'vue';
import type { AgentAttachment } from '../../../shared/agent-runtime';
import { AgentAttachmentDraft } from './useAgentAttachments';

export interface AgentConversationDraft {
  text: string;
  attachments: AgentAttachment[];
}

const DRAFT_STORAGE_KEY = 'delivery-workspace.agent-draft-texts.v1';
const MAX_PERSISTED_DRAFTS = 60;
const MAX_PERSISTED_DRAFT_CHARS = 32_000;

export interface DraftTextStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultDraftStorage(): DraftTextStorage | undefined {
  try {
    return typeof window !== 'undefined' ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

function loadPersistedDrafts(storage?: DraftTextStorage): Record<string, AgentConversationDraft> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const restored: Record<string, AgentConversationDraft> = {};
    for (const [id, text] of Object.entries(parsed).slice(0, MAX_PERSISTED_DRAFTS)) {
      if (id && typeof text === 'string' && text) {
        restored[id] = { text: text.slice(0, MAX_PERSISTED_DRAFT_CHARS), attachments: [] };
      }
    }
    return restored;
  } catch {
    return {};
  }
}

export function useAgentConversationDrafts(conversationId: Readonly<Ref<string>>, storage = defaultDraftStorage()) {
  const drafts = shallowRef<Record<string, AgentConversationDraft>>(loadPersistedDrafts(storage));
  const attachmentDrafts = shallowRef<Record<string, AgentAttachmentDraft>>({});
  let disposed = false;
  let persistTimer: ReturnType<typeof setTimeout> | undefined;

  function flushPersist() {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = undefined; }
    if (!storage) return;
    try {
      const entries = Object.entries(drafts.value)
        .filter(([id, item]) => id && item.text)
        .slice(-MAX_PERSISTED_DRAFTS)
        .map(([id, item]) => [id, item.text.slice(0, MAX_PERSISTED_DRAFT_CHARS)] as const);
      if (!entries.length) storage.removeItem(DRAFT_STORAGE_KEY);
      else storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch { /* 存储配额满或隐私模式时降级为内存草稿。 */ }
  }

  function schedulePersist(immediate = false) {
    if (!storage) return;
    if (immediate) { flushPersist(); return; }
    if (persistTimer) return;
    persistTimer = setTimeout(flushPersist, 200);
    persistTimer.unref?.();
  }

  function update(id: string, patch: Partial<AgentConversationDraft>) {
    if (!id || disposed) return;
    const current = drafts.value[id] || { text: '', attachments: [] };
    drafts.value = { ...drafts.value, [id]: { ...current, ...patch } };
    if (patch.text !== undefined) schedulePersist(!patch.text);
  }

  function bind(id: Readonly<Ref<string>>) {
    return {
      draft: computed({
        get: () => drafts.value[id.value]?.text || '',
        set: (text: string) => update(id.value, { text }),
      }),
      attachments: computed({
        get: () => drafts.value[id.value]?.attachments || [],
        set: (value: AgentAttachment[]) => update(id.value, { attachments: value }),
      }),
      attachmentDraft: computed(() => attachmentDraftFor(id.value)),
    };
  }

  function attachmentDraftFor(id: string) {
    if (!id || disposed) return undefined;
    if (!attachmentDrafts.value[id]) {
      const value = computed({
        get: () => drafts.value[id]?.attachments || [],
        set: (items: AgentAttachment[]) => update(id, { attachments: items }),
      });
      attachmentDrafts.value = { ...attachmentDrafts.value, [id]: new AgentAttachmentDraft(value) };
    }
    return attachmentDrafts.value[id];
  }
  function attachmentsPending(id: string) { return !!attachmentDrafts.value[id]?.pending; }

  function clear(id: string) {
    attachmentDrafts.value[id]?.discard();
    const targets = { ...attachmentDrafts.value };
    delete targets[id];
    attachmentDrafts.value = targets;
    const cleared = drafts.value[id];
    if (!cleared) return;
    const next = { ...drafts.value };
    delete next[id];
    drafts.value = next;
    schedulePersist(true);
    return cleared;
  }

  function restoreText(id: string, text: string) {
    if (!drafts.value[id]?.text) update(id, { text });
  }

  function restore(id: string, sent: AgentConversationDraft) {
    const current = drafts.value[id];
    const text = current?.text && current.text !== sent.text
      ? [sent.text, current.text].filter(Boolean).join('\n\n') : current?.text || sent.text;
    const attachments = [...new Map([...sent.attachments, ...(current?.attachments || [])]
      .map((attachment) => [attachment.id, attachment])).values()];
    update(id, { text, attachments });
  }

  function move(from: string, to: string) {
    if (from === to) return;
    const pending = drafts.value[from];
    const target = attachmentDrafts.value[from];
    if (target) {
      const destination = attachmentDraftFor(to);
      if (destination) target.moveTo(destination);
      const targets = { ...attachmentDrafts.value };
      delete targets[from];
      attachmentDrafts.value = targets;
    }
    const next = { ...drafts.value };
    delete next[from];
    drafts.value = next;
    if (pending) restore(to, pending);
    schedulePersist(true);
  }

  function pendingAttachments() {
    return Object.values(drafts.value).flatMap((item) => item.attachments);
  }

  function dispose() {
    flushPersist();
    disposed = true;
    Object.values(attachmentDrafts.value).forEach(target => target.discard());
    attachmentDrafts.value = {};
  }

  return { ...bind(conversationId), bind, attachmentDraftFor, attachmentsPending, clear, restoreText, restore, move, pendingAttachments, dispose };
}
