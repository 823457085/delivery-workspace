import test from 'node:test';
import assert from 'node:assert/strict';
import { shallowRef } from 'vue';
import type { AgentAttachment } from '../shared/agent-runtime.js';
import { useAgentConversationDrafts } from '../src/features/agent-workbench/useAgentConversationDrafts.js';

const image: AgentAttachment = {
  id: 'image-1',
  name: 'example.png',
  mimeType: 'image/png',
  size: 1024,
  url: '/api/agent-runtimes/attachments/image-1',
};

test('切换会话时分别保留各自的文本和附件草稿', () => {
  const conversationId = shallowRef('conversation-a');
  const drafts = useAgentConversationDrafts(conversationId);

  drafts.draft.value = '会话 A 草稿';
  drafts.attachments.value = [image];
  conversationId.value = 'conversation-b';
  assert.equal(drafts.draft.value, '');
  assert.deepEqual(drafts.attachments.value, []);

  drafts.draft.value = '会话 B 草稿';
  conversationId.value = 'conversation-a';
  assert.equal(drafts.draft.value, '会话 A 草稿');
  assert.deepEqual(drafts.attachments.value, [image]);

  conversationId.value = 'conversation-b';
  assert.equal(drafts.draft.value, '会话 B 草稿');
});

test('发送成功后只清除指定会话草稿', () => {
  const conversationId = shallowRef('conversation-a');
  const drafts = useAgentConversationDrafts(conversationId);
  drafts.draft.value = '会话 A 草稿';
  drafts.attachments.value = [image];
  conversationId.value = 'conversation-b';
  drafts.draft.value = '会话 B 草稿';

  assert.deepEqual(drafts.clear('conversation-a'), { text: '会话 A 草稿', attachments: [image] });
  assert.deepEqual(drafts.pendingAttachments(), []);
  assert.equal(drafts.draft.value, '会话 B 草稿');
});

test('发送失败时恢复原会话草稿，不影响用户已重新输入的内容', () => {
  const conversationId = shallowRef('conversation-a');
  const drafts = useAgentConversationDrafts(conversationId);
  drafts.draft.value = '';
  conversationId.value = 'conversation-b';
  drafts.draft.value = '会话 B 草稿';

  drafts.restoreText('conversation-a', '发送失败的会话 A 草稿');
  conversationId.value = 'conversation-a';
  assert.equal(drafts.draft.value, '发送失败的会话 A 草稿');

  drafts.draft.value = '用户重新输入的会话 A 内容';
  drafts.restoreText('conversation-a', '不应覆盖');
  assert.equal(drafts.draft.value, '用户重新输入的会话 A 内容');
});

test('失败的发送快照与新输入合并恢复，附件按 ID 去重', () => {
  const conversationId = shallowRef('conversation-a');
  const drafts = useAgentConversationDrafts(conversationId);
  const nextImage = { ...image, id: 'image-2' };
  drafts.draft.value = '后续输入';
  drafts.attachments.value = [image, nextImage];

  drafts.restore('conversation-a', { text: '发送失败的内容', attachments: [image] });

  assert.equal(drafts.draft.value, '发送失败的内容\n\n后续输入');
  assert.deepEqual(drafts.attachments.value, [image, nextImage]);
});

test('历史会话续接后迁移未发送草稿，不丢失文本或附件', () => {
  const conversationId = shallowRef('codex-session');
  const drafts = useAgentConversationDrafts(conversationId);
  drafts.draft.value = '续接期间输入';
  drafts.attachments.value = [image];
  drafts.move('codex-session', 'workspace-conversation');
  assert.equal(drafts.draft.value, '');
  conversationId.value = 'workspace-conversation';
  assert.equal(drafts.draft.value, '续接期间输入');
  assert.deepEqual(drafts.attachments.value, [image]);
});
