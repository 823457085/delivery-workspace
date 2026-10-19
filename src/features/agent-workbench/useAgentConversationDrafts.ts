/**
 * 设计说明：会话输入草稿必须以会话 ID 隔离，切换会话只切换当前引用，不销毁未发送内容。
 * 这里只管理当前页面生命周期内的文本和附件引用；不做本地持久化，避免刷新后恢复已经失效的临时附件。
 */
import { computed, shallowRef, type Ref } from 'vue';
import type { AgentAttachment } from '../../../shared/agent-runtime';
import { AgentAttachmentDraft } from './useAgentAttachments';

export interface AgentConversationDraft {
  text: string;
  attachments: AgentAttachment[];
}

export function useAgentConversationDrafts(conversationId: Readonly<Ref<string>>) {
  const drafts = shallowRef<Record<string, AgentConversationDraft>>({});
  const attachmentDrafts = shallowRef<Record<string, AgentAttachmentDraft>>({});
  let disposed = false;

  function update(id: string, patch: Partial<AgentConversationDraft>) {
    if (!id || disposed) return;
    const current = drafts.value[id] || { text: '', attachments: [] };
    drafts.value = { ...drafts.value, [id]: { ...current, ...patch } };
  }

  const draft = computed({
    get: () => drafts.value[conversationId.value]?.text || '',
    set: (text: string) => update(conversationId.value, { text }),
  });
  const attachments = computed({
    get: () => drafts.value[conversationId.value]?.attachments || [],
    set: (value: AgentAttachment[]) => update(conversationId.value, { attachments: value }),
  });

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
  const attachmentDraft = computed(() => attachmentDraftFor(conversationId.value));
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
  }

  function pendingAttachments() {
    return Object.values(drafts.value).flatMap((item) => item.attachments);
  }

  function dispose() {
    disposed = true;
    Object.values(attachmentDrafts.value).forEach(target => target.discard());
    attachmentDrafts.value = {};
  }

  return { draft, attachments, attachmentDraft, attachmentDraftFor, attachmentsPending, clear, restoreText, restore, move, pendingAttachments, dispose };
}
