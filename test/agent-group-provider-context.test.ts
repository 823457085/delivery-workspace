import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGrokAdapter } from '../server/grok-runtime.js';
import { probeLocalTools } from '../server/agent-local-tools.js';
import type { AgentRun } from '../shared/agent-runtime.js';

test('Grok dispatch preserves the custom member instructions and preceding team replies', async context => {
  if (!await probeLocalTools()) { context.skip('本机工具沙箱不可用，未执行 Grok 适配器请求夹具'); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'group-provider-context-'));
  const workspace = path.join(root, 'workspace'), directory = path.join(root, 'state');
  await fs.mkdir(workspace); await fs.mkdir(directory);
  let captured: Record<string, unknown> | undefined;
  const adapter = createGrokAdapter({ directory, models: () => [{ id: 'fixture-model-config', modelId: 'fixture-grok', label: 'Fixture', api: { baseUrl: 'https://api.x.ai/v1' } }],
    apiKey: async () => 'fixture-only-not-a-real-key', history: () => [], redact: value => value,
    request: async (_url, input) => { captured = JSON.parse(String(input?.body)); return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '已读取团队上下文' }] }] }), { status: 200 }); },
  });
  const run: AgentRun = { id: crypto.randomUUID(), provider: 'grok', mode: 'ask', accessMode: 'workspace', model: 'fixture-grok', customModelId: 'fixture-model-config',
    reasoningEffort: '', objective: '按职责回复', teamContext: '你是接口审查角色。前一位真实回复：context-nonce-4217。', workspacePath: workspace,
    branch: '', headSha: '', status: 'running', pid: null, sessionId: '', result: '', error: '', events: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  try {
    const result = await adapter.execute({ run, resumeSessionId: '', forkSessionId: '', forkLastTurnId: '', imagePaths: [], fileAttachments: [], signal: new AbortController().signal,
      onPid: () => {}, onSession: async () => {}, onEvent: () => {}, onOutput: () => {}, onUsage: () => {} });
    assert.equal(result, '已读取团队上下文');
    assert.match(String(captured?.instructions), /接口审查角色/);
    assert.match(String(captured?.instructions), /context-nonce-4217/);
    assert.match(String(captured?.instructions), /只读/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
