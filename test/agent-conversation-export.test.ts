import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRun } from '../shared/agent-runtime.js';
import type { AgentConversation } from '../src/features/agent-workbench/conversation.js';
import { conversationJson, conversationMarkdown } from '../src/features/agent-workbench/conversation-export.js';

const run: AgentRun = { id: 'run-1', provider: 'codex', mode: 'agent', accessMode: 'workspace', model: 'gpt-test', reasoningEffort: 'high',
  objective: '检查并修复会话搜索', workspacePath: '/repo', branch: 'feature/test', headSha: 'abc', status: 'completed',
  attachments: [{ id: '11111111-1111-1111-1111-111111111111', name: '问题截图.png', mimeType: 'image/png', size: 128,
    url: '/api/agent-runtimes/attachments/11111111-1111-1111-1111-111111111111' }],
  sessionId: 'session-12345678', pid: null, result: '已完成修复', error: '', events: [],
  createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:01:00.000Z' };
const conversation: AgentConversation = { id: run.id, title: '会话导出', runs: [run], latest: run,
  updatedAt: run.updatedAt, source: 'workspace', loaded: true };

test('会话导出保留用户与 Agent 内容，不暴露运行事件', () => {
  const markdown = conversationMarkdown(conversation);
  assert.match(markdown, /检查并修复会话搜索/);
  assert.match(markdown, /已完成修复/);
  assert.match(markdown, /问题截图\.png/);
  assert.doesNotMatch(markdown, /session-12345678/);

  const json = JSON.parse(conversationJson(conversation));
  assert.equal(json.turns[0].user, '检查并修复会话搜索');
  assert.equal(json.turns[0].assistant, '已完成修复');
  assert.equal(json.turns[0].attachments[0].name, '问题截图.png');
  assert.equal(json.turns[0].events, undefined);
});
